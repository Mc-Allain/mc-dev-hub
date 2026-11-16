// Suggests launchers for a folder by reading package.json scripts (including monorepo workspaces).
import fs from 'node:fs';
import path from 'node:path';
import { guessKind } from './apiscan.js';

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', 'out', 'coverage', '.cache', 'vendor']);
const SCRIPT_ORDER = ['dev', 'start:dev', 'develop', 'serve', 'start', 'watch'];
const FRAMEWORK_PORTS = [
  ['next', 3000], ['nuxt', 3000], ['@remix-run/dev', 3000], ['@sveltejs/kit', 5173], ['astro', 4321],
  ['@angular/core', 4200], ['vite', 5173], ['react-scripts', 3000], ['gatsby', 8000], ['@nestjs/core', 3000],
  ['express', 3000], ['fastify', 3000], ['hono', 3000], ['@vue/cli-service', 8080], ['parcel', 1234], ['webpack-dev-server', 8080],
];

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

function packageManager(root) {
  const has = (f) => fs.existsSync(path.join(root, f));
  if (has('pnpm-lock.yaml') || has('pnpm-workspace.yaml')) return 'pnpm';
  if (has('bun.lockb') || has('bun.lock')) return 'bun';
  if (has('yarn.lock')) return 'yarn';
  return 'npm';
}

function workspacePatterns(root, pkg) {
  const pats = [];
  const ws = pkg?.workspaces;
  if (Array.isArray(ws)) pats.push(...ws);
  else if (Array.isArray(ws?.packages)) pats.push(...ws.packages);
  const pnpm = path.join(root, 'pnpm-workspace.yaml');
  if (fs.existsSync(pnpm)) {
    let inPackages = false;
    for (const line of fs.readFileSync(pnpm, 'utf8').split(/\r?\n/)) {
      if (/^packages\s*:/.test(line)) { inPackages = true; continue; }
      if (inPackages) {
        const m = line.match(/^\s*-\s*['"]?([^'"#]+?)['"]?\s*(#.*)?$/);
        if (m) pats.push(m[1]);
        else if (/^\S/.test(line)) inPackages = false;
      }
    }
  }
  return pats.filter((p) => !p.startsWith('!'));
}

function expand(root, pattern) {
  const clean = pattern.replace(/\/\*\*$/, '/*').replace(/\/$/, '');
  if (!clean.includes('*')) return [path.join(root, clean)];
  const star = clean.indexOf('*');
  const base = path.join(root, clean.slice(0, star).replace(/\/$/, ''));
  if (!isDir(base)) return [];
  return fs.readdirSync(base).filter((n) => !SKIP.has(n)).map((n) => path.join(base, n)).filter(isDir);
}

function guessPort(pkg, scriptText) {
  const m = scriptText.match(/(?:--port[ =]|-p[ =]?|PORT=)(\d{2,5})/);
  if (m) return +m[1];
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  for (const [name, port] of FRAMEWORK_PORTS) if (deps[name]) return port;
  return null;
}

function suggestFor(root, dir, pm, isRoot) {
  const pkg = readJson(path.join(dir, 'package.json'));
  if (!pkg?.scripts) return null;
  const script = SCRIPT_ORDER.find((s) => pkg.scripts[s]);
  if (!script) return null;
  const rel = path.relative(root, dir).split(path.sep).join('/');
  const run = pm === 'npm' ? `npm run ${script}` : `${pm} ${script}`;
  return {
    name: isRoot ? (pkg.name?.replace(/^@[^/]+\//, '') || path.basename(dir)) : path.basename(dir),
    cwd: rel,
    command: run,
    port: guessPort(pkg, pkg.scripts[script]),
    script,
    scripts: Object.keys(pkg.scripts),
    kind: guessKind(dir),
  };
}

export function detect(root) {
  if (!isDir(root)) return { packageManager: null, suggestions: [], error: 'Folder not found' };
  const pm = packageManager(root);
  const rootPkg = readJson(path.join(root, 'package.json'));
  const dirs = new Set();
  for (const p of workspacePatterns(root, rootPkg)) for (const d of expand(root, p)) dirs.add(path.resolve(d));
  if (!dirs.size) {
    // no workspaces declared: look one and two levels down (api/, client/, apps/web, ...)
    for (const n of fs.readdirSync(root)) {
      const d = path.join(root, n);
      if (SKIP.has(n) || n.startsWith('.') || !isDir(d)) continue;
      if (fs.existsSync(path.join(d, 'package.json'))) dirs.add(path.resolve(d));
      else if (['apps', 'packages', 'services'].includes(n)) for (const m of fs.readdirSync(d)) if (fs.existsSync(path.join(d, m, 'package.json'))) dirs.add(path.resolve(d, m));
    }
  }
  const suggestions = [];
  const rootSug = suggestFor(root, root, pm, true);
  if (rootSug) suggestions.push(rootSug);
  for (const d of [...dirs].sort()) {
    const s = suggestFor(root, d, pm, false);
    if (s) suggestions.push(s);
  }
  // In a monorepo the root "dev" usually runs everything (turbo/concurrently); default to the packages.
  for (const s of suggestions) s.recommended = suggestions.length === 1 || s.cwd !== '';
  return { packageManager: pm, suggestions };
}
