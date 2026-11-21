// Finds the HTTP routes of an API project and what each one expects (path/query params, headers, body).
//
// Sources, best first:
//   1. a live OpenAPI / Swagger document served by the running API
//   2. static analysis of the source:
//      - Express / Hono / Fastify / Koa-style routers, including routers built in factory functions,
//        imported from other files and mounted with prefixes (app.use('/v1', v1); v1.use('/admin', admin) ...)
//      - zod body/query schemas, also from shared workspace packages (re-exports followed)
//      - Next.js route handlers (app/**/route.ts, pages/api/**) and NestJS controllers
// It's a heuristic reader, not a compiler: it aims to be right for common code and to say where a route came from.
import fs from 'node:fs';
import path from 'node:path';

const SRC_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', 'out', 'coverage', '.cache', 'public', 'static', 'migrations', 'drizzle', '__tests__', 'test', 'tests', 'e2e', 'scripts']);
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all'];
const ROUTER_NAMES = /^(app|router|api|server|fastify|routes?|r|v\d+|admin|publicRouter|apiRouter)$/;
const NOT_ROUTERS = new Set(['req', 'res', 'request', 'response', 'c', 'ctx', 'context', 'headers', 'searchParams', 'params', 'map', 'cache', 'url', 'query', 'store', 'client', 'db', 'axios', 'http', 'https', 'fetch', 'redis', 'session', 'cookies', 'formData', 'process', 'config', 'env', 'object', 'Object', 'Reflect', 'console']);
const AUTH_HINT = /auth|session|guard|protect|require|verify|jwt|token|login|admin|permission|role/i;

// ---------------------------------------------------------------------------------------------
// Source helpers

/** Same length as src; comments become spaces, string/template contents become "_" (quotes kept). */
function maskSource(src) {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  while (i < n) {
    const ch = src[i], nx = src[i + 1];
    if (ch === '/' && nx === '/') { while (i < n && src[i] !== '\n') out[i++] = ' '; continue; }
    if (ch === '/' && nx === '*') { out[i++] = ' '; out[i++] = ' '; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] !== '\n') out[i] = ' '; i++; } if (i < n) { out[i++] = ' '; out[i++] = ' '; } continue; }
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch; i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { out[i] = '_'; i++; if (i < n && src[i] !== '\n') out[i] = '_'; i++; continue; }
        if (q !== '`' && src[i] === '\n') break; // unterminated
        if (src[i] !== '\n') out[i] = '_';
        i++;
      }
      i++;
      continue;
    }
    i++;
  }
  return out.join('');
}

// Blanks out line and block comments but keeps strings (for JSONC like tsconfig.json).
function maskComments(src) {
  const m = maskSource(src);
  let out = '';
  for (let i = 0; i < src.length; i++) out += m[i] === ' ' && src[i] !== ' ' && src[i] !== '\n' && src[i] !== '\r' && src[i] !== '\t' ? ' ' : src[i];
  return out;
}

