'use strict';
/* Running instances window: this launcher's processes, plus other dev servers listening on local ports. */

const $ = (s, el = document) => el.querySelector(s);
const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('mcdh.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('mcdh.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const bridge = window.chrome?.webview;

const S = { own: [], other: [], scannedAt: 0, loading: false, busy: new Set(), errors: new Map(), showStopped: store.get('inst.showStopped', true) };

async function api(method, url, body) {
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

// ---------- theme (shared with the main window) ----------
function applyTheme() {
  const t = store.get('theme', null);
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  bridge?.postMessage({ type: 'theme', theme: t || 'system' });
}
window.addEventListener('storage', (e) => { if (e.key === 'mcdh.theme') applyTheme(); });
applyTheme();

// ---------- helpers ----------
function since(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d`;
}
const ACTIVE = ['starting', 'running', 'ready', 'stopping'];
const isActive = (r) => ACTIVE.includes(r.status);
function ownStatus(r) {
  if (r.status === 'exited') return r.exitCode ? { key: 'crashed', label: `Crashed (exit ${r.exitCode})` } : { key: 'stopped', label: 'Exited' };
  const labels = { starting: 'Starting…', running: 'Running', ready: 'Ready', stopping: 'Stopping…', stopped: 'Stopped' };
  return { key: r.status || 'stopped', label: labels[r.status] || r.status };
}
function openUrl(url, title) {
  if (bridge) bridge.postMessage({ type: 'openSite', url, title });
  else window.open(url, '_blank', 'noopener');
}
function portChips(ports, fallback) {
  const list = ports?.length ? ports : fallback ? [{ port: fallback, planned: true }] : [];
  return list.map((p) => `<a class="chip port-chip${p.planned ? ' planned' : ''}" href="http://localhost:${p.port}" data-open="http://localhost:${p.port}"
    title="${p.planned ? 'Configured port' : 'Listening'}${p.exposed ? ' on all network interfaces' : ''}. Click to open.">:${p.port}${p.exposed ? ' 🌐' : ''}</a>`).join('');
}

/** Asks before stopping several things at once. Resolves true when confirmed. */
function confirmStop(title, text, items, okLabel = 'Stop all') {
  const d = $('#confirmDlg');
  $('#cdTitle').textContent = title;
  $('#cdText').textContent = text;
  $('#cdList').innerHTML = items.map((x) => `<li>${x}</li>`).join('');
  $('#cdOk').textContent = okLabel;
  d.returnValue = 'cancel';
  d.showModal();
  $('#cdOk').focus();
  return new Promise((resolve) => { // the button's submit or close (Esc), whichever arrives first
    const form = d.querySelector('form');
    const done = (v) => { d.removeEventListener('close', onClose); form?.removeEventListener('submit', onSubmit); resolve(v === 'ok'); };
    const onClose = () => done(d.returnValue);
    const onSubmit = (ev) => done(ev.submitter?.value || 'cancel');
    d.addEventListener('close', onClose);
    form?.addEventListener('submit', onSubmit);
  });
}

// ---------- data ----------
let scanSeq = 0;
async function load(refresh = false) {
  const seq = ++scanSeq;
  S.loading = true;
  renderInfo();
  try {
    const d = await api('GET', '/api/instances' + (refresh ? '?refresh=1' : ''));
    if (seq !== scanSeq) return;
    S.own = d.own; S.other = d.other; S.hub = d.hub; S.scannedAt = d.scannedAt;
    render();
  } catch (e) {
    if (seq === scanSeq) toast(e.message, true);
  } finally {
    if (seq === scanSeq) { S.loading = false; renderInfo(); }
  }
}
let rescanTimer;
const rescanSoon = (ms = 900) => { clearTimeout(rescanTimer); rescanTimer = setTimeout(() => load(true), ms); };

// live status of our own launchers
let es;
function connect() {
  es = new EventSource('/api/events');
  es.addEventListener('hello', () => load());
  es.addEventListener('cli', () => rescanSoon(400));
  es.addEventListener('status', (ev) => {
    const s = JSON.parse(ev.data);
    const r = S.own.find((x) => x.id === s.id);
    if (r) {
      Object.assign(r, { status: s.status, pid: s.pid, startedAt: s.startedAt, exitCode: s.exitCode });
      if (!isActive(r)) r.ports = [];
      renderOwn();
    }
    rescanSoon();
  });
}

// ---------- rendering ----------
function render() { renderOwn(); renderOther(); renderInfo(); }

function renderInfo() {
  $('#scanInfo').textContent = S.loading ? 'Scanning…' : S.scannedAt ? `Updated ${new Date(S.scannedAt).toLocaleTimeString()}` : '';
  $('#refreshBtn').disabled = S.loading;
}

function rowError(id) {
  const e = S.errors.get(id);
  if (!e) return '';
  const fix = e.port ? `<button class="small ghost" data-act="freeStart" data-id="${h(id)}">Stop what's on :${e.port} and start</button>` : '';
  return `<div class="inst-error">${h(e.message)} ${fix}<button class="small plain" data-act="dismiss" data-id="${h(id)}">✕</button></div>`;
}

function renderOwn() {
  const running = S.own.filter(isActive);
  $('#ownCount').textContent = `${running.length} running · ${S.own.length} total`;
  $('#showStopped').checked = S.showStopped;
  $('#ownStopAll').disabled = !running.length;
  const rows = S.showStopped ? S.own : running;
  const el = $('#ownList');
  let html = hubRow();
  if (!S.own.length) { el.innerHTML = html + '<div class="inst-empty">No launchers yet. Add an environment in the main window.</div>'; return; }
  if (!rows.length) { el.innerHTML = html + '<div class="inst-empty">No launchers running. Tick <b>Show stopped</b> to start one.</div>'; return; }
  let lastEnv = null;
  for (const r of rows) {
    if (r.envId !== lastEnv) { lastEnv = r.envId; html += `<div class="inst-env">${h(r.envName)}</div>`; }
    const st = ownStatus(r);
    const busy = S.busy.has(r.id);
    const active = isActive(r);
    const meta = [active && r.startedAt ? `up ${since(r.startedAt)}` : '', r.pid ? `PID ${r.pid}` : ''].filter(Boolean).join(' · ');
    const actions = r.type === 'cli'
      ? `<button class="small ghost danger" data-act="stopCli" data-id="${h(r.id)}" ${busy ? 'disabled' : ''}>■ Stop</button>`
      : active
      ? `${r.url && (r.status === 'ready' || r.status === 'running') ? `<button class="small ghost" data-open="${h(r.url)}" data-title="${h(r.name)}">Open ↗</button>` : ''}
         <button class="small ghost danger" data-act="stop" data-id="${h(r.id)}" ${busy || r.status === 'stopping' ? 'disabled' : ''}>■ Stop</button>`
      : `<button class="small go" data-act="start" data-id="${h(r.id)}" ${busy ? 'disabled' : ''}>▶ Start</button>`;
    html += `<div class="inst-row${active ? '' : ' off'}">
      <span class="dot ${st.key}"></span>
      <div class="inst-body">
        <div class="inst-title"><b>${h(r.name)}</b> <span class="inst-status ${st.key}">${h(st.label)}</span> ${portChips(active ? r.ports : [], r.port)}</div>
        <div class="inst-cmd mono" title="${h(r.command)}">${h(r.command)}</div>
        ${rowError(r.id)}
      </div>
      <div class="inst-meta">${h(meta)}</div>
      <div class="inst-actions">${actions}</div>
    </div>`;
  }
  el.innerHTML = html;
}

function hubRow() {
  const x = S.hub;
  if (!x) return '';
  const meta = [`up ${since(x.startedAt)}`, `PID ${x.pid}`].join(' · ');
  const by = x.app ? ` · started by the desktop app (PID ${x.app.pid})` : '';
  return `<div class="inst-env">MC Dev Hub</div>
    <div class="inst-row hub-row">
      <span class="dot ready"></span>
      <div class="inst-body">
        <div class="inst-title"><b>MC Dev Hub</b> <span class="chip">this app</span> <span class="inst-status ready">Running</span>
          ${x.ports.map((p, i) => i === 0 ? `<span class="chip" title="This page">:${p.port}</span>` : `<span class="chip" title="Network monitor: where monitored launchers report">:${p.port} monitor</span>`).join('')}</div>
        <div class="inst-cmd mono" title="${h(x.command)}">node ${h(x.node)} · ${h(x.command)}${h(by)}</div>
      </div>
      <div class="inst-meta">${h(meta)}</div>
      <div class="inst-actions"><span class="muted small-text" title="Stopping it closes this window. Use the MC Dev Hub · Server window or the tray menu.">Stop from the app</span></div>
    </div>`;
}

function renderOther() {
  const running = S.other.filter((r) => r.status === 'running');
  const stopped = S.other.length - running.length;
  $('#otherCount').textContent = `${running.length} running` + (stopped ? ` · ${stopped} stopped` : '');
  $('#otherStopAll').disabled = !running.length;
  $('#otherRemoveStopped').hidden = !stopped;
  const el = $('#otherList');
  if (!S.other.length) { el.innerHTML = `<div class="inst-empty">${S.scannedAt ? 'No other dev servers are listening right now.' : 'Scanning…'}</div>`; return; }
  el.innerHTML = S.other.map((r) => {
    const on = r.status === 'running';
    const busy = S.busy.has(r.key);
    const meta = [on ? (r.startedAt ? `up ${since(r.startedAt)}` : '') : `stopped ${since(r.stoppedAt)} ago`, `PID ${r.pid}`].filter(Boolean).join(' · ');
    const from = [r.parent ? `from ${h(r.parent)}` : '', r.envName ? `<span class="chip">${h(r.envName)}</span>` : ''].filter(Boolean).join(' ');
    const actions = on
      ? `<button class="small ghost danger" data-act="stopOther" data-id="${h(r.key)}" ${busy ? 'disabled' : ''}>■ Stop</button>`
      : `<button class="small ghost" data-act="remove" data-id="${h(r.key)}">Remove</button>`;
    return `<div class="inst-row${on ? '' : ' off'}">
      <span class="dot ${on ? 'running' : ''}"></span>
      <div class="inst-body">
        <div class="inst-title"><b>${h(r.name)}</b> <span class="inst-status ${on ? 'running' : 'stopped'}">${on ? 'Running' : 'Stopped'}</span>
          ${on ? portChips(r.ports) : r.ports.map((p) => `<span class="chip">:${p.port}</span>`).join('')} <span class="muted small-text">${from}</span></div>
        <div class="inst-cmd mono" title="${h(r.command)}">${h(r.command)}</div>
        ${rowError(r.key)}
      </div>
      <div class="inst-meta">${h(meta)}</div>
      <div class="inst-actions">${actions}</div>
    </div>`;
  }).join('');
}

// ---------- actions ----------
async function withBusy(id, fn) {
  S.busy.add(id); S.errors.delete(id); render();
  try { await fn(); }
  catch (e) { S.errors.set(id, { message: e.message, port: e.data?.code === 'PORT_IN_USE' ? e.data.port : null, owner: e.data?.owner }); }
  finally { S.busy.delete(id); render(); }
}

const actions = {
  start: (id) => withBusy(id, () => api('POST', `/api/launchers/${id}/start`, {})),
  stop: (id) => withBusy(id, () => api('POST', `/api/launchers/${id}/stop`)),
  stopCli: (id) => withBusy(id, async () => { await api('POST', `/api/clis/${id}/stop`); rescanSoon(300); }),
  freeStart: (id) => { const err = S.errors.get(id); return err && withBusy(id, async () => {
    const other = err?.owner && S.other.find((o) => o.status === 'running' && (o.pid === err.owner.pid || o.listenerPids.includes(err.owner.pid)));
    // stopping it through "other sources" keeps a record of it there
    if (other) await api('POST', `/api/instances/other/${encodeURIComponent(other.key)}/stop`);
    else await api('POST', `/api/port/${err.port}/kill`);
    await api('POST', `/api/launchers/${id}/start`, { force: true });
    rescanSoon(300);
  }); },
  dismiss: (id) => { S.errors.delete(id); render(); },
  stopOther: (key) => withBusy(key, async () => {
    const rec = await api('POST', `/api/instances/other/${encodeURIComponent(key)}/stop`);
    const i = S.other.findIndex((o) => o.key === key);
    if (i >= 0) S.other[i] = rec;
    rescanSoon(300);
  }),
  remove: async (key) => {
    try { await api('DELETE', `/api/instances/other/${encodeURIComponent(key)}`); S.other = S.other.filter((o) => o.key !== key); render(); }
    catch (e) { toast(e.message, true); }
  },
};

document.addEventListener('click', (e) => {
  const open = e.target.closest('[data-open]');
  if (open) { e.preventDefault(); openUrl(open.dataset.open, open.dataset.title || ''); return; }
  const b = e.target.closest('[data-act]');
  if (b && actions[b.dataset.act]) actions[b.dataset.act](b.dataset.id);
});

$('#refreshBtn').addEventListener('click', () => load(true));
$('#showStopped').addEventListener('change', (e) => { S.showStopped = e.target.checked; store.set('inst.showStopped', S.showStopped); renderOwn(); });

$('#ownStopAll').addEventListener('click', async () => {
  const list = S.own.filter(isActive);
  if (!list.length) return;
  const ok = await confirmStop(
    `Stop ${list.length} running instance${list.length > 1 ? 's' : ''}?`,
    'Everything this launcher started, in every environment:',
    list.map((r) => `<b>${h(r.envName)}</b> · ${h(r.name)}${r.ports?.length ? ` <span class="muted">:${r.ports.map((p) => p.port).join(', :')}</span>` : ''}`),
  );
  if (!ok) return;
  try { await api('POST', '/api/instances/own/stop-all'); } catch (err) { toast(err.message, true); }
});
$('#otherStopAll').addEventListener('click', async () => {
  const list = S.other.filter((r) => r.status === 'running');
  if (!list.length) return;
  const ok = await confirmStop(
    `Stop ${list.length} process${list.length > 1 ? 'es' : ''} from other sources?`,
    'These weren\'t started by this launcher (a terminal, your editor, another tool). Unsaved work in them is lost.',
    list.map((r) => `<b>${h(r.name)}</b> <span class="muted">PID ${r.pid}${r.ports?.length ? ` · :${r.ports.map((p) => p.port).join(', :')}` : ''}</span><br><span class="mono small-text muted">${h(r.command.length > 90 ? r.command.slice(0, 90) + '…' : r.command)}</span>`),
  );
  if (!ok) return;
  await (async () => {
    try {
      const { results } = await api('POST', '/api/instances/other/stop-all');
      const failed = results.filter((r) => !r.ok);
      if (failed.length) toast(failed.map((f) => f.error).join('\n'), true);
    } catch (err) { toast(err.message, true); }
    load(true);
  })();
});
$('#otherRemoveStopped').addEventListener('click', async () => {
  try { await api('POST', '/api/instances/other/remove-stopped'); S.other = S.other.filter((o) => o.status === 'running'); render(); }
  catch (e) { toast(e.message, true); }
});

// re-scan every 5 s while the window is visible, and refresh "up 3m" labels
setInterval(() => { if (document.visibilityState === 'visible' && !S.loading) load(); }, 5000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(); });

connect();
