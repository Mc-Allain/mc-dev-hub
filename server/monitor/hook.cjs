'use strict';
// Network monitor hook. Loaded into a launcher's Node processes with NODE_OPTIONS=--require when its
// network monitor is on. It watches Node's own diagnostics channels (no monkey-patching of modules):
//   - incoming HTTP requests (http.server.*)
//   - outgoing HTTP via http/https (axios, got, proxies…) and fetch (undici)
//   - TCP connections (databases, caches, queues…)
// and streams them to the launcher over a local socket. It never throws into the app: every handler is guarded.
(() => {
  const port = Number(process.env.MCDH_MON_PORT);
  const token = process.env.MCDH_MON_TOKEN;
  const lid = process.env.MCDH_MON_ID;
  if (!port || !token || !lid || globalThis.__mcdhNetMonitor) return;
  globalThis.__mcdhNetMonitor = true;

  let dc, net, zlib, threadId = 0;
  try {
    dc = require('node:diagnostics_channel');
    net = require('node:net');
    zlib = require('node:zlib');
    threadId = require('node:worker_threads').threadId || 0;
  } catch { return; }

  const MAX_BODY = 1024 * 1024; // big enough for most JSON APIs; the launcher keeps a memory budget
  const pid = process.pid;
  let seq = 0;
  const newId = () => `${pid}.${threadId}.${++seq}`;
  const guard = (fn) => (...a) => { try { fn(...a); } catch { /* never disturb the app */ } };

  // ---------- transport: newline-delimited JSON over a local socket ----------
  const own = new WeakSet();
  let sock = null, connecting = false, failures = 0, timer = null;
  const queue = [];
  function send(ev) {
    if (failures > 5) return;
    queue.push(ev);
    if (queue.length > 3000) queue.splice(0, queue.length - 3000);
    if (!timer) { timer = setTimeout(flush, 120); timer.unref?.(); }
  }
  function flush() {
    timer = null;
    if (!queue.length) return;
    if (!sock) return connect();
    let out = '';
    for (const e of queue.splice(0)) { try { out += JSON.stringify(e) + '\n'; } catch { /* unserializable */ } }
    sock.write(out);
  }
  function connect() {
    if (connecting) return;
    connecting = true;
    const s = new net.Socket();
    own.add(s);
    s.on('error', () => { sock = null; connecting = false; failures++; if (failures <= 5) { timer = setTimeout(flush, 1000 * failures); timer.unref?.(); } });
    s.on('close', () => { if (sock === s) sock = null; });
    s.connect(port, '127.0.0.1', () => {
      connecting = false;
      failures = 0;
      sock = s;
      s.write(JSON.stringify({ hello: 1, token, lid, pid, thread: threadId, title: process.title, argv: process.argv.slice(1, 3) }) + '\n');
      flush();
    });
    s.unref();
  }

  // ---------- helpers ----------
  function collector() {
    const c = { chunks: [], kept: 0, size: 0 };
    c.add = (chunk, enc) => {
      if (chunk == null || typeof chunk === 'function') return;
      let b;
      if (Buffer.isBuffer(chunk)) b = chunk;
      else if (chunk instanceof Uint8Array) b = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      else if (typeof chunk === 'string') b = Buffer.from(chunk, typeof enc === 'string' && Buffer.isEncoding(enc) ? enc : 'utf8');
      else return;
      c.size += b.length;
      if (c.kept < MAX_BODY) {
        const part = b.subarray(0, MAX_BODY - c.kept);
        c.chunks.push(Buffer.from(part));
        c.kept += part.length;
      }
    };
    return c;
  }
  const TEXT = /^(text\/|application\/(.*\+)?(json|xml|javascript|x-www-form-urlencoded|graphql|x-ndjson)|multipart\/form-data)/i;
  function header(h, name) {
    if (!h) return '';
    const v = h[name] ?? h[name.toLowerCase()];
    return Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v);
  }
  /** -> { text?, size, truncated, binary?, base64? } */
  function bodyOut(c, headers) {
    if (!c || !c.size) return null;
    let buf = Buffer.concat(c.chunks);
    const truncated = c.size > c.kept;
    const enc = header(headers, 'content-encoding').toLowerCase();
    try {
      if (enc.includes('gzip')) buf = zlib.gunzipSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
      else if (enc.includes('deflate')) buf = zlib.inflateSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
      else if (enc.includes('br')) buf = zlib.brotliDecompressSync(buf, { finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH });
    } catch { /* keep raw */ }
    if (buf.length > MAX_BODY) buf = buf.subarray(0, MAX_BODY);
    const type = header(headers, 'content-type');
    const looksText = TEXT.test(type) || (!type && !buf.subarray(0, 512).includes(0));
    return looksText ? { text: buf.toString('utf8'), size: c.size, truncated } : { binary: true, size: c.size, truncated };
  }
  function plainHeaders(h) {
    const out = {};
    if (!h) return out;
    if (typeof h === 'string') { // undici (old): "a: b\r\nc: d\r\n"
      for (const line of h.split(/\r?\n/)) { const i = line.indexOf(':'); if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim(); }
      return out;
    }
    if (Array.isArray(h)) { // undici: flat [k, v, k, v] (strings or Buffers) or [[k, v]]
      if (h.length && Array.isArray(h[0])) for (const [k, v] of h) out[String(k).toLowerCase()] = String(v);
      else for (let i = 0; i + 1 < h.length; i += 2) {
        const k = String(h[i]).toLowerCase();
        const v = String(h[i + 1]);
        out[k] = out[k] ? `${out[k]}, ${v}` : v;
      }
      return out;
    }
    for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
    return out;
  }
  const sub = (name, fn) => { try { dc.subscribe(name, guard(fn)); } catch { /* channel not in this Node version */ } };
  // say hello right away, so the launcher can show "capturing" before the first request
  setImmediate(guard(connect));

  // ---------- incoming HTTP ----------
  sub('http.server.request.start', ({ request: req, response: res, socket }) => {
    if (own.has(socket)) return;
    const id = newId();
    const t0 = Date.now();
    const reqBody = collector();
    const resBody = collector();
    send({ t: 'start', id, dir: 'in', kind: 'http', method: req.method, url: req.url, host: req.headers.host || '', reqHeaders: plainHeaders(req.headers), startedAt: t0, remote: socket?.remoteAddress || '', pid });
    // request body: the parser hands chunks to req.push; watching there doesn't change how the app reads it
    const push = req.push;
    req.push = function (chunk, enc) { try { if (chunk) reqBody.add(chunk, enc); } catch { /* ignore */ } return push.call(this, chunk, enc); };
    const write = res.write;
    const end = res.end;
    res.write = function (chunk, enc) { try { resBody.add(chunk, enc); } catch { /* ignore */ } return write.apply(this, arguments); };
    res.end = function (chunk, enc) { try { resBody.add(chunk, enc); } catch { /* ignore */ } return end.apply(this, arguments); };
    let done = false;
    const finish = guard((aborted) => {
      if (done) return;
      done = true;
      const resHeaders = plainHeaders(res.getHeaders?.() || {});
      send({
        t: 'end', id, status: res.statusCode, statusText: res.statusMessage || '', resHeaders, duration: Date.now() - t0,
        reqBody: bodyOut(reqBody, req.headers), resBody: bodyOut(resBody, resHeaders), error: aborted && !res.writableFinished ? 'Connection closed before the response finished' : '',
      });
    });
    res.once('finish', () => finish(false));
    res.once('close', () => finish(true));
  });

  // ---------- outgoing HTTP: http / https modules ----------
  const clientReqs = new WeakMap();
  sub('http.client.request.start', ({ request: req }) => {
    if (own.has(req.socket)) return;
    const id = newId();
    const proto = req.protocol || (req.agent?.protocol) || 'http:';
    const host = req.host || header(req.getHeaders?.(), 'host');
    const defPort = proto === 'https:' ? 443 : 80;
    const hostPort = req.getHeader?.('host') || (req.socket?.remotePort && req.socket.remotePort !== defPort ? `${host}:${req.socket.remotePort}` : host);
    const st = { id, t0: Date.now(), reqBody: collector(), resBody: collector(), done: false };
    clientReqs.set(req, st);
    const write = req.write;
    const end = req.end;
    req.write = function (chunk, enc) { try { st.reqBody.add(chunk, enc); } catch { /* ignore */ } return write.apply(this, arguments); };
    req.end = function (chunk, enc) { try { st.reqBody.add(chunk, enc); } catch { /* ignore */ } return end.apply(this, arguments); };
    send({ t: 'start', id, dir: 'out', kind: 'http', via: 'http', method: req.method, url: `${proto}//${hostPort}${req.path}`, host: String(hostPort), reqHeaders: plainHeaders(req.getHeaders?.()), startedAt: st.t0, pid });
  });
  sub('http.client.response.finish', ({ request: req, response: res }) => {
    const st = clientReqs.get(req);
    if (!st) return;
    const push = res.push;
    res.push = function (chunk, enc) { try { if (chunk) st.resBody.add(chunk, enc); } catch { /* ignore */ } return push.call(this, chunk, enc); };
    const finish = guard(() => {
      if (st.done) return;
      st.done = true;
      const resHeaders = plainHeaders(res.headers);
      send({ t: 'end', id: st.id, status: res.statusCode, statusText: res.statusMessage || '', resHeaders, duration: Date.now() - st.t0,
        reqBody: bodyOut(st.reqBody, req.getHeaders?.()), resBody: bodyOut(st.resBody, resHeaders) });
    });
    res.once('end', finish);
    res.once('close', finish);
  });
  sub('http.client.request.error', ({ request: req, error }) => {
    const st = clientReqs.get(req);
    if (!st || st.done) return;
    st.done = true;
    send({ t: 'end', id: st.id, duration: Date.now() - st.t0, error: error?.message || String(error), reqBody: bodyOut(st.reqBody, req.getHeaders?.()) });
  });

  // ---------- outgoing HTTP: fetch (undici) ----------
  const fetches = new WeakMap();
  sub('undici:request:create', ({ request: r }) => {
    const id = newId();
    const st = { id, t0: Date.now(), reqBody: collector(), resBody: collector(), resHeaders: null, status: 0, statusText: '', done: false };
    fetches.set(r, st);
    if (typeof r.body === 'string' || r.body instanceof Uint8Array) st.reqBody.add(r.body);
    const reqHeaders = plainHeaders(r.headers);
    let host = '';
    try { host = new URL(r.origin).host; } catch { host = String(r.origin || ''); }
    send({ t: 'start', id, dir: 'out', kind: 'http', via: 'fetch', method: r.method, url: `${r.origin}${r.path}`, host, reqHeaders, startedAt: st.t0, pid });
    st.reqHeaders = reqHeaders;
  });
  sub('undici:request:headers', ({ request: r, response }) => {
    const st = fetches.get(r);
    if (!st) return;
    st.status = response.statusCode;
    st.statusText = response.statusText || '';
    st.resHeaders = plainHeaders(response.headers);
  });
  sub('undici:request:bodyChunkReceived', ({ request: r, chunk }) => { fetches.get(r)?.resBody.add(chunk); });
  const fetchDone = (r, error) => {
    const st = fetches.get(r);
    if (!st || st.done) return;
    st.done = true;
    send({ t: 'end', id: st.id, status: st.status || undefined, statusText: st.statusText, resHeaders: st.resHeaders || {}, duration: Date.now() - st.t0,
      reqBody: bodyOut(st.reqBody, st.reqHeaders), resBody: bodyOut(st.resBody, st.resHeaders), error: error ? (error.message || String(error)) : '' });
  };
  sub('undici:request:trailers', ({ request: r }) => fetchDone(r));
  sub('undici:request:error', ({ request: r, error }) => fetchDone(r, error));

  // ---------- TCP connections (databases, caches, queues…) ----------
  sub('net.client.socket', ({ socket }) => {
    if (own.has(socket)) return;
    const id = newId();
    const t0 = Date.now();
    let opened = false;
    socket.once('connect', guard(() => {
      opened = true;
      send({ t: 'start', id, dir: 'out', kind: 'tcp', remoteHost: socket.remoteAddress, remotePort: socket.remotePort, localPort: socket.localPort,
        host: `${socket._host || socket.remoteAddress}:${socket.remotePort}`, startedAt: t0, pid });
    }));
    socket.once('close', guard((hadError) => {
      if (!opened) return;
      send({ t: 'end', id, duration: Date.now() - t0, bytesRead: socket.bytesRead, bytesWritten: socket.bytesWritten, error: hadError ? 'Closed with an error' : '' });
    }));
  });
})();
