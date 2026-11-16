// Network monitor hub. Collects what launchers send and receive:
//   - server side: from the hook loaded into a launcher's Node processes (monitor/hook.cjs)
//   - browser side: from the desktop app's site windows (their DevTools network events)
// Each entry is labelled with its source, given a category for the default filters, and paired with
// its duplicate from the other side when the same request is seen by both.
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'monitor', 'hook.cjs');
const MAX_PER_ENV = 3000;
const BODY_BUDGET = 96 * 1024 * 1024; // per environment; past this the oldest bodies are dropped (headers stay)
export const MAX_BODY = 1024 * 1024; // per body, for site windows (the Node hook has the same limit)
const bodyBytes = (b) => (b?.text ? b.text.length : 0);
const PAIR_WINDOW = 4000; // ms

export const DB_PORTS = {
  5432: 'PostgreSQL', 3306: 'MySQL', 33060: 'MySQL X', 1433: 'SQL Server', 1521: 'Oracle', 27017: 'MongoDB', 6379: 'Redis', 6380: 'Redis',
  11211: 'Memcached', 5672: 'RabbitMQ', 9092: 'Kafka', 4222: 'NATS', 9200: 'Elasticsearch', 7700: 'Meilisearch', 8108: 'Typesense',
  26257: 'CockroachDB', 9042: 'Cassandra', 8086: 'InfluxDB', 7687: 'Neo4j', 5984: 'CouchDB', 1883: 'MQTT', 2181: 'ZooKeeper', 8529: 'ArangoDB',
};
const DEV_PATH = /^\/(@vite|@fs|@id|@react-refresh|__vite|node_modules\/\.vite|_next\/(static|webpack-hmr|image)|__nextjs|__webpack_hmr|_nuxt\/|__nuxt|sockjs-node|webpack-dev-server|\.well-known\/appspecific|favicon\.ico)/i;
const DEV_FILE = /\.(hot-update\.(js|json)|map)$/i;
const STATIC_EXT = /\.(m?js|cjs|jsx|tsx?|css|scss|less|html?|png|jpe?g|gif|svg|ico|webp|avif|bmp|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|ogg|wasm|json5?|webmanifest|txt|xml|pdf|zip)$/i;
const HEALTH = /^\/(api\/)?(v\d+\/)?(health|healthz|healthcheck|ping|ready|readyz|live|livez|alive|status|heartbeat)\/?$/i;
const STATIC_TYPES = new Set(['Document', 'Stylesheet', 'Script', 'Image', 'Font', 'Media', 'Manifest', 'TextTrack', 'Prefetch', 'Preflight', 'SignedExchange', 'Ping', 'CSPViolationReport']);

function pathOf(url) {
  try { const u = new URL(url, 'http://x'); return { path: u.pathname, search: u.search }; } catch { return { path: String(url || ''), search: '' }; }
}
function categorize(e) {
  if (e.kind === 'tcp') return DB_PORTS[e.remotePort] ? 'db' : 'tcp';
  if (e.kind === 'ws') return DEV_PATH.test(e.path || '') || /hmr|webpack|vite|_next|sockjs/i.test(e.url || '') ? 'dev' : 'ws';
  const p = e.path || '';
  if (DEV_PATH.test(p) || DEV_FILE.test(p) || /[?&](import|t=\d+|v=[0-9a-f]{6,})/.test(e.search || '') && /\.(m?[jt]sx?|vue|svelte|css)$/i.test(p)) return 'dev';
  if (HEALTH.test(p)) return 'health';
  if (e.src === 'browser' && e.resourceType) {
    if (STATIC_TYPES.has(e.resourceType)) return e.resourceType === 'Preflight' ? 'api' : 'static';
    return 'api'; // XHR, Fetch, EventSource, Other
  }
  if (e.dir === 'in' && STATIC_EXT.test(p)) return 'static';
  const ct = String(e.resHeaders?.['content-type'] || '');
  if (e.dir === 'in' && /^(image|font|video|audio)\/|text\/css|javascript/i.test(ct)) return 'static';
  if (e.dir === 'in' && /text\/html/i.test(ct) && e.method === 'GET') return 'static';
  return 'api';
}
const sizeOf = (body, headers) => body?.size ?? (Number(headers?.['content-length']) || 0);

