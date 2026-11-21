// MC Dev Hub server: serves the UI and runs your projects' launchers.
//   node server.js [--port 4800] [--data <dir>]
// Env: PORT, MCDH_DATA_DIR, MCDH_WATCH_STDIN=1 (exit when the parent app's pipe closes)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createStore } from './lib/store.js';
import { ProcessManager, launcherDir } from './lib/procs.js';
import * as git from './lib/git.js';
import { detect } from './lib/detect.js';
import * as sys from './lib/system.js';
import { scanProject, fetchOpenApi } from './lib/apiscan.js';
import { Instances, processTable, establishedConnections, listeningSockets } from './lib/instances.js';
import { CliManager } from './lib/cli.js';
import { NetMonitor } from './lib/monitor.js';
import { AiJobs, claudeStatus, openSignIn, signOut, AI_MODELS, DEFAULT_AI_MODEL } from './lib/ai.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };

const PORT = parseInt(arg('port') || process.env.PORT || '4800', 10);
const DATA_DIR = path.resolve(arg('data') || process.env.MCDH_DATA_DIR || path.join(here, '..', 'data'));
const PUBLIC = path.join(here, 'public');
const VERSION = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).version;

const store = createStore(DATA_DIR);
const procs = new ProcessManager();
const clis = new CliManager((lid) => store.findLauncher(lid));
const netmon = new NetMonitor({ store });
const aiJobs = new AiJobs();
await netmon.listen();
procs.monitorEnv = (launcher, nodeOptions) => netmon.hookEnv(launcher, nodeOptions);
procs.on('monitorStart', (lid) => netmon.launcherStarted(lid));
const instances = new Instances({ procs, store, clis });

// ---------- server-sent events ----------
const clients = new Map(); // res -> { webview: bool } (webview = the page inside the desktop app)
const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
function broadcast(type, data) {
  const msg = sse(type, data);
  for (const res of clients.keys()) res.write(msg);
}
procs.on('status', (s) => { instances.invalidate(); broadcast('status', s); });
procs.on('log', (l) => broadcast('log', l));
procs.on('clear', (c) => broadcast('clear', c));
clis.on('log', (l) => broadcast('log', l));
clis.on('clear', (c) => broadcast('clear', c));
clis.on('cli', (c) => { instances.invalidate(); broadcast('cli', c); });
clis.on('cliClosed', (c) => broadcast('cliClosed', c));
netmon.on('entries', (x) => broadcast('net', x));
netmon.on('cleared', (x) => broadcast('netCleared', x));
netmon.on('hooks', (x) => broadcast('netHooks', x));
netmon.on('token', (x) => broadcast('netToken', x));
aiJobs.on('event', (x) => broadcast('ai', x));
// "Open when ready": in the desktop app's window when that's the setting and the app is open, else the browser
procs.on('openSite', (site) => {
  if (store.state.settings.openSitesIn !== 'browser') {
    const host = [...clients].find(([, c]) => c.webview)?.[0];
    if (host) return host.write(sse('openSite', site));
  }
  sys.openUrl(site.url).catch(() => {});
});

// ---------- API viewer: request proxy with a cookie jar per origin (like Postman) ----------
const cookieJar = new Map(); // origin -> Map(name -> value)
function storeCookies(origin, setCookies) {
  if (!setCookies?.length) return;
  const jar = cookieJar.get(origin) || new Map();
  for (const c of setCookies) {
    const [pair, ...attrs] = c.split(';');
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const expired = attrs.some((a) => /^\s*max-age\s*=\s*0/i.test(a) || (/^\s*expires\s*=/i.test(a) && Date.parse(a.split('=')[1]) < Date.now()));
    if (expired || value === '') jar.delete(name); else jar.set(name, value);
  }
  cookieJar.set(origin, jar);
}
const TEXT_TYPE = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|problem\+json|ld\+json|graphql)|[^;]*\+json|[^;]*\+xml)/i;

