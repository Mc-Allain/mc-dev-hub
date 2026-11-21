'use strict';
/* MC Dev Hub UI: environments (project folders) → launchers (commands), live console, git. */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('mcdh.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('mcdh.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const S = {
  platform: 'win32', settings: {}, terminals: [], envs: [], statuses: {},
  envId: store.get('envId', null), tab: store.get('tab', 'launchers'), sel: store.get('sel', {}),
  logs: new Map(), // launcherId -> { lines, lastSeq, loaded, loading, pending }
  api: { lid: store.get('apiLid', null), data: null, dataFor: null, loading: false, sel: null, resp: null, sending: false, pane: 'params', respPane: 'body' },
  git: null, gitEnvId: null, gitBusy: false, gitOut: new Map(), serverPid: null, connected: false,
};

// ---------- api ----------
async function api(method, url, body) {
  // the server only accepts JSON for anything that changes state, so always send a body
  if (method !== 'GET' && body === undefined) body = {};
  const res = await fetch(url, {
    method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || res.statusText); e.data = data; e.status = res.status; throw e; }
  return data;
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (bad ? ' bad' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), bad ? 6000 : 2600);
}
const fail = (e) => toast(e.message || String(e), true);

// ---------- desktop app bridge (WebView2) ----------
const bridge = window.chrome?.webview;
const pendingBridge = new Map();
let bridgeSeq = 0;
if (bridge) {
  bridge.addEventListener('message', (ev) => {
    const msg = ev.data || {};
    const p = pendingBridge.get(msg.id);
    if (p) { pendingBridge.delete(msg.id); p(msg.result); }
  });
}
function bridgeCall(type, payload) {
  return new Promise((resolve) => {
    const id = ++bridgeSeq;
    pendingBridge.set(id, resolve);
    bridge.postMessage({ id, type, ...payload });
  });
}
async function pickFolder(initial) {
  if (bridge) return bridgeCall('pickFolder', { initial: initial || '' });
  toast('A folder dialog opened. It may be behind this window.');
  return (await api('POST', '/api/pick-folder', { initial: initial || '' })).path;
}

