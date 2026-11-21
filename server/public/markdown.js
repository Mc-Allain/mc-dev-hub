'use strict';
/* A compact GitHub-flavoured Markdown renderer for the README tab, plus an allow-list HTML sanitizer.
 * Covers what READMEs use: headings, paragraphs, emphasis, links, images, code (fenced/indented/inline),
 * lists (nested, task lists), block quotes, tables, rules, line breaks, and the inline HTML READMEs often
 * contain (<p align="center"><img>, <details>, <kbd>…). Anything not on the allow-list is removed. */

const MD = (() => {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const escText = (s) => String(s).replace(/&(?!#?\w+;)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // ---------- inline ----------
  function inline(src, refs) {
    const keep = [];
    const hold = (html) => `\u0000${keep.push(html) - 1}\u0000`;
    let s = src;
    s = s.replace(/\\([\\`*_{}[\]()#+\-.!|~<>"])/g, (m, c) => hold(esc(c))); // backslash escapes
    s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (m, t, code) => hold(`<code>${esc(code.replace(/^ (.*) $/, '$1'))}</code>`));
    s = s.replace(/<(https?:\/\/[^\s<>]+|mailto:[^\s<>]+)>/g, (m, u) => hold(`<a href="${esc(u)}">${esc(u.replace(/^mailto:/, ''))}</a>`));
    s = s.replace(/<\/?[A-Za-z][\w-]*(?:\s+[^<>]*)?\/?>|<!--[\s\S]*?-->/g, (m) => hold(m)); // inline HTML: the sanitizer decides
    s = escText(s);
    // images and links, inline [text](url "title") or reference [text][ref] / [text]
    const target = (url, title) => ` ${'\u0001'}="${esc(url)}"${title ? ` title="${esc(title)}"` : ''}`;
    const linkRe = /(!?)\[((?:\[[^\]]*\]|[^\]])*)\]\(\s*<?([^\s)>]*)>?(?:\s+(?:"([^"]*)"|'([^']*)'))?\s*\)/g;
    s = s.replace(linkRe, (m, bang, text, url, t1, t2) => {
      const t = t1 ?? t2;
      return bang ? hold(`<img alt="${esc(text.replace(/\u0000\d+\u0000/g, ''))}"${target(url, t).replace('\u0001', 'src')}>`)
        : hold(`<a${target(url, t).replace('\u0001', 'href')}>`) + text + hold('</a>'); // tags held: "_" in a URL isn't emphasis
    });
    s = s.replace(/(!?)\[((?:\[[^\]]*\]|[^\]])+)\](?:\[([^\]]*)\])?/g, (m, bang, text, ref) => {
      const r = refs[(ref || text).toLowerCase().replace(/\s+/g, ' ').trim()];
      if (!r) return m;
      return bang ? hold(`<img alt="${esc(text)}"${target(r.url, r.title).replace('\u0001', 'src')}>`) : hold(`<a${target(r.url, r.title).replace('\u0001', 'href')}>`) + text + hold('</a>');
    });
    // bare links (GitHub autolinks them)
    s = s.replace(/(^|[\s(])((?:https?:\/\/|www\.)[^\s<]*[^\s<.,:;"')\]])/g, (m, pre, u) => pre + hold(`<a href="${u.startsWith('www.') ? 'https://' + u : u}">${u}</a>`));
    // emphasis
    s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>');
    s = s.replace(/(^|[^\w*])\*(?=\S)([\s\S]*?\S)\*(?!\*)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^\w_])_(?=\S)([\s\S]*?\S)_(?![\w_])/g, '$1<em>$2</em>');
    s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
    // hard line breaks: two trailing spaces or a backslash before the newline
    s = s.replace(/(?: {2,}|\\)\n/g, '<br>\n');
    return s.replace(/\u0000(\d+)\u0000/g, (m, i) => keep[+i]).replace(/\u0000(\d+)\u0000/g, (m, i) => keep[+i]);
  }

  // ---------- blocks ----------
  const isBlank = (l) => !l.trim();
  const fenceRe = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
  const hrRe = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
  const headRe = /^ {0,3}(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*$/;
  const listRe = /^( {0,3})([-*+]|\d{1,9}[.)])(\s+|$)/;
  const quoteRe = /^ {0,3}> ?/;
  const tableSepRe = /^ {0,3}\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
  const htmlBlockRe = /^ {0,3}<(\/?)([A-Za-z][\w-]*)([\s>/]|$)|^ {0,3}<!--/;

  function splitRow(line) {
    let l = line.trim();
    if (l.startsWith('|')) l = l.slice(1);
    if (l.endsWith('|') && !l.endsWith('\\|')) l = l.slice(0, -1);
    const cells = [];
    let cur = '', code = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (c === '\\' && l[i + 1] === '|') { cur += '|'; i++; continue; }
      if (c === '`') code = !code;
      if (c === '|' && !code) { cells.push(cur.trim()); cur = ''; } else cur += c;
    }
    cells.push(cur.trim());
    return cells;
  }

  function blocks(lines, refs) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (isBlank(line)) { i++; continue; }
      let m;
      // fenced code
      if ((m = fenceRe.exec(line))) {
        const fence = m[1], lang = m[2];
        const indent = line.match(/^ */)[0].length;
        const body = [];
        i++;
        while (i < lines.length && !new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(lines[i])) body.push(lines[i++].replace(new RegExp(`^ {0,${indent}}`), ''));
        i++;
        out.push(`<pre><code${lang ? ` class="language-${esc(lang)}"` : ''}>${esc(body.join('\n'))}</code></pre>`);
        continue;
      }
      // heading
      if ((m = headRe.exec(line))) { out.push(`<h${m[1].length}>${inline(m[2] || '', refs)}</h${m[1].length}>`); i++; continue; }
      // rule
      if (hrRe.test(line)) { out.push('<hr>'); i++; continue; }
      // indented code
      if (/^( {4}|\t)/.test(line)) {
        const body = [];
        while (i < lines.length && (/^( {4}|\t)/.test(lines[i]) || isBlank(lines[i]))) body.push(lines[i++].replace(/^( {4}|\t)/, ''));
        while (body.length && isBlank(body[body.length - 1])) body.pop();
        out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
        continue;
      }
      // block quote
      if (quoteRe.test(line)) {
        const body = [];
        while (i < lines.length && !isBlank(lines[i]) && (quoteRe.test(lines[i]) || !body.length || !isBlock(lines[i]))) body.push(lines[i++].replace(quoteRe, ''));
        const inner = blocks(body, refs).join('\n');
        // GitHub alerts: > [!NOTE] / [!TIP] / [!IMPORTANT] / [!WARNING] / [!CAUTION]
        const alert = /^<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:<br>)?\s*/i.exec(inner);
        if (alert) {
          const kind = alert[1].toLowerCase();
          out.push(`<div class="md-alert md-alert-${kind}"><p class="md-alert-title">${kind[0].toUpperCase() + kind.slice(1)}</p>${inner.replace(alert[0], '<p>').replace(/^<p><\/p>/, '')}</div>`);
        } else out.push(`<blockquote>${inner}</blockquote>`);
        continue;
      }
      // list
      if ((m = listRe.exec(line))) { i = list(lines, i, refs, out); continue; }
      // table: a header row, then a separator row
      if (line.includes('|') && i + 1 < lines.length && tableSepRe.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        const head = splitRow(line);
        const align = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /^-+:$/.test(c) ? 'right' : /^:-+$/.test(c) ? 'left' : ''));
        i += 2;
        const rows = [];
        while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|')) rows.push(splitRow(lines[i++]));
        const cell = (tag, c, k) => `<${tag}${align[k] ? ` align="${align[k]}"` : ''}>${inline(c, refs)}</${tag}>`;
        out.push(`<table><thead><tr>${head.map((c, k) => cell('th', c, k)).join('')}</tr></thead>`
          + `<tbody>${rows.map((r) => `<tr>${head.map((_, k) => cell('td', r[k] ?? '', k)).join('')}</tr>`).join('')}</tbody></table>`);
        continue;
      }
      // raw HTML block: up to a blank line
      if (htmlBlockRe.test(line)) {
        const body = [];
        while (i < lines.length && !isBlank(lines[i])) body.push(lines[i++]);
        out.push(body.join('\n'));
        continue;
      }
      // paragraph (or a setext heading underlined with === / ---)
      const para = [];
      while (i < lines.length && !isBlank(lines[i])) {
        if (para.length && /^ {0,3}=+\s*$/.test(lines[i])) { out.push(`<h1>${inline(para.join('\n'), refs)}</h1>`); para.length = 0; i++; break; }
        if (para.length && /^ {0,3}-+\s*$/.test(lines[i])) { out.push(`<h2>${inline(para.join('\n'), refs)}</h2>`); para.length = 0; i++; break; }
        if (para.length && isBlock(lines[i])) break;
        para.push(lines[i++].replace(/^ {0,3}/, ''));
      }
      if (para.length) out.push(`<p>${inline(para.join('\n'), refs)}</p>`);
    }
    return out;
  }
  // a line that starts a new block (ends a paragraph)
  const isBlock = (l) => fenceRe.test(l) || headRe.test(l) || hrRe.test(l) || quoteRe.test(l) || listRe.test(l) || /^ {0,3}<(?:div|p|details|table|h\d|img|picture|br|hr)\b/i.test(l);

  function list(lines, i, refs, out) {
    const first = listRe.exec(lines[i]);
    const ordered = /\d/.test(first[2]);
    const start = ordered ? parseInt(first[2], 10) : 1;
    const items = [];
    let loose = false;
    while (i < lines.length) {
      const m = listRe.exec(lines[i]);
      if (!m || /\d/.test(m[2]) !== ordered) break;
      const contentIndent = m[0].length;
      const body = [lines[i].slice(contentIndent)];
      i++;
      let sawBlank = false;
      while (i < lines.length) {
        const l = lines[i];
        if (isBlank(l)) { sawBlank = true; body.push(''); i++; continue; }
        const ind = l.match(/^ */)[0].length;
        if (ind >= Math.min(contentIndent, 4) || (ind >= 2 && listRe.test(l.slice(Math.min(ind, contentIndent))))) {
          body.push(l.slice(Math.min(ind, contentIndent)));
          if (sawBlank && !listRe.test(l.trim())) loose = true;
          sawBlank = false; i++; continue;
        }
        if (!sawBlank && !isBlock(l)) { body.push(l.trim()); i++; continue; } // lazy continuation
        break;
      }
      while (body.length && isBlank(body[body.length - 1])) body.pop();
      const nextItem = i < lines.length && listRe.exec(lines[i]);
      if (sawBlank && nextItem && /\d/.test(nextItem[2]) === ordered) loose = true; // a blank line between items of this same list
      items.push(body);
    }
    const html = items.map((body) => {
      let task = '';
      const t = /^\[([ xX])\]\s+/.exec(body[0]);
      if (t) { task = `<input type="checkbox" disabled${t[1] !== ' ' ? ' checked' : ''}> `; body[0] = body[0].slice(t[0].length); }
      let inner = blocks(body, refs).join('\n');
      if (!loose) inner = inner.replace(/^<p>([\s\S]*?)<\/p>/, '$1').replace(/\n<p>([\s\S]*?)<\/p>/g, '\n$1');
      return `<li${task ? ' class="task"' : ''}>${task}${inner}</li>`;
    }).join('\n');
    out.push(ordered ? `<ol${start !== 1 ? ` start="${start}"` : ''}>${html}</ol>` : `<ul${html.includes('class="task"') ? ' class="tasks"' : ''}>${html}</ul>`);
    return i;
  }

  // ---------- sanitizer: only these tags and attributes survive ----------
  const TAGS = new Set('a abbr b blockquote br code dd del details div dl dt em figcaption figure h1 h2 h3 h4 h5 h6 hr i img input kbd li mark ol p picture pre q s samp small source span strike strong sub summary sup table tbody td tfoot th thead tr tt u ul var center'.split(' '));
  const DROP = new Set('script style iframe object embed form button textarea select link meta base svg math template noscript frame frameset applet'.split(' '));
  const ATTRS = { '*': ['title', 'align', 'id', 'name', 'lang', 'dir'], a: ['href'], img: ['src', 'alt', 'width', 'height'], source: ['srcset', 'media', 'type'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'], ol: ['start', 'type'], details: ['open'], input: ['type', 'checked', 'disabled'], code: ['class'], li: ['class'], ul: ['class'], div: ['class'], p: ['class'] };
  const safeUrl = (u, img) => {
    const v = String(u || '').trim();
    if (/^(https?:|mailto:|#)/i.test(v)) return true;
    if (img && /^data:image\/(png|gif|jpe?g|webp);/i.test(v)) return true;
    return !/^[a-z][\w+.-]*:/i.test(v) && !v.startsWith('//'); // relative paths only otherwise
  };
  function clean(node) {
    for (const el of [...node.children]) {
      const tag = el.tagName.toLowerCase();
      if (DROP.has(tag)) { el.remove(); continue; }
      if (!TAGS.has(tag)) { clean(el); el.replaceWith(...el.childNodes); continue; }
      const ok = new Set([...ATTRS['*'], ...(ATTRS[tag] || [])]);
      for (const a of [...el.attributes]) {
        const n = a.name.toLowerCase();
        if (!ok.has(n)) { el.removeAttribute(a.name); continue; }
        if ((n === 'href' || n === 'src') && !safeUrl(a.value, n === 'src')) el.removeAttribute(a.name);
        if (n === 'srcset' && a.value.split(',').some((p) => !safeUrl(p.trim().split(/\s+/)[0], true))) el.removeAttribute(a.name);
        if (n === 'class' && !/^(language-[\w+#-]+|task|tasks|md-alert[\w -]*)$/.test(a.value)) el.removeAttribute(a.name);
      }
      if (tag === 'input' && el.getAttribute('type') !== 'checkbox') { el.remove(); continue; }
      if (tag === 'input') el.setAttribute('disabled', '');
      clean(el);
    }
    // comments go too
    for (const c of [...node.childNodes]) if (c.nodeType === 8) c.remove();
  }

  /** GitHub's heading anchors: lower case, spaces to dashes, punctuation dropped; repeats get -1, -2… */
  function slugger() {
    const seen = new Map();
    return (text) => {
      let s = text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
      const n = seen.get(s) || 0;
      seen.set(s, n + 1);
      return n ? `${s}-${n}` : s;
    };
  }

  /** Markdown -> a sanitized DocumentFragment. opts.src(url) / opts.href(url) rewrite relative images and links. */
  function render(markdown, opts = {}) {
    const text = String(markdown).replace(/\r\n?/g, '\n').replace(/^﻿/, '');
    const refs = {};
    const lines = [];
    let inFence = false;
    for (const l of text.split('\n')) { // pull out [ref]: url "title" definitions (not inside code)
      if (fenceRe.test(l)) inFence = !inFence;
      const m = !inFence && /^ {0,3}\[([^\]]+)\]:\s*<?(\S+?)>?(?:\s+["'(](.*)["')])?\s*$/.exec(l);
      if (m) refs[m[1].toLowerCase().replace(/\s+/g, ' ').trim()] = { url: m[2], title: m[3] };
      else lines.push(l.replace(/\t/g, '    '));
    }
    const html = blocks(lines, refs).join('\n');
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    clean(doc.body);
    const slug = slugger();
    for (const hd of doc.body.querySelectorAll('h1, h2, h3, h4, h5, h6')) { hd.id = 'md-' + slug(hd.textContent); }
    for (const el of doc.body.querySelectorAll('[id]:not(h1):not(h2):not(h3):not(h4):not(h5):not(h6), [name]')) { // keep user anchors from clashing with the page
      if (el.id) el.id = 'md-' + el.id;
      if (el.getAttribute('name')) el.setAttribute('name', 'md-' + el.getAttribute('name'));
    }
    for (const img of doc.body.querySelectorAll('img[src], source[srcset]')) {
      if (img.hasAttribute('src')) img.setAttribute('src', opts.src ? opts.src(img.getAttribute('src')) : img.getAttribute('src'));
      if (img.hasAttribute('srcset')) img.setAttribute('srcset', img.getAttribute('srcset').split(',').map((p) => { const [u, ...rest] = p.trim().split(/\s+/); return [opts.src ? opts.src(u) : u, ...rest].join(' '); }).join(', '));
      img.setAttribute('loading', 'lazy');
    }
    const frag = document.createDocumentFragment();
    frag.append(...doc.body.childNodes);
    return frag;
  }

  return { render };
})();