async function proxyRequest(body) {
  let url;
  try { url = new URL(String(body.url || '')); } catch { throw new HttpError(400, 'Enter a full URL, e.g. http://localhost:4000/v1/health'); }
  if (!/^https?:$/.test(url.protocol)) throw new HttpError(400, 'Only http and https URLs');
  const method = String(body.method || 'GET').toUpperCase();
  const headers = new Headers();
  for (const [k, v] of Object.entries(body.headers || {})) if (k.trim()) { try { headers.set(k.trim(), String(v)); } catch { throw new HttpError(400, `Invalid header: ${k}`); } }
  const jar = cookieJar.get(url.origin);
  if (jar?.size && !headers.has('cookie')) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));

  let payload;
  if (!['GET', 'HEAD'].includes(method)) {
    if (Array.isArray(body.multipart)) {
      const fd = new FormData();
      for (const part of body.multipart) {
        if (!part.name) continue;
        if (part.base64 != null) fd.append(part.name, new Blob([Buffer.from(part.base64, 'base64')], { type: part.type || 'application/octet-stream' }), part.fileName || 'file');
        else fd.append(part.name, String(part.value ?? ''));
      }
      payload = fd;
      headers.delete('content-type'); // fetch sets the multipart boundary
    } else if (body.body != null && body.body !== '') {
      payload = String(body.body);
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    }
  }

  const started = performance.now();
  let res;
  try {
    res = await fetch(url, { method, headers, body: payload, redirect: 'follow', signal: AbortSignal.timeout(120000) });
  } catch (err) {
    const cause = err.cause?.code || err.cause?.message || err.message;
    return { error: /ECONNREFUSED/.test(cause) ? `Could not connect to ${url.host}. Is the API running?` : `Request failed: ${cause}`, ms: Math.round(performance.now() - started) };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const ms = Math.round(performance.now() - started);
  storeCookies(url.origin, res.headers.getSetCookie?.() || []);
  const type = res.headers.get('content-type') || '';
  const isText = !type || TEXT_TYPE.test(type);
  const LIMIT = 8 * 1024 * 1024;
  return {
    status: res.status, statusText: res.statusText, ms, size: buf.length, contentType: type, finalUrl: res.url,
    headers: [...res.headers.entries()],
    body: isText ? buf.subarray(0, LIMIT).toString('utf8') : null,
    base64: !isText && buf.length <= LIMIT ? buf.toString('base64') : null,
    truncated: buf.length > LIMIT,
    cookies: [...(cookieJar.get(url.origin) || [])].map(([k]) => k),
  };
}

// Route list per launcher: live OpenAPI first (if the API runs), else read from the code. Cached briefly.
const routeCache = new Map();
async function launcherRoutes(env, l, force, prefer) {
  const key = l.id + '|' + prefer;
  const hit = routeCache.get(key);
  if (hit && !force && Date.now() - hit.at < 15000) return hit.data;
  const baseUrl = (l.url || (l.port ? `http://localhost:${l.port}` : '')).replace(/\/$/, '');
  const running = procs.isActive(l.id) || (l.port ? await sys.isPortOpen(l.port) : false);
  let data = null;
  if (prefer !== 'code' && baseUrl && running) {
    const spec = await fetchOpenApi(baseUrl);
    if (spec) data = { source: 'openapi', specUrl: spec.url, routes: spec.routes };
  }
  if (!data) {
    const dir = launcherDir(env, l);
    if (!sys.pathInfo(dir).isDir) throw new HttpError(400, `Folder not found: ${dir}`);
    data = scanProject(dir);
  }
  data = { ...data, baseUrl, running, scannedAt: Date.now() };
  routeCache.set(key, { at: Date.now(), data });
  return data;
}
setInterval(() => broadcast('ping', Date.now()), 25000).unref();