// ---------- theme ----------
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  $$('#themeSeg button').forEach((b) => b.classList.toggle('active', b.dataset.theme === (t || 'system')));
  store.set('theme', t === 'system' ? null : t);
  bridge?.postMessage({ type: 'theme', theme: t || 'system' });
}
// ---------- running instances window ----------
$('#instancesBtn').addEventListener('click', () => {
  if (bridge) bridge.postMessage({ type: 'openWindow', path: '/instances.html', title: 'Running instances' });
  else window.open('/instances.html', 'mcdh-instances', 'popup,width=1000,height=720');
});
$('#themeSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) applyTheme(b.dataset.theme); });

// ---------- status helpers ----------
const env = () => S.envs.find((e) => e.id === S.envId) || null;
function statusOf(lid) {
  const s = S.statuses[lid];
  if (!s) return { key: 'stopped', label: 'Stopped' };
  if (s.status === 'exited') return s.exitCode ? { key: 'crashed', label: `Crashed (exit ${s.exitCode})`, s } : { key: 'stopped', label: 'Exited', s };
  const labels = { starting: 'Starting…', running: 'Running', ready: 'Ready', stopping: 'Stopping…', stopped: 'Stopped' };
  return { key: s.status, label: labels[s.status] || s.status, s };
}
const isActive = (lid) => ['starting', 'running', 'ready', 'stopping'].includes(S.statuses[lid]?.status);
function envAggregate(e) {
  const keys = e.launchers.map((l) => statusOf(l.id).key);
  const running = keys.filter((k) => k === 'ready' || k === 'running' || k === 'starting').length;
  let key = 'stopped';
  if (keys.includes('crashed')) key = 'crashed';
  else if (keys.includes('starting') || keys.includes('stopping')) key = 'starting';
  else if (running) key = 'running';
  return { key, running, total: keys.length };
}
function since(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d`;
}
const isApiKind = (l) => l.kind === 'api' || l.kind === 'both';
const launcherUrl = (l) => l.url || (l.port ? `http://localhost:${l.port}` : '');
const selectedLauncher = () => { const e = env(); if (!e) return null; return e.launchers.find((l) => l.id === S.sel[e.id]) || e.launchers[0] || null; };

// ---------- load / events ----------
async function loadState() {
  const st = await api('GET', '/api/state');
  S.platform = st.platform; S.settings = st.settings; S.terminals = st.terminals; S.envs = st.environments;
  S.statuses = st.statuses; S.info = st; loadAiStatus(); S.clis = st.clis || []; S.cliShells = st.cliShells || []; S.netHooks = st.netHooks || {};
  if (!S.envs.find((e) => e.id === S.envId)) S.envId = S.envs[0]?.id || null;
  render();
}

function connect() {
  const es = new EventSource('/api/events' + (bridge ? '?client=webview' : ''));
  es.addEventListener('openSite', (ev) => { const s = JSON.parse(ev.data); openSite(s.url, s.title); });
  es.addEventListener('hello', (ev) => {
    const { pid } = JSON.parse(ev.data);
    S.connected = true;
    if (S.serverPid && S.serverPid !== pid) { S.logs.clear(); loadState().catch(fail); } // server restarted
    else if (S.serverPid) loadState().catch(fail);
    S.serverPid = pid;
    renderSummary();
  });
  es.addEventListener('status', (ev) => {
    const s = JSON.parse(ev.data);
    S.statuses[s.id] = s;
    renderEnvList(); renderEnvHead(); renderLaunchers(); renderSummary(); renderConsoleHead();
    apiStatusChanged(s);
    updateSwitchLock();
    netStatusChanged(s);
  });
  es.addEventListener('log', (ev) => onLog(JSON.parse(ev.data)));
  es.addEventListener('cli', (ev) => onCliEvent(JSON.parse(ev.data)));
  es.addEventListener('net', (ev) => onNetEntries(JSON.parse(ev.data)));
  es.addEventListener('netToken', (ev) => apiTokenSeen(JSON.parse(ev.data).envId));
  es.addEventListener('ai', (ev) => onAiEvent(JSON.parse(ev.data)));
  es.addEventListener('netCleared', (ev) => onNetCleared(JSON.parse(ev.data)));
  es.addEventListener('netHooks', (ev) => onNetHooks(JSON.parse(ev.data)));
  es.addEventListener('cliClosed', (ev) => onCliClosed(JSON.parse(ev.data)));
  es.addEventListener('clear', (ev) => {
    const { id } = JSON.parse(ev.data);
    const L = S.logs.get(id);
    if (L) L.lines = [];
    consoleCleared(id);
  });
  es.onerror = () => { S.connected = false; renderSummary(); };
}

// ---------- logs ----------
const MAX_DOM_LINES = 5000;
function logBuf(id) {
  let L = S.logs.get(id);
  if (!L) { L = { lines: [], lastSeq: 0, loaded: false, loading: null, pending: [] }; S.logs.set(id, L); }
  return L;
}
function onLog({ id, lines }) {
  const L = logBuf(id);
  if (!L.loaded) { if (L.loading) L.pending.push(...lines); return; }
  const fresh = lines.filter((x) => x.s > L.lastSeq);
  if (!fresh.length) return;
  L.lines.push(...fresh);
  L.lastSeq = fresh[fresh.length - 1].s;
  if (L.lines.length > MAX_DOM_LINES) L.lines.splice(0, L.lines.length - MAX_DOM_LINES);
  appendConsole(id, fresh);
}
async function ensureLogs(id) {
  const L = logBuf(id);
  if (L.loaded) return L;
  if (!L.loading) {
    L.loading = api('GET', id.startsWith('cli_') ? `/api/clis/${id}/logs` : `/api/launchers/${id}/logs`).then((r) => {
      L.lines = r.lines; L.lastSeq = r.endSeq; L.loaded = true; L.loading = null;
      const extra = L.pending.filter((x) => x.s > L.lastSeq);
      L.pending = [];
      if (extra.length) { L.lines.push(...extra); L.lastSeq = extra[extra.length - 1].s; }
    }).catch((e) => { L.loading = null; throw e; });
  }
  await L.loading;
  return L;
}
const lineHtml = (x) => `<div class="${x.k}">${x.k === 'out' || x.k === 'err' ? ansiToHtml(x.t) : h(x.t)}</div>`;

// ---------- rendering ----------
function render() {
  renderEnvList();
  const e = env();
  $('#emptyState').hidden = !!e;
  $('#envView').hidden = !e;
  if (!e) { renderSummary(); return; }
  renderEnvHead();
  renderTabs();
  renderLaunchers();
  renderConsole();
  renderSummary();
  apiEnvChanged();
  netEnvChanged();
  if (S.gitEnvId !== e.id) { S.git = null; S.gitEnvId = e.id; renderGit(); loadGit(true); }
  else renderGit();
}

function renderSummary() {
  const el = $('#runningSummary');
  if (!S.connected && S.serverPid) { el.innerHTML = '<span style="color:var(--danger)">● Disconnected, reconnecting…</span>'; return; }
  const n = Object.values(S.statuses).filter((s) => ['starting', 'running', 'ready'].includes(s.status)).length;
  el.innerHTML = n ? `<b>●</b> ${n} running` : 'Nothing running';
}

function renderEnvList() {
  const q = $('#envFilter').value.trim().toLowerCase();
  const list = $('#envList');
  const items = S.envs.filter((e) => !q || e.name.toLowerCase().includes(q) || e.path.toLowerCase().includes(q));
  if (!S.envs.length) { list.innerHTML = '<li class="side-empty" style="display:block;cursor:default">No environments yet</li>'; return; }
  list.innerHTML = items.map((e) => {
    const a = envAggregate(e);
    const sub = !e.pathInfo?.isDir ? '⚠ Folder not found' : !a.total ? 'No launchers' : a.running ? `${a.running} of ${a.total} running` : `${a.total} launcher${a.total > 1 ? 's' : ''}`;
    return `<li data-id="${e.id}" class="${e.id === S.envId ? 'active' : ''}" title="${h(e.path)}${q ? '' : '\nDrag to reorder'}" ${q ? '' : 'draggable="true"'}>
      <span class="dot ${a.key}"></span><span class="env-name">${h(e.name)}</span><span class="env-sub">${h(sub)}</span></li>`;
  }).join('');
}
$('#envList').addEventListener('click', (ev) => {
  const li = ev.target.closest('li[data-id]');
  if (!li) return;
  selectEnv(li.dataset.id);
});
$('#envFilter').addEventListener('input', renderEnvList);

// drag an environment to reorder the list (off while the list is filtered)
let envDrag = null;
const envList = $('#envList');
function clearEnvDrop() { $$('#envList .drop-above, #envList .drop-below').forEach((x) => x.classList.remove('drop-above', 'drop-below')); }
envList.addEventListener('dragstart', (ev) => {
  const li = ev.target.closest('li[data-id]');
  if (!li) return;
  envDrag = li.dataset.id;
  ev.dataTransfer.effectAllowed = 'move';
  ev.dataTransfer.setData('text/plain', envDrag);
  li.classList.add('dragging');
});
// Where a drop would land, from the mouse's height anywhere in the sidebar: above the first row (the filter box,
// the gap under it) means "to the top", below the last means "to the end", in between the nearest row edge.
function envDropSpot(clientY) {
  const lis = $$('#envList li[data-id]');
  if (!lis.length) return null;
  for (const li of lis) {
    const r = li.getBoundingClientRect();
    if (clientY < r.top + r.height / 2) return { li, below: false };
  }
  return { li: lis[lis.length - 1], below: true };
}
const envSidebar = envList.closest('.sidebar') || envList;
envSidebar.addEventListener('dragover', (ev) => {
  if (!envDrag) return;
  const spot = envDropSpot(ev.clientY);
  if (!spot) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = 'move';
  clearEnvDrop();
  spot.li.classList.add(spot.below ? 'drop-below' : 'drop-above');
});
envSidebar.addEventListener('dragleave', (ev) => { if (!envSidebar.contains(ev.relatedTarget)) clearEnvDrop(); });
envSidebar.addEventListener('drop', async (ev) => {
  if (!envDrag) return;
  ev.preventDefault();
  const spot = envDropSpot(ev.clientY);
  const moving = envDrag;
  envDrag = null;
  clearEnvDrop();
  if (!spot) return renderEnvList();
  const ids = S.envs.map((e) => e.id).filter((id) => id !== moving);
  const at = spot.li.dataset.id === moving
    ? S.envs.findIndex((e) => e.id === moving) // dropped on itself: stays where it was
    : ids.indexOf(spot.li.dataset.id) + (spot.below ? 1 : 0);
  ids.splice(at, 0, moving);
  if (ids.every((id, i) => id === S.envs[i].id)) return renderEnvList(); // nothing moved
  const before = S.envs;
  S.envs = ids.map((id) => before.find((e) => e.id === id));
  renderEnvList();
  try { await api('POST', '/api/envs/order', { ids }); }
  catch (err) { S.envs = before; renderEnvList(); fail(err); }
});
envSidebar.addEventListener('dragend', () => { envDrag = null; clearEnvDrop(); $$('#envList .dragging').forEach((x) => x.classList.remove('dragging')); });
function selectEnv(id) {
  S.envId = id;
  store.set('envId', id);
  render();
}

function renderEnvHead() {
  const e = env();
  if (!e) return;
  $('#envName').textContent = e.name;
  $('#envPath').textContent = e.path;
  $('#envDot').className = 'dot ' + envAggregate(e).key;
  const warn = $('#envWarn');
  warn.hidden = !!e.pathInfo?.isDir;
  warn.textContent = e.pathInfo?.exists ? 'This path is not a folder.' : 'This folder does not exist anymore. Click Edit to point it to the right place.';
  $('#launcherCount').textContent = e.launchers.length || '';
}

function renderTabs() {
  const self = !!env()?.isSelf;
  $('#tabs [data-tab="net"]').hidden = self;
  if (S.tab === 'net' && self) S.tab = 'launchers';
  const hasApi = !!env()?.launchers.some(isApiKind);
  $('#apiTabBtn').hidden = !hasApi;
  $('#apiBadge').textContent = (hasApi && S.api.data?.routes?.length) || '';
  if (S.tab === 'api' && !hasApi) S.tab = 'launchers';
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === S.tab));
  $('#tab-launchers').hidden = S.tab !== 'launchers';
  $('#tab-api').hidden = S.tab !== 'api';
  $('#tab-git').hidden = S.tab !== 'git';
  $('#tab-net').hidden = S.tab !== 'net';
}
function showTab(tab) {
  S.tab = tab;
  store.set('tab', S.tab);
  renderTabs();
  if (S.tab === 'git') loadGit();
  else if (S.tab === 'api') renderApi();
  else if (S.tab === 'net') renderNet();
  else renderConsole();
}
$('#tabs').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-tab]');
  if (b) showTab(b.dataset.tab);
});