export class NetMonitor extends EventEmitter {
  constructor({ store }) {
    super();
    this.store = store;
    this.token = crypto.randomBytes(16).toString('hex');
    this.port = 0;
    this.byEnv = new Map(); // envId -> entries (oldest first)
    this.byKey = new Map(); // `${lid}|${id}` -> entry
    this.byN = new Map(); // n -> entry
    this.n = 0;
    this.hooked = new Map(); // lid -> Set(pid) of processes reporting since the launcher last started
    this.outbox = new Map(); // envId -> Map(n -> entry) waiting to be broadcast
    this.flushTimer = null;
  }

  // ---------- hook side ----------
  listen() {
    return new Promise((resolve) => {
      const srv = net.createServer((sock) => this.#onHook(sock));
      srv.on('error', () => resolve(0));
      srv.listen(0, '127.0.0.1', () => { this.port = srv.address().port; srv.unref(); resolve(this.port); });
    });
  }

  /** Environment variables that load the hook into a launcher's Node processes. */
  hookEnv(launcher, existingNodeOptions = '') {
    if (!this.port) return {};
    const req = `--require "${HOOK.replace(/\\/g, '/')}"`; // NODE_OPTIONS treats backslashes as escapes
    return {
      NODE_OPTIONS: existingNodeOptions ? `${existingNodeOptions} ${req}` : req,
      MCDH_MON_PORT: String(this.port), MCDH_MON_TOKEN: this.token, MCDH_MON_ID: launcher.id,
    };
  }

  launcherStarted(lid) { this.hooked.set(lid, new Set()); this.emit('hooks', { id: lid, processes: 0 }); }
  hookCount(lid) { return this.hooked.get(lid)?.size || 0; }

  #onHook(sock) {
    let buf = '';
    let who = null;
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    sock.on('close', () => {
      if (!who) return;
      const set = this.hooked.get(who.lid);
      if (set?.delete(`${who.pid}.${who.thread}`)) this.emit('hooks', { id: who.lid, processes: set.size });
    });
    sock.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > 8 * 1024 * 1024) { sock.destroy(); return; }
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (!who) {
          if (!msg.hello || msg.token !== this.token || !this.store.findLauncher(msg.lid)) { sock.destroy(); return; }
          who = { lid: msg.lid, pid: msg.pid, thread: msg.thread || 0 };
          if (!this.hooked.has(who.lid)) this.hooked.set(who.lid, new Set());
          const set = this.hooked.get(who.lid);
          set.add(`${who.pid}.${who.thread}`);
          this.emit('hooks', { id: who.lid, processes: set.size });
          continue;
        }
        this.#ingest(who.lid, 'server', msg);
      }
    });
  }

  // ---------- browser side (desktop app site windows) ----------
  /** Which launcher a page origin belongs to, if its monitor is on. */
  launcherForOrigin(origin) {
    let u;
    try { u = new URL(origin); } catch { return null; }
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    const local = (h) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(h);
    for (const env of this.store.state.environments) {
      for (const l of env.launchers) {
        if (!l.monitor) continue;
        let lu = null;
        try { if (l.url) lu = new URL(l.url); } catch { lu = null; }
        if (lu && (lu.host === u.host || (local(lu.hostname) && local(u.hostname) && (lu.port || '80') === port))) return { env, launcher: l };
        if (l.port && String(l.port) === port && local(u.hostname)) return { env, launcher: l };
      }
    }
    return null;
  }

  ingestBrowser(body) {
    const hit = this.launcherForOrigin(String(body.origin || ''));
    if (!hit) return { enabled: false };
    for (const ev of Array.isArray(body.events) ? body.events.slice(0, 500) : []) {
      if (ev && typeof ev === 'object' && ev.id) this.#ingest(hit.launcher.id, 'browser', { ...ev, dir: 'out' });
    }
    return { enabled: true, launcherId: hit.launcher.id, maxBody: MAX_BODY };
  }

  // ---------- entries ----------
  #ingest(lid, src, m) {
    const found = this.store.findLauncher(lid);
    if (!found) return;
    const key = `${lid}|${src}|${m.id}`;
    let e = this.byKey.get(key);
    if (m.t === 'start' || !e) {
      if (e) return;
      e = { n: ++this.n, key, lid, envId: found.env.id, src, dir: m.dir || 'out', kind: m.kind || 'http', via: m.via || '', pending: true, startedAt: Number(m.startedAt) || Date.now() };
      this.byKey.set(key, e);
      this.byN.set(e.n, e);
      const list = this.byEnv.get(e.envId) || [];
      list.push(e);
      if (list.length > MAX_PER_ENV) for (const old of list.splice(0, list.length - MAX_PER_ENV)) { this.byKey.delete(old.key); this.byN.delete(old.n); }
      this.byEnv.set(e.envId, list);
    }
    const pick = (k, max = 4000) => { if (m[k] != null) e[k] = typeof m[k] === 'string' ? m[k].slice(0, max) : m[k]; };
    pick('method', 20); pick('url'); pick('host', 300); pick('reqHeaders'); pick('resourceType', 40); pick('pid');
    pick('remote', 100); pick('remoteHost', 100); pick('remotePort'); pick('localPort'); pick('initiator', 300);
    const before = bodyBytes(e.reqBody) + bodyBytes(e.resBody);
    if (m.reqBody !== undefined && m.reqBody !== null) e.reqBody = m.reqBody;
    if (m.t === 'end' || m.t === 'update') {
      pick('status'); pick('statusText', 200); pick('resHeaders'); pick('duration'); pick('error', 1000);
      pick('bytesRead'); pick('bytesWritten'); pick('fromCache'); pick('size');
      if (m.resBody !== undefined && m.resBody !== null) e.resBody = m.resBody;
      if (m.t === 'end') e.pending = false;
    }
    if (e.url && !e.path) Object.assign(e, pathOf(e.url));
    if (e.kind === 'tcp' && !e.url) e.url = `tcp://${e.host || `${e.remoteHost}:${e.remotePort}`}`;
    e.cat = categorize(e);
    if (e.cat === 'static' || e.cat === 'dev') { delete e.reqBody; delete e.resBody; } // keep memory for what matters
    this.#budget(e.envId, bodyBytes(e.reqBody) + bodyBytes(e.resBody) - before);
    if (e.kind === 'http' && !e.pair && (e.src === 'browser' || e.dir === 'in')) this.#pair(e);
    this.#queue(e);
    // a bearer token (or a login response with one) just went by: tell the API tab right away
    if (e.kind === 'http' && (/^\s*bearer\s/i.test(e.reqHeaders?.authorization || '') || (m.t === 'end' && /token|jwt/i.test(e.resBody?.text || '')))) this.#tokenSeen(e.envId);
  }

  /** Keeps the bodies of one environment under BODY_BUDGET by dropping the oldest ones. */
  #budget(envId, delta) {
    this.bodyUse = this.bodyUse || new Map();
    let used = (this.bodyUse.get(envId) || 0) + delta;
    if (used > BODY_BUDGET) {
      for (const old of this.byEnv.get(envId) || []) {
        if (used <= BODY_BUDGET * 0.8) break;
        for (const k of ['reqBody', 'resBody']) {
          const n = bodyBytes(old[k]);
          if (!n) continue;
          used -= n;
          old[k] = { dropped: true, size: old[k].size };
        }
      }
    }
    this.bodyUse.set(envId, Math.max(0, used));
  }

  #tokenSeen(envId) {
    this.tokenTimers = this.tokenTimers || new Map();
    if (this.tokenTimers.has(envId)) return; // one notice per 150 ms per environment is plenty
    this.tokenTimers.set(envId, setTimeout(() => { this.tokenTimers.delete(envId); this.emit('token', { envId }); }, 150));
  }

  #pair(e) {
    const list = this.byEnv.get(e.envId) || [];
    const wantSrc = e.src === 'browser' ? 'server' : 'browser';
    let best = null;
    for (let i = list.length - 1; i >= 0 && i >= list.length - 400; i--) {
      const o = list[i];
      if (o.pair || o === e || o.src !== wantSrc || o.kind !== 'http' || (wantSrc === 'server' && o.dir !== 'in')) continue;
      if (o.method !== e.method || o.path !== e.path || (o.search || '') !== (e.search || '')) continue;
      const dt = Math.abs(o.startedAt - e.startedAt);
      if (dt > PAIR_WINDOW) continue;
      if (!e.pending && !o.pending && e.status && o.status && e.status !== o.status) continue;
      const score = dt + (o.lid === e.lid ? 0 : 1000);
      if (!best || score < best.score) best = { o, score };
    }
    if (!best) return;
    e.pair = best.o.n;
    best.o.pair = e.n;
    this.#queue(best.o);
  }

  #queue(e) {
    const box = this.outbox.get(e.envId) || new Map();
    box.set(e.n, e);
    this.outbox.set(e.envId, box);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.#flush(), 150);
  }
  #flush() {
    this.flushTimer = null;
    for (const [envId, box] of this.outbox) this.emit('entries', { envId, entries: [...box.values()].map(summary) });
    this.outbox.clear();
  }

  list(envId, since = 0) {
    return (this.byEnv.get(envId) || []).filter((e) => e.n > since).map(summary);
  }
  get(n) { return this.byN.get(Number(n)) || null; }

  /**
   * The bearer token a running app uses for `launcher` (an API), from captured traffic only:
   * the newest `Authorization: Bearer …` sent to it, or a token in a captured login response.
   * Returns { monitored, token, candidates: [{ token, seenAt, method, path, src, via }] }.
   */
  tokenFor(env, launcher) {
    const monitored = env.launchers.some((l) => l.monitor);
    if (!monitored) return { monitored, token: null, candidates: [] }; // no monitor, no auto-fill (even from older captures)
    const list = this.byEnv.get(env.id) || [];
    const local = (h) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(h);
    let lu = null;
    try { lu = new URL(launcher.url || `http://localhost:${launcher.port}`); } catch { lu = null; }
    const targets = (e) => {
      if (e.kind !== 'http') return false;
      if (e.src === 'server' && e.dir === 'in') return e.lid === launcher.id;
      try { // browser side or another launcher's outgoing call: by the address it went to
        const u = new URL(e.url);
        if (!lu) return false;
        const port = (x) => x.port || (x.protocol === 'https:' ? '443' : '80');
        return port(u) === port(lu) && (u.hostname === lu.hostname || (local(u.hostname) && local(lu.hostname)));
      } catch { return false; }
    };
    const found = new Map(); // token -> newest sighting
    const note = (token, e, via) => {
      if (!token || token.length < 8) return;
      const prev = found.get(token);
      if (!prev || prev.seenAt < e.startedAt) found.set(token, { token, seenAt: e.startedAt, method: e.method, path: e.path || e.url, src: e.src, dir: e.dir, via });
    };
    for (let i = list.length - 1; i >= 0 && found.size < 5; i--) {
      const e = list[i];
      if (!targets(e)) continue;
      const m = /^\s*bearer\s+(\S+)/i.exec(e.reqHeaders?.authorization || '');
      if (m) { if (e.status !== 401 && e.status !== 403) note(m[1], e, 'request'); } // a rejected token is an expired one
      else if (e.resBody?.text && e.status >= 200 && e.status < 300 && /token|jwt/i.test(e.resBody.text)) note(tokenInBody(e.resBody.text), e, 'login');
    }
    const candidates = [...found.values()].sort((a, b) => b.seenAt - a.seenAt);
    return { monitored, token: candidates[0]?.token || null, candidates };
  }

  /**
   * Connection view for launchers without a hook (Python, .NET, Go…): `conns` are the launcher's current outgoing
   * TCP connections. New ones become entries, ones that are gone get closed.
   */
  syncConnections(lid, conns) {
    this.connState = this.connState || new Map();
    const open = this.connState.get(lid) || new Map();
    const now = Date.now();
    const seen = new Set();
    for (const c of conns) {
      const id = `conn:${c.pid}:${c.localPort}:${c.remoteHost}:${c.remotePort}`;
      seen.add(id);
      if (open.has(id)) continue;
      open.set(id, now);
      this.#ingest(lid, 'server', { t: 'start', id, dir: 'out', kind: 'tcp', via: 'netstat', remoteHost: c.remoteHost, remotePort: c.remotePort,
        localPort: c.localPort, host: `${c.remoteHost.includes(':') ? `[${c.remoteHost}]` : c.remoteHost}:${c.remotePort}`, startedAt: now, pid: c.pid });
    }
    for (const [id, t0] of open) {
      if (seen.has(id)) continue;
      open.delete(id);
      this.#ingest(lid, 'server', { t: 'end', id, duration: now - t0 });
    }
    this.connState.set(lid, open);
  }

  clear(envId, lid) {
    const list = this.byEnv.get(envId) || [];
    const keep = lid ? list.filter((e) => e.lid !== lid) : [];
    for (const e of list) if (!keep.includes(e)) { this.byKey.delete(e.key); this.byN.delete(e.n); }
    this.byEnv.set(envId, keep);
    this.bodyUse?.set(envId, keep.reduce((n, e) => n + bodyBytes(e.reqBody) + bodyBytes(e.resBody), 0));
    this.emit('cleared', { envId, lid: lid || null });
  }
}