// ---------- helpers ----------
class HttpError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; } }
const need = (v, msg = 'Not found') => { if (!v) throw new HttpError(404, msg); return v; };

function send(res, status, body) {
  const data = JSON.stringify(body ?? {});
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 2 * 1024 * 1024) throw new HttpError(413, 'Request too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
}

const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
// This server can run commands, so only answer pages served by itself (blocks DNS rebinding and cross-site requests).
function guard(req) {
  if (!ALLOWED_HOSTS.has(String(req.headers.host || '').toLowerCase())) throw new HttpError(403, 'Forbidden host');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin && origin !== 'null' && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, '').toLowerCase())) throw new HttpError(403, 'Forbidden origin');
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'JSON only');
  }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

// MC Dev Hub's own folder (the repository this server runs from). As an environment it gets no launchers:
// starting another copy of the hub from inside itself would fight the running one for its port and data.
const HUB_ROOT = path.resolve(here, '..');
const norm = (p) => { const r = path.resolve(String(p || '')); return process.platform === 'win32' ? r.toLowerCase() : r; };
const isHubFolder = (p) => { const a = norm(p); const b = norm(HUB_ROOT); return a === b || a.startsWith(b + path.sep); };
const SELF_MSG = 'This environment is MC Dev Hub\'s own folder. It can\'t have launchers: MC Dev Hub is already running. Use CLI tabs, Terminal and Git here.';
function notSelf(env) { if (isHubFolder(env.path)) throw new HttpError(400, SELF_MSG); return env; }

function envView(env) {
  return { ...env, pathInfo: sys.pathInfo(env.path), isSelf: isHubFolder(env.path) };
}

function stateView() {
  return {
    version: VERSION,
    platform: process.platform,
    home: os.homedir(),
    port: PORT,
    dataFile: store.file,
    settings: store.state.settings,
    terminals: sys.terminalChoices(),
    environments: store.state.environments.map(envView),
    statuses: procs.snapshot(),
    clis: clis.list(),
    netHooks: Object.fromEntries(store.state.environments.flatMap((e) => e.launchers.map((l) => [l.id, netmon.hookCount(l.id)]))),
    cliShells: sys.cliShells(),
  };
}

async function startLauncher(env, l, force) {
  notSelf(env);
  if (!procs.isActive(l.id) && l.port && !force && (await sys.isPortOpen(l.port))) {
    const owner = await sys.portOwner(l.port);
    throw new HttpError(409, `Port ${l.port} is already in use${owner ? ` by ${owner.name || 'a process'} (PID ${owner.pid})` : ''}.`, { code: 'PORT_IN_USE', port: l.port, owner });
  }
  return procs.start(env, l);
}

// ---------- routes ----------
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

route('GET', '/api/health', () => ({ ok: true, app: 'mc-dev-hub', version: VERSION, pid: process.pid, port: PORT }));
route('GET', '/api/state', () => stateView());

route('POST', '/api/settings', async ({ body }) => {
  if (body.aiEnabled) { const c = await claudeStatus(); if (!(c.installed && c.loggedIn)) body.aiEnabled = false; } // needs a signed-in Claude Code
  return store.updateSettings(body);
});

route('POST', '/api/envs', ({ body }) => {
  if (!String(body.path || '').trim()) throw new HttpError(400, 'Choose a folder for this environment');
  return envView(store.addEnv(body));
});
route('PUT', '/api/envs/:id', ({ p, body }) => envView(need(store.updateEnv(p.id, body))));
route('DELETE', '/api/envs/:id', async ({ p }) => {
  const env = need(store.findEnv(p.id));
  await Promise.all(env.launchers.map((l) => procs.stop(l.id)));
  await clis.closeWhere((s) => s.envId === p.id);
  store.removeEnv(p.id);
  return { ok: true };
});
route('POST', '/api/envs/order', ({ body }) => { store.reorderEnvs(Array.isArray(body.ids) ? body.ids.map(String) : []); return { ok: true }; });
route('POST', '/api/envs/:id/move', ({ p, body }) => { store.moveEnv(p.id, body.dir); return { ok: true }; });

