'use strict';
/* Git tab: before/after view of one changed file, like GitHub's and GitLab's (split or unified). */

S.diff = { list: [], idx: -1, data: null, reveal: false, req: 0 };
const DIFF_MAX_ROWS = 6000; // more than this renders slowly; the rest is behind a button

/** The Changes list, in the order shown (staged first), so ‹ › can step through it. Set by renderGit. */
function setDiffList(list) { S.diff.list = list; }

async function openDiff(i) {
  const f = S.diff.list[i];
  const e = env();
  if (!f || !e) return;
  S.diff.idx = i;
  S.diff.reveal = false;
  S.diff.showAll = false;
  const d = $('#diffDialog');
  if (!d.open) d.showModal();
  await loadDiff();
}

async function loadDiff() {
  const f = S.diff.list[S.diff.idx];
  const e = env();
  if (!f || !e) return;
  const req = ++S.diff.req;
  renderDiffHead(f, null);
  $('#diffBody').innerHTML = '<p class="muted diff-msg">Loading…</p>';
  const q = new URLSearchParams({ path: f.path });
  if (f.from) q.set('from', f.from);
  if (f.staged) q.set('staged', '1');
  if (f.untracked) q.set('untracked', '1');
  if (store.get('diffFull', false)) q.set('full', '1');
  if (S.diff.reveal) q.set('reveal', '1');
  try {
    const data = await api('GET', `/api/envs/${e.id}/git/diff?${q}`);
    if (req !== S.diff.req) return; // a newer file was picked meanwhile
    S.diff.data = data;
    renderDiff();
  } catch (err) {
    if (req === S.diff.req) $('#diffBody').innerHTML = `<div class="warn-box diff-msg">${h(err.message)}</div>`;
  }
}

// ---------- parsing ----------
/** Unified diff hunks -> [{ header, lines: [{ t: ' '|'-'|'+', o, n, s }] }] with old/new line numbers. */
function parseHunks(text) {
  const hunks = [];
  let cur = null, o = 0, n = 0;
  for (const line of text.split('\n')) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (m) { cur = { header: line, ctx: m[3].trim(), lines: [] }; hunks.push(cur); o = +m[1]; n = +m[2]; continue; }
    if (!cur) continue;
    const t = line[0];
    const s = line.slice(1);
    if (t === '+') cur.lines.push({ t, n: n++, s });
    else if (t === '-') cur.lines.push({ t, o: o++, s });
    else if (t === ' ') cur.lines.push({ t, o: o++, n: n++, s });
    else if (t === '\\') cur.lines.push({ t: '\\', s: line.slice(2) }); // "No newline at end of file"
  }
  return hunks;
}

/** Highlights what changed inside a replaced line: the part between the shared start and the shared end. */
function intraLine(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const mark = (x) => {
    const mid = x.slice(p, x.length - s);
    // nearly the whole line changed: marking it adds nothing
    if (!mid || mid.length > x.length * 0.8) return h(x);
    return h(x.slice(0, p)) + `<span class="x">${h(mid)}</span>` + h(x.slice(x.length - s));
  };
  return [mark(a), mark(b)];
}

/** Pairs each run of removed lines with the added lines after it (a replaced block), for side-by-side rows. */
function pairRows(lines) {
  const rows = [];
  for (let i = 0; i < lines.length;) {
    const l = lines[i];
    if (l.t === ' ' || l.t === '\\') { rows.push({ l: l, r: l }); i++; continue; }
    const dels = [], adds = [];
    while (i < lines.length && lines[i].t === '-') dels.push(lines[i++]);
    while (i < lines.length && lines[i].t === '+') adds.push(lines[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ l: dels[k] || null, r: adds[k] || null });
  }
  return rows;
}

// ---------- rendering ----------
function renderDiffHead(f, data) {
  const i = S.diff.idx, n = S.diff.list.length;
  const split = store.get('diffSplit', true);
  let stats = '';
  if (data?.diff) {
    let add = 0, del = 0;
    for (const l of data.diff.split('\n')) { if (l[0] === '+') add++; else if (l[0] === '-') del++; }
    stats = `<span class="diff-stat"><span class="a">+${add}</span> <span class="d">−${del}</span></span>`;
  }
  const where = f.untracked ? 'New file, not tracked yet' : f.staged ? 'Staged changes (HEAD → index)' : 'Not staged (index → working tree)';
  $('#diffHead').innerHTML = `
    <span class="st ${h(f.letter)}">${h(f.letter)}</span>
    <div class="diff-title"><b class="mono" title="${h(f.path)}">${h(f.path)}</b>
      <span class="muted small-text">${data?.from ? `renamed from <span class="mono">${h(data.from)}</span> · ` : ''}${where}</span></div>
    ${stats}<span class="grow"></span>
    <div class="seg" role="group" aria-label="Layout">
      <button type="button" class="${split ? 'active' : ''}" data-diff="split" title="Before and after side by side">Split</button>
      <button type="button" class="${split ? '' : 'active'}" data-diff="unified" title="One column, removed lines above added ones">Unified</button>
    </div>
    <label class="check small-text" title="Show the whole file, not just the lines around each change"><input type="checkbox" data-diff="full" ${store.get('diffFull', false) ? 'checked' : ''}> Full file</label>
    <span class="diff-nav">
      <button type="button" class="ghost small" data-diff="prev" ${i <= 0 ? 'disabled' : ''} title="Previous file (←)">‹</button>
      <span class="muted small-text">${i + 1} / ${n}</span>
      <button type="button" class="ghost small" data-diff="next" ${i >= n - 1 ? 'disabled' : ''} title="Next file (→)">›</button>
    </span>
    <button type="button" class="plain" data-diff="close" title="Close (Esc)">✕</button>`;
}

