// Tiny ANSI (SGR) to HTML converter for the console. Colors, bold, dim, italic and underline;
// cursor movement / erase codes and OSC links are stripped.
(function () {
  const BASE = ['#3b4252', '#ff6b6b', '#5fd38d', '#f1cf7a', '#6fa8ff', '#d68bff', '#56d4dd', '#d7e1f0'];
  const BRIGHT = ['#7d8899', '#ff8f8f', '#86efac', '#fde68a', '#93c5fd', '#e9b5ff', '#8be9f0', '#ffffff'];
  const esc = (s) => s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));

  function c256(n) {
    if (n < 8) return BASE[n];
    if (n < 16) return BRIGHT[n - 8];
    if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
    n -= 16;
    const f = (x) => (x ? x * 40 + 55 : 0);
    return `rgb(${f(Math.floor(n / 36))},${f(Math.floor(n / 6) % 6)},${f(n % 6)})`;
  }

  function toHtml(input) {
    // drop OSC sequences (titles, hyperlinks) and non-SGR CSI sequences
    const text = input.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[A-Za-ln-z]/g, '').replace(/\x1b[()][0-9A-B]/g, '');
    let out = '', st = {}, open = false;
    const re = /\x1b\[([0-9;]*)m/g;
    let last = 0, m;
    const flush = (chunk) => {
      if (!chunk) return;
      const css = [];
      if (st.fg) css.push(`color:${st.fg}`);
      if (st.bg) css.push(`background:${st.bg}`);
      if (st.b) css.push('font-weight:700');
      if (st.d) css.push('opacity:.65');
      if (st.i) css.push('font-style:italic');
      if (st.u) css.push('text-decoration:underline');
      out += css.length ? `<span style="${css.join(';')}">${esc(chunk)}</span>` : esc(chunk);
    };
    while ((m = re.exec(text))) {
      flush(text.slice(last, m.index));
      last = re.lastIndex;
      const codes = m[1] === '' ? [0] : m[1].split(';').map(Number);
      for (let i = 0; i < codes.length; i++) {
        const c = codes[i];
        if (c === 0) st = {};
        else if (c === 1) st.b = true;
        else if (c === 2) st.d = true;
        else if (c === 3) st.i = true;
        else if (c === 4) st.u = true;
        else if (c === 22) { st.b = false; st.d = false; }
        else if (c === 23) st.i = false;
        else if (c === 24) st.u = false;
        else if (c >= 30 && c <= 37) st.fg = BASE[c - 30];
        else if (c >= 90 && c <= 97) st.fg = BRIGHT[c - 90];
        else if (c === 39) st.fg = null;
        else if (c >= 40 && c <= 47) st.bg = BASE[c - 40];
        else if (c >= 100 && c <= 107) st.bg = BRIGHT[c - 100];
        else if (c === 49) st.bg = null;
        else if (c === 38 || c === 48) {
          let col = null;
          if (codes[i + 1] === 5) { col = c256(codes[i + 2] || 0); i += 2; }
          else if (codes[i + 1] === 2) { col = `rgb(${codes[i + 2] || 0},${codes[i + 3] || 0},${codes[i + 4] || 0})`; i += 4; }
          if (c === 38) st.fg = col; else st.bg = col;
        }
      }
    }
    flush(text.slice(last));
    return out.replace(/\x1b/g, '');
  }

  window.ansiToHtml = toHtml;
  window.stripAnsi = (s) => s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
})();
