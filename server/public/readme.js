'use strict';
/* README tab (always the last tab): the project's README rendered like GitHub does, or as raw text, and an editor
 * with a formatting toolbar and live preview to write or create it. Links to other Markdown files in the project
 * open here too (with Back); web links open in the browser. */

S.readme = { envId: null, path: '', data: null, history: [], error: '', loading: false, req: 0 };
S.mdEdits = new Map(); // envId -> { path, text, original, baseModified, create } while editing (kept across tab/env switches)

/** Folder part of a project path ("docs/a.md" -> "docs/"). */
const mdDir = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
/** Resolves a link inside the project: "./x", "../x", "/x" (from the project root). -> "dir/x" or null if it leaves the folder */
function mdResolve(base, rel) {
  const parts = (rel.startsWith('/') ? rel.slice(1) : mdDir(base) + rel).split('/');
  const out = [];
  for (const p of parts) {
    if (p === '..') { if (!out.length) return null; out.pop(); } else if (p && p !== '.') out.push(p);
  }
  return out.join('/');
}
const isExternal = (u) => /^[a-z][\w+.-]*:/i.test(u) || u.startsWith('//');
/** Rendering options: relative images load from the project folder. */
const mdOpts = (envId, base) => ({
  src: (u) => {
    if (!u || isExternal(u) || u.startsWith('#')) return u;
    const p = mdResolve(base, decodeURI(u.split(/[?#]/)[0]));
    return p ? `/api/envs/${envId}/asset?path=${encodeURIComponent(p)}` : '';
  },
});
const mdEditing = () => S.mdEdits.get(env()?.id);
const mdDirty = (ed) => !!ed && (ed.create || ed.text !== ed.original);

function readmeEnvChanged() {
  const e = env();
  if (!e || S.readme.envId === e.id) return;
  S.readme = { ...S.readme, envId: e.id, path: '', data: null, history: [], error: '' };
  if (S.tab === 'readme') loadReadme();
}

/** keepScroll: a refresh of the same file (e.g. after editing it) stays where you were. */
async function loadReadme({ keepScroll = false } = {}) {
  const e = env();
  if (!e) return;
  if (mdEditing()) return renderReadme(); // never reload under the editor
  const req = ++S.readme.req;
  const top = keepScroll ? $('#mdScroll').scrollTop : 0;
  if (!keepScroll) { $('#mdDoc').innerHTML = '<p class="muted">Loading…</p>'; $('#mdOutline').hidden = true; }
  try {
    const data = await api('GET', `/api/envs/${e.id}/doc${S.readme.path ? `?path=${encodeURIComponent(S.readme.path)}` : ''}`);
    if (req !== S.readme.req || env()?.id !== e.id) return;
    S.readme.data = data;
    S.readme.error = '';
    if (data.found && !S.readme.path) S.readme.path = data.path;
  } catch (err) {
    if (req !== S.readme.req) return;
    S.readme.data = null;
    S.readme.error = err.message;
  }
  renderReadme();
  $('#mdScroll').scrollTop = top;
}

// ---------- reading ----------
function renderReadme() {
  const e = env();
  const ed = mdEditing();
  $('#mdScroll').hidden = !!ed;
  $('#mdEdit').hidden = !ed;
  if (ed) return renderEditor(ed);
  const r = S.readme;
  const raw = store.get('mdRaw', false);
  const d = r.data;
  const when = d?.modified ? new Date(d.modified).toLocaleString() : '';
  $('#mdBar').innerHTML = `
    ${r.history.length ? '<button class="ghost small" data-md="back" title="Back to the previous file">← Back</button>' : ''}
    <span class="md-file mono" title="${h(d?.path || '')}">📄 ${h(d?.found ? d.path : r.path || 'README')}</span>
    ${when ? `<span class="muted small-text" title="Last changed">${h(when)}</span>` : ''}
    <span class="grow"></span>
    ${d?.found ? `<div class="seg" role="group" aria-label="View">
      <button type="button" class="${raw ? '' : 'active'}" data-md="rendered" title="Formatted, like on GitHub">Preview</button>
      <button type="button" class="${raw ? 'active' : ''}" data-md="raw" title="The Markdown source">Raw</button>
    </div>
    <button class="ghost small" data-md="copy" title="Copy the Markdown source">Copy</button>
    <button class="ghost small" data-md="edit" title="Edit this file, with a formatting toolbar and live preview">✏️ Edit</button>` : ''}
    <button class="ghost small" data-md="refresh" title="Load the file again">↻ Refresh</button>`;
  const doc = $('#mdDoc');
  const outline = $('#mdOutline');
  outline.hidden = true;
  doc.classList.remove('raw');
  if (r.error) { doc.innerHTML = `<div class="warn-box">${h(r.error)}</div>`; return; }
  if (!d) { doc.innerHTML = '<p class="muted">Loading…</p>'; return; }
  if (!d.found) {
    doc.innerHTML = `<div class="md-empty"><div class="md-empty-icon">📄</div><b>No README in this folder</b>
      <p class="muted">A README tells people what the project is and how to run it. It's shown here, formatted like on GitHub.</p>
      <button class="primary" data-md="create">＋ Create README.md</button>
      <p class="muted small-text">Starts from a simple outline${e?.launchers?.length ? ' with your launchers\' commands filled in' : ''}. Nothing is saved until you press Save.</p></div>`;
    return;
  }
  doc.classList.toggle('raw', raw);
  if (raw || !/\.(md|markdown|mdx)$/i.test(d.path)) { // plain text files are shown as they are
    doc.innerHTML = `<pre class="md-raw">${h(d.content)}</pre>`;
    return;
  }
  doc.replaceChildren(MD.render(d.content, mdOpts(e.id, d.path)));
  // outline of the headings, for longer files
  const heads = [...doc.querySelectorAll('h1, h2, h3')];
  if (heads.length >= 4) {
    outline.innerHTML = `<div class="md-outline-title">On this page</div>${heads.map((x) => `<a href="#${h(x.id.replace(/^md-/, ''))}" class="lvl${x.tagName[1]}" data-md-anchor="${h(x.id)}">${h(x.textContent)}</a>`).join('')}`;
    outline.hidden = false;
  }
}

function openMdLink(href) {
  const r = S.readme;
  if (!href) return;
  if (href.startsWith('#')) return scrollToAnchor('md-' + decodeURIComponent(href.slice(1)));
  if (isExternal(href)) {
    if (/^(https?:|mailto:)/i.test(href)) api('POST', '/api/open-url', { url: href }).then(() => toast('Opened in your browser'), fail);
    return;
  }
  const [file, hash] = href.split('#');
  const p = mdResolve(r.path, decodeURI(file.split('?')[0]));
  if (!p) return toast('That link points outside the project folder.', true);
  if (/\.(md|markdown|mdx|txt)$/i.test(p) || /(^|\/)readme$/i.test(p)) {
    r.history.push({ path: r.path, top: $('#mdScroll').scrollTop });
    r.path = p;
    loadReadme().then(() => { if (hash) scrollToAnchor('md-' + decodeURIComponent(hash)); });
    return;
  }
  toast(`${p} is a file in the project: open it from your editor.`);
}
function scrollToAnchor(id, box = $('#mdScroll')) {
  const t = document.getElementById(id) || box.querySelector(`[name="${CSS.escape(id)}"]`);
  if (!t) return;
  box.scrollTop += t.getBoundingClientRect().top - box.getBoundingClientRect().top - 8;
}

// ---------- writing ----------
/** A first README: the project's name, what to fill in, and how to run it (from the environment's launchers). */
function readmeTemplate(e) {
  const runs = (e.launchers || []).filter((l) => l.command);
  const run = runs.length
    ? runs.map((l) => `${runs.length > 1 ? `**${l.name}**${l.cwd ? ` (in \`${l.cwd}\`)` : ''}:\n\n` : ''}\`\`\`bash\n${l.command}\n\`\`\``).join('\n\n')
    : '```bash\n# the command that starts the project, e.g.\nnpm install\nnpm run dev\n```';
  return `# ${e.name}

One or two sentences about what this project does and who it's for.

## Getting started

### Requirements

- List what needs to be installed first (e.g. Node.js 20+)

### Run it

${run}

## Usage

Explain how to use it, with an example.

## Project structure

| Folder | What's in it |
| ------ | ------------ |
| \`src\` | The source code |

## License

State the license here.
`;
}

function startEdit({ create = false } = {}) {
  const e = env();
  if (!e) return;
  const d = S.readme.data;
  if (create) {
    S.mdEdits.set(e.id, { path: 'README.md', text: readmeTemplate(e), original: '', baseModified: 0, create: true });
  } else {
    if (!d?.found) return;
    S.mdEdits.set(e.id, { path: d.path, text: d.content, original: d.content, baseModified: d.modified, create: false });
  }
  renderReadme();
  const ta = $('#mdText');
  ta.focus();
  ta.setSelectionRange(0, 0);
  ta.scrollTop = 0;
}

function renderEditor(ed) {
  const view = store.get('mdEditView', 'split');
  const dirty = mdDirty(ed);
  $('#mdBar').innerHTML = `
    <span class="md-file mono" title="${h(ed.path)}">✏️ ${ed.create ? 'New ' : 'Editing '}${h(ed.path)}</span>
    ${dirty ? '<span class="md-dirty" title="Not saved yet">● Unsaved</span>' : '<span class="muted small-text">No changes</span>'}
    <span class="grow"></span>
    <div class="seg" role="group" aria-label="Layout">
      <button type="button" class="${view === 'write' ? 'active' : ''}" data-md="view-write" title="Only the Markdown">Write</button>
      <button type="button" class="${view === 'split' ? 'active' : ''}" data-md="view-split" title="Markdown and preview side by side">Split</button>
      <button type="button" class="${view === 'preview' ? 'active' : ''}" data-md="view-preview" title="Only the preview">Preview</button>
    </div>
    <button class="ghost" data-md="cancel" title="Close the editor without saving">Cancel</button>
    <button class="primary" data-md="save" title="Save to ${h(ed.path)} (Ctrl+S)" ${dirty ? '' : 'disabled'}>${ed.create ? 'Create file' : 'Save'}</button>`;
  $('#mdPanes').className = `md-panes ${view}`;
  $('#mdToolbar').classList.toggle('off', view === 'preview');
  const ta = $('#mdText');
  if (ta.value !== ed.text) ta.value = ed.text;
  renderPreview();
}
function renderPreview() {
  const ed = mdEditing();
  if (!ed || store.get('mdEditView', 'split') === 'write') return;
  const box = $('#mdPrevWrap');
  const top = box.scrollTop;
  $('#mdPrev').replaceChildren(MD.render(ed.text, mdOpts(env().id, ed.path)));
  box.scrollTop = top;
}
/** Just the bar's state (unsaved dot, Save enabled), without touching the textarea. */
function refreshEditBar() {
  const ed = mdEditing();
  if (!ed) return;
  const dirty = mdDirty(ed);
  const flag = $('#mdBar .md-dirty, #mdBar .muted.small-text');
  if (flag) flag.outerHTML = dirty ? '<span class="md-dirty" title="Not saved yet">● Unsaved</span>' : '<span class="muted small-text">No changes</span>';
  const save = $('#mdBar [data-md="save"]');
  if (save) save.disabled = !dirty;
}

async function saveEdit(force = false) {
  const e = env();
  const ed = mdEditing();
  if (!e || !ed) return;
  const btn = $('#mdBar [data-md="save"]');
  if (btn) btn.disabled = true;
  try {
    const r = await api('POST', `/api/envs/${e.id}/doc`, { path: ed.path, content: ed.text, create: ed.create, baseModified: ed.baseModified, force });
    S.mdEdits.delete(e.id);
    S.readme.path = r.path;
    S.readme.data = { found: true, path: r.path, content: ed.text, modified: r.modified, size: r.size };
    S.readme.error = '';
    toast(ed.create ? `Created ${r.path}` : `Saved ${r.path}`);
    renderReadme();
  } catch (err) {
    if (btn) btn.disabled = false;
    if (err.data?.code === 'CHANGED') {
      const ok = await confirmBox({ title: 'The file changed on disk', text: `${ed.path} was changed outside MC Dev Hub (in your editor, or by git) since you started editing.\n\nSaving replaces that version with yours.`, ok: 'Save mine anyway', danger: true });
      if (ok === 'ok') return saveEdit(true);
      return;
    }
    if (err.data?.code === 'GONE') { ed.create = true; return saveEdit(); } // deleted meanwhile: write it again
    fail(err);
  }
}
async function cancelEdit() {
  const e = env();
  const ed = mdEditing();
  if (!e || !ed) return;
  if (mdDirty(ed)) { // a new file counts as unsaved until it's created
    const ok = await confirmBox({ title: ed.create ? 'Discard the new README?' : 'Discard your changes?', text: ed.create ? 'Nothing has been saved: README.md won\'t be created.' : `Your edits to ${ed.path} aren't saved and will be lost.`, ok: 'Discard', danger: true });
    if (ok !== 'ok') return;
  }
  S.mdEdits.delete(e.id);
  renderReadme();
}

// ---------- formatting toolbar ----------
/** Replaces [from, to) with text (keeps Ctrl+Z working), then selects [selFrom, selTo) inside the new text. */
function mdReplace(ta, from, to, text, selFrom = text.length, selTo = selFrom) {
  ta.focus();
  ta.setSelectionRange(from, to);
  if (!document.execCommand('insertText', false, text)) ta.setRangeText(text, from, to, 'end');
  ta.setSelectionRange(from + selFrom, from + selTo);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}
function mdWrap(ta, before, after, placeholder) {
  const { selectionStart: s, selectionEnd: e, value: v } = ta;
  const sel = v.slice(s, e);
  if (sel && v.slice(s - before.length, s) === before && v.slice(e, e + after.length) === after) { // already wrapped: unwrap
    return mdReplace(ta, s - before.length, e + after.length, sel, 0, sel.length);
  }
  const t = sel || placeholder;
  mdReplace(ta, s, e, before + t + after, before.length, before.length + t.length);
}
/** Applies fn to each whole line touched by the selection. */
function mdLines(ta, fn) {
  const { selectionStart: s, selectionEnd: e, value: v } = ta;
  const ls = v.lastIndexOf('\n', s - 1) + 1;
  let le = v.indexOf('\n', e > s && v[e - 1] === '\n' ? e - 1 : e);
  if (le < 0) le = v.length;
  const out = fn(v.slice(ls, le).split('\n')).join('\n');
  mdReplace(ta, ls, le, out, 0, out.length);
}
const LIST_MARK = /^(\s*)(?:[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/;
function mdTogglePrefix(ta, prefix, test) {
  mdLines(ta, (lines) => {
    const all = lines.filter((l) => l.trim()).every((l) => test.test(l));
    return lines.map((l) => (!l.trim() ? l : all ? l.replace(test, '$1') : l.replace(LIST_MARK, '$1').replace(/^(\s*)/, `$1${prefix}`)));
  });
}
/** Inserts a block on its own lines, with a blank line before and after. */
function mdBlock(ta, text, selFrom, selTo) {
  const { selectionStart: s, selectionEnd: e, value: v } = ta;
  const pre = s === 0 ? '' : v.slice(0, s).endsWith('\n\n') ? '' : v.slice(0, s).endsWith('\n') ? '\n' : '\n\n';
  const post = v.slice(e).startsWith('\n\n') ? '' : v.slice(e).startsWith('\n') ? '\n' : '\n\n';
  mdReplace(ta, s, e, pre + text + post, pre.length + (selFrom ?? text.length), pre.length + (selTo ?? selFrom ?? text.length));
}
function mdFormat(kind) {
  const ta = $('#mdText');
  const { selectionStart: s, selectionEnd: e, value: v } = ta;
  const sel = v.slice(s, e);
  switch (kind) {
    case 'h1': case 'h2': case 'h3': {
      const n = +kind[1];
      return mdLines(ta, (lines) => lines.map((l) => {
        const m = /^(#{1,6})\s+/.exec(l);
        const body = l.replace(/^#{1,6}\s+/, '');
        return m && m[1].length === n ? body : '#'.repeat(n) + ' ' + (body || 'Heading');
      }));
    }
    case 'bold': return mdWrap(ta, '**', '**', 'bold text');
    case 'italic': return mdWrap(ta, '*', '*', 'italic text');
    case 'strike': return mdWrap(ta, '~~', '~~', 'struck text');
    case 'code': return sel.includes('\n') ? mdFormat('codeblock') : mdWrap(ta, '`', '`', 'code');
    case 'link': {
      if (/^(https?:\/\/|www\.)\S+$/.test(sel)) return mdReplace(ta, s, e, `[link text](${sel})`, 1, 10);
      const t = sel || 'link text';
      return mdReplace(ta, s, e, `[${t}](https://)`, t.length + 3, t.length + 11);
    }
    case 'image': {
      const alt = sel || 'description';
      return mdReplace(ta, s, e, `![${alt}](images/picture.png)`, alt.length + 4, alt.length + 22);
    }
    case 'ul': return mdTogglePrefix(ta, '- ', /^(\s*)[-*+]\s+(?!\[[ xX]\])/);
    case 'task': return mdTogglePrefix(ta, '- [ ] ', /^(\s*)[-*+]\s+\[[ xX]\]\s+/);
    case 'quote': return mdTogglePrefix(ta, '> ', /^(\s*)>\s?/);
    case 'ol': return mdLines(ta, (lines) => {
      const all = lines.filter((l) => l.trim()).every((l) => /^\s*\d+[.)]\s+/.test(l));
      let k = 0;
      return lines.map((l) => (!l.trim() ? l : all ? l.replace(/^(\s*)\d+[.)]\s+/, '$1') : l.replace(LIST_MARK, '$1').replace(/^(\s*)/, `$1${++k}. `)));
    });
    case 'codeblock': {
      if (sel) return mdBlock(ta, '```\n' + sel.replace(/\n$/, '') + '\n```', 3, 3);
      return mdBlock(ta, '```bash\n\n```', 3, 7); // "bash" selected: type the language, or keep it
    }
    case 'table': return mdBlock(ta, '| Column 1 | Column 2 |\n| -------- | -------- |\n| Cell     | Cell     |', 2, 10);
    case 'note': return mdBlock(ta, `> [!NOTE]\n> ${sel || 'Something worth knowing.'}`, 12, 12 + (sel || 'Something worth knowing.').length);
    case 'hr': return mdBlock(ta, '---');
  }
}

/** Enter continues a list ("- ", "1. ", "- [ ] ", "> "); on an empty item it ends the list instead. */
function mdEnter(ta, ev) {
  const { selectionStart: s, selectionEnd: e, value: v } = ta;
  if (s !== e) return;
  const ls = v.lastIndexOf('\n', s - 1) + 1;
  const line = v.slice(ls, s);
  const m = /^(\s*)([-*+] \[[ xX]\] |[-*+] |(\d+)([.)]) |> )/.exec(line);
  if (!m) return;
  ev.preventDefault();
  if (line.trim() === m[2].trim()) return mdReplace(ta, ls, s, m[1]); // empty item: end the list
  const next = m[3] ? `${+m[3] + 1}${m[4]} ` : m[2].replace(/\[[xX]\]/, '[ ]');
  mdReplace(ta, s, e, '\n' + m[1] + next);
}
function mdIndent(ta, out) {
  const { selectionStart: s, selectionEnd: e } = ta;
  if (s === e && !out) return mdReplace(ta, s, e, '  ');
  mdLines(ta, (lines) => lines.map((l) => (out ? l.replace(/^ {1,2}|^\t/, '') : '  ' + l)));
}

// ---------- events ----------
$('#tab-readme').addEventListener('click', (ev) => {
  const f = ev.target.closest('[data-fmt]');
  if (f) { mdFormat(f.dataset.fmt); return; }
  const b = ev.target.closest('[data-md]');
  if (b) {
    const a = b.dataset.md;
    if (a.startsWith('view-')) {
      store.set('mdEditView', a.slice(5));
      const ed = mdEditing();
      if (ed) renderEditor(ed);
      if (a !== 'view-preview') $('#mdText').focus();
      return;
    }
    switch (a) {
      case 'rendered': store.set('mdRaw', false); return renderReadme();
      case 'raw': store.set('mdRaw', true); return renderReadme();
      case 'refresh': return loadReadme({ keepScroll: true });
      case 'copy': return navigator.clipboard.writeText(S.readme.data?.content || '').then(() => toast('Copied'), () => fail(new Error('Clipboard unavailable')));
      case 'edit': return startEdit();
      case 'create': return startEdit({ create: true });
      case 'save': return saveEdit();
      case 'cancel': return cancelEdit();
      case 'back': {
        const prev = S.readme.history.pop();
        if (!prev) return;
        S.readme.path = prev.path;
        return loadReadme().then(() => { $('#mdScroll').scrollTop = prev.top; });
      }
    }
    return;
  }
  const anchor = ev.target.closest('[data-md-anchor]');
  if (anchor) { ev.preventDefault(); return scrollToAnchor(anchor.dataset.mdAnchor); }
  const link = ev.target.closest('#mdDoc a[href], #mdPrev a[href]');
  if (link) {
    ev.preventDefault();
    const href = link.getAttribute('href');
    if (link.closest('#mdPrev')) { // in the editor's preview: only jump within it, or open web links
      if (href.startsWith('#')) scrollToAnchor('md-' + decodeURIComponent(href.slice(1)), $('#mdPrevWrap'));
      else if (/^(https?:|mailto:)/i.test(href)) api('POST', '/api/open-url', { url: href }).then(() => toast('Opened in your browser'), fail);
      return;
    }
    openMdLink(href);
  }
});
let mdPrevTimer;
$('#mdText').addEventListener('input', (ev) => {
  const ed = mdEditing();
  if (!ed) return;
  ed.text = ev.target.value;
  refreshEditBar();
  clearTimeout(mdPrevTimer);
  mdPrevTimer = setTimeout(renderPreview, 150);
});
$('#mdText').addEventListener('keydown', (ev) => {
  const ta = ev.target;
  const k = ev.key.toLowerCase();
  if (ev.ctrlKey || ev.metaKey) {
    if (k === 's') { ev.preventDefault(); return saveEdit(); }
    if (k === 'b') { ev.preventDefault(); return mdFormat('bold'); }
    if (k === 'i') { ev.preventDefault(); return mdFormat('italic'); }
    if (k === 'k') { ev.preventDefault(); return mdFormat('link'); }
    return;
  }
  if (ev.key === 'Enter' && !ev.shiftKey && !ev.altKey) return mdEnter(ta, ev);
  if (ev.key === 'Tab') { ev.preventDefault(); return mdIndent(ta, ev.shiftKey); }
});
// in Split view the preview follows the textarea's scroll position
$('#mdText').addEventListener('scroll', () => {
  if (store.get('mdEditView', 'split') !== 'split') return;
  const ta = $('#mdText');
  const box = $('#mdPrevWrap');
  const f = ta.scrollTop / Math.max(1, ta.scrollHeight - ta.clientHeight);
  box.scrollTop = f * (box.scrollHeight - box.clientHeight);
}, { passive: true });
document.addEventListener('keydown', (ev) => { // Ctrl+S anywhere in the README tab while editing
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's' && S.tab === 'readme' && mdEditing() && ev.target.id !== 'mdText') { ev.preventDefault(); saveEdit(); }
});
// the file may have been edited meanwhile: reload it when coming back to the app (not while editing it here)
window.addEventListener('focus', () => { if (S.tab === 'readme' && S.readme.data && !mdEditing()) loadReadme({ keepScroll: true }); });
// unsaved README edits: ask before the window closes or reloads
window.addEventListener('beforeunload', (ev) => { if ([...S.mdEdits.values()].some(mdDirty)) { ev.preventDefault(); ev.returnValue = ''; } });
