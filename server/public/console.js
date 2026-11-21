'use strict';
/* Console workspace for an environment:
 * - an Output tab per launcher, plus CLI tabs (command lines in a launcher's folder)
 * - up to 3 panes side by side; drag a tab onto another pane, onto a pane's edge to split, or along a tab bar to reorder. */

const MAX_PANES = 3;
S.clis = S.clis || [];
S.cliShells = S.cliShells || [];
S.layouts = {}; // envId -> { panes: [{ tabs, active, follow }], focus }
S.conDrafts = {}; // tabId -> unsent input
S.cliHist = {}; // cliId -> { list, i }
S.drag = null;

const tabKind = (t) => t.slice(0, 3); // 'out' | 'cli'
const tabLog = (t) => t.slice(4); // launcher id or cli id (their log buffers share S.logs)
const cliById = (id) => S.clis.find((c) => c.id === id);
function tabTarget(t) {
  const e = env();
  if (!e || !t) return null;
  if (tabKind(t) === 'out') {
    const l = e.launchers.find((x) => x.id === tabLog(t));
    return l ? { kind: 'out', l } : null;
  }
  const c = cliById(tabLog(t));
  if (!c || c.envId !== e.id) return null;
  if (!c.launcherId) return { kind: 'cli', c, l: null }; // in the project root
  const l = e.launchers.find((x) => x.id === c.launcherId);
  return l ? { kind: 'cli', c, l } : null;
}
const cliLabel = (x) => `${x.l ? x.l.name : 'root'} · CLI ${x.c.n}`;
function cwdLabel(c) {
  const e = env();
  const root = (e?.path || '').replace(/[\\/]+$/, '');
  const name = root.split(/[\\/]/).pop();
  if (root && c.cwd.toLowerCase().startsWith(root.toLowerCase())) return name + c.cwd.slice(root.length);
  return c.cwd;
}

// ---------- layout ----------
function layout() {
  const e = env();
  if (!e) return null;
  let L = S.layouts[e.id];
  if (!L) {
    const saved = store.get('layout.' + e.id, null);
    L = saved?.panes?.length
      ? { panes: saved.panes.map((p) => ({ tabs: [...(p.tabs || [])], active: p.active, follow: true })), focus: saved.focus || 0 }
      : { panes: [{ tabs: [], active: null, follow: true }], focus: 0 };
    S.layouts[e.id] = L;
  }
  normalize(L, e);
  return L;
}
function normalize(L, e) {
  const outs = e.launchers.map((l) => 'out:' + l.id);
  const cliTabs = S.clis.filter((c) => c.envId === e.id && (!c.launcherId || e.launchers.some((l) => l.id === c.launcherId))).map((c) => 'cli:' + c.id);
  const valid = new Set([...outs, ...cliTabs]);
  const seen = new Set();
  for (const p of L.panes) p.tabs = p.tabs.filter((t) => valid.has(t) && !seen.has(t) && (seen.add(t), true));
  L.focus = Math.min(Math.max(0, L.focus | 0), L.panes.length - 1);
  // new launchers / CLIs land in the focused pane
  const target = L.panes[L.focus] || L.panes[0];
  for (const t of [...outs, ...cliTabs]) if (!seen.has(t)) target.tabs.push(t);
  if (L.panes.length > 1) L.panes = L.panes.filter((p) => p.tabs.length);
  if (!L.panes.length) L.panes = [{ tabs: [], active: null, follow: true }];
  L.focus = Math.min(L.focus, L.panes.length - 1);
  for (const p of L.panes) if (!p.tabs.includes(p.active)) p.active = p.tabs[0] || null;
}
function saveLayout() {
  const e = env();
  const L = e && S.layouts[e.id];
  if (L) store.set('layout.' + e.id, { panes: L.panes.map((p) => ({ tabs: p.tabs, active: p.active })), focus: L.focus });
}
const paneEl = (i) => $(`#conArea .pane[data-pane="${i}"]`);