// Sites open in the desktop app's own window (WebView2) unless the setting says browser.
function openSite(url, title) {
  if (bridge && S.settings.openSitesIn !== 'browser') bridge.postMessage({ type: 'openSite', url, title: title || '' });
  else window.open(url, '_blank', 'noopener');
}

function renderLaunchers() {
  const e = env();
  if (!e) return;
  const box = $('#launcherList');
  const sel = selectedLauncher();
  $('#startAllBtn').disabled = !e.launchers.length || e.launchers.every((l) => isActive(l.id));
  $('#stopAllBtn').disabled = !e.launchers.some((l) => isActive(l.id));
  for (const id of ['#startAllBtn', '#stopAllBtn', '#detectBtn', '#addLauncherBtn']) $(id).hidden = !!e.isSelf;
  if (e.isSelf) {
    box.innerHTML = `<div class="no-launchers self-note"><b>This is MC Dev Hub's own folder.</b><br>
      It can't have launchers, since MC Dev Hub is already running. Use <b>＋</b> in the console below for a CLI here, or <b>Terminal</b>, <b>Folder</b>, <b>Editor</b> and the <b>Git</b> tab.</div>`;
    return;
  }
  if (!e.launchers.length) {
    box.innerHTML = `<div class="no-launchers">No launchers yet. <a href="#" data-act="detect">Detect from package.json</a> or <a href="#" data-act="add">add one</a>.</div>`;
    return;
  }
  box.innerHTML = e.launchers.map((l) => {
    const st = statusOf(l.id);
    const active = isActive(l.id);
    const url = launcherUrl(l);
    const time = active && st.s?.startedAt ? ` · ${since(st.s.startedAt)}` : '';
    return `<div class="launcher ${sel?.id === l.id ? 'selected' : ''}" data-id="${l.id}">
      <span class="dot ${st.key}"></span>
      <div class="l-main">
        <div class="l-name">${h(l.name)} ${l.kind === 'api' ? '<span class="chip api">API</span>' : l.kind === 'both' ? '<span class="chip api" title="Website with API routes">WEB + API</span>' : ''}${l.port ? `<span class="chip">:${l.port}</span>` : ''}${l.cwd ? `<span class="chip mono">${h(l.cwd)}</span>` : ''}${l.monitor ? '<span class="chip net" title="Network monitor is on. See the Network tab.">📡 NET</span>' : ''}</div>
        <div class="l-cmd mono" title="${h(l.command)}">${h(l.command) || '<i>no command</i>'}</div>
      </div>
      <div class="l-state ${st.key}">${h(st.label)}${time}</div>
      <div class="l-btns">
        ${active
          ? `<button class="ghost small" data-act="stop" ${st.key === 'stopping' ? 'disabled' : ''}>■ Stop</button><button class="ghost small" data-act="restart" title="Restart">↻</button>`
          : `<button class="go small" data-act="start">▶ Start</button>`}
        ${isApiKind(l) ? `<button class="ghost small" data-act="api" title="Browse and call this API's routes">⚡ API</button>` : ''}
        ${url ? `<a class="btn ghost small" href="${h(url)}" target="_blank" rel="noopener" data-act="open" title="${h(url)}">Open ↗</a>` : ''}
        <button class="plain small" data-act="edit" title="Edit launcher">✎</button>
      </div>
    </div>`;
  }).join('');
}

$('#launcherList').addEventListener('click', (ev) => {
  const act = ev.target.closest('[data-act]')?.dataset.act;
  if (act === 'detect') { ev.preventDefault(); return runDetect(env(), true); }
  if (act === 'add') { ev.preventDefault(); return openLauncherDialog(null); }
  const row = ev.target.closest('.launcher');
  if (!row) return;
  const e = env();
  const l = e.launchers.find((x) => x.id === row.dataset.id);
  if (!l) return;
  if (act === 'open') { ev.preventDefault(); return openSite(launcherUrl(l), l.name); }
  if (act === 'api') { S.api.lid = l.id; store.set('apiLid', l.id); return showTab('api'); }
  if (act === 'edit') return openLauncherDialog(l);
  if (act === 'start') startLauncher(l);
  if (act === 'stop') api('POST', `/api/launchers/${l.id}/stop`).catch(fail);
  if (act === 'restart') api('POST', `/api/launchers/${l.id}/restart`).catch(fail);
  if (S.sel[e.id] !== l.id) {
    S.sel[e.id] = l.id;
    store.set('sel', S.sel);
    renderLaunchers();
  }
  revealTab('out:' + l.id);
});

async function startLauncher(l, force = false) {
  try {
    await api('POST', `/api/launchers/${l.id}/start`, { force });
  } catch (e) {
    if (e.data?.code !== 'PORT_IN_USE') return fail(e);
    const o = e.data.owner;
    const choice = await confirmBox({
      title: `Port ${e.data.port} is already in use`,
      text: `${o ? `${o.name || 'A process'} (PID ${o.pid})` : 'Another program'} is already listening on port ${e.data.port}. It's often an earlier run of this project that didn't shut down.`,
      ok: 'Stop it, then start', alt: 'Start anyway',
    });
    if (choice === 'ok') {
      try { await api('POST', `/api/port/${e.data.port}/kill`, {}); await new Promise((r) => setTimeout(r, 600)); await api('POST', `/api/launchers/${l.id}/start`, { force: true }); }
      catch (err) { fail(err); }
    } else if (choice === 'alt') {
      api('POST', `/api/launchers/${l.id}/start`, { force: true }).catch(fail);
    }
  }
}

$('#startAllBtn').addEventListener('click', async () => {
  const e = env();
  try {
    const r = await api('POST', `/api/envs/${e.id}/start-all`, {});
    const bad = r.results.filter((x) => !x.ok);
    if (bad.length) {
      const names = Object.fromEntries(e.launchers.map((l) => [l.id, l.name]));
      toast(bad.map((b) => `${names[b.id]}: ${b.error}`).join('  ·  '), true);
    }
  } catch (err) { fail(err); }
});
$('#stopAllBtn').addEventListener('click', async () => {
  const e = env();
  const running = e.launchers.filter((l) => isActive(l.id));
  if (!running.length) return;
  const choice = await confirmBox({
    title: `Stop ${running.length} launcher${running.length > 1 ? 's' : ''} in ${e.name}?`,
    text: running.map((l) => `• ${l.name}${l.port ? ` (:${l.port})` : ''}`).join('\n'),
    ok: 'Stop all', danger: true,
  });
  if (choice === 'ok') api('POST', `/api/envs/${e.id}/stop-all`, {}).catch(fail);
});

