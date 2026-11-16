'use strict';
/* API tab: Postman-like viewer for launchers marked as API.
 *   Detected: routes from GET /api/launchers/:id/routes (live OpenAPI or read from code). Method and path come
 *             from the code and are locked; path parameters, query, headers and body are yours to fill.
 *   Custom:   your saved requests (per launcher, on the server), fully editable. New ones come from
 *             "Save to Custom", "Paste cURL", "+ New" and the Network tab's "Replay".
 * Requests go through the server's proxy (POST /api/http). Uses app.js globals. */

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
// never stored in the Custom collection: the shared "Auth & headers" supply them when sending
const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|x-api-key|api-key|x-auth-token|x-access-token|x-csrf-token|x-xsrf-token)$/i;
// added by browsers/curl themselves; dropped when replaying a captured request
const NOISE_HEADER = /^(:.*|host|content-length|connection|keep-alive|transfer-encoding|te|upgrade|accept-encoding|priority|upgrade-insecure-requests|sec-fetch-.*|sec-ch-.*|sec-gpc|dnt|origin|referer|user-agent)$/i;
const apiLaunchers = () => (env()?.launchers || []).filter(isApiKind);
const apiLauncher = () => apiLaunchers().find((l) => l.id === S.api.lid) || apiLaunchers()[0] || null;
const routeKey = (r) => `${r.method} ${r.path}`;
const apiRoute = () => S.api.data?.routes.find((r) => routeKey(r) === S.api.sel) || null;
S.api.list = store.get('api.list', 'detected');
S.api.custom = { lid: null, items: [], loading: false };
S.api.csel = null; // custom request id, or 'scratch' for the unsaved one
S.api.scratch = null; // { method, url, headers, body, bodyMode, multipart, name, warnings }
S.api.tok = { lid: null, data: null }; // the running app's bearer token, from Network monitor captures

// Each route and each Custom request keeps its own last response (and the request that produced it) while this
// window is open; closing or reloading it clears them. S.api.resp / lastReq / sending read the selected one.
const respStore = new Map(); // `${lid}|d|${routeKey}` or `${lid}|c|${customId}` -> { resp, req, sending }
function respKey(list = S.api.list, sel = list === 'custom' ? S.api.csel : S.api.sel) {
  const l = apiLauncher();
  return l && sel ? `${l.id}|${list === 'custom' ? 'c' : 'd'}|${sel}` : '';
}
function respSlot(key = respKey()) {
  if (!respStore.has(key)) respStore.set(key, { resp: null, req: null, sending: false });
  return respStore.get(key);
}
for (const [prop, field] of [['resp', 'resp'], ['lastReq', 'req'], ['sending', 'sending']]) {
  Object.defineProperty(S.api, prop, { configurable: true, get: () => respSlot()[field], set: (v) => { respSlot()[field] = v; } });
}
/** A small status chip for list rows that have a kept response. */
function respChip(key) {
  const s = respStore.get(key);
  if (s?.sending) return '<span class="rchip pending" title="Sending…">…</span>';
  const r = s?.resp;
  if (!r) return '';
  if (r.error) return '<span class="rchip bad" title="Failed">✕</span>';
  const cls = r.status < 300 ? 'ok' : r.status < 400 ? 'redir' : r.status < 500 ? 'warn' : 'bad';
  return `<span class="rchip ${cls}" title="Last response: ${r.status} (kept until this window closes)">${r.status}</span>`;
}
S.api.reveal = false; // show secret header values

// ---------- the running app's token (Network monitor captures only) ----------
const maskToken = (t) => (t.length > 14 ? `${t.slice(0, 6)}…${t.slice(-4)}` : '••••••');
function sharedAuth(lid) { return apiSaved(lid).shared.find((x) => /^authorization$/i.test(x.k)); }
async function loadToken() {
  const l = apiLauncher();
  if (!l) return;
  try {
    const data = await api('GET', `/api/launchers/${l.id}/token`);
    if (apiLauncher()?.id !== l.id) return;
    const prev = S.api.tok.lid === l.id ? S.api.tok.data : undefined;
    S.api.tok = { lid: l.id, data, at: Date.now() };
    // Keep in sync: follow the app's newest token
    const cur = sharedAuth(l.id);
    if (apiSaved(l.id).syncToken && data.token && !(cur && cur.on && cur.v === 'Bearer ' + data.token)) useAppToken(data.token, true);
    else if (S.tab === 'api' && (prev?.token !== data.token || prev?.monitored !== data.monitored || prev?.candidates?.[0]?.seenAt !== data.candidates[0]?.seenAt)) renderRequest();
  } catch { /* the bar just stays as it was */ }
}
// At most one lookup in flight; a request for another while one runs is done right after (so bursts of traffic can't delay it).
let tokBusy = false;
let tokAgain = false;
async function refreshToken() {
  if (tokBusy) { tokAgain = true; return; }
  tokBusy = true;
  try { await loadToken(); } finally { tokBusy = false; }
  if (tokAgain) { tokAgain = false; setTimeout(refreshToken, 300); }
}
/** The server saw a bearer token (or a login response) in this environment's traffic: look right away. */
function apiTokenSeen(envId) {
  const l = apiLauncher();
  if (!l || env()?.id !== envId) return;
  if (S.tab !== 'api' && !apiSaved(l.id).syncToken) { S.api.tok.at = 0; return; } // looked up when the tab opens
  refreshToken();
}
function useAppToken(token, quiet) {
  const l = apiLauncher();
  const shared = apiSaved(l.id).shared;
  const cur = sharedAuth(l.id);
  if (cur) Object.assign(cur, { v: 'Bearer ' + token, on: true }); else shared.push({ k: 'Authorization', v: 'Bearer ' + token, on: true });
  persistApi(l.id);
  if (!quiet) toast('The app\'s token is now sent as Authorization: Bearer … with every request.');
  if (S.tab === 'api') renderApi();
}
function since2(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : `${Math.floor(s / 3600)} h ago`;
}
/** The bar above a request: the app's token (Use it / Keep in sync), or a hint when it's needed but not available. */
function tokenBarHtml(guarded) {
  const l = apiLauncher();
  const t = S.api.tok.lid === l.id ? S.api.tok.data : null;
  if (!t) return '';
  const sync = !!apiSaved(l.id).syncToken;
  const syncBox = `<label class="check tok-sync" title="Whenever the app sends a newer token, use it automatically"><input type="checkbox" data-tok-sync ${sync ? 'checked' : ''}> Keep in sync</label>`;
  if (!t.monitored) {
    return guarded ? `<div class="tok-bar hint-bar">🔑 To fill in the token automatically, turn on the <a href="#" data-goto-net>Network monitor</a> for the app that calls this API, restart it, and use the app.</div>` : '';
  }
  if (!t.token) {
    return guarded ? `<div class="tok-bar hint-bar">🔑 No token seen yet. Log in to the app while the Network monitor is on, then it shows up here.</div>` : '';
  }
  const c = t.candidates[0];
  const where = `seen ${since2(c.seenAt)} in <span class="mono">${h(c.method || '')} ${h(c.path || '')}</span> (${c.via === 'login' ? 'login response' : c.src === 'browser' ? 'browser' : 'server'})`;
  const cur = sharedAuth(l.id);
  const using = cur && cur.on && cur.v === 'Bearer ' + t.token;
  const others = t.candidates.length > 1
    ? `<select data-tok-pick title="Other tokens seen recently">${t.candidates.map((x, i) => `<option value="${i}">${h(maskToken(x.token))} · ${since2(x.seenAt)}</option>`).join('')}</select>` : '';
  return using
    ? `<div class="tok-bar ok-bar">✓ Using the app's token <span class="mono">${h(maskToken(t.token))}</span> · ${where}<span class="grow"></span>${syncBox}</div>`
    : `<div class="tok-bar">🔑 The app's token <span class="mono">${h(maskToken(t.token))}</span> · ${where}<span class="grow"></span>${others}
        <button type="button" class="primary small" data-tok-use>Use it</button>${syncBox}</div>`;
}