// selecting a tab selects its launcher in the list above
function selectFromTab(t) {
  const x = tabTarget(t);
  const e = env();
  if (!x || !e || !x.l || S.sel[e.id] === x.l.id) return;
  S.sel[e.id] = x.l.id;
  store.set('sel', S.sel);
  renderLaunchers();
}

/** Shows a tab: activates it in the pane that holds it. */
function revealTab(t) {
  const L = layout();
  if (!L) return;
  const i = L.panes.findIndex((p) => p.tabs.includes(t));
  if (i < 0) return;
  const changed = L.panes[i].active !== t;
  L.panes[i].active = t;
  L.focus = i;
  saveLayout();
  if (changed) fillPane(i);
  markFocus();
  renderConsoleHead();
}

// ---------- rendering ----------
function tabHtml(t, active) {
  const x = tabTarget(t);
  if (!x) return '';
  if (x.kind === 'out') {
    return `<div class="ctab${active ? ' active' : ''}" draggable="true" data-tab="${t}" title="${h(x.l.name)}: output of ${h(x.l.command || 'the launcher')}">
      <span class="dot ${statusOf(x.l.id).key}"></span><span class="ctab-name">${h(x.l.name)}</span></div>`;
  }
  const c = x.c;
  return `<div class="ctab cli${active ? ' active' : ''}${c.running ? ' busy' : ''}" draggable="true" data-tab="${t}"
      title="CLI ${c.n} in ${h(c.cwd)}${c.running ? `\nRunning: ${h(c.command)}` : ''}\nMiddle-click to close">
    <span class="cli-ico">${c.running ? '●' : '›_'}</span><span class="ctab-name">${h(cliLabel(x))}</span>
    <span class="x" data-cact="closeTab" title="Close this CLI">✕</span></div>`;
}

function paneHtml(p, i, L) {
  return `<div class="pane console${L.panes.length > 1 && L.focus === i ? ' focused' : ''}" data-pane="${i}">
    <div class="pane-head">
      <div class="pane-tabs">${p.tabs.map((t) => tabHtml(t, p.active === t)).join('')}<button type="button" class="tab-add" data-cact="add" title="New CLI: a command line in a launcher's folder">＋</button></div>
      <div class="pane-tools">
        <button type="button" class="small" data-cact="stopCli" hidden title="Stop the running command (Ctrl+C)">■ <span class="lbl">Stop</span></button>
        <button type="button" class="small" data-cact="restartCli" hidden title="Restart: stop the command and run it again with Windows' current environment variables. The tab and its output stay.">↻ <span class="lbl">Restart</span></button>
        <button type="button" class="small follow${p.follow !== false ? ' on' : ''}" data-cact="follow" title="Keep scrolled to the newest output">⤓ <span class="lbl">Follow</span></button>
        <button type="button" class="small" data-cact="terminal" title="Open a terminal in this folder">⌨ <span class="lbl">Terminal</span></button>
        <button type="button" class="small" data-cact="copy" title="Copy the output">⧉ <span class="lbl">Copy</span></button>
        <button type="button" class="small" data-cact="clear" title="Clear the output">⌫ <span class="lbl">Clear</span></button>
        ${L.panes.length < MAX_PANES ? '<button type="button" class="small" data-cact="split" title="Split: move this tab into a new pane on the right. You can also drag a tab to the edge of a pane.">◫</button>' : ''}
        ${L.panes.length > 1 ? '<button type="button" class="small" data-cact="closePane" title="Close this pane. Its tabs move to the pane next to it.">✕</button>' : ''}
      </div>
    </div>
    <pre class="con-out"></pre>
    <form class="con-input" autocomplete="off"><span class="con-prompt">›</span><input class="con-text" spellcheck="false"></form>
    <div class="drop-hint"></div>
  </div>`;
}