// ---------- console: see console.js (tabs, CLI tabs, split panes) ----------

// ---------- env actions ----------
$$('[data-open]').forEach((b) => b.addEventListener('click', () => {
  api('POST', `/api/envs/${env().id}/open`, { what: b.dataset.open }).catch(fail);
}));

// ---------- dialogs ----------
document.addEventListener('click', (ev) => {
  if (ev.target.matches('[data-close]')) ev.target.closest('dialog').close();
});

function confirmBox({ title, text, ok = 'OK', alt = '', danger = false, input = null }) {
  const d = $('#confirmDialog');
  $('#cfTitle').textContent = title;
  $('#cfText').textContent = text || '';
  $('#cfText').hidden = !text;
  $('#cfOk').textContent = ok;
  $('#cfOk').className = danger ? 'danger-solid' : 'primary';
  $('#cfAlt').hidden = !alt;
  $('#cfAlt').textContent = alt;
  const inp = $('#cfInput');
  inp.hidden = input == null;
  inp.value = input?.value || '';
  inp.placeholder = input?.placeholder || '';
  d.returnValue = 'cancel';
  d.showModal();
  if (input != null) { inp.focus(); inp.select(); }
  return new Promise((resolve) => {
    // settle on the button's submit or on close (Esc, Enter in the input), whichever comes first:
    // some WebViews never deliver a dialog's close event, while the submit always arrives
    const form = d.querySelector('form');
    const done = (v) => {
      d.removeEventListener('close', onClose); form.removeEventListener('submit', onSubmit);
      resolve(input != null ? (v === 'ok' ? inp.value : null) : v);
    };
    const onClose = () => done(d.returnValue);
    const onSubmit = (ev) => done(ev.submitter?.value || 'cancel');
    d.addEventListener('close', onClose);
    form.addEventListener('submit', onSubmit);
  });
}
$('#cfInput').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') { ev.preventDefault(); $('#confirmDialog').close('ok'); }
});

// Environment dialog
let editingEnv = null;
function openEnvDialog(e) {
  editingEnv = e;
  const f = $('#envForm');
  f.reset();
  $('#envDlgTitle').textContent = e ? 'Edit environment' : 'New environment';
  $('#envDelete').hidden = !e;
  $('#envHint').hidden = !!e;
  f.path.value = e?.path || '';
  f.name.value = e?.name || '';
  $('#envDialog').showModal();
  if (!e) f.path.focus();
}
const baseName = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop();
$('#envBrowse').addEventListener('click', async () => {
  const f = $('#envForm');
  try {
    const p = await pickFolder(f.path.value || S.info?.home);
    if (!p) return;
    f.path.value = p;
    if (!f.name.value.trim()) f.name.value = baseName(p);
  } catch (e) { fail(e); }
});
$('#envForm').path.addEventListener('change', () => {
  const f = $('#envForm');
  if (!f.name.value.trim() && f.path.value.trim()) f.name.value = baseName(f.path.value.trim());
});
$('#envForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const body = { name: f.name.value.trim() || baseName(f.path.value.trim()), path: f.path.value.trim() };
  try {
    const info = await api('GET', '/api/path-info?path=' + encodeURIComponent(body.path));
    if (!info.isDir) {
      const go = await confirmBox({ title: 'Folder not found', text: `${body.path} doesn't exist. Save it anyway?`, ok: 'Save anyway' });
      if (go !== 'ok') return;
    }
    if (editingEnv) {
      await api('PUT', `/api/envs/${editingEnv.id}`, body);
      $('#envDialog').close();
      await loadState();
    } else {
      const created = await api('POST', '/api/envs', body);
      $('#envDialog').close();
      S.envId = created.id;
      store.set('envId', created.id);
      S.tab = 'launchers';
      await loadState();
      if (created.isSelf) toast('That\'s MC Dev Hub\'s own folder: added without launchers. Use CLI tabs, Terminal and Git there.');
      else if (info.isDir) runDetect(env(), false);
    }
  } catch (e) { fail(e); }
});
$('#envDelete').addEventListener('click', async () => {
  const e = editingEnv;
  const ok = await confirmBox({ title: `Remove "${e.name}"?`, text: 'Its launchers are stopped and removed from this list. Your project files are not touched.', ok: 'Remove', danger: true });
  if (ok !== 'ok') return;
  try {
    await api('DELETE', `/api/envs/${e.id}`);
    setCommitDraft(e.id, ''); // its saved commit message goes with it
    $('#envDialog').close();
    S.envId = null;
    await loadState();
  } catch (err) { fail(err); }
});
$('#addEnvBtn').addEventListener('click', () => openEnvDialog(null));
$('#emptyAddBtn').addEventListener('click', () => openEnvDialog(null));
$('#editEnvBtn').addEventListener('click', () => openEnvDialog(env()));

// Launcher dialog
let editingLauncher = null;
function openLauncherDialog(l) {
  editingLauncher = l;
  const f = $('#launcherForm');
  f.reset();
  $('#lDlgTitle').textContent = l ? `Edit launcher · ${l.name}` : 'New launcher';
  $('#lDelete').hidden = !l;
  const v = l || { name: '', command: 'npm run dev', cwd: '', port: '', url: '', envText: '', openOnReady: false, autoRestart: false, kind: 'web' };
  for (const k of ['name', 'command', 'cwd', 'url', 'envText']) f[k].value = v[k] || '';
  f.port.value = v.port || '';
  f.openOnReady.checked = !!v.openOnReady;
  f.autoRestart.checked = !!v.autoRestart;
  f.monitor.checked = !!v.monitor;
  setKind(v.kind || 'web');
  $('#launcherDialog').showModal();
  f.name.focus();
}
function relativeTo(base, p) {
  const norm = (x) => x.replace(/\\/g, '/').replace(/\/+$/, '');
  const b = norm(base), q = norm(p);
  const same = S.platform === 'win32' ? q.toLowerCase().startsWith(b.toLowerCase()) : q.startsWith(b);
  if (same && (q.length === b.length || q[b.length] === '/')) return q.slice(b.length + 1);
  return p;
}
$('#lBrowse').addEventListener('click', async () => {
  const e = env();
  const f = $('#launcherForm');
  try {
    const p = await pickFolder(f.cwd.value ? `${e.path}/${f.cwd.value}` : e.path);
    if (p) f.cwd.value = relativeTo(e.path, p);
  } catch (err) { fail(err); }
});
$('#launcherForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const e = env();
  const body = {
    name: f.name.value.trim(), command: f.command.value.trim(), cwd: f.cwd.value.trim(), port: f.port.value,
    url: f.url.value.trim(), envText: f.envText.value, openOnReady: f.openOnReady.checked, autoRestart: f.autoRestart.checked, monitor: f.monitor.checked, kind: f.kind.value,
  };
  try {
    let saved;
    if (editingLauncher) saved = await api('PUT', `/api/envs/${e.id}/launchers/${editingLauncher.id}`, body);
    else saved = await api('POST', `/api/envs/${e.id}/launchers`, body);
    $('#launcherDialog').close();
    S.sel[e.id] = saved.id;
    store.set('sel', S.sel);
    await loadState();
    if (editingLauncher && isActive(saved.id)) toast('Saved. Restart the launcher to apply the changes.');
  } catch (err) { fail(err); }
});
$('#lDelete').addEventListener('click', async () => {
  const l = editingLauncher;
  const ok = await confirmBox({ title: `Delete launcher "${l.name}"?`, text: isActive(l.id) ? 'It is running and will be stopped first.' : '', ok: 'Delete', danger: true });
  if (ok !== 'ok') return;
  try {
    await api('DELETE', `/api/envs/${env().id}/launchers/${l.id}`);
    $('#launcherDialog').close();
    S.logs.delete(l.id);
    await loadState();
  } catch (err) { fail(err); }
});
function setKind(k) {
  $('#launcherForm').kind.value = k;
  $$('#kindSeg button').forEach((b) => b.classList.toggle('active', b.dataset.kind === k));
}
$('#kindSeg').addEventListener('click', (ev) => { const b = ev.target.closest('button[data-kind]'); if (b) setKind(b.dataset.kind); });
$('#addLauncherBtn').addEventListener('click', () => openLauncherDialog(null));

