'use strict';
/* cURL command → request. Understands what people paste: Chrome/Edge "Copy as cURL" (bash and cmd),
 * PowerShell / bash / cmd line continuations, and the common curl options. */

// options that take a value (both spellings), and options that are fine to ignore
const CURL_ARG = new Set(['-X', '--request', '-H', '--header', '-d', '--data', '--data-ascii', '--data-raw', '--data-binary', '--data-urlencode', '--json',
  '-F', '--form', '--form-string', '-u', '--user', '-b', '--cookie', '-A', '--user-agent', '-e', '--referer', '--url', '-o', '--output',
  '-m', '--max-time', '--connect-timeout', '-w', '--write-out', '-x', '--proxy', '-T', '--upload-file', '-c', '--cookie-jar', '--retry', '-r', '--range',
  '--cacert', '--cert', '--key', '--resolve', '--limit-rate', '-K', '--config', '-E', '-y', '-Y', '-z']);
const CURL_SHORT_ARG = new Set(['X', 'H', 'd', 'F', 'u', 'b', 'A', 'e', 'o', 'm', 'w', 'x', 'T', 'c', 'r', 'K', 'E', 'y', 'Y', 'z']);

/** Splits a shell command line into words: '…', "…", $'…' (bash), backslash escapes. */
function curlWords(src) {
  const words = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    while (i < n && /\s/.test(src[i])) i++;
    if (i >= n) break;
    let w = '';
    let any = false;
    while (i < n && !/\s/.test(src[i])) {
      const c = src[i];
      any = true;
      if (c === "'") {
        const j = src.indexOf("'", i + 1);
        w += src.slice(i + 1, j < 0 ? n : j);
        i = j < 0 ? n : j + 1;
      } else if (c === '$' && src[i + 1] === "'") { // bash ANSI-C quoting, used by Chrome for bodies with special characters
        i += 2;
        while (i < n && src[i] !== "'") {
          if (src[i] === '\\' && i + 1 < n) {
            const e = src[i + 1];
            const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '0': '\0', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v' };
            if (e === 'x') { w += String.fromCharCode(parseInt(src.substr(i + 2, 2), 16)); i += 4; continue; }
            if (e === 'u') { w += String.fromCharCode(parseInt(src.substr(i + 2, 4), 16)); i += 6; continue; }
            if (e === 'U') { w += String.fromCodePoint(parseInt(src.substr(i + 2, 8), 16)); i += 10; continue; }
            w += map[e] ?? e;
            i += 2;
          } else w += src[i++];
        }
        i++;
      } else if (c === '"') {
        i++;
        while (i < n && src[i] !== '"') {
          if (src[i] === '\\' && i + 1 < n && '"\\$`'.includes(src[i + 1])) { w += src[i + 1]; i += 2; } else w += src[i++];
        }
        i++;
      } else if (c === '\\' && i + 1 < n) {
        w += src[i + 1];
        i += 2;
      } else w += src[i++];
    }
    if (any) words.push(w);
  }
  return words;
}

/** Undoes Windows cmd escaping (Chrome's "Copy as cURL (cmd)"): ^" ^& ^% ^^ and ^ line breaks. */
function uncaret(s) {
  return s.replace(/\^\r?\n/g, ' ').replace(/\^(.)/g, '$1');
}

/**
 * Parses a curl command. Returns { method, url, headers: [{k, v, on}], body, bodyMode, multipart, warnings }.
 * Throws an Error with a readable message when it isn't a curl command with a URL.
 */