function renderConsole() {
  const box = $('#conArea');
  const e = env();
  if (!e) { box.innerHTML = ''; return; }
  if (S.drag) { S.conDirty = true; return; } // don't pull the tab out from under a drag
  const L = layout();
  $$('.pane', box).forEach((el) => { const t = el.dataset.tab; if (t) S.conDrafts[t] = $('.con-text', el).value; });
  const hadFocus = box.contains(document.activeElement) && document.activeElement.classList.contains('con-text');
  box.innerHTML = L.panes.map((p, i) => paneHtml(p, i, L)).join('');
  L.panes.forEach((_, i) => fillPane(i));
  if (hadFocus) $(`.pane[data-pane="${L.focus}"] .con-text`, box)?.focus();
}

function fillPane(i) {
  const L = layout();
  const p = L?.panes[i];
  const el = paneEl(i);
  if (!p || !el) return;
  const prevTab = el.dataset.tab;
  if (prevTab) S.conDrafts[prevTab] = $('.con-text', el).value;
  const t = p.active;
  el.dataset.tab = t || '';
  $$('.ctab', el).forEach((x) => x.classList.toggle('active', x.dataset.tab === t));
  const out = $('.con-out', el);
  $('.con-text', el).value = (t && S.conDrafts[t]) || '';
  updatePaneControls(i);
  const x = tabTarget(t);
  if (!x) {
    out.innerHTML = env()?.isSelf
      ? '<div class="placeholder">Press ＋ above to open a CLI in MC Dev Hub\'s folder.</div>'
      : '<div class="placeholder">Add a launcher to see its output here, or press ＋ above for a CLI in the project folder.</div>';
    return;
  }
  const id = tabLog(t);
  const B = logBuf(id);
  if (!B.loaded) {
    out.innerHTML = '<div class="placeholder">Loading…</div>';
    ensureLogs(id).then(() => {
      const j = layout()?.panes.indexOf(p);
      if (j >= 0 && p.active === t) fillPane(j);
    }).catch((err) => { out.innerHTML = `<div class="err">${h(err.message)}</div>`; });
    return;
  }
  out.innerHTML = B.lines.length ? B.lines.map(lineHtml).join('')
    : x.kind === 'out' ? `<div class="placeholder">No output yet. Press Start to run <b>${h(x.l.command || 'this launcher')}</b>.</div>` : '';
  out.scrollTop = out.scrollHeight;
}

function updatePaneControls(i) {
  const L = layout();
  const p = L?.panes[i];
  const el = paneEl(i);
  if (!p || !el) return;
  const x = tabTarget(p.active);
  const input = $('.con-text', el);
  const prompt = $('.con-prompt', el);
  $('[data-cact="stopCli"]', el).hidden = !(x?.kind === 'cli' && x.c.running);
  $('[data-cact="restartCli"]', el).hidden = x?.kind !== 'cli';
  $('[data-cact="terminal"]', el).disabled = !x;
  if (!x) { input.disabled = true; input.placeholder = ''; prompt.textContent = '›'; return; }
  if (x.kind === 'out') {
    const active = isActive(x.l.id);
    input.disabled = !active;
    input.placeholder = active ? 'Send input to the running process (Enter)…' : 'Start the launcher to send input';
    prompt.textContent = '›';
  } else {
    input.disabled = false;
    prompt.textContent = x.c.running ? '›' : cwdLabel(x.c) + ' ›';
    input.placeholder = x.c.running ? `Input for ${x.c.command} · Ctrl+C stops it` : 'Type a command and press Enter (↑ ↓ history)';
  }
}