// ---------- per-launcher saved state (drafts of detected routes + shared headers), kept in this browser ----------
function apiSaved(lid) {
  if (!S.api.saved) S.api.saved = {};
  if (!S.api.saved[lid]) S.api.saved[lid] = store.get('api.' + lid, { drafts: {}, shared: [], baseUrl: '' });
  return S.api.saved[lid];
}
let saveTimer;
function persistApi(lid) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const s = apiSaved(lid);
    const keys = Object.keys(s.drafts);
    if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete s.drafts[k];
    store.set('api.' + lid, s);
  }, 300);
}

function draftFor(r) {
  const l = apiLauncher();
  const saved = apiSaved(l.id);
  const key = routeKey(r);
  if (!saved.drafts[key]) {
    saved.drafts[key] = {
      params: Object.fromEntries(r.params.map((p) => [p.name, ''])),
      query: r.query.map((q) => ({ k: q.name, v: '', on: false })),
      headers: r.headers.filter((x) => !/^authorization$/i.test(x)).map((x) => ({ k: x, v: '', on: false })),
      body: r.body && !r.body.multipart && r.body.example !== undefined ? JSON.stringify(r.body.example ?? {}, null, 2) : '',
      multipart: r.body?.multipart ? r.body.fields.map((f) => ({ name: f.name, kind: f.type === 'file' ? 'file' : 'text', value: '' })) : [],
    };
  }
  return saved.drafts[key];
}

function baseUrl() {
  const l = apiLauncher();
  return (apiSaved(l.id).baseUrl || S.api.data?.baseUrl || launcherUrl(l) || 'http://localhost').replace(/\/$/, '');
}

// Detected routes: the address is built from the route's path, the path parameters and the query rows.
function builtUrl(r, d) {
  const p = r.path.replace(/:(\w+)\*?\??|\{(\w+)\}/g, (m, a, b) => { const v = d.params[a || b]; return v ? encodeURIComponent(v) : m; });
  const qs = d.query.filter((q) => q.on && q.k).map((q) => `${encodeURIComponent(q.k)}=${encodeURIComponent(q.v)}`).join('&');
  return baseUrl() + p + (qs ? '?' + qs : '');
}
const detectedMethod = (r, d) => (r.anyMethod ? d.method || r.method : r.method);

// Custom requests keep an address on the launcher itself as a path ("/api/x"), so a new port doesn't break them.
const isLocalHost = (h) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(h);
function fullUrl(u) {
  u = String(u || '');
  return u.startsWith('/') ? baseUrl() + u : u;
}
function storedUrl(u) {
  u = String(u || '').trim();
  const m = u.match(/^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)(.*)$/i);
  if (!m) return u;
  try {
    const a = new URL(m[1]);
    const b = new URL(baseUrl());
    const samePort = (a.port || (a.protocol === 'https:' ? '443' : '80')) === (b.port || (b.protocol === 'https:' ? '443' : '80'));
    if (a.protocol === b.protocol && samePort && (a.hostname === b.hostname || (isLocalHost(a.hostname) && isLocalHost(b.hostname)))) {
      return m[2] || '/'; // the path as typed, placeholders included
    }
  } catch { /* not a full URL yet */ }
  return u;
}

