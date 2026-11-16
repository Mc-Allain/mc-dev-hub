'use strict';
/* Network tab: traffic captured from launchers (server side) and from the app's site windows (browser side). */

const NET_CHIPS_DEFAULT = { api: true, out: true, db: true, static: false, dev: false, health: false, tcp: false, errors: false, dups: false };
S.net = {
  envId: null, entries: new Map(), loading: false, sel: null, detail: null, detailTab: 'overview', reveal: false,
  lid: '', src: store.get('net.src', ''), q: '', chips: { ...NET_CHIPS_DEFAULT, ...store.get('net.chips', {}) }, paused: false, pausedCount: 0,
};
S.netHooks = S.netHooks || {};
const MAX_NET_ROWS = 1500;
const SENSITIVE = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-access-token|api-key|x-csrf-token)$/i;

// ---------- data ----------
function netEnvChanged() {
  const e = env();
  if (!e || S.net.envId === e.id) { if (S.tab === 'net') renderNet(); return; }
  S.net.envId = e.id;
  S.net.entries = new Map();
  S.net.sel = null; S.net.detail = null;
  if (S.net.lid && !e.launchers.some((l) => l.id === S.net.lid)) S.net.lid = '';
  loadNet();
}
async function loadNet() {
  const e = env();
  if (!e) return;
  S.net.loading = true;
  try {
    const { entries } = await api('GET', `/api/envs/${e.id}/net`);
    if (S.net.envId !== e.id) return;
    S.net.entries = new Map(entries.map((x) => [x.n, x]));
  } catch (err) { fail(err); }
  S.net.loading = false;
  renderNetBadge();
  if (S.tab === 'net') renderNet();
}
function onNetEntries({ envId, entries }) {
  if (envId !== S.net.envId) return;
  for (const x of entries) {
    if (S.net.paused && !S.net.entries.has(x.n)) { S.net.pausedCount++; S.net.held = S.net.held || []; S.net.held.push(x); continue; }
    S.net.entries.set(x.n, x);
  }
  if (S.net.sel && entries.some((x) => x.n === S.net.sel) && S.tab === 'net') loadDetail(S.net.sel, true);
  scheduleNetRender();
}
function onNetCleared({ envId, lid }) {
  if (envId !== S.net.envId) return;
  if (!lid) S.net.entries = new Map();
  else for (const [n, x] of S.net.entries) if (x.lid === lid) S.net.entries.delete(n);
  if (S.net.sel && !S.net.entries.has(S.net.sel)) { S.net.sel = null; S.net.detail = null; }
  scheduleNetRender();
}
function onNetHooks({ id, processes }) {
  S.netHooks[id] = processes;
  if (S.tab === 'net') renderNetMonitors();
}
function netStatusChanged() { if (S.tab === 'net') renderNetMonitors(); }

let netRenderTimer = null;
function scheduleNetRender() {
  renderNetBadge();
  if (S.tab !== 'net' || netRenderTimer) return;
  netRenderTimer = setTimeout(() => { netRenderTimer = null; renderNetRows(); }, 200);
}
function renderNetBadge() {
  const b = $('#netBadge');
  const on = env()?.launchers.some((l) => l.monitor);
  b.textContent = S.net.entries.size ? Math.min(S.net.entries.size, 9999) : ''; // no badge at 0
  b.classList.toggle('rec', !!on);
}