/** Light refresh: tab labels/dots and input state, without touching the output. */
function renderConsoleHead() {
  const L = layout();
  if (!L) return;
  if (S.drag) { S.conDirty = true; return; }
  L.panes.forEach((p, i) => {
    const el = paneEl(i);
    if (!el) return;
    const bar = $('.pane-tabs', el);
    const add = $('.tab-add', bar);
    const scroll = bar.scrollLeft;
    bar.innerHTML = p.tabs.map((t) => tabHtml(t, p.active === t)).join('');
    bar.appendChild(add);
    bar.scrollLeft = scroll;
    updatePaneControls(i);
  });
}
function markFocus() {
  const L = layout();
  if (!L) return;
  $$('#conArea .pane').forEach((el) => el.classList.toggle('focused', L.panes.length > 1 && +el.dataset.pane === L.focus));
}

function appendConsole(id, lines) {
  const L = layout();
  if (!L) return;
  L.panes.forEach((p, i) => {
    if (!p.active || tabLog(p.active) !== id) return;
    const out = $('.con-out', paneEl(i) || document.createElement('div'));
    if (!out) return;
    out.querySelector('.placeholder')?.remove();
    out.insertAdjacentHTML('beforeend', lines.map(lineHtml).join(''));
    let extra = out.childElementCount - MAX_DOM_LINES;
    while (extra-- > 0) out.firstElementChild.remove();
    if (p.follow !== false) out.scrollTop = out.scrollHeight;
  });
}
function consoleCleared(id) {
  const L = layout();
  L?.panes.forEach((p, i) => { if (p.active && tabLog(p.active) === id) fillPane(i); });
}

// ---------- CLI sessions (server events) ----------
function onCliEvent(c) {
  const known = !!cliById(c.id);
  const i = S.clis.findIndex((x) => x.id === c.id);
  if (i >= 0) S.clis[i] = c; else S.clis.push(c);
  if (c.envId !== env()?.id) return;
  if (known) renderConsoleHead(); else renderConsole();
}
function onCliClosed({ id }) {
  const c = cliById(id);
  S.clis = S.clis.filter((x) => x.id !== id);
  S.logs.delete(id);
  delete S.cliHist[id];
  if (c && c.envId === env()?.id) { layout(); saveLayout(); renderConsole(); }
}

async function createCli(paneIdx, l) { // l = null: in the project root
  const L = layout();
  L.focus = paneIdx;
  try {
    const c = await api('POST', l ? `/api/launchers/${l.id}/clis` : `/api/envs/${env().id}/clis`, {});
    if (!cliById(c.id)) S.clis.push(c);
    const t = 'cli:' + c.id;
    const L2 = layout(); // places the new tab in the focused pane
    const p = L2.panes.find((x) => x.tabs.includes(t));
    if (p) { p.active = t; L2.focus = L2.panes.indexOf(p); }
    saveLayout();
    renderConsole();
    $(`#conArea .pane[data-pane="${L2.focus}"] .con-text`)?.focus();
  } catch (err) { fail(err); }
}

function closeMenu() { $('#conMenu')?.remove(); }
function showAddMenu(paneIdx, btn) {
  const e = env();
  if (!e) return;
  const sel = selectedLauncher();
  if (!e.launchers.length) return createCli(paneIdx, null); // only the project root to choose from
  closeMenu();
  const m = document.createElement('div');
  m.id = 'conMenu';
  m.className = 'con-menu';
  const list = [...e.launchers].sort((a, b) => (a.id === sel?.id ? -1 : b.id === sel?.id ? 1 : 0));
  const rootName = e.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  m.innerHTML = '<div class="con-menu-title">New CLI in…</div>'
    + `<button type="button" data-lid=""><span class="cli-ico">›_</span><b>Project root</b><span class="muted mono small-text">${h(rootName)}</span></button>`
    + '<div class="con-menu-sep"></div>'
    + list.map((l) => `<button type="button" data-lid="${l.id}"><span class="cli-ico">›_</span><b>${h(l.name)}</b><span class="muted mono small-text">${h(l.cwd || '.')}</span></button>`).join('');
  document.body.appendChild(m);
  const r = btn.getBoundingClientRect();
  m.style.left = Math.min(r.left, window.innerWidth - m.offsetWidth - 8) + 'px';
  m.style.top = (r.bottom + 4 + m.offsetHeight > window.innerHeight ? r.top - m.offsetHeight - 4 : r.bottom + 4) + 'px';
  m.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-lid]');
    if (!b) return;
    closeMenu();
    createCli(paneIdx, b.dataset.lid ? e.launchers.find((l) => l.id === b.dataset.lid) : null);
  });
}
document.addEventListener('mousedown', (ev) => { if (!ev.target.closest('#conMenu, .tab-add')) closeMenu(); });
window.addEventListener('blur', closeMenu);