/** Index of the bracket matching the opener at `open` (uses the masked text). */
function matchBracket(m, open) {
  const pairs = { '(': ')', '{': '}', '[': ']' };
  const stack = [];
  for (let i = open; i < m.length; i++) {
    const c = m[i];
    if (c === '(' || c === '{' || c === '[') stack.push(pairs[c]);
    else if (c === ')' || c === '}' || c === ']') {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

/** Splits text between brackets at top-level commas. Returns [{text, start}] with offsets relative to `from`. */
function splitTopLevel(m, src, from, to) {
  const parts = [];
  let depth = 0, start = from;
  for (let i = from; i < to; i++) {
    const c = m[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) { parts.push({ start, end: i }); start = i + 1; }
  }
  if (m.slice(start, to).trim()) parts.push({ start, end: to });
  // leading/trailing whitespace measured on the masked text, so comments in front of a member are skipped too
  return parts.map((p) => {
    const mm = m.slice(p.start, p.end);
    const lead = mm.length - mm.trimStart().length;
    const trail = mm.length - mm.trimEnd().length;
    return { text: src.slice(p.start + lead, p.end - trail), start: p.start + lead };
  }).filter((p) => p.text);
}

function readStringAt(src, i) {
  const q = src[i];
  if (q !== '"' && q !== "'" && q !== '`') return null;
  let j = i + 1, s = '';
  while (j < src.length && src[j] !== q) { if (src[j] === '\\') { s += src[j + 1]; j += 2; continue; } s += src[j++]; }
  return s;
}
const stringLiteral = (text) => { const t = text.trim(); return /^(['"`])[\s\S]*\1$/.test(t) && !t.includes('${') ? t.slice(1, -1) : null; };
const lineOf = (src, i) => src.slice(0, i).split('\n').length;

// ---------------------------------------------------------------------------------------------
// Files and modules

class Project {
  constructor(root) {
    this.root = path.resolve(root);
    this.files = new Map(); // abs path -> parsed file
  }

  listSources() {
    const out = [];
    const walk = (dir, depth) => {
      if (depth > 8) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, depth + 1); }
        else if (SRC_EXT.includes(path.extname(e.name)) && !/\.(test|spec|d)\.[cm]?[jt]sx?$/.test(e.name) && !/\.config\./.test(e.name)) out.push(p);
      }
    };
    walk(this.root, 0);
    return out.slice(0, 1500);
  }

  file(abs) {
    if (this.files.has(abs)) return this.files.get(abs);
    let src = '';
    try {
      const st = fs.statSync(abs);
      if (st.size > 1.5 * 1024 * 1024) throw new Error('too big');
      src = fs.readFileSync(abs, 'utf8');
    } catch { this.files.set(abs, null); return null; }
    const f = parseFile(abs, src);
    this.files.set(abs, f);
    return f;
  }

  resolveFile(base) {
    const tries = [base, ...SRC_EXT.map((e) => base + e), ...SRC_EXT.map((e) => path.join(base, 'index' + e))];
    if (/\.[cm]?js$/.test(base)) { const stem = base.replace(/\.[cm]?js$/, ''); tries.push(...['.ts', '.tsx', '.mts', '.cts'].map((e) => stem + e)); }
    for (const t of tries) { try { if (fs.statSync(t).isFile()) return t; } catch { /* next */ } }
    return null;
  }

  /** tsconfig/jsconfig "paths" aliases (e.g. "@/*": ["./src/*"]) from the project or a parent folder. */
  aliases() {
    if (this._aliases) return this._aliases;
    this._aliases = [];
    let dir = this.root;
    for (let k = 0; k < 4; k++) {
      for (const name of ['tsconfig.json', 'jsconfig.json']) {
        const file = path.join(dir, name);
        if (!fs.existsSync(file)) continue;
        try {
          const text = maskComments(fs.readFileSync(file, 'utf8')).replace(/,(\s*[}\]])/g, '$1');
          const co = JSON.parse(text).compilerOptions || {};
          const base = path.resolve(dir, co.baseUrl || '.');
          for (const [pat, targets] of Object.entries(co.paths || {})) {
            this._aliases.push({ prefix: pat.replace(/\*$/, ''), wildcard: pat.endsWith('*'), targets: targets.map((t) => path.resolve(base, t.replace(/\*$/, ''))) });
          }
          if (co.baseUrl) this._aliases.push({ prefix: '', wildcard: true, targets: [base], baseUrl: true });
        } catch { /* unreadable tsconfig */ }
        if (this._aliases.length) return this._aliases;
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    return this._aliases;
  }

  /** Resolves an import specifier from a file. Third-party packages (real path inside node_modules) are ignored. */
  resolveImport(fromFile, spec) {
    if (spec.startsWith('.') || spec.startsWith('/')) return this.resolveFile(path.resolve(path.dirname(fromFile), spec));
    if (/^(node:|[a-z]+:)/.test(spec)) return null;
    for (const a of this.aliases()) {
      if (a.wildcard ? !spec.startsWith(a.prefix) : spec !== a.prefix) continue;
      const rest = a.wildcard ? spec.slice(a.prefix.length) : '';
      for (const t of a.targets) { const hit = this.resolveFile(path.join(t, rest)); if (hit) return hit; }
    }
    const parts = spec.split('/');
    const pkgName = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    const sub = parts.slice(spec.startsWith('@') ? 2 : 1).join('/');
    let dir = path.dirname(fromFile);
    for (let k = 0; k < 12; k++) {
      const cand = path.join(dir, 'node_modules', pkgName);
      if (fs.existsSync(cand)) {
        let real;
        try { real = fs.realpathSync(cand); } catch { return null; }
        if (real.split(path.sep).includes('node_modules')) return null; // a real dependency, not our code
        return this.resolvePackageEntry(real, sub);
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    return null;
  }

  resolvePackageEntry(pkgDir, sub) {
    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')); } catch { /* none */ }
    const pick = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' ? pick(v.import ?? v.types ?? v.default ?? v.require ?? v.node ?? Object.values(v)[0]) : null);
    let target = null;
    if (pkg.exports) {
      const key = sub ? './' + sub : '.';
      const e = typeof pkg.exports === 'string' || pkg.exports.import || pkg.exports.default ? (key === '.' ? pkg.exports : null) : pkg.exports[key];
      target = pick(e);
    }
    if (!target && sub) target = sub;
    if (!target) target = pkg.types || pkg.module || pkg.main || 'index';
    return this.resolveFile(path.resolve(pkgDir, target)) || this.resolveFile(path.resolve(pkgDir, 'src', sub || 'index'));
  }
}

function parseFile(abs, src) {
  const m = maskSource(src);
  const f = { abs, src, m, imports: new Map(), reexports: [], functions: [], defaultExport: null };

  // imports
  const importRe = /\bimport\s+(type\s+)?([\s\S]*?)\s*from\s*(['"])([^'"]+)\3/g;
  let x;
  while ((x = importRe.exec(src))) {
    if (m[x.index] !== 'i') continue;
    const spec = x[4];
    const clause = x[2].trim();
    const ns = clause.match(/\*\s+as\s+(\w+)/);
    if (ns) { f.imports.set(ns[1], { spec, name: '*' }); continue; }
    const named = clause.match(/\{([\s\S]*)\}/);
    const def = clause.replace(/\{[\s\S]*\}/, '').replace(/,/g, '').trim();
    if (def && /^\w+$/.test(def)) f.imports.set(def, { spec, name: 'default' });
    if (named) for (const part of named[1].split(',')) {
      const p = part.trim().replace(/^type\s+/, '');
      if (!p) continue;
      const [orig, alias] = p.split(/\s+as\s+/).map((s) => s.trim());
      f.imports.set(alias || orig, { spec, name: orig });
    }
  }
  const reqRe = /\b(?:const|let|var)\s+(\{[^}]*\}|\w+)\s*=\s*require\(\s*(['"])([^'"]+)\2\s*\)/g;
  while ((x = reqRe.exec(src))) {
    if (m[x.index] === ' ') continue;
    if (x[1].startsWith('{')) for (const part of x[1].slice(1, -1).split(',')) {
      const [orig, alias] = part.split(':').map((s) => s.trim());
      if (orig) f.imports.set(alias || orig, { spec: x[3], name: orig });
    } else f.imports.set(x[1], { spec: x[3], name: 'default' });
  }
  // re-exports
  const reRe = /\bexport\s+(?:type\s+)?(\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s*(['"])([^'"]+)\2/g;
  while ((x = reRe.exec(src))) {
    if (m[x.index] !== 'e') continue;
    if (x[1].startsWith('*')) f.reexports.push({ spec: x[3], all: true });
    else for (const part of x[1].slice(1, -1).split(',')) {
      const [orig, alias] = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).map((s) => s.trim());
      if (orig) f.reexports.push({ spec: x[3], name: orig, as: alias || orig });
    }
  }
  // functions (named): function foo(...) {   |   const foo = (async)? (...) => {   |   const foo = function (...) {
  const fnRe = /\b(?:async\s+)?function\s*\*?\s*(\w+)\s*(?:<[^>]*>)?\s*\(|\b(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b[^(]*\(|(?:<[^>]*>)?\((?=[^)]*\)\s*(?::[^=]+)?=>)|(\w+)\s*=>)/g;
  while ((x = fnRe.exec(m))) {
    const name = x[1] || x[2];
    const paren = m.indexOf('(', x.index + x[0].length - 1);
    let params = '', bodyOpen = -1;
    if (x[3]) { // single-param arrow: name = p => ...
      params = x[3];
      const arrow = m.indexOf('=>', x.index + x[0].length - 2);
      bodyOpen = arrow;
    } else {
      const pclose = matchBracket(m, paren);
      if (pclose < 0) continue;
      params = src.slice(paren + 1, pclose);
      bodyOpen = pclose;
    }
    // find "{" of the body (skip return type annotations and "=>")
    let j = bodyOpen + 1;
    while (j < m.length && /[\s=>:\w<>,.[\]|&?'"_]/.test(m[j]) && m[j] !== '{') j++;
    if (m[j] !== '{') {
      // expression-bodied arrow: body runs to end of statement
      const end = statementEnd(m, bodyOpen + 2);
      f.functions.push({ name, start: x.index, bodyStart: bodyOpen + 2, end, params: paramNames(params) });
      continue;
    }
    const end = matchBracket(m, j);
    if (end < 0) continue;
    f.functions.push({ name, start: x.index, bodyStart: j, end, params: paramNames(params) });
  }
  const de = src.match(/\bexport\s+default\s+(?:function\s+)?(\w+)/) || src.match(/\bmodule\.exports\s*=\s*(\w+)/);
  if (de) f.defaultExport = de[1];
  return f;
}

function paramNames(text) {
  return text.split(',').map((p) => p.trim().replace(/^\.\.\./, '').split(/[:=]/)[0].trim()).filter((p) => /^\w+$/.test(p));
}

function statementEnd(m, from) {
  let depth = 0;
  for (let i = from; i < m.length; i++) {
    const c = m[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') { if (depth === 0) return i; depth--; }
    else if (depth === 0 && c === ';') return i;
    else if (depth === 0 && c === '\n') {
      const rest = m.slice(i + 1).match(/^\s*(\S)/);
      if (!rest || !/[.?:+\-*/|&=,)]/.test(rest[1])) return i;
    }
  }
  return m.length;
}

/** Innermost named function containing position i. */
function scopeAt(f, i) {
  let best = null;
  for (const fn of f.functions) if (fn.bodyStart <= i && i <= fn.end && (!best || fn.bodyStart > best.bodyStart)) best = fn;
  return best;
}

/** Finds an exported/top-level binding `name` in a file, following imports and re-exports. Returns {file, name} or null. */
function resolveBinding(project, file, name, seen = new Set()) {
  const key = file.abs + '|' + name;
  if (seen.has(key) || seen.size > 40) return null;
  seen.add(key);
  if (name === 'default') {
    if (file.defaultExport) return resolveBinding(project, file, file.defaultExport, seen) || { file, name: file.defaultExport };
    return null;
  }
  const declRe = new RegExp(`\\b(?:const|let|var|function|class)\\s+${name}\\b`);
  const d = file.m.match(declRe);
  if (d) return { file, name };
  const imp = file.imports.get(name);
  if (imp) {
    const target = project.resolveImport(file.abs, imp.spec);
    const tf = target && project.file(target);
    if (tf) return imp.name === '*' ? { file: tf, name: '*' } : resolveBinding(project, tf, imp.name, seen);
  }
  for (const r of file.reexports) {
    if (!r.all && r.as !== name) continue;
    const target = project.resolveImport(file.abs, r.spec);
    const tf = target && project.file(target);
    if (!tf) continue;
    const hit = resolveBinding(project, tf, r.all ? name : r.name, seen);
    if (hit) return hit;
  }
  return null;
}

/** Text of the initializer expression of `const name = <expr>` in file. */
function declarationExpr(file, name) {
  const re = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*(?::[^=]+)?=\\s*`, 'g');
  let x;
  while ((x = re.exec(file.m))) {
    const start = x.index + x[0].length;
    const end = statementEnd(file.m, start);
    return { text: file.src.slice(start, end), start };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Schemas (zod, plain const arrays, TS DTO classes) -> fields + example

function describeSchema(project, file, expr, depth = 0) {
  if (!expr || depth > 8) return { type: 'unknown' };
  let text = expr.trim().replace(/\s+as\s+const\s*$/, '');
  const m = maskSource(text);
  // split off modifier chain: base(...).optional().nullable()...
  const chain = [];
  let base = text;
  {
    // walk top-level ".name(...)" calls from the start
    let i = 0, lastBaseEnd = -1;
    const segs = [];
    while (i < m.length) {
      const c = m[i];
      if (c === '(' || c === '{' || c === '[') { const e = matchBracket(m, i); if (e < 0) break; i = e + 1; continue; }
      if (c === '.' && i > 0) segs.push(i);
      i++;
    }
    // Prefer the first call that looks like a schema constructor (z.object(...)) and treat later ".x()" as modifiers
    const zStart = text.match(/^(?:z|zod|v|t|yup|Joi)\s*\.\s*(?:coerce\s*\.\s*)?(\w+)\s*\(/);
    if (zStart) {
      const open = zStart[0].length - 1;
      const close = matchBracket(m, open);
      lastBaseEnd = close;
      base = text.slice(0, close + 1);
    } else {
      const id = text.match(/^(\w+)/);
      if (id) { base = id[1]; lastBaseEnd = id[1].length - 1; }
    }
    if (lastBaseEnd >= 0) {
      const rest = text.slice(lastBaseEnd + 1);
      const rm = maskSource(rest);
      const callRe = /\.\s*(\w+)\s*(\()?/g;
      let c;
      while ((c = callRe.exec(rm))) {
        if (c.index !== 0 && rm.slice(0, c.index).trim() === '' && false) break;
        let args = '';
        if (c[2]) { const open = c.index + c[0].length - 1; const close = matchBracket(rm, open); if (close < 0) break; args = rest.slice(open + 1, close); callRe.lastIndex = close + 1; }
        chain.push({ name: c[1], args });
      }
      void segs;
    }
  }

  let d;
  const zs = base.match(/^(?:z|zod)\s*\.\s*(?:coerce\s*\.\s*)?(\w+)\s*\(([\s\S]*)\)$/);
  if (zs) d = describeZod(project, file, zs[1], zs[2], depth);
  else if (/^\w+$/.test(base)) d = describeIdentifier(project, file, base, depth);
  else if (base.startsWith('[')) d = { type: 'array', of: { type: 'string' } };
  else d = { type: 'unknown' };

  for (const c of chain) {
    if (c.name === 'optional' || c.name === 'nullish') d = { ...d, optional: true };
    else if (c.name === 'nullable') d = { ...d, nullable: true };
    else if (c.name === 'default' || c.name === 'catch' || c.name === 'prefault') d = { ...d, optional: true, default: c.args.trim() };
    else if (c.name === 'array') d = { type: 'array', of: d };
    else if (c.name === 'partial' && d.type === 'object') d = { ...d, fields: d.fields.map((f) => ({ ...f, schema: { ...f.schema, optional: true } })) };
    else if (c.name === 'required' && d.type === 'object') d = { ...d, fields: d.fields.map((f) => ({ ...f, schema: { ...f.schema, optional: false } })) };
    else if ((c.name === 'extend' || c.name === 'merge' || c.name === 'and') && d.type === 'object') {
      const extra = c.name === 'extend' ? describeZod(project, file, 'object', c.args, depth + 1) : describeSchema(project, file, c.args, depth + 1);
      if (extra.type === 'object') d = { ...d, fields: [...d.fields.filter((f) => !extra.fields.some((e) => e.name === f.name)), ...extra.fields] };
    } else if ((c.name === 'pick' || c.name === 'omit') && d.type === 'object') {
      const keys = [...c.args.matchAll(/(\w+)\s*:/g)].map((k) => k[1]);
      d = { ...d, fields: d.fields.filter((f) => (c.name === 'pick' ? keys.includes(f.name) : !keys.includes(f.name))) };
    } else if (c.name === 'element' && d.type === 'array') d = d.of;
    else if (c.name === 'shape') { /* x.shape.y handled loosely */ }
  }
  return d;
}

function describeIdentifier(project, file, name, depth) {
  const b = resolveBinding(project, file, name);
  if (!b || b.name === '*') return { type: 'unknown', ref: name };
  const decl = declarationExpr(b.file, b.name);
  if (decl) {
    const t = decl.text.trim();
    if (t.startsWith('[')) { // const VALUES = ['a', 'b'] as const
      const vals = [...t.matchAll(/(['"])([^'"]*)\1/g)].map((v) => v[2]);
      return vals.length ? { type: 'enum', values: vals } : { type: 'array', of: { type: 'unknown' } };
    }
    if (t.startsWith('{') && !/^\{\s*\w+\s*:\s*(?:z|zod)\./.test(t)) {
      const vals = [...t.matchAll(/:\s*(['"])([^'"]*)\1/g)].map((v) => v[2]);
      if (vals.length) return { type: 'enum', values: vals };
    }
    const d = describeSchema(project, b.file, t, depth + 1);
    return { ...d, ref: d.ref || name };
  }
  // class DTO (NestJS / class-validator)
  const cls = b.file.m.match(new RegExp(`\\bclass\\s+${b.name}\\b[^{]*\\{`));
  if (cls) {
    const open = cls.index + cls[0].length - 1;
    const close = matchBracket(b.file.m, open);
    const body = b.file.src.slice(open + 1, close);
    const fields = [];
    for (const p of body.matchAll(/^\s*(?:@[\w.]+\([^)]*\)\s*)*(?:readonly\s+|public\s+)?(\w+)(\?|!)?\s*:\s*([^;=\n]+)/gm)) {
      if (['constructor', 'static'].includes(p[1])) continue;
      fields.push({ name: p[1], schema: { ...tsType(p[3].trim()), optional: p[2] === '?' } });
    }
    return { type: 'object', fields, ref: name };
  }
  return { type: 'unknown', ref: name };
}

function tsType(t) {
  if (/\[\]$/.test(t) || /^Array</.test(t)) return { type: 'array', of: tsType(t.replace(/\[\]$/, '').replace(/^Array<(.*)>$/, '$1')) };
  if (/^string\b/.test(t)) return { type: 'string' };
  if (/^number\b/.test(t)) return { type: 'number' };
  if (/^boolean\b/.test(t)) return { type: 'boolean' };
  if (/^Date\b/.test(t)) return { type: 'date' };
  const lits = [...t.matchAll(/(['"])([^'"]*)\1/g)].map((v) => v[2]);
  if (lits.length) return { type: 'enum', values: lits };
  return { type: 'unknown', ref: t };
}

function describeZod(project, file, kind, args, depth) {
  const am = maskSource(args);
  const parts = splitTopLevel(am, args, 0, args.length);
  switch (kind) {
    case 'object': case 'strictObject': case 'looseObject': case 'interface': {
      const objText = parts[0]?.text || '{}';
      const om = maskSource(objText);
      if (!objText.startsWith('{')) return describeSchema(project, file, objText, depth + 1);
      const close = matchBracket(om, 0);
      const members = splitTopLevel(om, objText, 1, close < 0 ? objText.length : close);
      const fields = [];
      for (const mem of members) {
        if (mem.text.startsWith('...')) {
          const spread = describeSchema(project, file, mem.text.slice(3).replace(/\.shape$/, ''), depth + 1);
          if (spread.type === 'object') fields.push(...spread.fields);
          continue;
        }
        const km = mem.text.match(/^(['"]?)([\w$-]+)\1\s*(\?)?\s*:\s*([\s\S]+)$/);
        if (km) fields.push({ name: km[2], schema: describeSchema(project, file, km[4], depth + 1) });
        else if (/^\w+$/.test(mem.text)) fields.push({ name: mem.text, schema: describeSchema(project, file, mem.text, depth + 1) });
      }
      return { type: 'object', fields };
    }
    case 'array': case 'set': return { type: 'array', of: describeSchema(project, file, parts[0]?.text, depth + 1) };
    case 'tuple': return { type: 'array', of: describeSchema(project, file, (parts[0]?.text || '').replace(/^\[|\]$/g, '').split(',')[0], depth + 1) };
    case 'string': case 'uuid': case 'cuid': case 'cuid2': case 'ulid': case 'url': case 'base64': case 'nanoid': case 'jwt': case 'ipv4': case 'ipv6': case 'cidrv4': case 'hostname':
      return { type: 'string', format: kind === 'string' ? undefined : kind };
    case 'email': return { type: 'string', format: 'email' };
    case 'iso': case 'datetime': return { type: 'string', format: 'date-time' };
    case 'number': case 'int': case 'float': case 'float32': case 'float64': case 'int32': case 'bigint': return { type: 'number', format: kind === 'number' ? undefined : kind };
    case 'boolean': case 'stringbool': return { type: 'boolean' };
    case 'date': return { type: 'date' };
    case 'literal': { const v = parts[0]?.text || ''; const s = stringLiteral(v); return s != null ? { type: 'enum', values: [s] } : { type: 'literal', value: v }; }
    case 'enum': case 'nativeEnum': {
      const a = parts[0]?.text || '';
      if (a.startsWith('[')) { const vals = [...a.matchAll(/(['"])([^'"]*)\1/g)].map((v) => v[2]); return { type: 'enum', values: vals }; }
      const r = describeSchema(project, file, a, depth + 1);
      return r.type === 'enum' ? r : { type: 'string', ref: a };
    }
    case 'union': case 'discriminatedUnion': case 'xor': {
      const list = (kind === 'discriminatedUnion' ? parts[1] : parts[0])?.text || '';
      const inner = list.replace(/^\[/, '').replace(/\]$/, '');
      const first = splitTopLevel(maskSource(inner), inner, 0, inner.length)[0];
      return first ? { ...describeSchema(project, file, first.text, depth + 1), union: true } : { type: 'unknown' };
    }
    case 'record': case 'map': return { type: 'record' };
    case 'any': case 'unknown': case 'json': return { type: 'unknown' };
    case 'null': return { type: 'null' };
    case 'preprocess': case 'pipe': return describeSchema(project, file, parts[parts.length - 1]?.text, depth + 1);
    case 'lazy': return { type: 'unknown' };
    case 'file': return { type: 'file' };
    default: return { type: 'unknown' };
  }
}

function exampleOf(s, depth = 0) {
  if (!s || depth > 6) return null;
  if (s.default != null) { try { return JSON.parse(s.default.replace(/'/g, '"')); } catch { /* fall through */ } }
  switch (s.type) {
    case 'object': return Object.fromEntries(s.fields.map((f) => [f.name, exampleOf(f.schema, depth + 1)]));
    case 'array': { const e = exampleOf(s.of, depth + 1); return e == null ? [] : [e]; }
    case 'string': return s.format === 'email' ? 'user@example.com' : s.format === 'uuid' ? '00000000-0000-0000-0000-000000000000' : s.format === 'url' ? 'https://example.com' : s.format === 'date-time' ? new Date().toISOString() : '';
    case 'number': return 0;
    case 'boolean': return false;
    case 'date': return new Date().toISOString();
    case 'enum': return s.values?.[0] ?? '';
    case 'record': return {};
    case 'null': return null;
    default: return null;
  }
}

function typeLabel(s) {
  if (!s) return 'unknown';
  let t;
  switch (s.type) {
    case 'array': t = `${typeLabel(s.of)}[]`; break;
    case 'enum': t = s.values.length > 6 ? `${s.values.slice(0, 6).map((v) => `"${v}"`).join(' | ')} | …` : s.values.map((v) => `"${v}"`).join(' | ') || 'enum'; break;
    case 'object': t = s.ref && !/^[a-z]/.test(s.ref) ? s.ref : 'object'; break;
    case 'unknown': t = s.ref ? s.ref : 'any'; break;
    default: t = s.format ? `${s.type} (${s.format})` : s.type;
  }
  if (s.nullable) t += ' | null';
  return t;
}

/** Flattens an object schema into rows for the UI: {name, type, optional} with dotted names for nesting. */
function fieldRows(s, prefix = '', depth = 0, out = []) {
  if (!s || s.type !== 'object' || depth > 4) return out;
  for (const f of s.fields) {
    const name = prefix + f.name;
    out.push({ name, type: typeLabel(f.schema), optional: !!f.schema.optional });
    if (f.schema.type === 'object') fieldRows(f.schema, name + '.', depth + 1, out);
    else if (f.schema.type === 'array' && f.schema.of?.type === 'object') fieldRows(f.schema.of, name + '[].', depth + 1, out);
  }
  return out;
}

function bodySpec(schema, source) {
  if (!schema) return null;
  return { source, fields: fieldRows(schema), example: exampleOf(schema), schemaName: schema.ref || null };
}

// ---------------------------------------------------------------------------------------------
// Handler analysis: what a route reads from the request

function analyzeHandler(project, file, text, method, extraArgs = []) {
  const query = new Set(), headers = new Set(), body = new Set();
  let bodySchema = null, querySchema = null;
  const add = (set, s) => s.split(',').map((p) => p.trim().split(/[:=\s]/)[0].replace(/^\.\.\./, '')).filter((p) => /^[\w$-]+$/.test(p)).forEach((p) => set.add(p));
  const reqName = '(?:req|request|ctx\\.request|c\\.req)';

  for (const x of text.matchAll(new RegExp(`${reqName}\\.query\\.([\\w$]+)`, 'g'))) query.add(x[1]);
  for (const x of text.matchAll(new RegExp(`${reqName}\\.query\\[\\s*['"]([^'"]+)`, 'g'))) query.add(x[1]);
  for (const x of text.matchAll(new RegExp(`\\{([^{}]*)\\}\\s*=\\s*${reqName}\\.query\\b`, 'g'))) add(query, x[1]);
  for (const x of text.matchAll(/\b(?:c\.req\.query|query)\(\s*['"]([^'"]+)/g)) query.add(x[1]);
  for (const x of text.matchAll(/searchParams\.(?:get|getAll|has)\(\s*['"]([^'"]+)/g)) query.add(x[1]);

  for (const x of text.matchAll(new RegExp(`${reqName}\\.body\\.([\\w$]+)`, 'g'))) body.add(x[1]);
  for (const x of text.matchAll(new RegExp(`\\{([^{}]*)\\}\\s*=\\s*${reqName}\\.body\\b`, 'g'))) add(body, x[1]);
  for (const x of text.matchAll(/\{([^{}]*)\}\s*=\s*await\s+(?:req|request|c\.req)\.json\(\)/g)) add(body, x[1]);

  for (const x of text.matchAll(/(?:req|request|c\.req)\.(?:get|header)\(\s*['"]([^'"]+)/g)) headers.add(x[1]);
  for (const x of text.matchAll(/(?:req|request)\.headers(?:\.get\(\s*['"]([^'"]+)|\[\s*['"]([^'"]+)|\.([\w$]+))/g)) headers.add(x[1] || x[2] || x[3]);
  for (const x of text.matchAll(/\bheaders\(\)\.get\(\s*['"]([^'"]+)/g)) headers.add(x[1]);

  // schemas: X.parse(req.body) / X.safeParse(await req.json()) / zValidator('json', X) / validate(X)
  const parsed = text.matchAll(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.(?:parse|safeParse|parseAsync|safeParseAsync|validate|validateSync|assert)\(\s*(await\s+)?([\w.]+(?:\(\))?)/g);
  for (const x of parsed) {
    const src = x[3];
    const name = x[1].split('.').pop() === 'shape' ? x[1].split('.')[0] : x[1].includes('.') ? null : x[1];
    if (!name) continue;
    if (/(\.body|\.json\(\)|^body$|^payload$|^data$|^input$)/.test(src) && !bodySchema) bodySchema = name;
    else if (/\.query$|searchParams|^query$/.test(src) && !querySchema) querySchema = name;
  }
  // helpers that take the request and a schema: parseBody(request, schema), validate(req, schema), getQuery(req, schema)
  for (const x of text.matchAll(/\b(\w+)\(\s*(?:await\s+)?(?:req|request|c|ctx|event)\b[^,()]*,\s*([A-Za-z_$][\w$]*)\s*[,)]/g)) {
    const [, helper, schema] = x;
    if (!/schema|dto|input|validator|body|payload/i.test(schema) && !/body|json|parse|valid/i.test(helper)) continue;
    if (/query|search|params/i.test(helper)) querySchema ||= schema;
    else if (method !== 'get') bodySchema ||= schema;
  }
  // body read into a variable by a helper: const body = await readBody(req) -> body.x / { a, b } = body
  for (const x of text.matchAll(/\b(?:const|let|var)\s+(\w+|\{[^{}]*\})\s*=\s*await\s+(?:\w+\.)?\w*(?:[Bb]ody|[Jj]son|[Pp]ayload)\w*\(\s*(?:req|request)?/g)) {
    if (x[1].startsWith('{')) { add(body, x[1].slice(1, -1)); continue; }
    const v = x[1];
    for (const y of text.matchAll(new RegExp(`\\b${v}\\.([A-Za-z_$][\\w$]*)\\b(?!\\s*\\()`, 'g'))) body.add(y[1]);
    for (const y of text.matchAll(new RegExp(`\\{([^{}]*)\\}\\s*=\\s*${v}\\b`, 'g'))) add(body, y[1]);
  }
  // searchParams kept in a variable: const q = url.searchParams; q.get('x')
  for (const x of text.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*[\w.]*searchParams\b/g)) {
    for (const y of text.matchAll(new RegExp(`\\b${x[1]}\\.(?:get|getAll|has)\\(\\s*['"]([^'"]+)`, 'g'))) query.add(y[1]);
  }

  for (const x of text.matchAll(/(?:zValidator|validator|sValidator|tbValidator)\(\s*['"](json|form|query|param)['"]\s*,\s*(\w+)/g)) {
    if (x[1] === 'json' || x[1] === 'form') bodySchema ||= x[2];
    if (x[1] === 'query') querySchema ||= x[2];
  }
  for (const a of extraArgs) {
    const v = a.match(/^\w*(?:validate|validator|body|validateBody|withBody)\w*\(\s*(\w+)/i);
    if (v && !bodySchema && method !== 'get') bodySchema = v[1];
    const vq = a.match(/^\w*(?:validateQuery|query)\w*\(\s*(\w+)/i);
    if (vq && !querySchema) querySchema = vq[1];
  }

  let bodyInfo = null;
  // file uploads: multer upload.single('file') / .array('photos') / .fields([{ name: 'a' }])
  const files = [];
  for (const a of extraArgs) {
    const s = a.match(/\.(?:single|array)\(\s*['"]([\w-]+)['"]/);
    if (s) files.push(s[1]);
    for (const fl of a.matchAll(/name\s*:\s*['"]([\w-]+)['"]/g)) if (/\.fields\(/.test(a)) files.push(fl[1]);
  }
  if (!files.length && /req\.files?\b|formData\(\)|\.parseMultipart|busboy/i.test(text) && method !== 'get') files.push('file');
  if (files.length) {
    const extra = [...body].filter((b) => !files.includes(b));
    return {
      query: [...query].map((q) => ({ name: q.replace(/\?$/, ''), optional: true })),
      headers: [...headers].filter((h) => !/^(content-type|accept|user-agent|host)$/i.test(h)),
      body: { source: 'multipart', multipart: true, fields: [...files.map((n) => ({ name: n, type: 'file', optional: false })), ...extra.map((n) => ({ name: n, type: 'text', optional: true }))], example: null },
    };
  }
  if (bodySchema) {
    const d = describeSchema(project, file, bodySchema, 0);
    if (d.type === 'object' || d.type === 'array') bodyInfo = bodySpec({ ...d, ref: d.ref || bodySchema }, bodySchema);
  }
  if (!bodyInfo && body.size) {
    const fields = [...body].map((n) => ({ name: n, schema: { type: 'unknown' } }));
    bodyInfo = { source: 'req.body', fields: fields.map((f) => ({ name: f.name, type: 'any', optional: false })), example: Object.fromEntries(fields.map((f) => [f.name, ''])) };
  }
  if (querySchema) {
    const d = describeSchema(project, file, querySchema, 0);
    if (d.type === 'object') for (const f of d.fields) query.add(f.name + (f.schema.optional ? '?' : ''));
  }
  const usesBody = /\b(?:req|request)\.body\b|\.json\(\)|formData\(\)/.test(text);
  return {
    query: [...query].map((q) => ({ name: q.replace(/\?$/, ''), optional: true })),
    headers: [...headers].filter((h) => !/^(content-type|accept|user-agent|host)$/i.test(h)),
    body: bodyInfo || (usesBody && !['get', 'head', 'delete'].includes(method) ? { source: 'unknown', fields: [], example: {} } : null),
  };
}

// ---------------------------------------------------------------------------------------------
// Express / Hono / Fastify / Koa router graph

function scanRouters(project, files) {
  const nodes = new Map(); // id -> { id, file, fn, var, kind, routes: [], mounts: [], middleware: [] }
  const nodeId = (f, fn, v) => `${f.abs}#${fn ? fn.name + '@' + fn.start : ''}#${v}`;
  const getNode = (f, fn, v, kind = 'router') => {
    const id = nodeId(f, fn, v);
    if (!nodes.has(id)) nodes.set(id, { id, file: f, fn, var: v, kind, routes: [], mounts: [], middleware: [] });
    const n = nodes.get(id);
    if (kind === 'app') n.kind = 'app';
    return n;
  };

  // creation sites
  const createRe = /\b(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*(?:await\s+)?(new\s+Hono\b|new\s+(?:Koa)?Router\b|(?:express\s*\.\s*)?Router\s*\(|express\s*\(\s*\)|(?:F|f)astify\s*\(|new\s+Elysia\b|createRouter\s*\(|new\s+OpenAPIHono\b)/g;
  for (const f of files) {
    let x;
    while ((x = createRe.exec(f.m))) {
      const isApp = /Hono|express\s*\(|astify|Elysia/.test(x[2]) && !/Router/.test(x[2]);
      const n = getNode(f, scopeAt(f, x.index), x[1], isApp ? 'app' : 'router');
      const prefix = f.src.slice(x.index, statementEnd(f.m, x.index + x[0].length)).match(/prefix\s*:\s*(['"`])([^'"`]+)\1/);
      if (prefix) n.ownPrefix = prefix[2];
      const bp = f.src.slice(x.index, statementEnd(f.m, x.index + x[0].length)).match(/\.basePath\(\s*(['"`])([^'"`]+)\1/);
      if (bp) n.ownPrefix = bp[2];
    }
  }

  const findNode = (f, pos, v) => {
    const fn = scopeAt(f, pos);
    for (let s = fn; s; s = scopeAt(f, s.start - 1)) {
      const id = nodeId(f, s, v);
      if (nodes.has(id)) return nodes.get(id);
      if (s.params.includes(v) && (ROUTER_NAMES.test(v) || /fastify|app|router|server|instance/i.test(v))) return getNode(f, s, v);
    }
    if (nodes.has(nodeId(f, null, v))) return nodes.get(nodeId(f, null, v));
    if (ROUTER_NAMES.test(v) && !NOT_ROUTERS.has(v)) return getNode(f, fn, v);
    return null;
  };

  // what router does a function produce? (returned var, else the only router created inside, else routes registered on its params)
  const routerOfFunction = (f, fn) => {
    const body = f.m.slice(fn.bodyStart, fn.end + 1);
    const ret = [...body.matchAll(/\breturn\s+(\w+)\s*;?/g)].map((r) => r[1]);
    for (const r of ret) { const id = nodeId(f, fn, r); if (nodes.has(id)) return nodes.get(id); }
    const inside = [...nodes.values()].filter((n) => n.file === f && n.fn === fn);
    if (inside.length === 1) return inside[0];
    const viaParam = inside.find((n) => fn.params.includes(n.var));
    return viaParam || inside[0] || null;
  };

  const resolveTarget = (f, pos, expr, seen = new Set()) => {
    expr = expr.trim();
    if (seen.has(f.abs + expr) || seen.size > 20) return null;
    seen.add(f.abs + expr);
    let mm = expr.match(/^(?:await\s+)?(\w+)\s*\(/); // factory call
    if (mm && !['require', 'import'].includes(mm[1])) return resolveName(f, pos, mm[1], seen);
    mm = expr.match(/^require\(\s*['"]([^'"]+)['"]\s*\)/) || expr.match(/^(?:await\s+)?import\(\s*['"]([^'"]+)['"]\s*\)/);
    if (mm) {
      const t = project.resolveImport(f.abs, mm[1]);
      const tf = t && project.file(t);
      return tf && tf.defaultExport ? resolveName(tf, tf.m.length - 1, tf.defaultExport, seen) : null;
    }
    mm = expr.match(/^(\w+)$/);
    if (mm) return resolveName(f, pos, mm[1], seen);
    return null;
  };
  const resolveName = (f, pos, name, seen) => {
    const local = findNodeStrict(f, pos, name);
    if (local) return local;
    const fn = f.functions.find((x) => x.name === name);
    if (fn) return routerOfFunction(f, fn);
    const b = resolveBinding(project, f, name);
    if (b && b.file !== f) {
      if (!project._routerScanned.has(b.file.abs)) return null;
      const fn2 = b.file.functions.find((x) => x.name === b.name);
      if (fn2) return routerOfFunction(b.file, fn2);
      const top = nodes.get(nodeId(b.file, null, b.name));
      if (top) return top;
      const decl = declarationExpr(b.file, b.name);
      if (decl) return resolveTarget(b.file, decl.start, decl.text, seen);
    }
    if (b && b.file === f && b.name !== name) return resolveName(f, pos, b.name, seen);
    return null;
  };
  const findNodeStrict = (f, pos, v) => {
    for (let s = scopeAt(f, pos); s; s = scopeAt(f, s.start - 1)) { const id = nodeId(f, s, v); if (nodes.has(id)) return nodes.get(id); }
    return nodes.get(nodeId(f, null, v)) || null;
  };

  // registrations + mounts
  // two passes: routes first (this also discovers routers passed in as parameters), then mounts
  for (const phase of ['routes', 'mounts'])
  for (const f of files) {
    const callRe = /\b(\w+)\s*\.\s*(get|post|put|patch|delete|del|options|head|all|use|route|register|on)\s*\(/g;
    let x;
    while ((x = callRe.exec(f.m))) {
      const [, v, kind] = x;
      if (NOT_ROUTERS.has(v)) continue;
      const isMount = kind === 'use' || kind === 'register' || kind === 'route';
      if ((phase === 'mounts') !== isMount) continue;
      const open = x.index + x[0].length - 1;
      const close = matchBracket(f.m, open);
      if (close < 0) continue;
      const args = splitTopLevel(f.m, f.src, open + 1, close);
      if (!args.length) continue;
      const node = findNode(f, x.index, v);
      if (!node) continue;
      const first = stringLiteral(args[0].text);

      if (kind === 'use' || kind === 'route' || kind === 'register') {
        let prefix = first ?? '';
        let targets = first != null ? args.slice(1) : args;
        if (kind === 'register') {
          const opts = args[1]?.text.match(/prefix\s*:\s*(['"`])([^'"`]+)\1/);
          prefix = opts ? opts[2] : '';
          targets = [args[0]];
        }
        if (kind === 'route' && first != null && args.length === 1) {
          // express: router.route('/x').get(...).post(...)
          const tail = f.m.slice(close + 1, statementEnd(f.m, close + 1));
          for (const c of tail.matchAll(/\.\s*(get|post|put|patch|delete|all)\s*\(/g)) {
            const o = close + 1 + c.index + c[0].length - 1;
            const cc = matchBracket(f.m, o);
            const hargs = splitTopLevel(f.m, f.src, o + 1, cc);
            node.routes.push({ method: c[1], path: first, file: f, pos: o, args: hargs });
          }
          continue;
        }
        if (kind === 'route' && first == null && args[0].text.startsWith('{')) { // fastify app.route({ method, url })
          const obj = args[0].text;
          const mth = obj.match(/method\s*:\s*\[?\s*(['"])(\w+)\1/);
          const url = obj.match(/(?:url|path)\s*:\s*(['"`])([^'"`]+)\1/);
          if (mth && url) node.routes.push({ method: mth[2].toLowerCase(), path: url[2], file: f, pos: x.index, args: [{ text: obj }] });
          continue;
        }
        let found = false;
        for (const t of targets) {
          const target = resolveTarget(f, t.start, t.text);
          if (target && target !== node) { node.mounts.push({ prefix, target, pos: x.index }); found = true; }
          else if (/^\w+$/.test(t.text) || /^\w+\(/.test(t.text)) node.middleware.push({ name: t.text.match(/^(\w+)/)[1], pos: x.index, prefix });
        }
        void found;
        continue;
      }
      if (kind === 'on') { // hono: app.on('GET', '/x', h)
        const m2 = stringLiteral(args[0].text);
        const p2 = args[1] && stringLiteral(args[1].text);
        if (m2 && p2 != null) node.routes.push({ method: m2.toLowerCase(), path: p2, file: f, pos: x.index, args: args.slice(1) });
        continue;
      }
      if (first == null) continue;
      if (!first.startsWith('/') && first !== '' && first !== '*') continue; // e.g. app.get('env')
      node.routes.push({ method: kind === 'del' ? 'delete' : kind, path: first, file: f, pos: x.index, args });
    }
  }
  return nodes;
}

const joinPath = (a, b) => {
  const s = ('/' + [a, b].filter((p) => p && p !== '/').map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/'));
  return s === '' ? '/' : s;
};

function collectRoutes(project, nodes) {
  const targets = new Set();
  for (const n of nodes.values()) for (const m of n.mounts) targets.add(m.target.id);
  const roots = [...nodes.values()].filter((n) => !targets.has(n.id) && (n.routes.length || n.mounts.length));
  const hasApp = roots.some((r) => r.kind === 'app');
  const out = [];
  const visit = (n, prefix, guards, stack) => {
    if (stack.includes(n.id) || stack.length > 12) return;
    const base = n.ownPrefix ? joinPath(prefix, n.ownPrefix) : prefix;
    const guardsAt = (pos) => [...guards, ...n.middleware.filter((mw) => mw.pos < pos && !mw.prefix && AUTH_HINT.test(mw.name)).map((mw) => mw.name)];
    for (const r of n.routes) {
      const handlerArgs = r.args.slice(r.method === 'route' ? 0 : 1);
      const routeGuards = handlerArgs.slice(0, -1).map((a) => a.text.match(/^(\w+)/)?.[1]).filter((g) => g && AUTH_HINT.test(g));
      out.push({ ...r, fullPath: joinPath(base, r.path), guards: [...new Set([...guardsAt(r.pos), ...routeGuards])], unmounted: !hasApp && n.kind !== 'app' && stack.length === 0 });
    }
    for (const m of n.mounts) visit(m.target, joinPath(base, m.prefix), guardsAt(m.pos), [...stack, n.id]);
  };
  for (const r of roots) visit(r, '', [], []);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Next.js route handlers and NestJS controllers

/** Exported GET/POST/... handlers of a file-based route (Next.js route.ts, SvelteKit +server.ts). */
function fileRouteExports(f, p) {
  const out = [];
  const add = (method, pos, text, wrapper) => {
    const guards = wrapper && AUTH_HINT.test(wrapper) ? [wrapper] : [];
    out.push({ method: method.toLowerCase(), fullPath: p, file: f, pos, handlerText: text, guards });
  };
  // export async function POST(...) { }  |  export const POST = async (...) => { }  |  export const POST = authedRoute(async (...) => { })
  for (const x of f.src.matchAll(/export\s+(?:async\s+)?(?:function\s+|const\s+)(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b(\s*(?::[^=]+)?=\s*(?:(\w+)\s*(?:<[^>]*>)?\s*\()?)?/g)) {
    if (f.m[x.index] !== 'e') continue;
    const fnInfo = f.functions.find((fn) => fn.name === x[1]);
    let text;
    if (fnInfo) text = f.src.slice(fnInfo.bodyStart, fnInfo.end);
    else { const start = x.index + x[0].length; text = f.src.slice(start, statementEnd(f.m, start)); }
    add(x[1], x.index, text, x[3]);
  }
  // export { handler as GET, handler as POST }
  for (const x of f.src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of x[1].split(',')) {
      const mm = part.trim().match(/^(\w+)\s+as\s+(GET|POST|PUT|PATCH|DELETE)$/);
      if (!mm) continue;
      const fn = f.functions.find((y) => y.name === mm[1]);
      add(mm[2], x.index, fn ? f.src.slice(fn.bodyStart, fn.end) : f.src, null);
    }
  }
  return out;
}

/**
 * Plain Node http servers (no framework):
 *   if (p === '/api/x' && req.method === 'POST') { ... }
 *   const del = p.match(/^\/api\/x\/([^/]+)$/);  if (del && req.method === 'DELETE') { ... }
 *   if (route === 'GET /api/state') { ... }    case 'POST /api/run':
 */
function scanPlainHttp(project, files) {
  const out = [];
  const METHOD_RE = /(?:\.|\b)method\s*===?\s*(['"])(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\1/;
  const blockAfter = (f, from) => {
    // body of the if/case that starts at `from`: the next "{...}" (or the rest of the case up to the next case)
    const open = f.m.indexOf('{', from);
    if (open < 0 || open - from > 600) return f.src.slice(from, from + 1500);
    const close = matchBracket(f.m, open);
    return f.src.slice(open, close < 0 ? open + 1500 : close);
  };
  const conditionAround = (f, pos) => {
    // the whole "if (...)" condition containing pos, else the line
    const ifStart = f.m.lastIndexOf('if', pos);
    if (ifStart >= 0 && pos - ifStart < 300) {
      const open = f.m.indexOf('(', ifStart);
      const close = open >= 0 ? matchBracket(f.m, open) : -1;
      if (close > pos) return { text: f.src.slice(open, close + 1), end: close + 1 };
    }
    const ls = f.src.lastIndexOf('\n', pos) + 1;
    const le = f.src.indexOf('\n', pos);
    return { text: f.src.slice(ls, le < 0 ? undefined : le), end: le < 0 ? f.src.length : le };
  };
  // regex source -> path with numbered placeholders {{1}}, {{2}} for the capture groups
  const regexToPath = (re) => {
    let n = 0;
    const names = [];
    const p = re.replace(/^\^/, '').replace(/\/?\$$/, '').replace(/\\\//g, '/')
      .replace(/\((?:\?<(\w+)>)?(?:\[\^\/\]\+|\\w\+|\\d\+|\.\+|\.\*|\[[^\]]*\][+*])\)/g, (mm, name) => { n++; names.push(name || (n === 1 ? 'id' : 'p' + n)); return `{{${n}}}`; })
      .replace(/\\(.)/g, '$1');
    return { template: p, names };
  };
  const fillPath = ({ template, names }, literals = {}) =>
    template.replace(/\{\{(\d+)\}\}/g, (mm, i) => literals[i] ?? `:${names[i - 1]}`);
  for (const f of files) {
    // a file only counts when it looks like an http handler
    if (!/\b(createServer|req\.url|request\.url|IncomingMessage|req\.method)\b/.test(f.src)) continue;
    // 'GET /api/x' strings
    for (const x of f.src.matchAll(/(['"`])(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\/[^'"`\s]*)\1/g)) {
      if (f.m[x.index] !== x[1]) continue;
      out.push({ method: x[2].toLowerCase(), fullPath: x[3], file: f, pos: x.index, handlerText: blockAfter(f, x.index), guards: [] });
    }
    // pathname comparisons
    for (const x of f.src.matchAll(/\b([\w.]*(?:pathname|path|url|route|^p)|p)\s*===?\s*(['"`])(\/[^'"`\s]*)\2/gm)) {
      if (f.m[x.index] === ' ' || !/(pathname|^p$|^path$|^url$|\.url$|^route$)/.test(x[1])) continue;
      const cond = conditionAround(f, x.index);
      const mm = cond.text.match(METHOD_RE);
      out.push({ method: (mm ? mm[2] : 'get').toLowerCase(), anyMethod: !mm, fullPath: x[3], file: f, pos: x.index, handlerText: blockAfter(f, cond.end), guards: [] });
    }
    // const m = p.match(/^\/api\/x\/([^/]+)$/)   then   if (m && req.method === 'DELETE')
    for (const x of f.src.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*[\w.]+\.match\(\s*\/\^?(\\\/[^\n]*?)\/[gimsuy]*\s*\)/g)) {
      const tpl = regexToPath(x[2]);
      if (!tpl.template.startsWith('/')) continue;
      const v = x[1];
      let found = false;
      for (const u of f.src.slice(x.index).matchAll(new RegExp(`\\bif\\s*\\(\\s*${v}\\s*&&`, 'g'))) {
        const pos = x.index + u.index;
        const cond = conditionAround(f, pos + 3);
        const mm = cond.text.match(METHOD_RE);
        // if (m && m[2] === 'tables') -> that segment is the literal "tables"
        const literals = {};
        for (const lit of cond.text.matchAll(new RegExp(`\\b${v}\\[(\\d+)\\]\\s*===?\\s*(['"])([^'"]+)\\2`, 'g'))) literals[lit[1]] = lit[3];
        out.push({ method: (mm ? mm[2] : 'get').toLowerCase(), anyMethod: !mm, fullPath: fillPath(tpl, literals), file: f, pos, handlerText: blockAfter(f, cond.end), guards: [] });
        found = true;
      }
      if (!found) out.push({ method: 'get', anyMethod: true, fullPath: fillPath(tpl), file: f, pos: x.index, handlerText: '', guards: [] });
    }
  }
  // "/" is the page itself, not an API route
  const routes = out.filter((r) => r.fullPath !== '/');
  // custom headers the server checks once for every request (e.g. a token) belong to each route of that file
  for (const r of routes) {
    const hs = [...r.file.src.matchAll(/\b(?:req|request)\.headers(?:\[\s*['"](x-[\w-]+)['"]|\.get\(\s*['"](x-[\w-]+)['"])/gi)].map((x) => x[1] || x[2]);
    if (hs.length) r.fileHeaders = [...new Set(hs)];
  }
  return routes;
}

function scanNext(project, files) {
  const out = [];
  for (const f of files) {
    const rel = path.relative(project.root, f.abs).split(path.sep).join('/');
    let m = rel.match(/^(?:src\/)?app\/(.*?)\/?route\.[cm]?[jt]sx?$/);
    if (m || /^(?:src\/)?app\/route\.[cm]?[jt]sx?$/.test(rel)) {
      const segs = (m ? m[1] : '').split('/').filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith('@'));
      const p = '/' + segs.map((s) => s.replace(/^\[\[?\.\.\.(\w+)\]?\]$/, ':$1*').replace(/^\[(\w+)\]$/, ':$1')).join('/');
      out.push(...fileRouteExports(f, p));
      continue;
    }
    // SvelteKit: src/routes/**/+server.ts
    m = rel.match(/^src\/routes\/(.*?)\/?\+server\.[jt]s$/);
    if (m || /^src\/routes\/\+server\.[jt]s$/.test(rel)) {
      const segs = (m ? m[1] : '').split('/').filter((s) => s && !/^\(.*\)$/.test(s));
      const p = '/' + segs.map((s) => s.replace(/^\[\.\.\.(\w+)\]$/, ':$1*').replace(/^\[\[?(\w+)\]?\]$/, ':$1')).join('/');
      out.push(...fileRouteExports(f, p));
      continue;
    }
    // Nuxt / Nitro: server/api/users/[id].get.ts -> GET /api/users/:id
    m = rel.match(/^server\/(api|routes)\/(.*)\.[cm]?[jt]s$/);
    if (m) {
      let name = m[2];
      const mm = name.match(/\.(get|post|put|patch|delete|head|options)$/i);
      if (mm) name = name.slice(0, -mm[0].length);
      const segs = name.replace(/(^|\/)index$/, '').split('/').filter(Boolean);
      const p = (m[1] === 'api' ? '/api/' : '/') + segs.map((s) => s.replace(/^\[\.\.\.(\w*)\]$/, ':$1*').replace(/^\[(\w+)\]$/, ':$1')).join('/');
      const guards = [...f.src.matchAll(/\b(require\w*|\w*[Aa]uth\w*|\w*[Ss]ession\w*)\(\s*event/g)].map((x) => x[1]).filter((g) => AUTH_HINT.test(g));
      out.push({ method: (mm ? mm[1] : 'get').toLowerCase(), fullPath: p.replace(/\/$/, '') || '/', file: f, pos: 0, handlerText: f.src, guards: [...new Set(guards)] });
      continue;
    }
    m = rel.match(/^(?:src\/)?pages\/(api\/.*)\.[cm]?[jt]sx?$/);
    if (m) {
      const p = '/' + m[1].replace(/\/index$/, '').split('/').map((s) => s.replace(/^\[\.\.\.(\w+)\]$/, ':$1*').replace(/^\[(\w+)\]$/, ':$1')).join('/');
      const methods = [...new Set([...f.src.matchAll(/method\s*===?\s*['"](GET|POST|PUT|PATCH|DELETE)['"]/g)].map((x) => x[1].toLowerCase()))];
      for (const meth of methods.length ? methods : ['get']) out.push({ method: meth, fullPath: p, file: f, pos: 0, handlerText: f.src, guards: [] });
    }
  }
  return out;
}

function scanNest(project, files) {
  const out = [];
  let globalPrefix = '';
  for (const f of files) {
    const gp = f.src.match(/setGlobalPrefix\(\s*(['"`])([^'"`]+)\1/);
    if (gp) globalPrefix = gp[2];
  }
  for (const f of files) {
    for (const c of f.src.matchAll(/@Controller\(\s*(?:(['"`])([^'"`]*)\1|\{[^}]*path\s*:\s*(['"`])([^'"`]*)\3[^}]*\})?\s*\)[\s\S]*?class\s+(\w+)[^{]*\{/g)) {
      const open = c.index + c[0].length - 1;
      const close = matchBracket(f.m, open);
      const body = f.src.slice(open, close);
      const base = joinPath(globalPrefix, c[2] ?? c[4] ?? '');
      const classGuards = (f.src.slice(Math.max(0, c.index - 300), c.index + c[0].length).match(/@UseGuards\(([^)]*)\)/) || [])[1];
      for (const r of body.matchAll(/@(Get|Post|Put|Patch|Delete|Head|Options|All)\(\s*(?:(['"`])([^'"`]*)\2)?\s*\)([\s\S]*?)(?:async\s+)?(\w+)\s*\(([\s\S]*?)\)\s*(?::[^{]+)?\{/g)) {
        const decorators = r[4];
        const params = r[6];
        const query = [...params.matchAll(/@Query\(\s*(['"])(\w+)\1/g)].map((q) => ({ name: q[2], optional: true }));
        const headers = [...params.matchAll(/@Headers\(\s*(['"])([\w-]+)\1/g)].map((q) => q[2]);
        const bodyDto = params.match(/@Body\(\s*\)\s*\w+\s*:\s*(\w+)/);
        const queryDto = params.match(/@Query\(\s*\)\s*\w+\s*:\s*(\w+)/);
        let bodyInfo = null;
        if (bodyDto) { const d = describeSchema(project, f, bodyDto[1]); if (d.type === 'object') bodyInfo = bodySpec(d, bodyDto[1]); }
        if (queryDto) { const d = describeSchema(project, f, queryDto[1]); if (d.type === 'object') for (const fl of d.fields) query.push({ name: fl.name, optional: !!fl.schema.optional }); }
        const g = [classGuards, (decorators.match(/@UseGuards\(([^)]*)\)/) || [])[1]].filter(Boolean).join(', ');
        out.push({ method: r[1].toLowerCase(), fullPath: joinPath(base, r[3] || ''), file: f, pos: open + r.index, guards: g ? g.split(',').map((s) => s.trim()) : [], analysis: { query, headers, body: bodyInfo } });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Public: static scan

function pathParams(p) {
  return [...p.matchAll(/:(\w+)(\*|\?)?|\{(\w+)\}|\[(\w+)\]/g)].map((m) => ({ name: m[1] || m[3] || m[4], optional: m[2] === '?' }));
}

export function scanProject(root) {
  const project = new Project(root);
  const paths = project.listSources();
  const files = paths.map((p) => project.file(p)).filter(Boolean);
  project._routerScanned = new Set(files.map((f) => f.abs));
  const routes = [];

  const nodes = scanRouters(project, files);
  for (const r of collectRoutes(project, nodes)) {
    const handlerArgs = r.args.slice(1);
    const last = handlerArgs[handlerArgs.length - 1];
    let text = last ? last.text : '';
    // handler is a reference (controller fn) -> use that function's body
    const ref = text.match(/^(?:(\w+)\.)?(\w+)$/);
    if (ref) {
      const name = ref[2];
      let fn = r.file.functions.find((x) => x.name === name);
      let ff = r.file;
      if (!fn) {
        const b = resolveBinding(project, r.file, ref[1] || name);
        if (b && b.name !== '*') { ff = b.file; fn = b.file.functions.find((x) => x.name === b.name); }
        else if (b && b.name === '*') { ff = b.file; fn = b.file.functions.find((x) => x.name === name); }
        if (!fn && ff) { const meth = ff.src.match(new RegExp(`\\b${name}\\s*(?::\\s*[^=]+)?[(=]`)); if (meth) text = ff.src.slice(meth.index, meth.index + 4000); }
      }
      if (fn) text = ff.src.slice(fn.bodyStart, fn.end);
      r.handlerFile = ff;
    }
    const analysis = analyzeHandler(project, r.handlerFile || r.file, text, r.method, handlerArgs.slice(0, -1).map((a) => a.text));
    routes.push(finishRoute(project, r, analysis));
  }
  for (const r of scanNext(project, files)) routes.push(finishRoute(project, r, analyzeHandler(project, r.file, r.handlerText, r.method)));
  for (const r of scanNest(project, files)) routes.push(finishRoute(project, r, r.analysis));
  for (const r of scanPlainHttp(project, files)) routes.push(finishRoute(project, r, analyzeHandler(project, r.file, r.handlerText, r.method)));

  // de-duplicate (same method+path) and sort by path
  const seen = new Set();
  const unique = routes.filter((r) => { const k = r.method + ' ' + r.path; if (seen.has(k)) return false; seen.add(k); return true; });
  // catch-all routes (/:path*, usually a 404 fallback) go last
  const wild = (r) => (/\*/.test(r.path) ? 1 : 0);
  unique.sort((a, b) => wild(a) - wild(b) || a.path.localeCompare(b.path) || HTTP_METHODS.indexOf(a.method.toLowerCase()) - HTTP_METHODS.indexOf(b.method.toLowerCase()));
  return { source: 'code', routes: unique, filesScanned: files.length };
}

function finishRoute(project, r, analysis) {
  const method = r.method === 'all' ? 'get' : r.method;
  return {
    method: method.toUpperCase(),
    anyMethod: r.method === 'all' || !!r.anyMethod,
    path: r.fullPath,
    file: path.relative(project.root, r.file.abs).split(path.sep).join('/'),
    line: lineOf(r.file.src, r.pos),
    guards: r.guards || [],
    unmounted: !!r.unmounted,
    params: pathParams(r.fullPath),
    query: [...new Map((analysis?.query || []).map((q) => [q.name, q])).values()],
    headers: [...new Set([...(r.fileHeaders || []), ...(analysis?.headers || [])])],
    body: analysis?.body || null,
  };
}

// ---------------------------------------------------------------------------------------------
// Public: OpenAPI from the running API

const SPEC_PATHS = ['/openapi.json', '/swagger.json', '/api-docs', '/api-docs/swagger.json', '/api/openapi.json', '/api/docs-json', '/docs-json', '/docs/json', '/v3/api-docs', '/swagger/v1/swagger.json', '/api/swagger.json', '/doc', '/openapi'];

export async function fetchOpenApi(baseUrl) {
  for (const p of SPEC_PATHS) {
    try {
      const res = await fetch(baseUrl.replace(/\/$/, '') + p, { signal: AbortSignal.timeout(1500), headers: { accept: 'application/json' } });
      if (!res.ok) continue;
      const text = await res.text();
      if (text.length > 20 * 1024 * 1024) continue;
      let spec;
      try { spec = JSON.parse(text); } catch { continue; }
      if (spec && (spec.openapi || spec.swagger) && spec.paths) return { url: p, routes: openApiRoutes(spec) };
    } catch { /* next */ }
  }
  return null;
}

function openApiRoutes(spec) {
  const resolveRef = (s, depth = 0) => {
    if (!s || depth > 10) return s;
    if (s.$ref) {
      const parts = s.$ref.replace(/^#\//, '').split('/');
      let t = spec;
      for (const p of parts) t = t?.[p.replace(/~1/g, '/').replace(/~0/g, '~')];
      return resolveRef(t, depth + 1);
    }
    return s;
  };
  const toSchema = (s, depth = 0) => {
    s = resolveRef(s);
    if (!s || depth > 6) return { type: 'unknown' };
    if (s.allOf) {
      const fields = s.allOf.map((x) => toSchema(x, depth + 1)).flatMap((x) => (x.type === 'object' ? x.fields : []));
      return { type: 'object', fields };
    }
    if (s.oneOf || s.anyOf) return toSchema((s.oneOf || s.anyOf)[0], depth + 1);
    if (s.enum) return { type: 'enum', values: s.enum.map(String) };
    const t = Array.isArray(s.type) ? s.type.find((x) => x !== 'null') : s.type;
    if (t === 'object' || s.properties) {
      const req = new Set(s.required || []);
      return { type: 'object', fields: Object.entries(s.properties || {}).map(([k, v]) => ({ name: k, schema: { ...toSchema(v, depth + 1), optional: !req.has(k) } })) };
    }
    if (t === 'array') return { type: 'array', of: toSchema(s.items, depth + 1) };
    if (t === 'integer' || t === 'number') return { type: 'number' };
    if (t === 'boolean') return { type: 'boolean' };
    if (t === 'string') return { type: 'string', format: s.format };
    return { type: 'unknown' };
  };
  const routes = [];
  const basePath = spec.basePath || (spec.servers?.[0]?.url && /^\//.test(spec.servers[0].url) ? spec.servers[0].url : '');
  for (const [p, item] of Object.entries(spec.paths || {})) {
    for (const [m, op] of Object.entries(item)) {
      if (!HTTP_METHODS.includes(m)) continue;
      const params = [...(item.parameters || []), ...(op.parameters || [])].map((x) => resolveRef(x));
      let body = null;
      const content = resolveRef(op.requestBody)?.content;
      const json = content?.['application/json'] || (content && Object.values(content)[0]);
      if (json?.schema) {
        const s = toSchema(json.schema);
        body = { source: 'openapi', fields: fieldRows(s), example: json.example ?? exampleOf(s) };
      } else {
        const bp = params.find((x) => x.in === 'body');
        if (bp?.schema) { const s = toSchema(bp.schema); body = { source: 'openapi', fields: fieldRows(s), example: exampleOf(s) }; }
      }
      const full = joinPath(basePath, p.replace(/\{(\w+)\}/g, ':$1'));
      routes.push({
        method: m.toUpperCase(), path: full, summary: op.summary || op.operationId || '', file: null, line: null,
        guards: (op.security || spec.security || []).flatMap((s) => Object.keys(s)),
        params: pathParams(full), query: params.filter((x) => x.in === 'query').map((x) => ({ name: x.name, optional: !x.required })),
        headers: params.filter((x) => x.in === 'header').map((x) => x.name), body,
      });
    }
  }
  return routes;
}

// ---------------------------------------------------------------------------------------------
// Is a folder an API (vs a website)?

const API_DEPS = ['express', 'fastify', 'hono', 'koa', '@nestjs/core', '@hapi/hapi', 'restify', 'elysia', '@trpc/server', 'apollo-server', '@apollo/server', 'polka', 'h3'];
const APP_DEPS = ['electron', 'electron-forge', '@electron-forge/cli', 'nw', '@neutralinojs/neu'];
/** A .NET project that isn't ASP.NET (console/WinForms/WPF/Avalonia), or a Rust/Go program without a web framework. */
function isNativeApp(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return false; }
  const read = (n) => { try { return fs.readFileSync(path.join(dir, n), 'utf8').slice(0, 200000); } catch { return ''; } };
  const csproj = names.find((n) => /\.(cs|fs|vb)proj$/i.test(n));
  if (csproj) return !/Microsoft\.NET\.Sdk\.(Web|BlazorWebAssembly|Razor)/i.test(read(csproj));
  if (names.includes('Cargo.toml')) return !/^\s*(actix-web|axum|rocket|warp|tide|poem|salvo)\s*=/m.test(read('Cargo.toml'));
  if (names.includes('go.mod')) return !/(gin-gonic|labstack\/echo|gofiber|go-chi|gorilla\/mux|net\/http)/.test(read('go.mod') + names.filter((n) => n.endsWith('.go')).slice(0, 20).map(read).join('\n'));
  return false;
}
const WEB_DEPS = ['next', 'nuxt', 'vite', 'react-scripts', '@angular/core', 'astro', '@sveltejs/kit', '@remix-run/dev', 'gatsby', 'parcel', '@vue/cli-service', 'webpack-dev-server'];

/** First file under `dir` (depth-limited) whose relative path matches `re`. */
function findFile(dir, re, depth = 0, base = dir) {
  if (depth > 10) return null;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const hit = findFile(p, re, depth + 1, base); if (hit) return hit; }
    else if (re.test(path.relative(base, p).split(path.sep).join('/'))) return p;
  }
  return null;
}

/** Framework file-based API routes inside a frontend project (Next, SvelteKit, Nuxt, Remix resource routes). */
function hasFileApiRoutes(dir) {
  const has = (p) => fs.existsSync(path.join(dir, p));
  if (['pages/api', 'src/pages/api', 'server/api', 'server/routes'].some(has)) return true;
  for (const appDir of ['app', 'src/app']) if (has(appDir) && findFile(path.join(dir, appDir), /(^|\/)route\.[cm]?[jt]sx?$/)) return true;
  if (has('src/routes') && findFile(path.join(dir, 'src/routes'), /(^|\/)\+server\.[jt]s$/)) return true;
  return false;
}

/** The server's entry file for plain Node projects (from "node server.js" in scripts, "main", or common names). */
function entryFile(dir, pkg) {
  const scripts = Object.values(pkg?.scripts || {}).join(' ');
  const fromScript = scripts.match(/\b(?:node|nodemon|tsx|ts-node|bun)\s+(?:--[\w-]+(?:=\S+)?\s+)*([\w./-]+\.[cm]?[jt]s)\b/);
  const candidates = [fromScript?.[1], pkg?.main, 'server.js', 'server.mjs', 'server.ts', 'index.js', 'app.js', 'src/server.ts', 'src/server.js', 'src/index.ts', 'src/index.js', 'src/app.ts', 'src/main.ts'];
  for (const c of candidates) if (c && fs.existsSync(path.join(dir, c))) return path.join(dir, c);
  return null;
}

/**
 * Website, API, or both?
 *  - frontend framework + its own API routes (Next app/api, pages/api, Nuxt server/api, SvelteKit +server) -> both
 *  - frontend framework + server framework (e.g. Vite + Express) -> both
 *  - server that also serves a page (express.static, sendFile, public/index.html) -> both
 *  - server only -> api; frontend only -> web
 */
export function guessKind(dir) {
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { /* none */ }
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  const web = WEB_DEPS.some((d) => deps[d]);
  const apiDeps = API_DEPS.some((d) => deps[d]);

  // programs that run on the PC, not in a browser: desktop shells (even with a Vite front end), CLI packages, native projects
  if (APP_DEPS.some((d) => deps[d]) || Object.keys(deps).some((d) => d.startsWith('@tauri-apps/'))) return 'app';
  if (pkg?.bin && !web && !apiDeps) return 'app';
  if (!pkg && isNativeApp(dir)) return 'app';

  if (web) return hasFileApiRoutes(dir) || apiDeps ? 'both' : 'web';

  const entry = entryFile(dir, pkg);
  let src = '';
  try { if (entry) src = fs.readFileSync(entry, 'utf8').slice(0, 400000); } catch { /* unreadable */ }
  const servesPage = /express\.static|serveStatic|serve-static|@fastify\/static|sendFile\(|\bsirv\b|index\.html|text\/html/.test(src)
    || ['public/index.html', 'static/index.html', 'www/index.html', 'client/index.html'].some((p) => fs.existsSync(path.join(dir, p)));
  const hasApi = apiDeps || /['"`]\/api\/|req\.method|request\.method|\.(get|post|put|delete)\(\s*['"`]\//.test(src);

  if (hasApi && servesPage && src) return 'both';
  if (apiDeps) return 'api';
  if (src && /createServer/.test(src)) return servesPage ? 'both' : 'api';
  if (fs.existsSync(path.join(dir, 'manage.py'))) return 'api';
  return 'web';
}