// ---------- filtering ----------
const launcherName = (lid) => env()?.launchers.find((l) => l.id === lid)?.name || '?';
function chipOf(x) {
  if (x.cat === 'static' || x.cat === 'dev' || x.cat === 'health' || x.cat === 'tcp') return x.cat;
  if (x.cat === 'db' || x.cat === 'ws' || x.kind === 'ws') return 'db';
  if (x.src === 'server' && x.dir === 'out') return 'out';
  return 'api';
}
const isError = (x) => !!x.error || (x.status != null && x.status >= 400);
function visibleEntries() {
  const { chips, src, lid } = S.net;
  const q = S.net.q.trim().toLowerCase();
  const out = [];
  for (const x of S.net.entries.values()) {
    if (lid && x.lid !== lid) continue;
    if (src && x.src !== src) continue;
    if (!chips[chipOf(x)]) continue;
    if (chips.errors && !isError(x)) continue;
    if (chips.dups && x.pair && x.src === 'server') continue; // the browser row stands for both
    if (q && !`${x.method} ${x.url} ${x.host} ${x.status ?? ''} ${x.service} ${launcherName(x.lid)}`.toLowerCase().includes(q)) continue;
    out.push(x);
  }
  return out.length > MAX_NET_ROWS ? out.slice(-MAX_NET_ROWS) : out;
}

// ---------- rendering ----------
function renderNet() {
  const e = env();
  if (!e) return;
  $('#netLauncher').innerHTML = `<option value="">All launchers</option>` + e.launchers.map((l) => `<option value="${l.id}">${h(l.name)}</option>`).join('');
  $('#netLauncher').value = S.net.lid;
  $$('#netSrc button').forEach((b) => b.classList.toggle('active', b.dataset.src === S.net.src));
  $$('#netChips button').forEach((b) => b.classList.toggle('on', !!S.net.chips[b.dataset.chip]));
  $('#netSearch').value = S.net.q;
  renderNetMonitors();
  renderNetRows();
  renderNetDetail();
}