async function closeCliTab(t) {
  const x = tabTarget(t);
  if (!x || x.kind !== 'cli') return;
  if (x.c.running) {
    const ok = await confirmBox({ title: 'Close this CLI?', text: `"${x.c.command}" is still running. Closing the tab stops it.`, ok: 'Stop and close', danger: true });
    if (ok !== 'ok') return;
  }
  try { await api('DELETE', `/api/clis/${x.c.id}`); onCliClosed({ id: x.c.id }); } catch (err) { fail(err); }
}

// ---------- pane actions ----------
function moveTab(tab, target) {
  const L = layout();
  const src = L.panes.find((p) => p.tabs.includes(tab));
  if (!src) return;
  const oldIdx = src.tabs.indexOf(tab);
  let dest;
  if (target.type === 'split') {
    if (src.tabs.length === 1 && L.panes[target.pane] === src) return; // splitting a pane off its only tab changes nothing
    dest = { tabs: [], active: null, follow: true };
    L.panes.splice(target.side === 'left' ? target.pane : target.pane + 1, 0, dest);
  } else dest = L.panes[target.pane];
  let index = target.type === 'tabs' ? target.index : dest.tabs.length;
  if (dest === src && oldIdx < index) index--;
  src.tabs.splice(oldIdx, 1);
  if (src.active === tab) src.active = src.tabs[Math.min(oldIdx, src.tabs.length - 1)] || null;
  dest.tabs.splice(Math.min(index, dest.tabs.length), 0, tab);
  dest.active = tab;
  L.panes = L.panes.filter((p) => p.tabs.length);
  L.focus = Math.max(0, L.panes.indexOf(dest));
  saveLayout();
  renderConsole();
  selectFromTab(tab);
}

function splitPane(i) {
  const L = layout();
  const p = L.panes[i];
  if (L.panes.length >= MAX_PANES) return toast(`Up to ${MAX_PANES} panes`, true);
  if (p.tabs.length < 2) return toast('This pane has only one tab. Open another tab first, or drag a tab here from another pane.', true);
  moveTab(p.active, { type: 'split', pane: i, side: 'right' });
}
function closePane(i) {
  const L = layout();
  if (L.panes.length < 2) return;
  const into = L.panes[i > 0 ? i - 1 : i + 1];
  into.tabs.push(...L.panes[i].tabs);
  L.panes.splice(i, 1);
  L.focus = L.panes.indexOf(into);
  saveLayout();
  renderConsole();
}