route('POST', '/api/envs/:id/launchers', ({ p, body }) => { notSelf(need(store.findEnv(p.id))); return need(store.addLauncher(p.id, body)); });
route('POST', '/api/envs/:id/launchers/bulk', ({ p, body }) => {
  notSelf(need(store.findEnv(p.id)));
  return (body.launchers || []).map((l) => store.addLauncher(p.id, l));
});
route('PUT', '/api/envs/:id/launchers/:lid', ({ p, body }) => need(store.updateLauncher(p.id, p.lid, body)));
route('DELETE', '/api/envs/:id/launchers/:lid', async ({ p }) => {
  await procs.stop(p.lid);
  await clis.closeWhere((s) => s.launcherId === p.lid);
  store.removeLauncher(p.id, p.lid);
  return { ok: true };
});
route('POST', '/api/envs/:id/launchers/:lid/move', ({ p, body }) => { store.moveLauncher(p.id, p.lid, body.dir); return { ok: true }; });

route('POST', '/api/envs/:id/start-all', async ({ p }) => {
  const env = notSelf(need(store.findEnv(p.id)));
  const results = [];
  for (const l of env.launchers) {
    try { results.push({ id: l.id, ok: true, info: await startLauncher(env, l, false) }); }
    catch (e) { results.push({ id: l.id, ok: false, error: e.message, ...(e.extra || {}) }); }
  }
  return { results };
});
route('POST', '/api/envs/:id/stop-all', async ({ p }) => {
  const env = need(store.findEnv(p.id));
  await Promise.all(env.launchers.map((l) => procs.stop(l.id)));
  return { ok: true };
});

route('POST', '/api/envs/:id/open', async ({ p, body }) => {
  const env = need(store.findEnv(p.id));
  let dir = env.path;
  if (body.launcherId) {
    const l = need(env.launchers.find((x) => x.id === body.launcherId));
    dir = launcherDir(env, l);
  }
  const s = store.state.settings;
  if (body.what === 'terminal') await sys.openTerminal(dir, s.terminal);
  else if (body.what === 'folder') await sys.openFolder(dir);
  else if (body.what === 'editor') await sys.openEditor(dir, s.editor);
  else throw new HttpError(400, 'Unknown target');
  return { ok: true };
});

const launcherOf = (lid) => need(store.findLauncher(lid), 'Launcher not found');
route('POST', '/api/launchers/:lid/start', async ({ p, body }) => {
  const { env, launcher } = launcherOf(p.lid);
  return startLauncher(env, launcher, !!body.force);
});
route('POST', '/api/launchers/:lid/stop', async ({ p }) => { await procs.stop(p.lid); return procs.info(p.lid); });
route('POST', '/api/launchers/:lid/restart', async ({ p }) => {
  const { env, launcher } = launcherOf(p.lid);
  await procs.stop(p.lid);
  return startLauncher(env, launcher, true);
});
route('POST', '/api/launchers/:lid/input', ({ p, body }) => { procs.write(p.lid, String(body.text ?? '')); return { ok: true }; });
route('GET', '/api/launchers/:lid/logs', ({ p }) => procs.logs(p.lid));
route('POST', '/api/launchers/:lid/clear', ({ p }) => { procs.clearLogs(p.lid); return { ok: true }; });

route('GET', '/api/envs/:id/git', async ({ p }) => {
  const env = need(store.findEnv(p.id));
  if (!sys.pathInfo(env.path).isDir) return { isRepo: false, folderMissing: true };
  return git.info(env.path);
});
route('POST', '/api/envs/:id/git', async ({ p, body }) => {
  const env = need(store.findEnv(p.id));
  if (body.action === 'switch') {
    // switching swaps the files under running dev servers: they'd reload half-way, or keep serving the old branch
    const running = env.launchers.filter((l) => procs.isActive(l.id));
    if (running.length) throw new HttpError(409, `Stop the running launcher${running.length > 1 ? 's' : ''} first (${running.map((l) => l.name).join(', ')}), then switch branch.`, { code: 'LAUNCHERS_RUNNING' });
  }
  return git.action(env.path, body);
});