// Detect dialog
let detected = [];
async function runDetect(e, manual) {
  try {
    const r = await api('GET', '/api/detect?path=' + encodeURIComponent(e.path));
    const existing = new Set(e.launchers.map((l) => `${l.cwd}|${l.command}`));
    detected = r.suggestions.map((s) => ({ ...s, exists: existing.has(`${s.cwd}|${s.command}`) }));
    if (!detected.length) {
      if (manual) toast('No dev/start scripts found. Add a launcher manually with + Launcher.');
      else openLauncherDialog(null);
      return;
    }
    $('#detectHint').innerHTML = `Found ${detected.length} package${detected.length > 1 ? 's' : ''} with a runnable script (package manager: <b>${h(r.packageManager)}</b>). Tick the ones you want; you can edit them any time.`;
    $('#detectList').innerHTML = detected.map((s, i) => `
      <div class="detect-item">
        <input type="checkbox" data-i="${i}" ${s.recommended && !s.exists ? 'checked' : ''} ${s.exists ? 'disabled' : ''}>
        <input type="text" data-f="name" data-i="${i}" value="${h(s.name)}" title="Name">
        <input type="text" class="cmd" data-f="command" data-i="${i}" value="${h(s.command)}" title="Command">
        <input type="number" data-f="port" data-i="${i}" value="${s.port || ''}" placeholder="port" title="Port (a guess, check it)">
        <div class="where">${h(({ web: '🌐 Website', api: '⚡ API', both: '🌐⚡ Website + API' })[s.kind] || '')} · 📁 ${h(s.cwd || '(project root)')} · scripts: ${h(s.scripts.slice(0, 8).join(', '))}${s.exists ? ' · <b>already added</b>' : ''}</div>
      </div>`).join('');
    $('#detectDialog').showModal();
  } catch (err) { fail(err); }
}
$('#detectList').addEventListener('input', (ev) => {
  const i = ev.target.dataset.i, f = ev.target.dataset.f;
  if (f) detected[i][f] = ev.target.value;
});
$('#detectForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const picks = $$('#detectList input[type=checkbox]:checked').map((c) => detected[c.dataset.i]);
  $('#detectDialog').close();
  if (!picks.length) return;
  try {
    const e = env();
    const added = await api('POST', `/api/envs/${e.id}/launchers/bulk`, { launchers: picks.map((p) => ({ name: p.name, command: p.command, cwd: p.cwd, port: p.port, kind: p.kind })) });
    S.sel[e.id] = added[0]?.id;
    store.set('sel', S.sel);
    await loadState();
    toast(`Added ${added.length} launcher${added.length > 1 ? 's' : ''}`);
  } catch (err) { fail(err); }
});
$('#detectBtn').addEventListener('click', () => runDetect(env(), true));

// Settings dialog
$('#settingsBtn').addEventListener('click', () => {
  const f = $('#settingsForm');
  $('#terminalSelect').innerHTML = S.terminals.map((t) => `<option value="${t.id}">${h(t.label)}</option>`).join('');
  f.terminal.value = S.settings.terminal || 'auto';
  f.editor.value = S.settings.editor || 'code';
  f.openSitesIn.value = S.settings.openSitesIn || 'app';
  $('#cliShellSelect').innerHTML = S.cliShells.map((t) => `<option value="${t.id}">${h(t.label)}</option>`).join('');
  f.cliShell.value = S.cliShells.some((t) => t.id === S.settings.cliShell) ? S.settings.cliShell : (S.cliShells[0]?.id || '');
  const i = S.info || {};
  renderAiSettings(true);
  loadAiStatus(true);
  $('#settingsInfo').innerHTML = `Server v${h(i.version)} on port <b>${h(i.port)}</b>. The port and startup options are set in the <b>MC Dev Hub · Server</b> desktop app.<br>Data file: <code>${h(i.dataFile)}</code>`;
  $('#settingsDialog').showModal();
});
$('#settingsForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  try {
    S.settings = await api('POST', '/api/settings', { terminal: f.terminal.value, editor: f.editor.value, openSitesIn: f.openSitesIn.value, cliShell: f.cliShell.value, aiEnabled: f.aiEnabled.checked, aiModel: f.aiModel.value });
    $('#settingsDialog').close();
    await loadAiStatus(); // before re-rendering the Git tab, so the AI button matches what was saved
    if (S.tab === 'git') renderGit();
    toast('Settings saved');
  } catch (err) { fail(err); }
});

// ---------- git ----------
async function loadGit(quiet = false) {
  const e = env();
  if (!e) return;
  const id = e.id;
  try {
    const g = await api('GET', `/api/envs/${id}/git`);
    if (env()?.id !== id) return;
    S.git = g;
    renderGitBadge();
    if (S.tab === 'git') renderGit();
  } catch (err) { if (!quiet) fail(err); }
}
function renderGitBadge() {
  const g = S.git;
  const b = $('#gitBadge');
  if (!g || !g.isRepo) { b.textContent = ''; return; }
  b.textContent = g.head.branch + (g.files.length ? ` · ${g.files.length}` : '');
}
function gitOut(envId) { if (!S.gitOut.has(envId)) S.gitOut.set(envId, []); return S.gitOut.get(envId); }
function hostName(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'web'; } }
const statusLetter = (f) => (f.untracked ? 'U' : f.staged ? f.x : f.y);