async function paneAction(act, i, el, ev) {
  const L = layout();
  const p = L.panes[i];
  const x = tabTarget(p?.active);
  switch (act) {
    case 'add': return showAddMenu(i, ev.target.closest('.tab-add'));
    case 'closeTab': return closeCliTab(ev.target.closest('.ctab').dataset.tab);
    case 'split': return splitPane(i);
    case 'closePane': return closePane(i);
    case 'follow': {
      p.follow = p.follow === false;
      ev.target.closest('button').classList.toggle('on', p.follow);
      if (p.follow) { const out = $('.con-out', el); out.scrollTop = out.scrollHeight; }
      return;
    }
  }
  if (!x) return;
  const id = tabLog(p.active);
  if (act === 'stopCli') return api('POST', `/api/clis/${id}/stop`).catch(fail);
  if (act === 'restartCli') return api('POST', `/api/clis/${id}/restart`).catch(fail);
  if (act === 'clear') return api('POST', x.kind === 'cli' ? `/api/clis/${id}/clear` : `/api/launchers/${id}/clear`).catch(fail);
  if (act === 'terminal') {
    return (x.kind === 'cli' ? api('POST', `/api/clis/${id}/terminal`) : api('POST', `/api/envs/${env().id}/open`, { what: 'terminal', launcherId: id })).catch(fail);
  }
  if (act === 'copy') {
    const text = (S.logs.get(id)?.lines || []).map((l) => stripAnsi(l.t)).join('\n');
    try { await navigator.clipboard.writeText(text); toast('Output copied'); } catch { fail(new Error('Could not access the clipboard')); }
  }
}

const conArea = $('#conArea');
conArea.addEventListener('click', (ev) => {
  const el = ev.target.closest('.pane');
  if (!el) return;
  const i = +el.dataset.pane;
  const act = ev.target.closest('[data-cact]')?.dataset.cact;
  if (act) { ev.preventDefault(); return paneAction(act, i, el, ev); }
  const tab = ev.target.closest('.ctab');
  if (tab) {
    const L = layout();
    L.panes[i].active = tab.dataset.tab;
    L.focus = i;
    saveLayout();
    fillPane(i);
    markFocus();
    selectFromTab(tab.dataset.tab);
    $('.con-text', el).focus({ preventScroll: true });
  }
});
conArea.addEventListener('auxclick', (ev) => {
  const tab = ev.target.closest('.ctab.cli');
  if (tab && ev.button === 1) { ev.preventDefault(); closeCliTab(tab.dataset.tab); }
});
conArea.addEventListener('focusin', (ev) => {
  const el = ev.target.closest('.pane');
  const L = layout();
  if (!el || !L || L.focus === +el.dataset.pane) return;
  L.focus = +el.dataset.pane;
  saveLayout();
  markFocus();
  selectFromTab(L.panes[L.focus]?.active);
});
// scrolling up pauses "follow"; scrolling back to the bottom resumes it
conArea.addEventListener('scroll', (ev) => {
  if (!ev.target.classList?.contains('con-out')) return;
  const el = ev.target.closest('.pane');
  const p = layout()?.panes[+el.dataset.pane];
  if (!p) return;
  const out = ev.target;
  p.follow = out.scrollHeight - out.scrollTop - out.clientHeight < 30;
  $('[data-cact="follow"]', el).classList.toggle('on', p.follow);
}, true);

conArea.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const el = ev.target.closest('.pane');
  const p = layout()?.panes[+el.dataset.pane];
  const x = tabTarget(p?.active);
  const input = $('.con-text', el);
  if (!x) return;
  const text = input.value;
  const id = tabLog(p.active);
  if (x.kind === 'out') {
    api('POST', `/api/launchers/${id}/input`, { text }).then(() => { input.value = ''; S.conDrafts[p.active] = ''; }).catch(fail);
    return;
  }
  if (text.trim() && !x.c.running) {
    const H = S.cliHist[id] || (S.cliHist[id] = { list: [], i: 0 });
    if (H.list[H.list.length - 1] !== text) H.list.push(text);
    H.i = H.list.length;
  }
  input.value = '';
  S.conDrafts[p.active] = '';
  if (p.follow === false) { p.follow = true; $('[data-cact="follow"]', el).classList.add('on'); }
  api('POST', `/api/clis/${id}/run`, { text }).then(onCliEvent).catch(fail);
});
conArea.addEventListener('keydown', (ev) => {
  if (!ev.target.classList.contains('con-text')) return;
  const el = ev.target.closest('.pane');
  const p = layout()?.panes[+el.dataset.pane];
  const x = tabTarget(p?.active);
  if (x?.kind !== 'cli') return;
  const input = ev.target;
  if (ev.key === 'c' && ev.ctrlKey && !ev.shiftKey && input.selectionStart === input.selectionEnd && x.c.running) {
    ev.preventDefault();
    api('POST', `/api/clis/${x.c.id}/stop`).catch(fail);
    return;
  }
  if ((ev.key === 'ArrowUp' || ev.key === 'ArrowDown') && !x.c.running) {
    const H = S.cliHist[x.c.id];
    if (!H?.list.length) return;
    ev.preventDefault();
    H.i = Math.max(0, Math.min(H.list.length, H.i + (ev.key === 'ArrowUp' ? -1 : 1)));
    input.value = H.list[H.i] ?? '';
    input.setSelectionRange(input.value.length, input.value.length);
  }
  if (ev.key === 'l' && ev.ctrlKey) { ev.preventDefault(); api('POST', `/api/clis/${x.c.id}/clear`).catch(fail); }
});