route('GET', '/api/detect', ({ q }) => detect(q.get('path') || ''));
route('GET', '/api/path-info', ({ q }) => sys.pathInfo(q.get('path') || ''));
route('POST', '/api/pick-folder', async ({ body }) => ({ path: await sys.pickFolder(body.initial || '') }));
route('POST', '/api/open-url', async ({ body }) => { await sys.openUrl(String(body.url || '')); return { ok: true }; });

route('GET', '/api/launchers/:lid/routes', async ({ p, q }) => {
  const { env, launcher } = launcherOf(p.lid);
  return launcherRoutes(env, launcher, q.get('refresh') === '1', q.get('source') === 'code' ? 'code' : 'auto');
});
route('POST', '/api/http', ({ body }) => proxyRequest(body));
route('POST', '/api/http/cookies/clear', ({ body }) => {
  try { cookieJar.delete(new URL(String(body.url)).origin); } catch { cookieJar.clear(); }
  return { ok: true };
});

route('GET', '/api/port/:port', async ({ p }) => ({ port: +p.port, open: await sys.isPortOpen(+p.port), owner: await sys.portOwner(+p.port) }));
route('POST', '/api/port/:port/kill', async ({ p }) => {
  const owner = await sys.portOwner(+p.port);
  if (!owner) return { ok: true, killed: null };
  if (owner.pid === process.pid) throw new HttpError(400, 'That port belongs to the launcher itself');
  await sys.killTree(owner.pid);
  return { ok: true, killed: owner };
});

// ---------- CLI tabs ----------
const cliOf = (cid) => need(clis.get(cid), 'This CLI was closed');
route('POST', '/api/launchers/:lid/clis', ({ p, body }) => {
  const { env, launcher } = launcherOf(p.lid);
  const shells = sys.cliShells();
  const want = body.shell || store.state.settings.cliShell;
  const shell = shells.find((s) => s.id === want)?.id || shells[0].id;
  return clis.create(env, launcher, shell);
});
route('POST', '/api/envs/:id/clis', ({ body, p }) => {
  const env = need(store.findEnv(p.id));
  const shells = sys.cliShells();
  const want = body.shell || store.state.settings.cliShell;
  const shell = shells.find((s) => s.id === want)?.id || shells[0].id;
  return clis.create(env, null, shell);
});
route('GET', '/api/clis/:cid/logs', ({ p }) => { cliOf(p.cid); return clis.logs(p.cid); });
route('POST', '/api/clis/:cid/run', ({ p, body }) => { cliOf(p.cid); return clis.run(p.cid, String(body.text ?? '')); });
route('POST', '/api/clis/:cid/stop', async ({ p }) => { cliOf(p.cid); return clis.stop(p.cid); });
route('POST', '/api/clis/:cid/clear', ({ p }) => { cliOf(p.cid); clis.clear(p.cid); return { ok: true }; });
route('DELETE', '/api/clis/:cid', async ({ p }) => { await clis.close(p.cid); return { ok: true }; });
route('POST', '/api/clis/:cid/terminal', async ({ p }) => { await sys.openTerminal(cliOf(p.cid).cwd, store.state.settings.terminal); return { ok: true }; });