function renderGit() {
  const wrap = $('#gitWrap');
  const e = env();
  const g = S.git;
  renderGitBadge();
  if (!e) return;
  if (!g) { wrap.innerHTML = '<p class="muted">Loading git status…</p>'; return; }
  if (g.folderMissing) { wrap.innerHTML = '<div class="warn-box">The folder does not exist.</div>'; return; }
  if (g.gitMissing) { wrap.innerHTML = '<div class="warn-box">Git was not found. Install Git and make sure <code>git</code> is in your PATH.</div>'; return; }
  if (!g.isRepo) {
    wrap.innerHTML = `<div class="card"><div class="body"><p style="margin:0">This folder is not a Git repository.</p>
      <div><button class="primary" data-git="init">Initialize repository</button></div></div></div>`;
    return;
  }
  const busy = S.gitBusy ? 'disabled' : '';
  const hd = g.head;
  const staged = g.files.filter((f) => f.staged);
  const unstaged = g.files.filter((f) => f.unstaged || f.untracked);
  const sync = hd.upstream
    ? (hd.gone ? `Upstream <b>${h(hd.upstream)}</b> was deleted on the remote`
      : hd.ahead || hd.behind ? `Tracking <b>${h(hd.upstream)}</b> · ${hd.ahead ? `<b>↑${hd.ahead}</b> to push` : ''} ${hd.behind ? `<b>↓${hd.behind}</b> to pull` : ''}`
      : `Up to date with <b>${h(hd.upstream)}</b>`)
    : hd.noCommits ? 'No commits yet' : 'Not published yet: <b>Push</b> will publish this branch';

  const opts = g.branches.map((b) => `<option ${b === hd.branch ? 'selected' : ''}>${h(b)}</option>`).join('')
    + (hd.detached ? '<option selected>(detached HEAD)</option>' : '')
    + (g.remoteBranches.length ? `<optgroup label="Remote only">${g.remoteBranches.map((b) => `<option>${h(b)}</option>`).join('')}</optgroup>` : '');

  const fileRow = (f, isStaged) => `<li title="${h(f.from ? `${f.from} → ${f.path}` : f.path)}">
      <span class="st ${statusLetter(f)}">${statusLetter(f)}</span><span class="p mono">‎${h(f.path)}</span>
      <button class="plain small" data-git="${isStaged ? 'unstage' : 'stage'}" data-path="${h(f.path)}" title="${isStaged ? 'Unstage' : 'Stage'}">${isStaged ? '−' : '+'}</button></li>`;

  const origin = g.remotes[0];
  // is the current branch on the remote? (as of the last fetch)
  const hasBranch = !!hd.branch && !hd.detached;
  const onRemote = hasBranch && origin && (g.remoteRefs || []).includes(`${origin.name}/${hd.branch}`);
  const remoteRows = g.remotes.map((r, i) => `
      <div class="remote${i === 0 ? ' primary-remote' : ''}">
        <div class="remote-head"><b>${h(r.name)}</b>${i === 0 && g.remotes.length > 1 ? '<span class="chip">used for Push</span>' : ''}<span class="grow"></span>
          <button class="plain small danger" data-git="remoteRemove" data-name="${h(r.name)}" ${busy} title="Remove this remote from the repository (nothing is deleted on the server)">Remove</button></div>
        <div class="kv">
          <span class="k">URL</span><span class="v mono">${h(r.fetchUrl)}</span><button class="plain small" data-copy="${h(r.fetchUrl)}">Copy</button>
          ${r.pushUrl && r.pushUrl !== r.fetchUrl ? `<span class="k">Push</span><span class="v mono">${h(r.pushUrl)}</span><button class="plain small" data-copy="${h(r.pushUrl)}">Copy</button>` : ''}
          ${i === 0 && hd.upstream ? `<span class="k">Tracking</span><span class="v mono">${h(hd.upstream)}</span><span></span>` : ''}
        </div>
        ${i === 0 ? `<div class="remote-links">
          ${r.webUrl ? `<a class="btn ghost small" href="${h(r.webUrl)}" target="_blank" rel="noopener">Open on ${h(hostName(r.webUrl))} ↗</a>` : ''}
          ${!hasBranch ? '' : onRemote
            ? (r.webUrl ? `<a class="btn ghost small" href="${h(r.webUrl)}/tree/${h(encodeURIComponent(hd.branch))}" target="_blank" rel="noopener">This branch ↗</a>` : '')
            : `<span class="chip warn" title="As of the last Fetch">Local branch only</span><span class="small-text muted"><b>${h(hd.branch)}</b> isn't on ${h(r.name)} yet. <b>Push</b> publishes it.</span>`}
        </div>` : ''}
      </div>`).join('');
  const addForm = `<form class="remote-add" id="remoteAdd">
      <input name="name" value="${g.remotes.some((r) => r.name === 'origin') ? '' : 'origin'}" placeholder="name" spellcheck="false" title="Remote name, usually origin" ${busy}>
      <input name="url" placeholder="https://github.com/you/project.git" spellcheck="false" title="Repository URL (HTTPS or SSH)" ${busy}>
      <button class="ghost small" ${busy}>Add remote</button>
    </form>`;
  const remoteHtml = g.remotes.length
    ? `${remoteRows}<details class="remote-more" ${S.gitAddOpen ? 'open' : ''}><summary>+ Add another remote</summary>${addForm}</details>`
    : `<p class="hint" style="margin:0">No remote yet. Add one to push and pull, e.g. the repository's URL on GitHub:</p>${addForm}`;

  const out = gitOut(e.id);
  wrap.innerHTML = `
  <div class="git-grid">
    <div class="git-col">
      <div class="card">
        <header><h3>Branch</h3><span class="grow"></span><button class="plain small" data-git="refresh" ${busy}>↻ Refresh</button></header>
        <div class="body">
          <div class="branch-row">
            ${g.branches.length || hd.detached
              ? `<select id="branchSelect" ${busy} title="Switch branch">${opts}</select>`
              : `<span class="no-branch">No branches yet${hd.branch ? `: <b>${h(hd.branch)}</b> is created by the first commit` : ''}.</span>`}
            <button class="ghost small" data-git="newBranch" ${busy}>+ New branch</button>
            ${aiBranchButton()}
          </div>
          <div class="switch-lock" id="switchLock" hidden></div>
          <div class="sync">${sync}</div>
          <div class="quick">
            <button class="ghost" data-git="fetch" ${busy}>Fetch</button>
            <button class="ghost" data-git="pull" ${busy}>↓ Pull${hd.behind ? ` (${hd.behind})` : ''}</button>
            <button class="ghost" data-git="push" ${busy}>↑ Push${hd.ahead ? ` (${hd.ahead})` : ''}</button>
            <button class="ghost" data-git="stash" ${busy || (!g.files.length ? 'disabled' : '')} title="Put all changes aside">Stash</button>
            <button class="ghost" data-git="stashPop" ${busy || (!g.stashes.length ? 'disabled' : '')} title="${g.stashes.length ? h(g.stashes[0].msg) : 'No stashes'}">Pop stash${g.stashes.length ? ` (${g.stashes.length})` : ''}</button>
          </div>
        </div>
      </div>

      <div class="card">
        <header><h3>Changes</h3><span class="muted">${g.files.length || 'clean'}</span><span class="grow"></span>
          ${unstaged.length ? `<button class="plain small" data-git="stageAll" ${busy}>Stage all</button>` : ''}
          ${staged.length ? `<button class="plain small" data-git="unstageAll" ${busy}>Unstage all</button>` : ''}</header>
        ${g.files.length ? `<ul class="files">
          ${staged.length ? `<li class="group">Staged · ${staged.length}</li>${staged.map((f) => fileRow(f, true)).join('')}` : ''}
          ${unstaged.length ? `<li class="group">Not staged · ${unstaged.length}</li>${unstaged.map((f) => fileRow(f, false)).join('')}` : ''}
        </ul>` : '<div class="body muted">Working tree clean, nothing to commit.</div>'}
      </div>
    </div>

    <div class="git-col">
      <div class="card">
        <header><h3>${g.remotes.length > 1 ? 'Remotes' : 'Remote origin'}</h3></header>
        <div class="body">${remoteHtml}
          ${g.user.name || g.user.email ? `<div class="small-text muted">Committing as ${h(g.user.name)} ${g.user.email ? `&lt;${h(g.user.email)}&gt;` : ''}</div>` : '<div class="small-text" style="color:var(--warn-text)">No git user.name / user.email configured.</div>'}
        </div>
      </div>
      <div class="card">
        <header><h3>Commit</h3><span class="grow"></span>${aiCommitButton()}</header>
        <div class="commit-box">
          <textarea id="commitMsg" placeholder="Commit message" ${busy} ${store.get('commitMsgHeight', 0) ? `style="height:${store.get('commitMsgHeight', 0)}px"` : ''}>${h(S.commitDraft[e.id] || '')}</textarea>
          <div class="row">
            <label><input type="checkbox" id="commitAll" ${staged.length ? '' : 'checked'}> Stage all changes first</label>
            <span class="grow"></span>
            <button class="ghost" data-git="commit" ${busy}>Commit</button>
            <button class="primary" data-git="commitPush" ${busy}>Commit &amp; push</button>
          </div>
          ${aiOffNote()}
          <div class="ai-card" id="aiCard" hidden></div>
        </div>
      </div>
      <div class="card">
        <header><h3>Recent commits</h3></header>
        ${g.commits.length ? `<ul class="commits">${g.commits.map((c) => `<li title="${h(c.subject)}">
            <div class="subj">${(c.refs || '').split(', ').filter(Boolean).map((r) => `<span class="ref">${h(r.replace('HEAD -> ', ''))}</span>`).join('')}${h(c.subject)}</div>
            <div class="meta"><span class="hash">${h(c.short)}</span><span>${h(c.author)}</span><span>${h(c.rel)}</span></div></li>`).join('')}</ul>`
          : '<div class="body muted">No commits yet.</div>'}
      </div>
    </div>
  </div>

  <div class="card" style="margin-top:12px">
    <header><h3>Output</h3><span class="muted small-text">${S.gitBusy ? 'Running…' : ''}</span><span class="grow"></span>${out.length ? '<button class="plain small" data-git="clearOut">Clear</button>' : ''}</header>
    <pre class="git-out" id="gitOut">${out.length ? out.map((s) => `<span class="cmd">$ ${h(s.cmd)}</span>\n${h((s.stdout + s.stderr).trim())}${s.ok ? '' : `\n<span class="bad">✖ exit code ${s.code}</span>`}`).join('\n\n') : '<span style="opacity:.6">Results of git commands appear here.</span>'}</pre>
    <form class="git-custom" id="gitCustom"><span>git</span><input id="gitArgs" placeholder="any git command, e.g. log --oneline -10" spellcheck="false" ${busy}><button class="ghost" ${busy}>Run</button></form>
  </div>`;
  const o = $('#gitOut');
  o.scrollTop = o.scrollHeight;
  watchCommitHeight();
  updateSwitchLock();
  renderAiCard();
}