function renderNetMonitors() {
  const e = env();
  if (!e) return;
  const box = $('#netMonitors');
  if (!e.launchers.length) { box.innerHTML = ''; return; }
  box.innerHTML = e.launchers.map((l) => {
    const st = S.statuses[l.id];
    const active = isActive(l.id);
    const procs = S.netHooks[l.id] || 0;
    let state;
    let action = '';
    if (!l.monitor) {
      state = active && st?.monitored ? 'Off. Still capturing until the next restart.' : 'Off';
    } else if (!active) {
      state = 'On. Capture starts when you start it.';
    } else if (!st?.monitored) {
      state = 'On, but it was started before. Restart it to capture.';
      action = `<button class="small ghost" data-net-restart="${l.id}">↻ Restart</button>`;
    } else if (procs) {
      state = `<b class="ok-text">● Capturing</b> · ${procs} Node process${procs > 1 ? 'es' : ''}`;
    } else {
      state = 'On. Waiting for a Node process to report. Non-Node servers (Python, .NET…) only show browser-side traffic.';
    }
    return `<div class="net-mon${l.monitor ? ' on' : ''}">
      <label class="switch" title="Monitor this launcher's network traffic"><input type="checkbox" data-net-toggle="${l.id}" ${l.monitor ? 'checked' : ''}><span></span></label>
      <span class="dot ${statusOf(l.id).key}"></span><b>${h(l.name)}</b><span class="muted small-text">${state}</span>${action}</div>`;
  }).join('');
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}
function fmtSize(n) {
  if (n == null || n === 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function fmtDur(ms) {
  if (ms == null) return '';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}
function srcLabel(x) {
  if (x.src === 'browser') return x.pair && S.net.chips.dups ? '<span class="src both" title="Seen by the browser and the server">Browser + Server</span>' : '<span class="src browser">Browser</span>';
  return `<span class="src server">Server · ${x.dir === 'in' ? 'In' : 'Out'}</span>`;
}
const CAT_LABEL = { api: 'API', static: 'Static', dev: 'Dev server', health: 'Health', db: 'Database', ws: 'WebSocket', tcp: 'TCP' };
function typeLabel(x) {
  if (x.kind === 'tcp') return x.service || 'TCP';
  if (x.kind === 'ws') return 'WebSocket';
  if (x.src === 'browser' && x.resourceType && x.cat !== 'api') return x.resourceType;
  if (x.cat === 'api') return x.via === 'fetch' ? 'fetch' : x.src === 'browser' ? (x.resourceType || 'XHR') : x.contentType.replace(/^application\//, '') || 'API';
  return CAT_LABEL[x.cat] || x.cat;
}
function statusCell(x) {
  if (x.kind === 'tcp') return x.pending ? '<span class="st open">open</span>' : `<span class="st ${x.error ? 'bad' : 'done'}">${x.error ? 'error' : 'closed'}</span>`;
  if (x.error && !x.status) return '<span class="st bad" title="' + h(x.error) + '">failed</span>';
  if (x.pending && !x.status) return '<span class="st pending">…</span>';
  const s = x.status;
  const cls = s >= 500 ? 'bad' : s >= 400 ? 'warn' : s >= 300 ? 'redir' : 'ok';
  return `<span class="st ${cls}">${s}${x.fromCache ? ' ⟲' : ''}</span>`;
}
function urlCell(x) {
  if (x.kind === 'tcp') return `<span class="mono">${h(x.host || x.url)}</span>`;
  const local = x.src === 'server' && x.dir === 'in';
  const hostPart = local ? '' : `<span class="host">${h(x.host)}</span>`;
  return `${hostPart}<span class="mono">${h(x.path || x.url)}${x.search ? `<span class="q">${h(x.search)}</span>` : ''}</span>`;
}

function renderNetRows() {
  if (S.tab !== 'net') return;
  const wrap = $('#netWrap');
  const atBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 40;
  const rows = visibleEntries();
  $('#netRows').innerHTML = rows.map((x) => `<tr data-n="${x.n}" class="${x.n === S.net.sel ? 'sel' : ''}${isError(x) ? ' err' : ''}${x.pending ? ' pending' : ''}">
    <td class="mono muted">${fmtTime(x.startedAt)}</td>
    <td>${srcLabel(x)}${x.pair ? `<button class="link-pair" data-jump="${x.pair}" title="Also captured on the ${x.src === 'browser' ? 'server' : 'browser'} side. Click to see it.">🔗</button>` : ''}</td>
    <td class="muted">${h(launcherName(x.lid))}</td>
    <td><b>${h(x.kind === 'tcp' ? 'TCP' : x.method)}</b></td>
    <td>${statusCell(x)}</td>
    <td class="url">${urlCell(x)}</td>
    <td class="muted">${h(typeLabel(x))}</td>
    <td class="num muted">${x.kind === 'tcp' ? fmtSize((x.bytesRead || 0) + (x.bytesWritten || 0)) : fmtSize(x.resSize)}</td>
    <td class="num muted">${x.pending ? (x.kind === 'tcp' ? '' : '…') : fmtDur(x.duration)}</td>
  </tr>`).join('');
  const e = env();
  const anyOn = e?.launchers.some((l) => l.monitor);
  const hidden = S.net.entries.size - rows.length;
  const empty = $('#netEmpty');
  empty.hidden = rows.length > 0;
  empty.innerHTML = !anyOn
    ? 'Turn on monitoring for a launcher above, then restart it. Its API calls, outgoing requests and database connections show up here.'
    : S.net.entries.size
      ? `Nothing matches the filters. ${hidden} captured item${hidden === 1 ? ' is' : 's are'} hidden; turn on more types above.`
      : 'Waiting for traffic. Use your app, or call the API from the API tab.';
  $('#netPause').textContent = S.net.paused ? `▶ Resume${S.net.pausedCount ? ` (${S.net.pausedCount} new)` : ''}` : '⏸ Pause';
  if (atBottom) wrap.scrollTop = wrap.scrollHeight;
}

// ---------- details ----------
async function loadDetail(n, quiet) {
  try {
    const d = await api('GET', `/api/net/${n}`);
    if (S.net.sel !== n) return;
    S.net.detail = d;
  } catch (err) { if (!quiet) fail(err); S.net.detail = null; }
  renderNetDetail();
}
function prettyBody(b) {
  if (!b) return '<div class="muted small-text">No body</div>';
  if (b.binary) return `<div class="muted small-text">Binary data, ${fmtSize(b.size)}</div>`;
  if (b.dropped) return '<div class="muted small-text">This body was dropped to save memory (older captures keep headers only).</div>';
  const text = b.text ?? '';
  const note = b.truncated ? `Showing the first ${fmtSize(text.length)} of ${fmtSize(b.size)}` : '';
  return `<div class="net-body">${bodyViewHtml(text, { note, truncated: !!b.truncated })}</div>`;
}
function headersTable(hd) {
  const entries = Object.entries(hd || {});
  if (!entries.length) return '<div class="muted small-text">None</div>';
  return `<table class="kv-table">${entries.map(([k, v]) => {
    const secret = SENSITIVE.test(k) && !S.net.reveal;
    return `<tr><td>${h(k)}</td><td class="mono">${secret ? `<span class="masked" title="Hidden. Use Show secrets to see it.">••••••••</span>` : h(v)}</td></tr>`;
  }).join('')}</table>`;
}
function curlOf(d) {
  const parts = [`curl -X ${d.method || 'GET'} '${String(d.url).replace(/'/g, "'\\''")}'`];
  for (const [k, v] of Object.entries(d.reqHeaders || {})) {
    if (/^(host|content-length|connection)$/i.test(k)) continue;
    parts.push(`-H '${k}: ${String(v).replace(/'/g, "'\\''")}'`);
  }
  if (d.reqBody?.text) parts.push(`--data-raw '${d.reqBody.text.replace(/'/g, "'\\''")}'`);
  return parts.join(' \\\n  ');
}
function renderNetDetail() {
  const box = $('#netDetail');
  const d = S.net.detail;
  if (!S.net.sel || !d) { box.hidden = true; return; }
  box.hidden = false;
  const x = S.net.entries.get(d.n) || {};
  const tab = S.net.detailTab;
  const isTcp = d.kind === 'tcp';
  const absUrl = d.src === 'server' && d.dir === 'in' && d.url?.startsWith('/') ? `http://${d.host || 'localhost'}${d.url}` : d.url;
  let body = '';
  if (tab === 'overview') {
    const rows = [
      ['Source', d.src === 'browser' ? 'Browser (the app\'s site window)' : `Server (inside ${h(launcherName(d.lid))}), ${d.dir === 'in' ? 'incoming request' : 'outgoing'}`],
      ['Launcher', h(launcherName(d.lid))],
      isTcp ? ['Service', h(x.service || 'TCP')] : ['URL', `<span class="mono">${h(absUrl)}</span>`],
      isTcp ? ['Remote', `<span class="mono">${h(d.host || `${d.remoteHost}:${d.remotePort}`)}</span>`] : ['Status', d.status ? `${d.status} ${h(d.statusText || '')}` : d.pending ? 'Waiting for the response…' : '—'],
      ['Started', new Date(d.startedAt).toLocaleString()],
      ['Duration', d.pending ? (isTcp ? 'Still open' : 'In progress') : fmtDur(d.duration)],
      d.via ? ['Made with', d.via === 'fetch' ? 'fetch()' : 'http / https module'] : null,
      d.resourceType ? ['Resource type', h(d.resourceType)] : null,
      isTcp && !d.pending ? ['Traffic', `${fmtSize(d.bytesWritten) || '0 B'} sent · ${fmtSize(d.bytesRead) || '0 B'} received`] : null,
      d.remote ? ['Client', `<span class="mono">${h(d.remote)}</span>`] : null,
      d.pid ? ['Process', `PID ${d.pid}`] : null,
      d.error ? ['Error', `<span class="bad-text">${h(d.error)}</span>`] : null,
    ].filter(Boolean);
    body = `<table class="kv-table">${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>`;
    if (d.pair) body += `<button class="ghost small" data-jump="${d.pair}">🔗 Show the ${d.src === 'browser' ? 'server' : 'browser'} side of this request</button>`;
  } else {
    // body first and filling the panel; headers fold away above it (open state remembered)
    const hd = tab === 'request' ? d.reqHeaders : d.resHeaders;
    const n = Object.keys(hd || {}).length;
    const bodyHtml = tab === 'response' && d.pending ? '<div class="muted small-text">Waiting for the response…</div>' : prettyBody(tab === 'request' ? d.reqBody : d.resBody);
    body = `<details class="net-hdrs" ${S.net.headersOpen ? 'open' : ''}><summary>Headers <span class="count">${n}</span></summary>${headersTable(hd)}</details>${bodyHtml}`;
  }
  box.innerHTML = `<div class="net-detail-head">
      <div class="title">${isTcp ? `<b>${h(x.service || 'TCP')}</b> <span class="mono">${h(d.host)}</span>` : `<b>${h(d.method)}</b> <span class="mono">${h(d.path || d.url)}</span>`}</div>
      <button class="plain small" data-net-wide title="${S.net.wide ? 'Show the list again' : 'Use the full width for the details'}">${S.net.wide ? '⤡' : '⤢'}</button>
      <button class="plain small" data-net-close title="Close">✕</button>
    </div>
    <div class="tabs small net-dtabs">
      <button data-dtab="overview" class="${tab === 'overview' ? 'active' : ''}">Overview</button>
      ${isTcp ? '' : `<button data-dtab="request" class="${tab === 'request' ? 'active' : ''}">Request</button><button data-dtab="response" class="${tab === 'response' ? 'active' : ''}">Response</button>`}
    </div>
    <div class="net-detail-body${tab === 'overview' ? '' : ' fill'}">${body}</div>
    <div class="net-detail-foot">
      ${isTcp ? '' : `<button class="ghost small" data-net-replay title="Open this request in the API tab, ready to send again or save to Custom">↻ Replay</button><button class="ghost small" data-net-copy="curl">Copy cURL</button><button class="ghost small" data-net-copy="url">Copy URL</button>`}
      <label class="check small-text"><input type="checkbox" id="netReveal" ${S.net.reveal ? 'checked' : ''}> Show secrets</label>
    </div>`;
  box.dataset.url = absUrl;
}

function selectNet(n) {
  S.net.sel = n;
  S.net.detail = null;
  if (!n) { renderNetDetail(); renderNetRows(); return; }
  const x = S.net.entries.get(n);
  if (x && x.kind === 'tcp' && S.net.detailTab !== 'overview') S.net.detailTab = 'overview';
  renderNetRows();
  loadDetail(n);
}

// ---------- events ----------
$('#netRows').addEventListener('click', (ev) => {
  const jump = ev.target.closest('[data-jump]');
  if (jump) { ev.stopPropagation(); return jumpTo(+jump.dataset.jump); }
  const tr = ev.target.closest('tr[data-n]');
  if (tr) selectNet(+tr.dataset.n === S.net.sel ? null : +tr.dataset.n);
});
function jumpTo(n) {
  const x = S.net.entries.get(n);
  if (!x) return toast('That entry is no longer in the list', true);
  // make sure it's visible
  if (S.net.src && S.net.src !== x.src) S.net.src = '';
  if (S.net.lid && S.net.lid !== x.lid) S.net.lid = '';
  if (S.net.chips.dups) S.net.chips.dups = false;
  S.net.chips[chipOf(x)] = true;
  renderNet();
  selectNet(n);
  $(`#netRows tr[data-n="${n}"]`)?.scrollIntoView({ block: 'center' });
}
$('#netDetail').addEventListener('click', async (ev) => {
  if (ev.target.closest('[data-net-close]')) { S.net.wide = false; $('.net-layout').classList.remove('wide'); $('#tab-net').classList.remove('net-focus'); return selectNet(null); }
  if (ev.target.closest('[data-net-wide]')) { S.net.wide = !S.net.wide; $('.net-layout').classList.toggle('wide', S.net.wide); $('#tab-net').classList.toggle('net-focus', S.net.wide); return renderNetDetail(); }
  const jump = ev.target.closest('[data-jump]');
  if (jump) return jumpTo(+jump.dataset.jump);
  const dt = ev.target.closest('[data-dtab]');
  if (dt) { S.net.detailTab = dt.dataset.dtab; return renderNetDetail(); }
  if (ev.target.closest('[data-net-replay]') && S.net.detail) {
    if (S.net.detail.kind === 'ws') return toast('WebSocket connections can\'t be replayed here.', true);
    return apiReplay({ ...S.net.detail, url: $('#netDetail').dataset.url });
  }
  const copy = ev.target.closest('[data-net-copy]');
  if (copy && S.net.detail) {
    const d = { ...S.net.detail, url: $('#netDetail').dataset.url };
    try { await navigator.clipboard.writeText(copy.dataset.netCopy === 'curl' ? curlOf(d) : d.url); toast('Copied'); } catch { fail(new Error('Could not access the clipboard')); }
  }
});
$('#netDetail').addEventListener('toggle', (ev) => { if (ev.target.classList?.contains('net-hdrs')) S.net.headersOpen = ev.target.open; }, true);
$('#netDetail').addEventListener('change', (ev) => { if (ev.target.id === 'netReveal') { S.net.reveal = ev.target.checked; renderNetDetail(); } });
$('#netLauncher').addEventListener('change', (ev) => { S.net.lid = ev.target.value; renderNetRows(); });
$('#netSrc').addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  S.net.src = b.dataset.src;
  store.set('net.src', S.net.src);
  $$('#netSrc button').forEach((x) => x.classList.toggle('active', x === b));
  renderNetRows();
});
$('#netChips').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-chip]');
  if (!b) return;
  S.net.chips[b.dataset.chip] = !S.net.chips[b.dataset.chip];
  store.set('net.chips', S.net.chips);
  b.classList.toggle('on', S.net.chips[b.dataset.chip]);
  renderNetRows();
});
let netSearchTimer;
$('#netSearch').addEventListener('input', (ev) => { clearTimeout(netSearchTimer); netSearchTimer = setTimeout(() => { S.net.q = ev.target.value; renderNetRows(); }, 150); });
$('#netPause').addEventListener('click', () => {
  S.net.paused = !S.net.paused;
  if (!S.net.paused) {
    for (const x of S.net.held || []) S.net.entries.set(x.n, x);
    S.net.held = [];
    S.net.pausedCount = 0;
  }
  renderNetRows();
});
$('#netClearBtn').addEventListener('click', () => {
  const e = env();
  if (e) api('POST', `/api/envs/${e.id}/net/clear`, { launcherId: S.net.lid || null }).catch(fail);
});
$('#netMonitors').addEventListener('change', async (ev) => {
  const lid = ev.target.dataset.netToggle;
  if (!lid) return;
  const on = ev.target.checked;
  try {
    const saved = await api('POST', `/api/launchers/${lid}/monitor`, { on });
    const e = env();
    const i = e.launchers.findIndex((l) => l.id === lid);
    if (i >= 0) e.launchers[i] = saved;
    renderLaunchers();
    renderNetMonitors();
    renderNetRows();
    renderNetBadge();
    if (on && isActive(lid) && !S.statuses[lid]?.monitored) toast('Restart the launcher to start capturing');
  } catch (err) { ev.target.checked = !on; fail(err); }
});
$('#netMonitors').addEventListener('click', (ev) => {
  const lid = ev.target.closest('[data-net-restart]')?.dataset.netRestart;
  if (lid) api('POST', `/api/launchers/${lid}/restart`).catch(fail);
});