// ---------- network monitor ----------
route('GET', '/api/envs/:id/net', ({ p, q }) => { need(store.findEnv(p.id)); return { entries: netmon.list(p.id, Number(q.get('since')) || 0) }; });
route('GET', '/api/net/:n', ({ p }) => need(netmon.get(p.n), 'That entry is no longer kept'));
route('POST', '/api/envs/:id/net/clear', ({ p, body }) => { need(store.findEnv(p.id)); netmon.clear(p.id, body.launcherId || null); return { ok: true }; });
route('POST', '/api/launchers/:lid/monitor', ({ p, body }) => {
  const { env } = launcherOf(p.lid);
  return need(store.updateLauncher(env.id, p.lid, { monitor: !!body.on }));
});
// from the desktop app's site windows
route('POST', '/api/net/browser', ({ body }) => netmon.ingestBrowser(body));

// ---------- AI in the Git tab (Claude Code) ----------
// AI stays on only while Claude Code is signed in: signing out (here or elsewhere) turns it off.
async function aiStatus(refresh = false) {
  const claude = await claudeStatus(refresh);
  if (store.state.settings.aiEnabled && !(claude.installed && claude.loggedIn)) store.updateSettings({ aiEnabled: false });
  return { enabled: !!store.state.settings.aiEnabled, model: store.state.settings.aiModel || DEFAULT_AI_MODEL, models: AI_MODELS, claude };
}
route('GET', '/api/ai/status', ({ q }) => aiStatus(q.get('refresh') === '1'));
route('POST', '/api/ai/sign-out', async () => {
  try { await signOut(); } catch (e) { throw new HttpError(e.status || 500, e.message); }
  store.updateSettings({ aiEnabled: false });
  return aiStatus();
});
route('GET', '/api/envs/:id/ai', ({ p }) => { need(store.findEnv(p.id)); return { job: aiJobs.current(p.id) }; });
// AI jobs: commit-message writes a message into the box; branch-name suggests a name the person confirms before it's created
for (const [kind, method] of [['commit-message', 'commitMessage'], ['branch-name', 'branchName']]) {
  route('POST', `/api/envs/:id/ai/${kind}`, async ({ p }) => {
    const env = need(store.findEnv(p.id));
    if (!store.state.settings.aiEnabled) throw new HttpError(400, 'AI in the Git tab is turned off. Turn it on in Settings.', { code: 'AI_OFF' });
    try { return await aiJobs[method](env, store.state.settings.aiModel || DEFAULT_AI_MODEL); }
    catch (e) { throw new HttpError(e.status || 500, e.message, e.code ? { code: e.code } : undefined); }
  });
}
route('POST', '/api/ai/sign-in', async ({ body }) => {
  try { return await openSignIn(String(body.shell || '')); }
  catch (e) { throw new HttpError(e.status || 500, e.message); }
});
route('POST', '/api/ai/jobs/:jid/cancel', async ({ p }) => { await aiJobs.cancel(p.jid); return { ok: true }; });

// ---------- API tab: the running app's bearer token, from Network monitor captures only ----------
route('GET', '/api/launchers/:lid/token', ({ p }) => {
  const { env, launcher } = launcherOf(p.lid);
  return netmon.tokenFor(env, launcher);
});

// ---------- API tab: Custom request collection per launcher ----------
route('GET', '/api/launchers/:lid/requests', ({ p }) => { launcherOf(p.lid); return { requests: store.requests(p.lid) }; });
route('POST', '/api/launchers/:lid/requests', ({ p, body }) => { launcherOf(p.lid); return store.saveRequest(p.lid, { ...body, id: undefined }); });
route('PUT', '/api/launchers/:lid/requests/:rid', ({ p, body }) => {
  launcherOf(p.lid);
  if (!store.requests(p.lid).some((r) => r.id === p.rid)) throw new HttpError(404, 'That saved request no longer exists');
  return store.saveRequest(p.lid, { ...body, id: p.rid });
});
route('DELETE', '/api/launchers/:lid/requests/:rid', ({ p }) => { launcherOf(p.lid); store.deleteRequest(p.lid, p.rid); return { ok: true }; });

