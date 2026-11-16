'use strict';
/* Body viewer shared by the API viewer and the Network tab:
 * JSON bodies get a Tree view (expandable, collapsible) and a Raw view (the text exactly as sent).
 * Small JSON opens in the view you used last. Large JSON opens in Raw and builds its tree only when you
 * press Tree, so big responses don't slow the page down. Other text bodies are shown raw. */

const BV_EAGER = 256 * 1024; // above this, start in Raw and build the tree on demand
const BV_OPEN_DEPTH = 3; // levels expanded at first (1 for large bodies)
const bvTexts = new Map(); // id -> text waiting for its tree (large bodies)
let bvSeq = 0;

function bvPref() { try { return localStorage.getItem('mcdh.bodyView') === 'raw' ? 'raw' : 'tree'; } catch { return 'tree'; } }
function bvSize(n) { return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} kB` : `${(n / 1048576).toFixed(1)} MB`; }

function bvScalar(v) {
  if (v === null) return '<span class="j-lit">null</span>';
  if (typeof v === 'string') return `<span class="j-str">"${h(v)}"</span>`;
  if (typeof v === 'number') return `<span class="j-num">${v}</span>`;
  if (typeof v === 'boolean') return `<span class="j-lit">${v}</span>`;
  return h(String(v));
}
function bvNode(v, key, depth, last, openDepth) {
  const k = key == null ? '' : typeof key === 'number' ? `<span class="jv-idx">${key}</span><span class="jv-colon">: </span>` : `<span class="j-key">"${h(key)}"</span><span class="jv-colon">: </span>`;
  const comma = last ? '' : '<span class="jv-comma">,</span>';
  if (v === null || typeof v !== 'object') return `<div class="jv-row">${k}${bvScalar(v)}${comma}</div>`;
  const arr = Array.isArray(v);
  const entries = arr ? v.map((x, i) => [i, x]) : Object.entries(v);
  const [open, close] = arr ? ['[', ']'] : ['{', '}'];
  if (!entries.length) return `<div class="jv-row">${k}<span class="jv-b">${open}${close}</span>${comma}</div>`;
  const count = arr ? `${entries.length} item${entries.length > 1 ? 's' : ''}` : `${entries.length} key${entries.length > 1 ? 's' : ''}`;
  const kids = entries.map(([ck, cv], i) => bvNode(cv, ck, depth + 1, i === entries.length - 1, openDepth)).join('');
  return `<details class="jv"${depth < openDepth ? ' open' : ''}><summary>${k}<span class="jv-b">${open}</span><span class="jv-sum"> ${count} </span><span class="jv-b jv-b-closed">${close}</span>${comma ? '<span class="jv-comma jv-b-closed">,</span>' : ''}</summary><div class="jv-kids">${kids}</div><div class="jv-row jv-end"><span class="jv-b">${close}</span>${comma}</div></details>`;
}
const bvTreeHtml = (json, big) => bvNode(json, null, 0, true, big ? 1 : BV_OPEN_DEPTH);

/**
 * HTML for a body. `text` is the body as received. Options:
 *   empty:     what to show when there's no text
 *   note:      a line shown above the body (e.g. "showing the first 1 MB")
 *   truncated: the text was cut off (so JSON in it may not parse)
 */
function bodyViewHtml(text, { empty = '(empty)', note = '', truncated = false } = {}) {
  text = text ?? '';
  const noteHtml = (n) => (n ? `<div class="bv-note">${n}</div>` : '');
  if (!text) return `${noteHtml(note)}<pre class="bv-raw resp-body"><span class="muted">${h(empty)}</span></pre>`;
  if (!/^\s*[[{]/.test(text)) return `${noteHtml(note)}<pre class="bv-raw resp-body">${h(text)}</pre>`;

  const big = text.length > BV_EAGER;
  let json;
  let tree = '';
  if (!big) {
    try { json = JSON.parse(text); } catch {
      const why = truncated ? 'The body was cut off, so it can\'t be shown as a tree.' : 'Not valid JSON, so it can\'t be shown as a tree.';
      return `${noteHtml([note, why].filter(Boolean).join(' '))}<pre class="bv-raw resp-body">${h(text)}</pre>`;
    }
  }
  // large bodies start in Raw; their tree is built when Tree is pressed
  const mode = big ? 'raw' : bvPref();
  let id = '';
  if (big) {
    id = 'bv' + ++bvSeq;
    bvTexts.set(id, { text, truncated });
    if (bvTexts.size > 30) bvTexts.delete(bvTexts.keys().next().value);
  } else if (mode === 'tree') {
    tree = bvTreeHtml(json, false);
  } else {
    id = 'bv' + ++bvSeq; // small but shown raw: build the tree when asked
    bvTexts.set(id, { text, truncated });
    if (bvTexts.size > 30) bvTexts.delete(bvTexts.keys().next().value);
  }
  const bigNote = big ? `Large body (${bvSize(text.length)}): showing Raw. Press Tree to build the tree.` : '';
  return `<div class="bodyview" data-mode="${mode}"${id ? ` data-bv-id="${id}"` : ''}>
    <div class="bv-bar">
      <div class="seg bv-seg"><button type="button" data-bv="tree" class="${mode === 'tree' ? 'active' : ''}" title="Expandable JSON">Tree</button><button type="button" data-bv="raw" class="${mode === 'raw' ? 'active' : ''}" title="Exactly as sent">Raw</button></div>
      <span class="bv-tree-only">
        <button type="button" class="plain small" data-bv-all="open" title="Expand everything">⊞ Expand all</button>
        <button type="button" class="plain small" data-bv-all="close" title="Collapse to the top level">⊟ Collapse all</button>
      </span>
      ${noteHtml([note, bigNote].filter(Boolean).join(' · '))}
    </div>
    <div class="bv-tree resp-body">${tree}</div>
    <pre class="bv-raw resp-body">${h(text)}</pre>
  </div>`;
}

/** Builds a tree that wasn't built yet (large or Raw-first bodies). */
function bvBuild(box) {
  const id = box.dataset.bvId;
  const treeEl = box.querySelector('.bv-tree');
  if (!id || box.dataset.built || !treeEl) return;
  const entry = bvTexts.get(id);
  if (!entry) { treeEl.innerHTML = '<div class="muted">Open this request again to see its tree.</div>'; return; }
  box.dataset.built = '1';
  treeEl.innerHTML = `<div class="muted">Building the tree (${bvSize(entry.text.length)})…</div>`;
  setTimeout(() => { // let "Building…" paint first
    try {
      const json = JSON.parse(entry.text);
      treeEl.innerHTML = bvTreeHtml(json, entry.text.length > BV_EAGER);
    } catch {
      treeEl.innerHTML = `<div class="muted">${entry.truncated ? 'The body was cut off, so it can\'t be shown as a tree.' : 'Not valid JSON, so it can\'t be shown as a tree.'} Use Raw.</div>`;
    }
  }, 30);
}

document.addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-bv]');
  if (btn) {
    ev.preventDefault();
    const m = btn.dataset.bv;
    try { localStorage.setItem('mcdh.bodyView', m); } catch { /* private mode */ }
    // the body you clicked switches; other small bodies on screen follow your choice
    const clicked = btn.closest('.bodyview');
    $$('.bodyview').forEach((b) => {
      if (b !== clicked && b.dataset.bvId && bvTexts.get(b.dataset.bvId)?.text.length > BV_EAGER) return; // large ones only on request
      b.dataset.mode = m;
      $$('[data-bv]', b).forEach((x) => x.classList.toggle('active', x.dataset.bv === m));
      if (m === 'tree') bvBuild(b);
    });
    return;
  }
  const all = ev.target.closest('[data-bv-all]');
  if (all) {
    const open = all.dataset.bvAll === 'open';
    const tree = all.closest('.bodyview').querySelector('.bv-tree');
    $$('details.jv', tree).forEach((d) => { d.open = open; });
    if (!open) { const top = tree.querySelector(':scope > details.jv'); if (top) top.open = true; } // keep the top level visible
  }
});