function renderDiff() {
  const f = S.diff.list[S.diff.idx];
  const data = S.diff.data;
  renderDiffHead(f, data);
  const body = $('#diffBody');
  const msg = (html) => { body.innerHTML = `<div class="diff-msg">${html}</div>`; };
  if (data.secret) return msg(`🔒 <b>${h(f.path)}</b> looks like a secret file (keys, passwords or tokens), so its contents are hidden.
    <div style="margin-top:8px"><button type="button" class="ghost small" data-diff="reveal">Show anyway</button></div>`);
  if (data.binary) return msg('This is a binary file, so there are no lines to compare.');
  if (data.tooLarge) return msg('This change is too large to show here (over 2 MB). Open the file in your editor instead.');
  const hunks = parseHunks(data.diff || '');
  if (!hunks.length) {
    if (data.from) return msg(`Renamed from <b class="mono">${h(data.from)}</b> with no changes to its contents.`);
    return msg(f.untracked ? 'The file is empty.' : 'No line changes (only the file mode changed).');
  }

  const split = store.get('diffSplit', true);
  const ln = (x) => `<td class="ln">${x ?? ''}</td>`;
  let rows = 0;
  const out = [];
  for (const hk of hunks) {
    if (rows > DIFF_MAX_ROWS && !S.diff.showAll) break;
    out.push(`<tr class="hunk"><td colspan="${split ? 4 : 3}"><span class="mono">${h((hk.header.match(/^@@ [^@]* @@/) || [hk.header])[0])}</span>${hk.ctx ? ` <span class="ctx mono">${h(hk.ctx)}</span>` : ''}</td></tr>`);
    if (split) {
      for (const { l, r } of pairRows(hk.lines)) {
        rows++;
        if (l && l.t === '\\') { out.push(`<tr class="nonl"><td></td><td colspan="3">${h(l.s)}</td></tr>`); continue; }
        let lt = l ? h(l.s) : '', rt = r ? h(r.s) : '';
        if (l && r && l.t === '-' && r.t === '+') [lt, rt] = intraLine(l.s, r.s);
        const lc = !l ? 'empty' : l.t === '-' ? 'del' : 'ctx';
        const rc = !r ? 'empty' : r.t === '+' ? 'add' : 'ctx';
        out.push(`<tr>${ln(l?.o)}<td class="code ${lc}">${lt}</td>${ln(r?.n)}<td class="code ${rc}">${rt}</td></tr>`);
      }
    } else {
      const pairs = new Map(); // replaced lines get the same in-line highlight as in split view
      for (const { l, r } of pairRows(hk.lines)) if (l && r && l.t === '-' && r.t === '+') { const [a, b] = intraLine(l.s, r.s); pairs.set(l, a); pairs.set(r, b); }
      for (const l of hk.lines) {
        rows++;
        if (l.t === '\\') { out.push(`<tr class="nonl"><td></td><td></td><td>${h(l.s)}</td></tr>`); continue; }
        const cls = l.t === '+' ? 'add' : l.t === '-' ? 'del' : 'ctx';
        out.push(`<tr>${ln(l.o)}${ln(l.n)}<td class="code ${cls}"><span class="sign">${l.t === ' ' ? ' ' : l.t === '-' ? '−' : '+'}</span>${pairs.get(l) ?? h(l.s)}</td></tr>`);
      }
    }
  }
  const more = rows > DIFF_MAX_ROWS && !S.diff.showAll
    ? `<div class="diff-msg">Showing the first ${DIFF_MAX_ROWS.toLocaleString()} lines. <button type="button" class="ghost small" data-diff="all">Show everything</button></div>` : '';
  body.innerHTML = `<table class="diff-table ${split ? 'split' : 'unified'}">
    <colgroup>${split ? '<col class="ln"><col><col class="ln"><col>' : '<col class="ln"><col class="ln"><col>'}</colgroup>
    <tbody>${out.join('')}</tbody></table>${more}`;
  body.scrollTop = 0;
}

// ---------- events ----------
$('#diffDialog').addEventListener('click', (ev) => {
  if (ev.target === ev.currentTarget) return ev.currentTarget.close(); // click on the backdrop
  const b = ev.target.closest('[data-diff]');
  if (!b || b.tagName === 'INPUT') return;
  switch (b.dataset.diff) {
    case 'close': return $('#diffDialog').close();
    case 'prev': return openDiff(S.diff.idx - 1);
    case 'next': return openDiff(S.diff.idx + 1);
    case 'split': store.set('diffSplit', true); return S.diff.data && renderDiff();
    case 'unified': store.set('diffSplit', false); return S.diff.data && renderDiff();
    case 'reveal': S.diff.reveal = true; return loadDiff();
    case 'all': S.diff.showAll = true; return renderDiff();
  }
});
$('#diffDialog').addEventListener('change', (ev) => {
  if (ev.target.dataset.diff === 'full') { store.set('diffFull', ev.target.checked); loadDiff(); }
});
$('#diffDialog').addEventListener('keydown', (ev) => {
  if (ev.target.closest('input, textarea, select')) return;
  if (ev.key === 'ArrowLeft' && S.diff.idx > 0) { ev.preventDefault(); openDiff(S.diff.idx - 1); }
  else if (ev.key === 'ArrowRight' && S.diff.idx < S.diff.list.length - 1) { ev.preventDefault(); openDiff(S.diff.idx + 1); }
});