/** A token in a login response body: { token | accessToken | access_token | jwt | … } anywhere a few levels deep. */
function tokenInBody(text) {
  let json;
  try { json = JSON.parse(text); } catch { return null; }
  const seen = new Set();
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 4 || seen.has(o)) return null;
    seen.add(o);
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' && v.length >= 16 && /^(token|accessToken|access_token|jwt|idToken|id_token|sessionToken|authToken|bearer)$/i.test(k)) return v;
    }
    for (const v of Object.values(o)) { const t = walk(v, depth + 1); if (t) return t; }
    return null;
  };
  return walk(json, 0);
}

/** What the list needs (no headers or bodies). */
export function summary(e) {
  return {
    n: e.n, lid: e.lid, envId: e.envId, src: e.src, dir: e.dir, kind: e.kind, via: e.via, cat: e.cat, method: e.method || '', url: e.url || '',
    host: e.host || '', path: e.path || '', search: e.search || '', status: e.status ?? null, statusText: e.statusText || '', pending: !!e.pending,
    startedAt: e.startedAt, duration: e.duration ?? null, error: e.error || '', pair: e.pair || null, resourceType: e.resourceType || '',
    reqSize: sizeOf(e.reqBody, e.reqHeaders), resSize: e.size ?? sizeOf(e.resBody, e.resHeaders), remotePort: e.remotePort ?? null,
    service: e.kind === 'tcp' ? DB_PORTS[e.remotePort] || '' : '', bytesRead: e.bytesRead ?? null, bytesWritten: e.bytesWritten ?? null,
    contentType: String(e.resHeaders?.['content-type'] || '').split(';')[0], fromCache: !!e.fromCache,
  };
}