// ---------- drag & drop ----------
function clearDropHints() {
  $$('#conArea .drop-before').forEach((x) => x.classList.remove('drop-before'));
  $$('#conArea .drop-end').forEach((x) => x.classList.remove('drop-end'));
  $$('#conArea .drop-hint').forEach((x) => (x.className = 'drop-hint'));
}
function dropTarget(ev) {
  const el = ev.target.closest?.('.pane');
  const L = layout();
  if (!el || !L) return null;
  const i = +el.dataset.pane;
  const bar = ev.target.closest('.pane-tabs');
  if (bar) {
    const tabs = $$('.ctab', bar);
    let index = tabs.length;
    for (let k = 0; k < tabs.length; k++) {
      const r = tabs[k].getBoundingClientRect();
      if (ev.clientX < r.left + r.width / 2) { index = k; break; }
    }
    return { type: 'tabs', pane: i, index, el: tabs[index] || bar };
  }
  const r = el.getBoundingClientRect();
  const f = (ev.clientX - r.left) / r.width;
  if (L.panes.length < MAX_PANES && f < 0.3) return { type: 'split', pane: i, side: 'left', el };
  if (L.panes.length < MAX_PANES && f > 0.7) return { type: 'split', pane: i, side: 'right', el };
  return { type: 'center', pane: i, el };
}
conArea.addEventListener('dragstart', (ev) => {
  const tab = ev.target.closest?.('.ctab');
  if (!tab) return;
  S.drag = { tab: tab.dataset.tab };
  ev.dataTransfer.effectAllowed = 'move';
  ev.dataTransfer.setData('text/plain', tab.dataset.tab);
  tab.classList.add('dragging');
  conArea.classList.add('dragging');
  closeMenu();
});
conArea.addEventListener('dragover', (ev) => {
  if (!S.drag) return;
  const t = dropTarget(ev);
  if (!t) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = 'move';
  clearDropHints();
  if (t.type === 'tabs') t.el.classList.add(t.el.classList.contains('ctab') ? 'drop-before' : 'drop-end');
  else $('.drop-hint', t.el).className = `drop-hint show ${t.type === 'split' ? t.side : 'center'}`;
});
conArea.addEventListener('dragleave', (ev) => { if (!conArea.contains(ev.relatedTarget)) clearDropHints(); });
conArea.addEventListener('drop', (ev) => {
  if (!S.drag) return;
  ev.preventDefault();
  const t = dropTarget(ev);
  const tab = S.drag.tab;
  S.drag = null;
  clearDropHints();
  conArea.classList.remove('dragging');
  if (t) moveTab(tab, t);
});
conArea.addEventListener('dragend', () => {
  const dirty = S.conDirty;
  S.drag = null;
  S.conDirty = false;
  clearDropHints();
  conArea.classList.remove('dragging');
  $$('#conArea .ctab.dragging').forEach((x) => x.classList.remove('dragging'));
  if (dirty) renderConsole();
});