function parseCurl(input) {
  let src = String(input || '').trim();
  if (!src) throw new Error('Paste a curl command first.');
  // line continuations: bash "\", PowerShell "`", cmd "^"
  src = src.replace(/\\\r?\n/g, ' ').replace(/`\r?\n/g, ' ');
  if (/\^"|\^\r?\n|\^&/.test(src)) src = uncaret(src);
  src = src.replace(/\r?\n/g, ' ');
  const words = curlWords(src);
  if (!words.length || !/^curl(\.exe)?$/i.test(words[0].replace(/^.*[\\/]/, ''))) throw new Error('That doesn\'t look like a curl command. It should start with curl.');

  const out = { method: '', url: '', headers: [], body: '', bodyMode: 'raw', multipart: [], warnings: [] };
  const data = [];
  let get = false;
  let head = false;
  const setHeader = (k, v) => {
    const i = out.headers.findIndex((x) => x.k.toLowerCase() === k.toLowerCase());
    if (i >= 0 && k.toLowerCase() !== 'cookie') out.headers[i].v = v; else out.headers.push({ k, v, on: true });
  };
  const opt = (name, value) => {
    switch (name) {
      case '-X': case '--request': out.method = value.toUpperCase(); break;
      case '-H': case '--header': {
        const i = value.indexOf(':');
        if (i > 0) { const k = value.slice(0, i).trim(); const v = value.slice(i + 1).trim(); if (v || !/;$/.test(k)) setHeader(k, v); }
        else if (/;$/.test(value)) setHeader(value.slice(0, -1).trim(), ''); // curl's "Header;" = empty value
        break;
      }
      case '-d': case '--data': case '--data-ascii': case '--data-raw': case '--data-binary':
        if (value.startsWith('@') && name !== '--data-raw') out.warnings.push(`The body was read from a file (${value}) when curl ran; that file isn't available here, so the body is empty.`);
        else data.push(name === '-d' || name === '--data' || name === '--data-ascii' ? value.replace(/\r?\n/g, '') : value);
        break;
      case '--data-urlencode': {
        const eq = value.indexOf('=');
        data.push(eq >= 0 ? `${value.slice(0, eq)}=${encodeURIComponent(value.slice(eq + 1))}` : encodeURIComponent(value));
        break;
      }
      case '--json':
        data.push(value);
        if (!out.headers.some((x) => /^content-type$/i.test(x.k))) setHeader('Content-Type', 'application/json');
        if (!out.headers.some((x) => /^accept$/i.test(x.k))) setHeader('Accept', 'application/json');
        break;
      case '-F': case '--form': case '--form-string': {
        const eq = value.indexOf('=');
        const fname = eq >= 0 ? value.slice(0, eq) : value;
        const fval = eq >= 0 ? value.slice(eq + 1) : '';
        out.bodyMode = 'multipart';
        if (name !== '--form-string' && /^[@<]/.test(fval)) {
          out.multipart.push({ name: fname, kind: 'file', value: '' });
          out.warnings.push(`"${fname}" was a file (${fval.slice(1).split(';')[0]}). Pick the file again before sending.`);
        } else out.multipart.push({ name: fname, kind: 'text', value: fval });
        break;
      }
      case '-u': case '--user': setHeader('Authorization', 'Basic ' + btoa(unescape(encodeURIComponent(value.includes(':') ? value : value + ':')))); break;
      case '-b': case '--cookie':
        if (value.includes('=')) setHeader('Cookie', value);
        else out.warnings.push(`Cookies were read from a file (${value}); they aren't included.`);
        break;
      case '-A': case '--user-agent': setHeader('User-Agent', value); break;
      case '-e': case '--referer': setHeader('Referer', value); break;
      case '--url': out.url = value; break;
      case '-T': case '--upload-file': out.warnings.push(`curl uploaded the file ${value}; it isn't included.`); if (!out.method) out.method = 'PUT'; break;
      default: break; // output, timeouts, proxy, TLS options… don't change the request itself
    }
  };

  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === '-G' || w === '--get') { get = true; continue; }
    if (w === '-I' || w === '--head') { head = true; continue; }
    if (w.startsWith('--')) {
      const eq = w.indexOf('=');
      const name = eq > 2 && !CURL_ARG.has(w) ? w.slice(0, eq) : w;
      if (CURL_ARG.has(name)) opt(name, eq > 2 && name !== w ? w.slice(eq + 1) : (words[++i] ?? ''));
      continue; // flags like --compressed, --insecure, --location
    }
    if (w.startsWith('-') && w.length > 1) {
      // -XPOST, -H'…' (value attached) or bundled flags like -sSL / -sX POST
      for (let k = 1; k < w.length; k++) {
        const f = w[k];
        if (f === 'G') { get = true; continue; }
        if (f === 'I') { head = true; continue; }
        if (CURL_SHORT_ARG.has(f)) { opt('-' + f, k + 1 < w.length ? w.slice(k + 1) : (words[++i] ?? '')); break; }
      }
      continue;
    }
    if (!out.url) out.url = w;
  }
  if (!out.url) throw new Error('No URL found in that curl command.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(out.url)) out.url = 'http://' + out.url;

  const joined = data.join('&');
  if (get || head) {
    if (joined) out.url += (out.url.includes('?') ? '&' : '?') + joined;
    out.method = head ? 'HEAD' : 'GET';
  } else {
    out.body = joined;
    if (!out.method) out.method = data.length || out.multipart.length ? 'POST' : 'GET';
    if (joined && !out.headers.some((x) => /^content-type$/i.test(x.k))) {
      // what curl itself sends with -d
      setHeader('Content-Type', /^\s*[[{]/.test(joined) ? 'application/json' : 'application/x-www-form-urlencoded');
    }
  }
  if (out.bodyMode === 'multipart') out.headers = out.headers.filter((x) => !/^content-type$/i.test(x.k)); // the boundary is set when sending
  return out;
}
