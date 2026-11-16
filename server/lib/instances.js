// Running instances: this launcher's processes, plus other dev servers listening on local ports
// (started from a terminal, an editor, another tool…). Other sources you stop here are remembered
// until you remove them.
import path from 'node:path';
import { isWin, run, killTree } from './system.js';

// Processes that count as "a dev server". Everything else listening (system services, browsers, apps) is left out.
const DEV = /^(node|nodemon|bun|deno|python[\d.]*|pythonw|py|uvicorn|gunicorn|flask|dotnet|java|javaw|php|php-cgi|ruby|rails|puma|go|air|hugo|caddy|nginx|httpd|workerd|wrangler|esbuild)$/i;
const SHELL = /^(cmd|sh|bash|zsh|powershell|pwsh)$/i;
const base = (name) => path.basename(String(name || '')).replace(/\.exe$/i, '');

// ---------- OS queries ----------
const PS_TABLE = [
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
  "$epoch=[datetime]'1970-01-01'",
  'Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ p=$_.ProcessId; pp=$_.ParentProcessId; n=$_.Name; c=$_.CommandLine; ' +
    't=$(if ($_.CreationDate) { [long](($_.CreationDate.ToUniversalTime() - $epoch).TotalMilliseconds) } else { 0 }) } } | ConvertTo-Json -Compress',
].join('; ');

async function processTableWin() {
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_TABLE], { maxBuffer: 32 * 1024 * 1024 });
  let rows = [];
  try { rows = JSON.parse(r.stdout || '[]'); } catch { rows = []; }
  if (!Array.isArray(rows)) rows = [rows];
  return rows.map((x) => ({ pid: x.p, ppid: x.pp, name: base(x.n), cmd: x.c || '', startedAt: x.t || null }));
}
async function processTableUnix() {
  const r = await run('ps', ['-axo', 'pid=,ppid=,command=']);
  return r.stdout.split('\n').map((line) => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) return null;
    return { pid: +m[1], ppid: +m[2], name: base(m[3].split(/\s+/)[0]), cmd: m[3], startedAt: null };
  }).filter(Boolean);
}

/** pid -> [{ port, addr }] for every listening TCP socket */
async function listeners() {
  const out = new Map();
  const add = (pid, addr, port) => {
    if (!pid || !port) return;
    const list = out.get(pid) || [];
    if (!list.some((x) => x.port === port)) list.push({ port, addr });
    out.set(pid, list);
  };
  if (isWin) {
    const [a, b] = await Promise.all([run('netstat.exe', ['-ano', '-p', 'tcp']), run('netstat.exe', ['-ano', '-p', 'tcpv6'])]);
    for (const line of (a.stdout + '\n' + b.stdout).split(/\r?\n/)) {
      const c = line.trim().split(/\s+/);
      if (c.length < 5 || !/LISTEN/i.test(c[3])) continue;
      const i = c[1].lastIndexOf(':');
      add(parseInt(c[4], 10), c[1].slice(0, i), parseInt(c[1].slice(i + 1), 10));
    }
  } else {
    const r = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pn']);
    let pid = 0;
    for (const line of r.stdout.split('\n')) {
      if (line[0] === 'p') pid = parseInt(line.slice(1), 10);
      else if (line[0] === 'n') { const i = line.lastIndexOf(':'); add(pid, line.slice(1, i), parseInt(line.slice(i + 1), 10)); }
    }
  }
  for (const list of out.values()) list.sort((x, y) => x.port - y.port);
  return out;
}

const exposed = (addr) => addr === '0.0.0.0' || addr === '[::]' || addr === '*' || addr === '::';
const portView = (socks) => [...socks].sort((a, b) => a.port - b.port).map((x) => ({ port: x.port, exposed: exposed(x.addr) }));

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
const httpError = (status, msg) => Object.assign(new Error(msg), { status });

export const processTable = () => (isWin ? processTableWin() : processTableUnix());