// Launchers whose processes don't load the hook (not Node): list their TCP connections every few seconds.
let connBusy = false;
setInterval(async () => {
  if (connBusy) return;
  const targets = [];
  for (const env of store.state.environments) {
    for (const l of env.launchers) {
      const s = procs.info(l.id);
      if (!s.monitored || !s.pid || !['running', 'ready'].includes(s.status)) continue;
      if (netmon.hookCount(l.id) || Date.now() - (s.startedAt || 0) < 6000) continue; // Node: the hook covers it
      targets.push(s);
    }
  }
  if (!targets.length) return;
  connBusy = true;
  try {
    const [table, conns, listen] = await Promise.all([processTable(), establishedConnections(), listeningSockets()]);
    const kids = new Map();
    for (const p of table) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p.pid); }
    for (const s of targets) {
      const tree = new Set([s.pid]);
      const stack = [s.pid];
      while (stack.length) for (const k of kids.get(stack.pop()) || []) if (!tree.has(k)) { tree.add(k); stack.push(k); }
      const ownPorts = new Set();
      for (const pid of tree) for (const x of listen.get(pid) || []) ownPorts.add(x.port);
      // outgoing only: connections to the launcher's own listening ports are visitors, not calls it makes
      netmon.syncConnections(s.id, conns.filter((c) => tree.has(c.pid) && !ownPorts.has(c.localPort) && c.remotePort !== PORT));
    }
  } catch { /* try again next round */ }
  connBusy = false;
}, 5000).unref();

// ---------- running instances (this launcher's + other sources) ----------
route('GET', '/api/instances', ({ q }) => instances.scan(q.get('refresh') === '1'));
route('POST', '/api/instances/own/stop-all', async () => { await Promise.all([procs.stopAll(), clis.stopAll()]); instances.invalidate(); return { ok: true }; });
route('POST', '/api/instances/other/stop-all', () => instances.stopAllOther());
route('POST', '/api/instances/other/remove-stopped', () => instances.removeAllStopped());
route('POST', '/api/instances/other/:key/stop', ({ p }) => instances.stopOther(p.key));
route('DELETE', '/api/instances/other/:key', ({ p }) => instances.removeStopped(p.key));

route('POST', '/api/shutdown', ({ res }) => {
  res.on('finish', () => shutdown('requested by app'));
  return { ok: true };
});

// ---------- http server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    guard(req);
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`event: hello\ndata: ${JSON.stringify({ pid: process.pid })}\n\n`);
      clients.set(res, { webview: url.searchParams.get('client') === 'webview' });
      req.on('close', () => clients.delete(res));
      return;
    }
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      const body = req.method === 'GET' ? {} : await readBody(req);
      const p = Object.fromEntries(Object.entries(m.groups || {}).map(([k, v]) => [k, decodeURIComponent(v)]));
      const out = await r.fn({ req, res, p, q: url.searchParams, body });
      return send(res, 200, out);
    }
    throw new HttpError(404, 'Unknown endpoint');
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    if (!res.headersSent) send(res, status, { error: err.message, ...(err.extra || {}) });
  }
});

let shuttingDown = false;
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Shutting down (${reason}), stopping launchers…`);
  const force = setTimeout(() => process.exit(0), 10000);
  try { await Promise.all([procs.stopAll(), clis.stopAll()]); } catch { /* best effort */ }
  clearTimeout(force);
  for (const c of clients.keys()) c.end();
  server.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP', () => shutdown('SIGHUP'));
if (process.env.MCDH_WATCH_STDIN === '1') {
  // The desktop app keeps our stdin open. If the app dies, the pipe closes and we clean up.
  process.stdin.on('end', () => shutdown('parent app exited'));
  process.stdin.on('error', () => shutdown('parent app exited'));
  process.stdin.resume();
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Pick another port in the launcher app or run with --port <n>.`);
  else console.error(err);
  process.exit(2);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`MC Dev Hub ${VERSION} running at http://localhost:${PORT}`);
  console.log(`Data: ${store.file}`);
});