/** Remembers the height the commit message box is dragged to (kept across re-renders and restarts, for all environments). */
let commitResize;
function watchCommitHeight() {
  commitResize?.disconnect();
  const ta = $('#commitMsg');
  if (!ta || !window.ResizeObserver) return;
  commitResize = new ResizeObserver(() => {
    // a drag writes the new size into style.height; saving that (not offsetHeight) keeps it from growing by the padding each time
    const px = Math.round(parseFloat(ta.style.height) || 0);
    if (px > 0 && ta.offsetHeight > 0 && px !== store.get('commitMsgHeight', 0)) store.set('commitMsgHeight', px);
  });
  commitResize.observe(ta);
}

/** No branch switching while this environment's launchers run (the server refuses it too). Updated live, without a re-render. */
function updateSwitchLock() {
  const e = env();
  const sel = $('#branchSelect');
  const note = $('#switchLock');
  if (!e || !note) return;
  const running = e.launchers.filter((l) => isActive(l.id));
  note.hidden = !running.length;
  note.innerHTML = running.length
    ? `🔒 Stop ${running.length > 1 ? 'the running launchers' : 'the running launcher'} (<b>${running.map((l) => h(l.name)).join('</b>, <b>')}</b>) to switch branch.`
    : '';
  if (sel) {
    sel.disabled = !!running.length || S.gitBusy;
    sel.title = running.length ? 'Stop the running launchers to switch branch' : 'Switch branch';
  }
}

async function gitAction(body, label) {
  const e = env();
  if (!e || S.gitBusy) return;
  S.gitBusy = true;
  renderGit();
  try {
    const r = await api('POST', `/api/envs/${e.id}/git`, body);
    gitOut(e.id).push(...r.steps);
    const bad = r.steps.find((s) => !s.ok);
    if (bad) toast(`${label} failed: ${(bad.stderr || bad.stdout).trim().split('\n').pop()}`, true);
    else toast(`${label} done`);
    return !bad;
  } catch (err) { fail(err); return false; }
  finally {
    S.gitBusy = false;
    if (env()?.id === e.id) await loadGit();
    renderGit();
  }
}

// commit message drafts, per environment, kept across restarts (cleared after a successful commit)
S.commitDraft = store.get('commitDrafts', {});
let draftSaveTimer;
function setCommitDraft(envId, text) {
  if (text) S.commitDraft[envId] = text; else delete S.commitDraft[envId];
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => store.set('commitDrafts', S.commitDraft), 300);
}
window.addEventListener('beforeunload', () => { clearTimeout(draftSaveTimer); store.set('commitDrafts', S.commitDraft); });
$('#gitWrap').addEventListener('toggle', (ev) => { if (ev.target.classList?.contains('remote-more')) S.gitAddOpen = ev.target.open; }, true);
$('#gitWrap').addEventListener('input', (ev) => {
  if (ev.target.id === 'commitMsg') setCommitDraft(env().id, ev.target.value);
});
$('#gitWrap').addEventListener('change', async (ev) => {
  if (ev.target.id !== 'branchSelect') return;
  const b = ev.target.value;
  if (b && b !== S.git.head.branch && !b.startsWith('(')) await switchBranch(b);
});