/** Established TCP connections: [{ pid, localPort, remoteHost, remotePort }] */
export async function establishedConnections() {
  const out = [];
  if (isWin) {
    const [a, b] = await Promise.all([run('netstat.exe', ['-ano', '-p', 'tcp']), run('netstat.exe', ['-ano', '-p', 'tcpv6'])]);
    for (const line of (a.stdout + '\n' + b.stdout).split(/\r?\n/)) {
      const c = line.trim().split(/\s+/);
      if (c.length < 5 || !/ESTABLISHED/i.test(c[3])) continue;
      const li = c[1].lastIndexOf(':');
      const ri = c[2].lastIndexOf(':');
      out.push({ pid: parseInt(c[4], 10), localPort: parseInt(c[1].slice(li + 1), 10), remoteHost: c[2].slice(0, ri).replace(/^\[|\]$/g, ''), remotePort: parseInt(c[2].slice(ri + 1), 10) });
    }
  } else {
    const r = await run('lsof', ['-nP', '-iTCP', '-sTCP:ESTABLISHED', '-F', 'pn']);
    let pid = 0;
    for (const line of r.stdout.split('\n')) {
      if (line[0] === 'p') pid = parseInt(line.slice(1), 10);
      else if (line[0] === 'n') {
        const m = line.slice(1).match(/:(\d+)->(.+):(\d+)$/);
        if (m) out.push({ pid, localPort: +m[1], remoteHost: m[2].replace(/^\[|\]$/g, ''), remotePort: +m[3] });
      }
    }
  }
  return out;
}
export { listeners as listeningSockets };

// ---------- the scanner ----------
export class Instances {
  constructor({ procs, store, clis }) {
    this.procs = procs;
    this.clis = clis;
    this.store = store;
    this.stopped = new Map(); // key -> record of an other-source instance stopped from here
    this.lastOther = new Map(); // key -> running other-source record from the latest scan
    this.pending = null;
    this.cache = null;
  }

  /** Scans at most once every 2 s; concurrent callers share one scan. */
  async scan(force = false) {
    if (!force && this.cache && Date.now() - this.cache.at < 2000) return this.cache.data;
    if (!this.pending) {
      this.pending = this.#scan()
        .then((data) => { this.cache = { at: Date.now(), data }; return data; })
        .finally(() => { this.pending = null; });
    }
    return this.pending;
  }

  invalidate() { this.cache = null; }

  async #scan() {
    const [table, listen] = await Promise.all([isWin ? processTableWin() : processTableUnix(), listeners()]);
    const byPid = new Map(table.map((p) => [p.pid, p]));
    // a "parent" that started after its child is a reused pid, not the real parent
    const parentOf = (p) => {
      const par = byPid.get(p.ppid);
      if (!par || par.pid === p.pid || (par.startedAt && p.startedAt && par.startedAt > p.startedAt)) return null;
      return par;
    };
    const kids = new Map();
    for (const p of table) {
      const par = parentOf(p);
      if (!par) continue;
      if (!kids.has(par.pid)) kids.set(par.pid, []);
      kids.get(par.pid).push(p.pid);
    }
    const treeOf = (root) => {
      const seen = new Set([root]);
      const stack = [root];
      while (stack.length) for (const k of kids.get(stack.pop()) || []) if (!seen.has(k)) { seen.add(k); stack.push(k); }
      return seen;
    };

    // ours: every launcher's process tree
    const statuses = this.procs.snapshot();
    const owned = new Map(); // pid -> launcherId
    for (const s of Object.values(statuses)) if (s.pid) for (const pid of treeOf(s.pid)) owned.set(pid, s.id);
    const cliRuns = this.clis?.running() || []; // commands typed into CLI tabs count as ours too
    for (const c of cliRuns) if (c.pid) for (const pid of treeOf(c.pid)) owned.set(pid, c.id);
    const self = new Set([process.pid, process.ppid]);

    const ownSocks = new Map(); // launcherId -> Map(port -> sock)
    for (const [pid, socks] of listen) {
      const lid = owned.get(pid);
      if (!lid) continue;
      const m = ownSocks.get(lid) || new Map();
      for (const s of socks) m.set(s.port, s);
      ownSocks.set(lid, m);
    }

    const envs = this.store.state.environments;
    const own = [];
    for (const env of envs) {
      for (const c of cliRuns.filter((x) => x.envId === env.id && !x.launcherId)) {
        own.push({
          type: 'cli', envId: env.id, envName: env.name, id: c.id, launcherId: null, name: `project root · CLI ${c.n}`, command: c.command,
          status: 'running', pid: c.pid, startedAt: c.startedAt, exitCode: null, port: null, url: '',
          ports: portView(ownSocks.get(c.id)?.values() || []),
        });
      }
      for (const l of env.launchers) {
        const s = statuses[l.id] || { status: 'stopped' };
        own.push({
          envId: env.id, envName: env.name, id: l.id, name: l.name, command: l.command, kind: l.kind,
          port: l.port || null, url: l.url || (l.port ? `http://localhost:${l.port}` : ''),
          status: s.status, pid: s.pid || null, startedAt: s.startedAt || null, exitCode: s.exitCode ?? null,
          ports: portView(ownSocks.get(l.id)?.values() || []),
        });
        for (const c of cliRuns.filter((x) => x.launcherId === l.id)) {
          own.push({
            type: 'cli', envId: env.id, envName: env.name, id: c.id, launcherId: l.id, name: `${l.name} · CLI ${c.n}`, command: c.command,
            status: 'running', pid: c.pid, startedAt: c.startedAt, exitCode: null, port: null, url: '',
            ports: portView(ownSocks.get(c.id)?.values() || []),
          });
        }
      }
    }