// ---------- path parameters in Custom requests: /users/:id or /users/{id} ----------
const PARAM_SEG = /\/(?::(\w+)|\{(\w+)\})(?=[/?#]|$)/g;
function splitUrl(u) { // [origin, path, rest] without encoding anything (URL() would turn {id} into %7Bid%7D)
  const m = String(fullUrl(u)).match(/^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)?([^?#]*)(.*)$/i);
  return [m[1] || '', m[2] || '', m[3] || ''];
}
function pathParamNames(u) {
  const names = [];
  for (const m of splitUrl(u)[1].matchAll(PARAM_SEG)) { const n = m[1] || m[2]; if (!names.includes(n)) names.push(n); }
  return names;
}
function fillPath(u, params) {
  const [origin, path, rest] = splitUrl(u);
  return origin + path.replace(PARAM_SEG, (seg, a, b) => { const v = params?.[a || b]; return v ? '/' + encodeURIComponent(v) : seg; }) + rest;
}

// ---------- Custom collection (server) ----------
async function loadCustom(force) {
  const l = apiLauncher();
  if (!l || (!force && S.api.custom.lid === l.id)) return;
  S.api.custom = { lid: l.id, items: [], loading: true };
  try {
    const { requests } = await api('GET', `/api/launchers/${l.id}/requests`);
    if (apiLauncher()?.id !== l.id) return;
    S.api.custom.items = requests;
  } catch (e) { fail(e); }
  S.api.custom.loading = false;
  if (S.api.csel && S.api.csel !== 'scratch' && !customById(S.api.csel)) S.api.csel = null;
  if (S.tab === 'api') renderApi();
}
const customById = (id) => S.api.custom.items.find((c) => c.id === id) || null;
const currentCustom = () => (S.api.csel === 'scratch' ? S.api.scratch : customById(S.api.csel));

/** What gets stored: the address as a path when it's on this launcher, and no secret headers. */
function toStored(c) {
  const removed = [...new Set((c.headers || []).filter((x) => SECRET_HEADER.test(x.k)).map((x) => x.k))];
  return {
    payload: {
      name: c.name, method: c.method, url: storedUrl(fullUrl(c.url)), params: c.params || {}, headers: (c.headers || []).filter((x) => x.k && !SECRET_HEADER.test(x.k)),
      bodyMode: c.bodyMode, body: c.body || '', multipart: (c.multipart || []).map((p) => ({ name: p.name, kind: p.kind, value: p.kind === 'file' ? '' : p.value })),
    },
    removed,
  };
}
const customPersistTimers = new Map();
function persistCustom(c) {
  if (!c?.id) return; // the unsaved request lives only here
  const l = apiLauncher();
  clearTimeout(customPersistTimers.get(c.id));
  customPersistTimers.set(c.id, setTimeout(async () => {
    customPersistTimers.delete(c.id);
    try { await api('PUT', `/api/launchers/${l.id}/requests/${c.id}`, toStored(c).payload); } catch (e) { fail(e); }
  }, 500));
}
async function saveToCustom(c, { select = true } = {}) {
  const l = apiLauncher();
  const { payload, removed } = toStored(c);
  try {
    const saved = await api('POST', `/api/launchers/${l.id}/requests`, payload);
    // keep file picks and secret headers for this session; the server copy has neither
    const local = { ...saved, headers: (c.headers || []).map((x) => ({ ...x })), multipart: (c.multipart || []).map((p) => ({ ...p })), url: saved.url, params: { ...(c.params || {}) } };
    S.api.custom.items.push(local);
    if (select) { S.api.list = 'custom'; store.set('api.list', 'custom'); S.api.csel = local.id; }
    toast(removed.length ? `Saved to Custom. ${removed.join(', ')} ${removed.length > 1 ? 'were' : 'was'} left out; your shared Auth & headers are sent instead.` : 'Saved to Custom');
    return local;
  } catch (e) { fail(e); return null; }
}

/** A detected route that would handle this method + address, if any. */
function matchDetected(method, url) {
  const routes = S.api.data?.routes || [];
  let path;
  try { path = new URL(fullUrl(url)).pathname; } catch { return null; }
  const esc = (s) => s.replace(/[.+?^${}()|[\]\\*]/g, '\\$&');
  for (const r of routes) {
    if (r.method !== method && !r.anyMethod) continue;
    const pattern = r.path.split('/').map((seg) => {
      if (/^:\w+\*$/.test(seg) || seg === '*' || /^\[\.\.\.\w+\]$/.test(seg)) return '.+';
      if (/^:\w+\?$/.test(seg)) return '[^/]*';
      if (/^:\w+$/.test(seg) || /^\{\w+\}$/.test(seg) || /^\[\w+\]$/.test(seg)) return '[^/]+';
      return esc(seg);
    }).join('/');
    if (new RegExp(`^${pattern}/?$`).test(path)) return r;
  }
  return null;
}

/** Opens a request (from Paste cURL or the Network tab) as an unsaved Custom request. */
function openScratch(req, { name = '', warnings = [] } = {}) {
  S.api.scratch = {
    id: null, name: name || `${req.method} ${(() => { try { return new URL(req.url).pathname; } catch { return req.url; } })()}`,
    method: req.method || 'GET', url: storedUrl(req.url), headers: req.headers || [], body: req.body || '',
    bodyMode: req.bodyMode === 'multipart' ? 'multipart' : 'raw', multipart: req.multipart || [], warnings,
  };
  S.api.list = 'custom';
  store.set('api.list', 'custom');
  S.api.csel = 'scratch';
  S.api.resp = null;
  S.api.cpane = req.bodyMode === 'multipart' || req.body ? 'body' : 'params';
}

// ---------- loading ----------
function apiEnvChanged() {
  const l = apiLauncher();
  if (!l) { S.api.data = null; S.api.dataFor = null; return; }
  if (S.api.dataFor !== l.id) { S.api.data = null; S.api.sel = null; loadRoutes(false); }
  if (S.api.custom.lid !== l.id) { S.api.csel = null; S.api.scratch = null; loadCustom(); }
}

async function loadRoutes(refresh, source) {
  const l = apiLauncher();
  if (!l) return;
  S.api.loading = true;
  S.api.error = null;
  if (S.tab === 'api') renderApi();
  try {
    const data = await api('GET', `/api/launchers/${l.id}/routes?refresh=${refresh ? 1 : 0}${source ? '&source=' + source : ''}`);
    if (apiLauncher()?.id !== l.id) return;
    S.api.data = data;
    S.api.dataFor = l.id;
    if (!S.api.sel || !data.routes.some((r) => routeKey(r) === S.api.sel)) S.api.sel = data.routes[0] ? routeKey(data.routes[0]) : null;
  } catch (e) {
    S.api.error = e.message;
  } finally {
    S.api.loading = false;
    renderTabs();
    if (S.tab === 'api') renderApi();
  }
}

// ---------- render ----------
function renderApi() {
  const list = apiLaunchers();
  const l = apiLauncher();
  if (!l) return;
  if (S.api.dataFor !== l.id && !S.api.loading) loadRoutes(false);
  if (S.api.custom.lid !== l.id && !S.api.custom.loading) loadCustom();
  if (S.api.tok.lid !== l.id) { S.api.tok = { lid: l.id, data: null, at: 0 }; refreshToken(); }
  else if (Date.now() - (S.api.tok.at || 0) > 3000) refreshToken(); // coming back to the tab: make sure it's current
  $('#apiLauncher').innerHTML = list.map((x) => `<option value="${x.id}" ${x.id === l.id ? 'selected' : ''}>${h(x.name)}${x.port ? ' :' + x.port : ''}</option>`).join('');
  $('#apiLauncher').hidden = list.length < 2;
  const d = S.api.data;
  const running = isActive(l.id) && statusOf(l.id).key === 'ready' || d?.running;
  $('#apiStart').hidden = isActive(l.id) || !!d?.running;
  $('#apiSource').innerHTML = S.api.loading ? 'Reading routes…'
    : S.api.error ? `<span style="color:var(--danger)">${h(S.api.error)}</span>`
    : d ? (d.source === 'openapi'
      ? `<b>${d.routes.length}</b> routes from the API's OpenAPI document <span class="mono">${h(d.specUrl)}</span> · <a href="#" data-src="code">read from code instead</a>`
      : `<b>${d.routes.length}</b> routes found in the code (${d.filesScanned} files)${running ? '' : ' · start the API to send requests'}`)
    : '';
  const shared = apiSaved(l.id).shared.filter((x) => x.on && x.k).length;
  $('#apiAuthCount').textContent = shared || '';
  $$('#apiLists button').forEach((b) => b.classList.toggle('active', b.dataset.list === S.api.list));
  $('#apiCountDetected').textContent = d ? d.routes.length : '';
  $('#apiCountCustom').textContent = S.api.custom.items.length + (S.api.scratch ? 1 : 0);
  $('#apiFilter').placeholder = S.api.list === 'custom' ? 'Filter saved requests…' : 'Filter routes…';
  renderRouteList();
  renderRequest();
}

function routeGroups(routes) {
  // group by the first two path segments after the prefix all routes share (e.g. /v1)
  const segs = routes.map((r) => r.path.split('/').filter(Boolean));
  let common = 0;
  if (segs.length > 1) while (segs.every((s) => s[common] && !s[common].startsWith(':') && s[common] === segs[0][common])) common++;
  const groups = new Map();
  for (const r of routes) {
    const s = r.path.split('/').filter(Boolean);
    const g = [];
    for (let i = common; i < s.length && g.length < 2 && !/^[:{[]/.test(s[i]); i++) g.push(s[i]);
    const key = g.join('/') || '/';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return { prefix: segs[0] ? '/' + segs[0].slice(0, common).join('/') : '', groups };
}

const methodBadge = (m) => `<span class="m ${h(m)}">${m === 'DELETE' ? 'DEL' : h(m)}</span>`;

function renderRouteList() {
  if (S.api.list === 'custom') return renderCustomList();
  const box = $('#apiRouteList');
  const d = S.api.data;
  if (!d) { box.innerHTML = `<div class="muted small-text" style="padding:10px">${S.api.loading ? 'Reading routes…' : ''}</div>`; return; }
  if (!d.routes.length) {
    box.innerHTML = `<div class="muted small-text" style="padding:10px">No routes found. Supported: Express, Fastify, Hono, Koa, NestJS, Next.js route handlers, or an OpenAPI document served by the running API (e.g. <code>/openapi.json</code>). Use the <b>Custom</b> list for any other request.</div>`;
    return;
  }
  const q = $('#apiFilter').value.trim().toLowerCase();
  const routes = d.routes.filter((r) => !q || (r.method + ' ' + r.path + ' ' + (r.summary || '')).toLowerCase().includes(q));
  const { prefix, groups } = routeGroups(routes);
  box.innerHTML = (prefix && prefix !== '/' ? `<div class="route-prefix mono">${h(prefix)}</div>` : '') + [...groups].map(([g, rs]) => `
    <div class="route-group">${h(g)}</div>
    ${rs.map((r) => `<div class="route ${routeKey(r) === S.api.sel ? 'active' : ''}${r.unmounted ? ' unmounted' : ''}" data-key="${h(routeKey(r))}" title="${h(r.summary || r.path)}${r.unmounted ? ' (mount prefix unknown)' : ''}">
      ${methodBadge(r.anyMethod ? 'ANY' : r.method)}
      <span class="p mono">${h(r.path.slice(prefix.length) || '/')}</span>
      ${r.guards?.length ? '<span class="lock" title="' + h(r.guards.join(', ')) + '">🔒</span>' : ''}
      ${respChip(respKey('detected', routeKey(r)))}
    </div>`).join('')}`).join('');
}

function renderCustomList() {
  const box = $('#apiRouteList');
  const q = $('#apiFilter').value.trim().toLowerCase();
  const pathOf = (c) => { const [, path, rest] = splitUrl(c.url); return (path || '/') + rest; };
  const row = (c, id, extra = '') => `<div class="route custom ${S.api.csel === id ? 'active' : ''}${extra}" data-cid="${h(id)}" title="${h(fullUrl(c.url))}">
      ${methodBadge(c.method)}
      <span class="p"><span class="cname">${h(c.name)}</span><span class="cpath mono">${h(pathOf(c))}</span></span>
      ${respChip(respKey('custom', id))}
    </div>`;
  const items = S.api.custom.items.filter((c) => !q || `${c.method} ${c.name} ${c.url}`.toLowerCase().includes(q));
  let html = '';
  if (S.api.scratch) html += `<div class="route-group">Not saved</div>${row(S.api.scratch, 'scratch', ' scratch')}`;
  if (S.api.custom.loading) html += '<div class="muted small-text" style="padding:10px">Loading…</div>';
  else if (items.length) html += `<div class="route-group">Saved</div>${items.map((c) => row(c, c.id)).join('')}`;
  else if (!S.api.scratch) {
    html += `<div class="muted small-text custom-empty">No saved requests yet.<br><br>
      <b>Save to Custom</b> on a detected route, <b>⧉ Paste cURL</b>, <b>＋ New</b>, or <b>↻ Replay</b> a request from the Network tab.</div>`;
  }
  box.innerHTML = html;
}

function kvRows(rows, kind, { secretNote = false } = {}) {
  return rows.map((x, i) => `<div class="kv-row" data-kind="${kind}" data-i="${i}">
      <input type="checkbox" data-f="on" ${x.on ? 'checked' : ''}>
      <input data-f="k" value="${h(x.k)}" placeholder="name" spellcheck="false">
      ${SECRET_HEADER.test(x.k.trim())
        ? `<span class="secret-wrap"><input data-f="v" type="${S.api.reveal ? 'text' : 'password'}" value="${h(x.v)}" placeholder="value" spellcheck="false" autocomplete="off"><button type="button" class="plain small" data-reveal title="${S.api.reveal ? 'Hide' : 'Show'} secret values">${S.api.reveal ? '🙈' : '👁'}</button></span>`
        : `<input data-f="v" value="${h(x.v)}" placeholder="value" spellcheck="false">`}
      <button type="button" class="plain small" data-del="${kind}" title="Remove">✕</button>
      ${secretNote && SECRET_HEADER.test(x.k) ? '<span class="kv-note">Not saved. Kept for this session; use Auth &amp; headers to keep it.</span>' : ''}
    </div>`).join('');
}

function multipartRows(list) {
  return `<div class="pane-title">Form data (multipart)</div>
    ${list.map((p, i) => `<div class="kv-row mp" data-i="${i}">
        <input data-mp="name" value="${h(p.name)}" placeholder="name">
        <select data-mp="kind"><option value="text" ${p.kind === 'text' ? 'selected' : ''}>Text</option><option value="file" ${p.kind === 'file' ? 'selected' : ''}>File</option></select>
        ${p.kind === 'file' ? `<input type="file" data-mp="file"><span class="small-text muted">${h(p.fileName || '')}</span>` : `<input data-mp="value" value="${h(p.value)}" placeholder="value">`}
        <button type="button" class="plain small" data-mp-del="${i}">✕</button></div>`).join('')}
    <button type="button" class="plain small" data-mp-add>+ Field</button>`;
}

function renderRequest() {
  if (S.api.list === 'custom') return renderCustomRequest();
  const main = $('#apiMain');
  const l = apiLauncher();
  const r = apiRoute();
  if (!r) {
    main.innerHTML = `<div class="empty"><h2>API viewer</h2><p>Pick a route on the left. Its path parameters, query, headers and body are pre-filled from the code.</p></div>`;
    return;
  }
  const d = draftFor(r);
  const pane = S.api.pane;
  const method = detectedMethod(r, d);
  const bodyAllowed = !['GET', 'HEAD'].includes(method);
  const where = r.file ? `<span class="mono">${h(r.file)}:${r.line}</span>` : r.summary ? h(r.summary) : '';
  const guards = r.guards?.length ? `<span class="chip warn">🔒 ${h(r.guards.join(', '))}</span>` : '';
  const shared = apiSaved(l.id).shared.filter((x) => x.on && x.k);
  const needsAuth = r.guards?.length && !shared.some((x) => /^authorization$/i.test(x.k));

  let paneHtml = '';
  if (pane === 'params') {
    paneHtml = `
      ${r.params.length ? `<div class="pane-title">Path</div>${r.params.map((p) => `<label class="kv-row single"><span class="mono">:${h(p.name)}</span><input data-param="${h(p.name)}" value="${h(d.params[p.name] || '')}" placeholder="${h(p.name)}" spellcheck="false"></label>`).join('')}` : ''}
      <div class="pane-title">Query <button type="button" class="plain small" data-add="query">+ Add</button></div>
      ${d.query.length ? kvRows(d.query, 'query') : '<p class="hint">No query parameters detected.</p>'}`;
  } else if (pane === 'headers') {
    paneHtml = `
      <div class="pane-title">Headers for this request <button type="button" class="plain small" data-add="headers">+ Add</button></div>
      ${d.headers.length ? kvRows(d.headers, 'headers') : '<p class="hint">None. Shared headers (Auth) are added automatically.</p>'}
      <p class="hint">Shared for every request: ${shared.length ? shared.map((x) => `<code>${h(x.k)}</code>`).join(' ') : 'none'} · <a href="#" data-open-auth>edit</a></p>`;
  } else if (pane === 'body') {
    if (!bodyAllowed) paneHtml = `<p class="hint">${method} requests have no body.</p>`;
    else if (r.body?.multipart) paneHtml = multipartRows(d.multipart);
    else {
      const fields = r.body?.fields || [];
      paneHtml = `
        <div class="pane-title">JSON ${r.body?.schemaName ? `<span class="muted small-text">from <span class="mono">${h(r.body.schemaName)}</span></span>` : ''}
          <span class="grow"></span><button type="button" class="plain small" data-body="format">Format</button><button type="button" class="plain small" data-body="reset">Reset to example</button></div>
        <textarea id="reqBody" class="code-area" spellcheck="false" placeholder="{ }">${h(d.body)}</textarea>
        ${fields.length ? `<details class="fields" ${fields.length <= 12 ? 'open' : ''}><summary>Fields (${fields.length})</summary>
          <table>${fields.map((f) => `<tr><td class="mono">${h(f.name)}${f.optional ? '<span class="muted">?</span>' : ''}</td><td class="muted mono">${h(f.type)}</td></tr>`).join('')}</table></details>` : ''}`;
    }
  }

  // method and address come from the code: shown, not editable (routes that take any method keep a picker)
  const methodHtml = r.anyMethod
    ? `<select id="reqMethod" title="This route accepts any method">${METHODS.map((m) => `<option ${m === method ? 'selected' : ''}>${m}</option>`).join('')}</select>`
    : `<span class="req-method-locked ${h(method)}" title="The method comes from the code">${h(method)}</span>`;
  main.innerHTML = `
    <form class="req-line" id="reqForm">
      ${methodHtml}
      <div id="reqUrl" class="url-locked mono" title="The address comes from the code. Fill in path parameters and the query below; to change it freely, use Save to Custom.">${h(builtUrl(r, d))}</div>
      <button class="primary" id="reqSend" ${S.api.sending ? 'disabled' : ''}>${S.api.sending ? 'Sending…' : 'Send'}</button>
    </form>
    <div class="req-meta">${guards} ${where}<span class="grow"></span>
      <button type="button" class="ghost small" data-save-custom title="Copy this request into your Custom list, where the method and address can be changed">＋ Save to Custom</button></div>
    ${tokenBarHtml(!!r.guards?.length)}
    ${needsAuth && !(S.api.tok.data?.token) ? `<div class="warn-box small-text">This route is behind <b>${h(r.guards.join(', '))}</b>. Call the login route, then press <b>Use token</b> on its response, or set an Authorization header under <a href="#" data-open-auth>Auth &amp; headers</a>.</div>` : ''}
    <nav class="tabs small">
      <button type="button" data-pane="params" class="${pane === 'params' ? 'active' : ''}">Params${r.params.length + d.query.filter((q) => q.on).length ? ` <span class="count">${r.params.length + d.query.filter((q) => q.on).length}</span>` : ''}</button>
      <button type="button" data-pane="body" class="${pane === 'body' ? 'active' : ''}" ${bodyAllowed ? '' : 'disabled'}>Body${r.body ? ' <span class="count">●</span>' : ''}</button>
      <button type="button" data-pane="headers" class="${pane === 'headers' ? 'active' : ''}">Headers${d.headers.filter((x) => x.on).length + shared.length ? ` <span class="count">${d.headers.filter((x) => x.on).length + shared.length}</span>` : ''}</button>
    </nav>
    <div class="req-pane" style="${S.api.reqH ? `height:${S.api.reqH}px;max-height:none` : ''}">${paneHtml}</div>
    <div class="split-handle" data-split title="Drag to resize the request and response. Double-click to reset."></div>
    <div class="resp" id="resp">${respHtml()}</div>`;
  main.classList.toggle('resp-max', !!S.api.respMax);
}

// query rows of a custom request are read from (and written back to) its address
function urlQueryRows(u) {
  try { return [...new URL(fullUrl(u)).searchParams].map(([k, v]) => ({ k, v, on: true })); } catch { return []; }
}
function withQuery(u, rows) {
  const full = fullUrl(u);
  const i = full.indexOf('?');
  const base = i >= 0 ? full.slice(0, i) : full;
  const qs = rows.filter((q) => q.on && q.k).map((q) => `${encodeURIComponent(q.k)}=${encodeURIComponent(q.v)}`).join('&');
  return storedUrl(base + (qs ? '?' + qs : ''));
}

function renderCustomRequest() {
  const main = $('#apiMain');
  const l = apiLauncher();
  const c = currentCustom();
  if (!c) {
    main.innerHTML = `<div class="empty"><h2>Custom requests</h2><p>Your own requests for this API, saved with the launcher. Everything is editable here, including the method and address.</p>
      <div class="row" style="justify-content:center"><button class="ghost" data-c="new">＋ New request</button><button class="ghost" data-c="paste">⧉ Paste cURL</button></div></div>`;
    return;
  }
  const scratch = S.api.csel === 'scratch';
  const pane = S.api.cpane || 'params';
  const bodyAllowed = !['GET', 'HEAD'].includes(c.method);
  const shared = apiSaved(l.id).shared.filter((x) => x.on && x.k);
  if (!S.api.cquery || S.api.cquery.for !== c) S.api.cquery = { for: c, rows: urlQueryRows(c.url) };
  const qrows = S.api.cquery.rows;
  const match = matchDetected(c.method, c.url);
  c.params = c.params || {};
  const pnames = pathParamNames(c.url);
  let paneHtml = '';
  if (pane === 'params') {
    paneHtml = `${pnames.length ? `<div class="pane-title">Path</div>${pnames.map((n) => `<label class="kv-row single"><span class="mono">:${h(n)}</span><input data-cparam="${h(n)}" value="${h(c.params[n] || '')}" placeholder="${h(n)}" spellcheck="false"></label>`).join('')}
        <p class="hint">Sends to <span class="mono" id="cSendsTo">${h(fillPath(c.url, c.params))}</span></p>`
        : '<p class="hint">Tip: put <code>:id</code> or <code>{id}</code> in the address, e.g. <code>/users/:id</code>, to fill it in here.</p>'}
      <div class="pane-title">Query <button type="button" class="plain small" data-add="cquery">+ Add</button></div>
      ${qrows.length ? kvRows(qrows, 'cquery') : '<p class="hint">No query parameters. Add one, or type it in the address.</p>'}`;
  } else if (pane === 'headers') {
    paneHtml = `<div class="pane-title">Headers for this request <button type="button" class="plain small" data-add="cheaders">+ Add</button></div>
      ${c.headers.length ? kvRows(c.headers, 'cheaders', { secretNote: true }) : '<p class="hint">None. Shared headers (Auth) are added automatically.</p>'}
      <p class="hint">Shared for every request: ${shared.length ? shared.map((x) => `<code>${h(x.k)}</code>`).join(' ') : 'none'} · <a href="#" data-open-auth>edit</a>. Authorization and cookie headers are never saved with a Custom request.</p>`;
  } else if (!bodyAllowed) {
    paneHtml = `<p class="hint">${h(c.method)} requests have no body.</p>`;
  } else {
    paneHtml = `<div class="pane-title">
        <div class="seg"><button type="button" data-cbody="raw" class="${c.bodyMode !== 'multipart' ? 'active' : ''}">Raw / JSON</button><button type="button" data-cbody="multipart" class="${c.bodyMode === 'multipart' ? 'active' : ''}">Form data</button></div>
        <span class="grow"></span>${c.bodyMode !== 'multipart' ? '<button type="button" class="plain small" data-body="format">Format</button>' : ''}</div>
      ${c.bodyMode === 'multipart' ? multipartRows(c.multipart) : `<textarea id="reqBody" class="code-area" spellcheck="false" placeholder="{ }">${h(c.body)}</textarea>`}`;
  }
  const methods = METHODS.includes(c.method) ? METHODS : [c.method, ...METHODS];
  main.innerHTML = `
    <form class="req-line" id="reqForm">
      <select id="reqMethod">${methods.map((m) => `<option ${m === c.method ? 'selected' : ''}>${m}</option>`).join('')}</select>
      <input id="reqUrl" class="mono" value="${h(fullUrl(c.url))}" spellcheck="false" placeholder="${h(baseUrl())}/path">
      <button class="primary" id="reqSend" ${S.api.sending ? 'disabled' : ''}>${S.api.sending ? 'Sending…' : 'Send'}</button>
    </form>
    <div class="req-meta custom-meta">
      ${scratch ? '<span class="chip warn">Not saved</span>' : ''}
      <input id="reqName" class="req-name" value="${h(c.name)}" placeholder="Name" spellcheck="false" title="Name in the Custom list">
      <span class="grow"></span>
      ${scratch
        ? '<button type="button" class="primary small" data-c="save">＋ Save to Custom</button><button type="button" class="ghost small" data-c="discard">Discard</button>'
        : '<button type="button" class="ghost small" data-c="dup">Duplicate</button><button type="button" class="ghost small danger" data-c="del">Delete</button>'}
    </div>
    ${match ? `<div class="hint small-text">Matches the detected route <a href="#" data-c="goto" data-key="${h(routeKey(match))}">${h(match.method)} ${h(match.path)}</a>.</div>` : ''}
    ${scratch && c.warnings?.length ? `<div class="warn-box small-text">${c.warnings.map(h).join('<br>')}</div>` : ''}
    ${tokenBarHtml(false)}
    <nav class="tabs small">
      <button type="button" data-cpane="params" class="${pane === 'params' ? 'active' : ''}">Params${qrows.length + pnames.length ? ` <span class="count">${qrows.length + pnames.length}</span>` : ''}</button>
      <button type="button" data-cpane="body" class="${pane === 'body' ? 'active' : ''}" ${bodyAllowed ? '' : 'disabled'}>Body${(c.bodyMode === 'multipart' ? c.multipart.length : c.body) ? ' <span class="count">●</span>' : ''}</button>
      <button type="button" data-cpane="headers" class="${pane === 'headers' ? 'active' : ''}">Headers${c.headers.filter((x) => x.on).length + shared.length ? ` <span class="count">${c.headers.filter((x) => x.on).length + shared.length}</span>` : ''}</button>
    </nav>
    <div class="req-pane" style="${S.api.reqH ? `height:${S.api.reqH}px;max-height:none` : ''}">${paneHtml}</div>
    <div class="split-handle" data-split title="Drag to resize the request and response. Double-click to reset."></div>
    <div class="resp" id="resp">${respHtml()}</div>`;
  main.classList.toggle('resp-max', !!S.api.respMax);
}

function prettyJson(text) {
  let obj;
  try { obj = JSON.parse(text); } catch { return null; }
  const json = JSON.stringify(obj, null, 2);
  return h(json).replace(/(&quot;(?:\\.|[^&\\]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, (m, str, colon, lit, num) => {
    if (str) return colon ? `<span class="j-key">${str}</span>${colon}` : `<span class="j-str">${str}</span>`;
    if (lit) return `<span class="j-lit">${lit}</span>`;
    if (num) return `<span class="j-num">${num}</span>`;
    return m;
  });
}

function findToken(text) {
  try {
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
    return walk(JSON.parse(text), 0);
  } catch { return null; }
}

function fmtSize(n) { return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`; }

function respHtml() {
  const x = S.api.resp;
  if (S.api.sending) return '<div class="resp-empty muted">Sending…</div>';
  if (!x) return '<div class="resp-empty muted">Press <b>Send</b> (or Ctrl+Enter) to see the response here.</div>';
  if (x.error) {
    const l = apiLauncher();
    return `<div class="error" style="margin:10px">${h(x.error)}</div>${l && !isActive(l.id) ? `<div style="padding:0 10px"><button class="go small" data-start-api>▶ Start ${h(l.name)}</button></div>` : ''}`;
  }
  const cls = x.status < 300 ? 'ok' : x.status < 400 ? 'redir' : x.status < 500 ? 'warn' : 'bad';
  const token = x.body && findToken(x.body);
  let body;
  if (S.api.respPane === 'headers') body = `<table class="resp-headers">${x.headers.map(([k, v]) => `<tr><td class="mono">${h(k)}</td><td class="mono">${h(v)}</td></tr>`).join('')}</table>`;
  else if (x.base64 && /^image\//.test(x.contentType)) body = `<div style="padding:12px"><img alt="" style="max-width:100%" src="data:${h(x.contentType)};base64,${x.base64}"></div>`;
  else if (x.base64) body = `<p class="hint" style="padding:12px">Binary response (${h(x.contentType)}, ${fmtSize(x.size)}).</p>`;
  else body = bodyViewHtml(x.body, { empty: '(empty body)', truncated: !!x.truncated });
  return `
    <div class="resp-head">
      <span class="status ${cls}">${x.status} ${h(x.statusText || '')}</span>
      <span class="muted small-text">${x.ms} ms · ${fmtSize(x.size)}${x.truncated ? ' (truncated)' : ''}</span>
      <nav class="tabs small"><button type="button" data-rpane="body" class="${S.api.respPane === 'body' ? 'active' : ''}">Body</button><button type="button" data-rpane="headers" class="${S.api.respPane === 'headers' ? 'active' : ''}">Headers <span class="count">${x.headers.length}</span></button></nav>
      <span class="grow"></span>
      ${token ? `<button type="button" class="primary small" data-use-token title="Send it as Authorization: Bearer … on every request">🔑 Use token</button>` : ''}
      <button type="button" class="plain small" data-copy-resp>Copy</button>
      <button type="button" class="plain small" data-copy-curl>Copy cURL</button>
      <button type="button" class="plain small" data-resp-max title="${S.api.respMax ? 'Show the request again' : 'Give the response the whole height'}">${S.api.respMax ? '⤡ Restore' : '⤢ Expand'}</button>
    </div>
    ${body}`;
}

// ---------- send ----------
/** The request on screen, as the proxy wants it: { method, url, headers, body | multipart } (or a toast + null). */
function requestToSend() {
  const l = apiLauncher();
  const headers = {};
  for (const x of apiSaved(l.id).shared) if (x.on && x.k) headers[x.k] = x.v;
  const json = (text) => {
    try { JSON.parse(text); return true; } catch (e) {
      if (!/^\s*[{[]/.test(text)) return true; // not JSON: sent as-is
      toast('The body is not valid JSON: ' + e.message, true);
      return false;
    }
  };
  const parts = (list) => list.filter((p) => p.name).map((p) => (p.kind === 'file' ? { name: p.name, fileName: p.fileName, type: p.type, base64: p.base64 || '' } : { name: p.name, value: p.value }));
  if (S.api.list === 'custom') {
    const c = currentCustom();
    if (!c) return null;
    for (const x of c.headers) if (x.on && x.k) headers[x.k] = x.v;
    const missing = pathParamNames(c.url).filter((n) => !c.params?.[n]);
    if (missing.length) {
      S.api.cpane = 'params';
      renderRequest();
      toast(`Fill in ${missing.map((n) => ':' + n).join(', ')} first`, true);
      return null;
    }
    const req = { method: c.method, url: fillPath(c.url, c.params), headers };
    if (!['GET', 'HEAD'].includes(c.method)) {
      if (c.bodyMode === 'multipart') req.multipart = parts(c.multipart);
      else if (c.body?.trim()) {
        if (!json(c.body)) { S.api.cpane = 'body'; renderRequest(); return null; }
        req.body = c.body;
      }
    }
    return req;
  }
  const r = apiRoute();
  if (!r) return null;
  const d = draftFor(r);
  for (const x of d.headers) if (x.on && x.k) headers[x.k] = x.v;
  const method = detectedMethod(r, d);
  const req = { method, url: builtUrl(r, d), headers };
  if (!['GET', 'HEAD'].includes(method)) {
    if (r.body?.multipart) req.multipart = parts(d.multipart);
    else if (d.body.trim()) {
      if (!json(d.body)) { S.api.pane = 'body'; renderRequest(); return null; }
      req.body = d.body;
    }
  }
  return req;
}

async function sendRequest() {
  const slot = respSlot();
  if (slot.sending) return;
  const req = requestToSend();
  if (!req) return;
  slot.sending = true;
  slot.req = req;
  renderRequest();
  renderRouteList();
  try { slot.resp = await api('POST', '/api/http', req); }
  catch (e) { slot.resp = { error: e.message }; }
  finally { slot.sending = false; renderRequest(); renderRouteList(); }
}

function curlOf(req) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const parts = [`curl -X ${req.method} ${q(req.url)}`];
  for (const [k, v] of Object.entries(req.headers || {})) parts.push(`-H ${q(`${k}: ${v}`)}`);
  if (req.body) {
    if (!Object.keys(req.headers || {}).some((k) => /^content-type$/i.test(k))) parts.push(`-H 'Content-Type: application/json'`);
    parts.push(`--data-raw ${q(req.body)}`);
  }
  if (req.multipart) for (const p of req.multipart) parts.push(p.base64 != null ? `-F ${q(`${p.name}=@${p.fileName || 'file'}`)}` : `-F ${q(`${p.name}=${p.value}`)}`);
  return parts.join(' \\\n  ');
}

// launcher status changed (from the live event stream)
function apiStatusChanged(s) {
  const l = apiLauncher();
  if (!l || s.id !== l.id) return;
  $('#apiStart').hidden = isActive(l.id);
  // once the API answers, look again: it may serve an OpenAPI document, and "running" changes the hints
  if (s.status === 'ready' && S.api.data && !S.api.data.running) loadRoutes(true);
}

/** From the Network tab: open a captured request in the API tab, ready to send or save. */
function apiReplay(entry) {
  const e = env();
  const apis = apiLaunchers();
  if (!apis.length) return toast('Mark a launcher as API or Both (Edit launcher) to use the API tab.', true);
  let target = apis.find((l) => l.id === entry.lid) || null;
  try { // prefer the API the request was sent to
    const u = new URL(entry.url);
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    target = apis.find((l) => String(l.port) === port && isLocalHost(u.hostname)) || target;
  } catch { /* relative */ }
  target = target || apis[0];
  if (S.api.lid !== target.id || S.api.custom.lid !== target.id) {
    S.api.lid = target.id;
    store.set('apiLid', target.id);
    if (S.api.dataFor !== target.id) { S.api.data = null; S.api.sel = null; }
    loadCustom(true); // marks the collection as this launcher's right away, so the replay isn't cleared
  }
  const headers = Object.entries(entry.reqHeaders || {}).filter(([k]) => !NOISE_HEADER.test(k)).map(([k, v]) => ({ k, v: String(v), on: true }));
  const warnings = [];
  if (entry.reqBody?.truncated) warnings.push('The captured body was cut off, so it may be incomplete.');
  if (entry.reqBody?.binary) warnings.push('The captured body was binary and isn\'t included.');
  if (/multipart\/form-data/i.test(entry.reqHeaders?.['content-type'] || '')) warnings.push('This was a multipart form; its raw body is shown. Switch the body to Form data and pick the files to send it properly.');
  openScratch({ method: entry.method, url: entry.url, headers, body: entry.reqBody?.text || '' }, { name: `Replay: ${entry.method} ${entry.path || ''}`, warnings });
  showTab('api');
}

// ---------- events ----------
$('#apiLauncher').addEventListener('change', (ev) => {
  S.api.lid = ev.target.value;
  store.set('apiLid', S.api.lid);
  S.api.data = null; S.api.sel = null; S.api.scratch = null; S.api.csel = null;
  loadRoutes(false);
  loadCustom(true);
});
$('#apiRescan').addEventListener('click', () => loadRoutes(true));
$('#apiStart').addEventListener('click', () => { const l = apiLauncher(); if (l) startLauncher(l); });
$('#apiFilter').addEventListener('input', renderRouteList);
$('#apiSource').addEventListener('click', (ev) => {
  const a = ev.target.closest('[data-src]');
  if (a) { ev.preventDefault(); loadRoutes(true, a.dataset.src); }
});
$('#apiLists').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-list]');
  if (!b || S.api.list === b.dataset.list) return;
  S.api.list = b.dataset.list;
  store.set('api.list', S.api.list);
  if (S.api.list === 'custom' && !currentCustom()) S.api.csel = S.api.scratch ? 'scratch' : S.api.custom.items[0]?.id || null;
  renderApi();
});
$('#apiRouteList').addEventListener('click', (ev) => {
  const crow = ev.target.closest('.route[data-cid]');
  if (crow) {
    S.api.csel = crow.dataset.cid;
    renderRouteList();
    renderRequest();
    return;
  }
  const row = ev.target.closest('.route[data-key]');
  if (!row) return;
  S.api.sel = row.dataset.key;
  const r = apiRoute();
  S.api.pane = r && r.body && !['GET', 'HEAD'].includes(r.method) ? 'body' : 'params';
  renderRouteList();
  renderRequest();
});
$('#apiNewBtn').addEventListener('click', () => {
  openScratch({ method: 'GET', url: baseUrl() + '/', headers: [] }, { name: 'New request' });
  renderApi();
  $('#reqUrl')?.focus();
});

// Paste cURL
$('#apiCurlBtn').addEventListener('click', () => {
  $('#curlText').value = '';
  $('#curlError').hidden = true;
  $('#curlDialog').showModal();
  $('#curlText').focus();
});
$('#curlForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  try {
    const p = parseCurl($('#curlText').value);
    openScratch(p, { warnings: p.warnings });
    $('#curlDialog').close();
    renderApi();
  } catch (e) {
    $('#curlError').textContent = e.message;
    $('#curlError').hidden = false;
  }
});

const apiMain = $('#apiMain');
apiMain.addEventListener('submit', (ev) => { ev.preventDefault(); sendRequest(); });
apiMain.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); sendRequest(); }
  if (ev.key === 'Tab' && ev.target.id === 'reqBody') { // indent instead of leaving the editor
    ev.preventDefault();
    const t = ev.target, s = t.selectionStart;
    t.setRangeText('  ', s, t.selectionEnd, 'end');
    t.dispatchEvent(new Event('input', { bubbles: true }));
  }
});

function onCustomInput(t, c) {
  if (t.id === 'reqBody') c.body = t.value;
  else if (t.id === 'reqName') { c.name = t.value; const n = $(`.route[data-cid="${CSS.escape(S.api.csel)}"] .cname`); if (n) n.textContent = t.value; }
  else if (t.id === 'reqUrl') {
    const before = pathParamNames(c.url).join();
    c.url = storedUrl(t.value);
    S.api.cquery = { for: c, rows: urlQueryRows(c.url) };
    if (pathParamNames(c.url).join() !== before && (S.api.cpane || 'params') === 'params') { persistCustom(c); const pos = t.selectionStart; renderRequest(); const u = $('#reqUrl'); u.focus(); u.setSelectionRange(pos, pos); return; }
    const st = $('#cSendsTo'); if (st) st.textContent = fillPath(c.url, c.params);
  }
  else if (t.dataset.cparam) { c.params = c.params || {}; c.params[t.dataset.cparam] = t.value; const st = $('#cSendsTo'); if (st) st.textContent = fillPath(c.url, c.params); }
  else if (t.dataset.f) {
    const row = t.closest('.kv-row');
    const kind = row.dataset.kind;
    const list = kind === 'cquery' ? S.api.cquery.rows : c.headers;
    const item = list[+row.dataset.i];
    item[t.dataset.f] = t.type === 'checkbox' ? t.checked : t.value;
    if (t.dataset.f !== 'on' && t.value && !item.on) { item.on = true; row.querySelector('[data-f=on]').checked = true; }
    if (kind === 'cquery') { c.url = withQuery(c.url, list); $('#reqUrl').value = fullUrl(c.url); }
  } else if (t.dataset.mp === 'name' || t.dataset.mp === 'value') {
    c.multipart[+t.closest('.kv-row').dataset.i][t.dataset.mp] = t.value;
  } else return;
  persistCustom(c);
}

apiMain.addEventListener('input', (ev) => {
  const t = ev.target;
  if (S.api.list === 'custom') { const c = currentCustom(); if (c) onCustomInput(t, c); return; }
  const r = apiRoute(); if (!r) return;
  const d = draftFor(r);
  if (t.id === 'reqBody') d.body = t.value;
  else if (t.dataset.param) { d.params[t.dataset.param] = t.value; $('#reqUrl').textContent = builtUrl(r, d); }
  else if (t.dataset.f) {
    const row = t.closest('.kv-row');
    const list = d[row.dataset.kind];
    const item = list[+row.dataset.i];
    item[t.dataset.f] = t.type === 'checkbox' ? t.checked : t.value;
    if (t.dataset.f !== 'on' && t.value && !item.on) { item.on = true; row.querySelector('[data-f=on]').checked = true; }
    if (row.dataset.kind === 'query') $('#reqUrl').textContent = builtUrl(r, d);
  } else if (t.dataset.mp === 'name' || t.dataset.mp === 'value') {
    d.multipart[+t.closest('.kv-row').dataset.i][t.dataset.mp] = t.value;
  }
  persistApi(apiLauncher().id);
});
apiMain.addEventListener('change', async (ev) => {
  const t = ev.target;
  if (t.hasAttribute('data-tok-sync')) {
    const l = apiLauncher();
    apiSaved(l.id).syncToken = t.checked;
    persistApi(l.id);
    if (t.checked) { const tok = S.api.tok.data?.token; if (tok) useAppToken(tok, true); toast('The app\'s newest token will be used automatically.'); }
    return;
  }
  if (t.hasAttribute('data-tok-pick')) return;
  const custom = S.api.list === 'custom';
  const c = custom ? currentCustom() : null;
  const r = custom ? null : apiRoute();
  if (!c && !r) return;
  const d = r ? draftFor(r) : null;
  const holder = c || d;
  if (t.id === 'reqMethod') {
    if (c) { c.method = t.value; persistCustom(c); }
    else { d.method = t.value === r.method ? undefined : t.value; persistApi(apiLauncher().id); }
    return renderRequest();
  }
  if (t.dataset.mp === 'kind') { holder.multipart[+t.closest('.kv-row').dataset.i].kind = t.value; if (c) persistCustom(c); renderRequest(); }
  if (t.dataset.mp === 'file' && t.files[0]) {
    const f = t.files[0];
    if (f.size > 25 * 1024 * 1024) return toast('Files over 25 MB are not supported here', true);
    const b64 = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1] || ''); fr.readAsDataURL(f); });
    Object.assign(holder.multipart[+t.closest('.kv-row').dataset.i], { fileName: f.name, type: f.type, base64: b64 });
    renderRequest();
  }
});

async function customAction(act, el) {
  const l = apiLauncher();
  const c = currentCustom();
  if (act === 'new') { $('#apiNewBtn').click(); return; }
  if (act === 'paste') { $('#apiCurlBtn').click(); return; }
  if (act === 'goto') {
    S.api.list = 'detected'; store.set('api.list', 'detected');
    S.api.sel = el.dataset.key;
    return renderApi();
  }
  if (!c) return;
  if (act === 'save') {
    const saved = await saveToCustom(c);
    if (saved) { // the response it got before saving stays with it
      const lid = apiLauncher().id;
      const was = respStore.get(`${lid}|c|scratch`);
      if (was) { respStore.set(`${lid}|c|${saved.id}`, was); respStore.delete(`${lid}|c|scratch`); }
      S.api.scratch = null;
      renderApi();
    }
  } else if (act === 'discard') {
    respStore.delete(respKey('custom', 'scratch'));
    S.api.scratch = null;
    S.api.csel = S.api.custom.items[0]?.id || null;
    renderApi();
  } else if (act === 'dup') {
    const copy = await saveToCustom({ ...c, name: `${c.name} (copy)` });
    if (copy) renderApi();
  } else if (act === 'del') {
    const ok = await confirmBox({ title: `Delete "${c.name}"?`, text: 'It\'s removed from the Custom list for this launcher.', ok: 'Delete', danger: true });
    if (ok !== 'ok') return;
    try {
      await api('DELETE', `/api/launchers/${l.id}/requests/${c.id}`);
      S.api.custom.items = S.api.custom.items.filter((x) => x.id !== c.id);
      respStore.delete(respKey('custom', c.id));
      S.api.csel = S.api.custom.items[0]?.id || null;
      renderApi();
    } catch (e) { fail(e); }
  }
}

apiMain.addEventListener('click', async (ev) => {
  const t = ev.target;
  const l = apiLauncher();
  const custom = S.api.list === 'custom';
  const c = custom ? currentCustom() : null;
  const r = custom ? null : apiRoute();
  const d = r && draftFor(r);
  const ca = t.closest('[data-c]');
  if (ca) { ev.preventDefault(); return customAction(ca.dataset.c, ca); }
  if (t.closest('[data-reveal]')) { S.api.reveal = !S.api.reveal; return renderRequest(); }
  if (t.closest('[data-tok-use]')) {
    const pick = $('[data-tok-pick]', apiMain);
    const cands = S.api.tok.data?.candidates || [];
    const tok = cands[pick ? +pick.value : 0]?.token;
    if (tok) useAppToken(tok);
    return;
  }
  if (t.closest('[data-goto-net]')) { ev.preventDefault(); return showTab('net'); }
  if (t.closest('[data-pane]')) { S.api.pane = t.closest('[data-pane]').dataset.pane; return renderRequest(); }
  if (t.closest('[data-cpane]')) { S.api.cpane = t.closest('[data-cpane]').dataset.cpane; return renderRequest(); }
  if (t.closest('[data-cbody]') && c) { c.bodyMode = t.closest('[data-cbody]').dataset.cbody; persistCustom(c); return renderRequest(); }
  if (t.closest('[data-rpane]')) { S.api.respPane = t.closest('[data-rpane]').dataset.rpane; return renderRequest(); }
  if (t.closest('[data-resp-max]')) { S.api.respMax = !S.api.respMax; store.set('api.respMax', S.api.respMax); return renderRequest(); }
  if (t.closest('[data-open-auth]')) { ev.preventDefault(); return openAuthDialog(); }
  if (t.closest('[data-start-api]')) return startLauncher(l);
  if (t.closest('[data-save-custom]') && r) {
    // the detected route as it's filled in now, as an editable Custom request
    const method = detectedMethod(r, d);
    const hasBody = !['GET', 'HEAD'].includes(method);
    const qs = d.query.filter((q) => q.on && q.k).map((q) => `${encodeURIComponent(q.k)}=${encodeURIComponent(q.v)}`).join('&');
    const saved = await saveToCustom({
      name: `${method} ${r.path}`, method, url: baseUrl() + r.path.replace(/:(\w+)[*?]/g, ':$1') + (qs ? '?' + qs : ''), params: { ...d.params },
      headers: d.headers.filter((x) => x.k).map((x) => ({ ...x })),
      bodyMode: r.body?.multipart ? 'multipart' : 'raw', body: hasBody && !r.body?.multipart ? d.body : '',
      multipart: hasBody && r.body?.multipart ? d.multipart.map((p) => ({ ...p })) : [],
    });
    if (saved) renderApi();
    return;
  }
  if (t.dataset.add) {
    const row = { k: '', v: '', on: true };
    if (t.dataset.add === 'cquery') S.api.cquery.rows.push(row);
    else if (t.dataset.add === 'cheaders') c.headers.push(row);
    else { d[t.dataset.add].push(row); persistApi(l.id); }
    return renderRequest();
  }
  if (t.dataset.del) {
    const i = +t.closest('.kv-row').dataset.i;
    if (t.dataset.del === 'cquery') { S.api.cquery.rows.splice(i, 1); c.url = withQuery(c.url, S.api.cquery.rows); persistCustom(c); }
    else if (t.dataset.del === 'cheaders') { c.headers.splice(i, 1); persistCustom(c); }
    else { d[t.dataset.del].splice(i, 1); persistApi(l.id); }
    return renderRequest();
  }
  const holder = c || d;
  if (t.hasAttribute('data-mp-add')) { holder.multipart.push({ name: '', kind: 'text', value: '' }); if (c) persistCustom(c); return renderRequest(); }
  if (t.dataset.mpDel != null) { holder.multipart.splice(+t.dataset.mpDel, 1); if (c) persistCustom(c); return renderRequest(); }
  if (t.dataset.body === 'format') {
    try { holder.body = JSON.stringify(JSON.parse(holder.body), null, 2); if (c) persistCustom(c); else persistApi(l.id); renderRequest(); } catch (e) { toast('Not valid JSON: ' + e.message, true); }
    return;
  }
  if (t.dataset.body === 'reset' && r) { d.body = JSON.stringify(r.body?.example ?? {}, null, 2); persistApi(l.id); return renderRequest(); }
  if (t.hasAttribute('data-use-token')) {
    const token = findToken(S.api.resp.body);
    const shared = apiSaved(l.id).shared;
    const existing = shared.find((x) => /^authorization$/i.test(x.k));
    if (existing) Object.assign(existing, { v: 'Bearer ' + token, on: true }); else shared.push({ k: 'Authorization', v: 'Bearer ' + token, on: true });
    persistApi(l.id);
    toast('Token saved. It is now sent as Authorization: Bearer … with every request.');
    return renderApi();
  }
  if (t.hasAttribute('data-copy-resp')) { navigator.clipboard.writeText(S.api.resp?.body ?? '').then(() => toast('Response copied'), () => {}); return; }
  if (t.hasAttribute('data-copy-curl')) { navigator.clipboard.writeText(curlOf(S.api.lastReq || {})).then(() => toast('cURL copied'), () => {}); }
});

// ---------- shared headers dialog ----------
let authRows = [];
function renderAuthRows() {
  $('#apiAuthRows').innerHTML = authRows.length ? kvRows(authRows, 'auth') : '<p class="hint">No shared headers yet.</p>';
}
function openAuthDialog() {
  const l = apiLauncher();
  authRows = apiSaved(l.id).shared.map((x) => ({ ...x }));
  if (!authRows.length) authRows.push({ k: 'Authorization', v: 'Bearer ', on: false });
  renderAuthRows();
  $('#apiAuthDialog').showModal();
}
$('#apiAuthBtn').addEventListener('click', openAuthDialog);
$('#apiAuthAdd').addEventListener('click', () => { authRows.push({ k: '', v: '', on: true }); renderAuthRows(); });
$('#apiAuthRows').addEventListener('input', (ev) => {
  const row = ev.target.closest('.kv-row');
  if (!row) return;
  const item = authRows[+row.dataset.i];
  item[ev.target.dataset.f] = ev.target.type === 'checkbox' ? ev.target.checked : ev.target.value;
  if (ev.target.dataset.f === 'v' && ev.target.value && !item.on) { item.on = true; row.querySelector('[data-f=on]').checked = true; }
});
$('#apiAuthRows').addEventListener('click', (ev) => {
  if (ev.target.dataset.del) { authRows.splice(+ev.target.closest('.kv-row').dataset.i, 1); renderAuthRows(); }
  if (ev.target.closest('[data-reveal]')) { S.api.reveal = !S.api.reveal; renderAuthRows(); }
});
$('#apiCookiesClear').addEventListener('click', async () => {
  try { await api('POST', '/api/http/cookies/clear', { url: baseUrl() }); toast('Cookies for this API forgotten'); } catch (e) { fail(e); }
});
$('#apiAuthForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const l = apiLauncher();
  apiSaved(l.id).shared = authRows.filter((x) => x.k.trim());
  persistApi(l.id);
  $('#apiAuthDialog').close();
  renderApi();
});

// drag the bar between the request and the response to resize them; double-click resets
S.api.reqH = store.get('api.reqH', 0);
S.api.respMax = store.get('api.respMax', false);
apiMain.addEventListener('mousedown', (ev) => {
  if (!ev.target.closest('[data-split]')) return;
  const pane = apiMain.querySelector('.req-pane');
  if (!pane) return;
  ev.preventDefault();
  const y0 = ev.clientY;
  const h0 = pane.getBoundingClientRect().height;
  const max = apiMain.getBoundingClientRect().height - 160;
  document.body.classList.add('resizing-v');
  const move = (e) => {
    S.api.reqH = Math.round(Math.max(60, Math.min(max, h0 + e.clientY - y0)));
    pane.style.height = S.api.reqH + 'px';
    pane.style.maxHeight = 'none';
  };
  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    document.body.classList.remove('resizing-v');
    store.set('api.reqH', S.api.reqH);
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
});
apiMain.addEventListener('dblclick', (ev) => {
  if (!ev.target.closest('[data-split]')) return;
  S.api.reqH = 0;
  store.set('api.reqH', 0);
  renderRequest();
});