/** Switches branch. When Git refuses because of uncommitted work, explains it and offers stash or carry-over. */
async function switchBranch(b, mode) {
  const e = env();
  if (!e || S.gitBusy) return;
  const from = S.git?.head?.branch;
  S.gitBusy = true;
  renderGit();
  let r = null;
  try {
    r = await api('POST', `/api/envs/${e.id}/git`, { action: 'switch', branch: b, mode });
    gitOut(e.id).push(...r.steps);
  } catch (err) { fail(err); }
  S.gitBusy = false;
  if (env()?.id === e.id) await loadGit();
  renderGit();
  if (!r) return;

  if (r.blocked) {
    const files = r.blocked.files;
    const list = files.slice(0, 8).map((f) => `• ${f}`).join('\n') + (files.length > 8 ? `\n…and ${files.length - 8} more` : '');
    const choice = await confirmBox({
      title: `Can't switch to ${b} yet`,
      text: r.blocked.untracked
        ? `These files aren't committed on ${from}, and ${b} has its own versions of them:\n${list}\n\nStash & switch puts your uncommitted work aside first. Bring it back later with Pop stash.`
        : `Your uncommitted changes to these files would be overwritten by ${b}:\n${list}\n\n• Stash & switch: put your changes aside first; bring them back later with Pop stash.\n• Bring changes along: carry them over to ${b}, merging them with its versions (you may have to resolve conflicts).`,
      ok: 'Stash & switch',
      alt: r.blocked.untracked ? '' : 'Bring changes along',
    });
    if (choice === 'ok') return switchBranch(b, 'stash');
    if (choice === 'alt') return switchBranch(b, 'merge');
    return; // cancelled: stay where you are
  }

  const bad = r.steps.find((s) => !s.ok);
  const now = S.git?.head?.branch;
  // "Bring changes along" can leave files where both sides changed the same lines (Git still says it worked)
  const conflicted = (S.git?.files || []).filter((f) => f.x === 'U' || f.y === 'U' || (f.x === 'A' && f.y === 'A') || (f.x === 'D' && f.y === 'D'));
  if (now === b && conflicted.length) toast(`Switched to ${b}, but ${conflicted.length} file${conflicted.length > 1 ? 's have' : ' has'} overlapping changes to resolve: ${conflicted.slice(0, 3).map((f) => f.path).join(', ')}${conflicted.length > 3 ? '…' : ''}. Look for the <<<<<<< markers.`, true);
  else if (bad && now === b) toast(`Switched to ${b}, but some changes overlap and need resolving. Look for conflict markers in the changed files.`, true);
  else if (bad) toast(`Switch to ${b} failed: ${(bad.stderr || bad.stdout).trim().split('\n').pop()}`, true);
  else if (mode === 'stash') toast(`Switched to ${b}. Your changes are in the stash: switch back to ${from} and press Pop stash to restore them.`);
  else toast(`Switched to ${b}`);
}
$('#gitWrap').addEventListener('submit', async (ev) => {
  if (ev.target.id === 'remoteAdd') {
    ev.preventDefault();
    const f = ev.target;
    const name = f.name.value.trim();
    const url = f.url.value.trim();
    if (!name) { f.name.focus(); return toast('Give the remote a name, usually origin', true); }
    if (!url) { f.url.focus(); return toast('Enter the repository URL', true); }
    const ok = await gitAction({ action: 'remoteAdd', name, url }, `Add remote ${name}`);
    if (ok) { S.gitAddOpen = false; renderGit(); toast(`Remote ${name} added. Fetch to see its branches, or Push to publish yours.`); }
    return;
  }
  if (ev.target.id !== 'gitCustom') return;
  ev.preventDefault();
  const args = $('#gitArgs').value.trim();
  if (args) gitAction({ action: 'custom', args }, `git ${args.split(' ')[0]}`);
});
$('#gitWrap').addEventListener('click', async (ev) => {
  const copy = ev.target.closest('[data-copy]');
  if (copy) { navigator.clipboard.writeText(copy.dataset.copy).then(() => toast('Copied'), () => fail(new Error('Clipboard unavailable'))); return; }
  const b = ev.target.closest('[data-git]');
  if (!b) return;
  const a = b.dataset.git;
  const e = env();
  switch (a) {
    case 'refresh': return loadGit();
    case 'clearOut': gitOut(e.id).length = 0; return renderGit();
    case 'init': return gitAction({ action: 'init' }, 'git init');
    case 'aiMessage': return aiCommitMessage();
    case 'aiBranch': return aiBranchName();
    case 'fetch': return gitAction({ action: 'fetch' }, 'Fetch');
    case 'pull': return gitAction({ action: 'pull' }, 'Pull');
    case 'push': return gitAction({ action: 'push' }, 'Push');
    case 'stash': return gitAction({ action: 'stash' }, 'Stash');
    case 'stashPop': return gitAction({ action: 'stashPop' }, 'Pop stash');
    case 'remoteRemove': {
      const name = b.dataset.name;
      const ok = await confirmBox({ title: `Remove remote "${name}"?`, text: `This repository forgets the remote and its tracking branches (like ${name}/main). Nothing is deleted on the server, and you can add it again any time.`, ok: 'Remove', danger: true });
      if (ok === 'ok') return gitAction({ action: 'remoteRemove', name }, `Remove remote ${name}`);
      return;
    }
    case 'stage': return gitAction({ action: 'stage', path: b.dataset.path }, 'Stage');
    case 'unstage': return gitAction({ action: 'unstage', path: b.dataset.path }, 'Unstage');
    case 'stageAll': return gitAction({ action: 'stageAll' }, 'Stage all');
    case 'unstageAll': return gitAction({ action: 'unstageAll' }, 'Unstage all');
    case 'newBranch': {
      const name = await confirmBox({ title: 'New branch', text: `Created from ${S.git.head.branch} and switched to. Your uncommitted changes come along.`, ok: 'Create', input: { placeholder: 'feature/my-change' } });
      if (name && name.trim()) return gitAction({ action: 'newBranch', branch: name.trim() }, 'New branch');
      return;
    }
    case 'commit': case 'commitPush': {
      const message = $('#commitMsg').value.trim();
      if (!message) { $('#commitMsg').focus(); return toast('Write a commit message first', true); }
      const ok = await gitAction({ action: 'commit', message, stageAll: $('#commitAll').checked, push: a === 'commitPush' }, a === 'commitPush' ? 'Commit & push' : 'Commit');
      if (ok) { setCommitDraft(e.id, ''); renderGit(); }
    }
  }
});

window.addEventListener('focus', () => { if (S.tab === 'git') loadGit(true); else if (env()) loadGit(true); });

// ---------- boot ----------
setInterval(() => { if (S.tab === 'launchers' && env()) renderLaunchers(); }, 15000);
applyTheme(store.get('theme', null) || 'system');
// Start once every script on the page has run (console.js, network.js, api.js… load after this file;
// starting earlier let a fast server answer arrive before their functions existed).
function boot() {
  loadState().then(connect).catch((e) => {
    document.body.innerHTML = `<div class="empty"><h2>Can't reach the launcher server</h2><p>${h(e.message)}</p></div>`;
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