    // others: dev processes listening that aren't ours, grouped under their top-most dev ancestor (npm → vite → …)
    const isFree = (p) => p && !owned.has(p.pid) && !self.has(p.pid);
    const roots = new Map(); // rootPid -> { root, socks, pids }
    for (const [pid, socks] of listen) {
      const p = byPid.get(pid);
      if (!isFree(p) || !DEV.test(p.name)) continue;
      let root = p;
      for (let hops = 0; hops < 20; hops++) {
        const par = parentOf(root);
        if (!isFree(par)) break;
        if (DEV.test(par.name)) { root = par; continue; }
        const grand = SHELL.test(par.name) ? parentOf(par) : null; // npm → cmd /c vite → node
        if (isFree(grand) && DEV.test(grand.name)) { root = grand; continue; }
        break;
      }
      const g = roots.get(root.pid) || { root, socks: new Map(), pids: new Set() };
      for (const s of socks) g.socks.set(s.port, s);
      g.pids.add(pid);
      roots.set(root.pid, g);
    }
    const norm = (s) => String(s || '').toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '');
    const other = new Map();
    for (const { root, socks, pids } of roots.values()) {
      const key = `${root.pid}-${root.startedAt || 0}`;
      const cmd = norm(root.cmd);
      const env = envs.find((e) => e.path && cmd.includes(norm(e.path)));
      other.set(key, {
        key, pid: root.pid, name: root.name, command: root.cmd || root.name, startedAt: root.startedAt,
        parent: parentOf(root)?.name || '', listenerPids: [...pids], ports: portView(socks.values()),
        envName: env ? env.name : '', status: 'running',
      });
    }
    this.lastOther = other;
    for (const k of this.stopped.keys()) if (other.has(k)) this.stopped.delete(k);
    const byPort = (a, b) => (a.ports[0]?.port || 0) - (b.ports[0]?.port || 0);
    const others = [...[...other.values()].sort(byPort), ...[...this.stopped.values()].sort((a, b) => b.stoppedAt - a.stoppedAt)];
    // MC Dev Hub itself: this server (and the desktop app that started it, if any)
    const app = byPid.get(process.ppid);
    const hub = {
      pid: process.pid, startedAt: Math.round(Date.now() - process.uptime() * 1000), node: process.version,
      ports: portView(listen.get(process.pid) || []), command: process.argv.slice(1).join(' '),
      app: app && /mcdevhub/i.test(app.name) ? { pid: app.pid, name: app.name } : null,
    };
    return { own, other: others, hub, self: { pid: process.pid }, scannedAt: Date.now() };
  }

  async stopOther(key) {
    let rec = this.lastOther.get(key);
    if (!rec) { await this.scan(true); rec = this.lastOther.get(key); }
    if (!rec) {
      if (this.stopped.has(key)) return this.stopped.get(key);
      throw httpError(404, 'That process is no longer running');
    }
    await killTree(rec.pid);
    for (let i = 0; i < 15 && alive(rec.pid); i++) await new Promise((r) => setTimeout(r, 150));
    if (alive(rec.pid)) throw httpError(409, `Couldn't stop PID ${rec.pid}. It may be running as administrator.`);
    const done = { ...rec, status: 'stopped', stoppedAt: Date.now() };
    this.lastOther.delete(key);
    this.stopped.set(key, done);
    this.cache = null;
    return done;
  }

  async stopAllOther() {
    await this.scan(true);
    const keys = [...this.lastOther.keys()];
    const results = await Promise.all(keys.map((k) => this.stopOther(k).then(() => ({ key: k, ok: true }), (e) => ({ key: k, ok: false, error: e.message }))));
    return { results };
  }

  removeStopped(key) {
    if (this.lastOther.has(key)) throw httpError(409, 'Only stopped instances can be removed. Stop it first.');
    this.stopped.delete(key);
    this.cache = null;
    return { ok: true };
  }

  removeAllStopped() {
    this.stopped.clear();
    this.cache = null;
    return { ok: true };
  }
}
