// CLI sessions: extra command lines inside a launcher's folder, shown as console tabs.
// Each command you type runs in the chosen shell with the launcher's environment variables.
// `cd` is remembered between commands; `cls` / `clear` clear the tab.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isWin, killTree, cliShellCommand, freshEnv, withVars } from './system.js';
import { parseEnvText, launcherDir } from './procs.js';

const MAX_LINES = 5000;
const CD = /^\s*(?:cd|chdir|sl|set-location|pushd)(?:\s+\/d)?(?:\s+(.+?))?\s*;?\s*$/i;
const CLEAR = /^\s*(?:cls|clear|clear-host)\s*$/i;
const unquote = (s) => s.replace(/^(['"])(.*)\1$/, '$2');

export class CliManager extends EventEmitter {
  /** @param {(launcherId: string) => ({ env, launcher } | null)} resolve  finds the launcher's current settings */
  constructor(resolve) {
    super();
    this.resolve = resolve;
    this.sessions = new Map(); // id -> session
  }

  info(s) {
    return {
      id: s.id, launcherId: s.launcherId, envId: s.envId, n: s.n, cwd: s.cwd, shell: s.shell, createdAt: s.createdAt,
      running: !!s.child, command: s.command || '', pid: s.child?.pid ?? null, startedAt: s.child ? s.startedAt : null,
    };
  }

  list() { return [...this.sessions.values()].map((s) => this.info(s)); }
  get(id) { return this.sessions.get(id) || null; }

  /** Running commands (for the instances window). */
  running() {
    return [...this.sessions.values()].filter((s) => s.child).map((s) => ({ ...this.info(s) }));
  }

  /** A CLI in a launcher's folder, or (launcher = null) in the environment's own folder. */
  create(env, launcher, shell) {
    const dir = launcher ? launcherDir(env, launcher) : env.path;
    if (!fs.existsSync(dir)) throw Object.assign(new Error(`Folder not found: ${dir}`), { status: 400 });
    const lid = launcher ? launcher.id : null;
    const used = new Set([...this.sessions.values()].filter((s) => s.envId === env.id && s.launcherId === lid).map((s) => s.n));
    let n = 1;
    while (used.has(n)) n++;
    const s = {
      id: 'cli_' + crypto.randomBytes(5).toString('hex'), launcherId: lid, envId: env.id, n, cwd: dir, root: env.path, shell,
      env, launcher, lines: [], seq: 0, partial: '', partialTimer: null, child: null, command: '', startedAt: null, wantStop: false, createdAt: Date.now(),
    };
    this.sessions.set(s.id, s);
    this.#push(s, [`CLI ${n} · ${launcher ? launcher.name : 'project root'} · ${shell}`, `  in ${dir}`, '  Type a command and press Enter. ↑/↓ for history, Ctrl+C stops the running command.'], 'sys');
    this.emit('cli', this.info(s));
    return this.info(s);
  }

  logs(id) {
    const s = this.sessions.get(id);
    return s ? { lines: s.lines, endSeq: s.seq } : { lines: [], endSeq: 0 };
  }

  clear(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.lines = [];
    this.emit('clear', { id });
  }

  #push(s, text, kind = 'out') {
    const lines = text.map((t) => ({ s: ++s.seq, k: kind, t }));
    s.lines.push(...lines);
    if (s.lines.length > MAX_LINES) s.lines.splice(0, s.lines.length - MAX_LINES);
    if (lines.length) this.emit('log', { id: s.id, lines });
  }

  #onData(s, chunk, kind) {
    clearTimeout(s.partialTimer);
    const parts = (s.partial + chunk.toString('utf8')).split('\n');
    s.partial = parts.pop();
    this.#push(s, parts.map((p) => { p = p.replace(/\r$/, ''); return p.slice(p.lastIndexOf('\r') + 1); }), kind);
    if (s.partial) {
      s.partialTimer = setTimeout(() => {
        if (s.partial) { const p = s.partial; s.partial = ''; this.#push(s, [p.slice(p.lastIndexOf('\r') + 1)], kind); }
      }, 250);
    }
  }

  prompt(s) {
    const rel = path.relative(s.root || s.cwd, s.cwd);
    const where = !rel ? path.basename(s.cwd) || s.cwd : rel.startsWith('..') ? s.cwd : path.join(path.basename(s.root), rel);
    return `${where} ›`;
  }

  /** Runs a command, or sends the line to the command that's running. */
  async run(id, text) {
    const s = this.sessions.get(id);
    if (!s) throw Object.assign(new Error('This CLI was closed'), { status: 404 });
    if (s.starting) throw Object.assign(new Error('The previous command is still starting'), { status: 409 });
    if (s.child) {
      if (!s.child.stdin?.writable) throw Object.assign(new Error('The command is not accepting input'), { status: 409 });
      this.#push(s, [`› ${text}`], 'in');
      s.child.stdin.write(text + (isWin ? '\r\n' : '\n'));
      return this.info(s);
    }
    const line = String(text || '').trim();
    if (!line) { this.#push(s, [this.prompt(s)], 'in'); return this.info(s); }
    if (CLEAR.test(line)) { this.clear(id); return this.info(s); }
    this.#push(s, [`${this.prompt(s)} ${line}`], 'in');

    const cd = line.match(CD);
    if (cd) {
      if (!cd[1]) { this.#push(s, [s.cwd], 'out'); return this.info(s); }
      let target = unquote(cd[1].trim());
      if (target === '~' || target.startsWith('~/') || target.startsWith('~\\')) target = path.join(os.homedir(), target.slice(1));
      const next = path.resolve(s.cwd, target);
      let ok = false;
      try { ok = fs.statSync(next).isDirectory(); } catch { ok = false; }
      if (ok) { s.cwd = next; this.emit('cli', this.info(s)); }
      else this.#push(s, [`Folder not found: ${next}`], 'err');
      return this.info(s);
    }

    const found = s.launcherId ? this.resolve?.(s.launcherId) : null; // pick up edits to the launcher's env vars
    if (found) { s.env = found.env; s.launcher = found.launcher; }
    // Windows' variables as they are now (a change made in Windows reaches the next command, no restart needed)
    s.starting = true;
    let base;
    try { base = await freshEnv(); } finally { s.starting = false; }
    if (!this.sessions.has(id)) return this.info(s); // closed meanwhile
    const vars = withVars(base, { FORCE_COLOR: '1', ...parseEnvText(s.launcher?.envText) });
    delete vars.MCDH_DATA_DIR; delete vars.MCDH_WATCH_STDIN;
    if (!('NO_COLOR' in parseEnvText(s.launcher?.envText))) delete vars.NO_COLOR;
    if (s.launcher?.port && !vars.PORT) vars.PORT = String(s.launcher.port);

    const { file, args, verbatim } = cliShellCommand(s.shell, line);
    s.lastCommand = line;
    let child;
    try {
      child = spawn(file, args, { cwd: s.cwd, env: vars, windowsHide: true, windowsVerbatimArguments: !!verbatim, detached: !isWin, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      this.#push(s, [`✖ Could not run: ${err.message}`], 'sys');
      return this.info(s);
    }
    s.child = child;
    s.command = line;
    s.startedAt = Date.now();
    s.wantStop = false;
    s.partial = '';
    child.stdout.on('data', (c) => this.#onData(s, c, 'out'));
    child.stderr.on('data', (c) => this.#onData(s, c, 'err'));
    child.stdin.on('error', () => {});
    child.once('error', (err) => this.#push(s, [`✖ Could not run: ${err.message}`], 'sys'));
    child.once('close', (code) => {
      if (s.child !== child) return;
      clearTimeout(s.partialTimer);
      if (s.partial) { this.#push(s, [s.partial], 'out'); s.partial = ''; }
      const secs = ((Date.now() - s.startedAt) / 1000).toFixed(1);
      if (s.wantStop) this.#push(s, [`■ Stopped after ${secs}s`], 'sys');
      else if (code) this.#push(s, [`✖ Exited with code ${code} · ${secs}s`], 'sys');
      else this.#push(s, [`✓ Done in ${secs}s`], 'sys');
      s.child = null;
      s.command = '';
      this.emit('cli', this.info(s));
    });
    this.emit('cli', this.info(s));
    return this.info(s);
  }

  async stop(id) {
    const s = this.sessions.get(id);
    if (!s?.child) return s ? this.info(s) : null;
    const child = s.child;
    s.wantStop = true;
    const closed = new Promise((r) => child.once('close', r));
    await killTree(child.pid);
    await Promise.race([closed, new Promise((r) => setTimeout(r, 5000))]);
    return this.info(s);
  }

  /**
   * Restarts the console's command with Windows' current variables: stops the running one (e.g. a dev server) and runs
   * it again, or runs the last command again if nothing is running. The tab, its output and its folder stay.
   */
  async restart(id) {
    const s = this.sessions.get(id);
    if (!s) throw Object.assign(new Error('This CLI was closed'), { status: 404 });
    const cmd = s.child ? s.command : s.lastCommand;
    if (!cmd) {
      this.#push(s, ['↻ Fresh start: the next command gets Windows\' current environment variables.'], 'sys');
      return this.info(s);
    }
    if (s.child) await this.stop(id);
    this.#push(s, [`↻ Restarting with fresh environment variables: ${cmd}`], 'sys');
    return this.run(id, cmd);
  }

  async close(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    await this.stop(id);
    this.sessions.delete(id);
    this.emit('cliClosed', { id });
  }

  async closeWhere(pred) {
    await Promise.all([...this.sessions.values()].filter(pred).map((s) => this.close(s.id)));
  }

  async stopAll() {
    await Promise.all([...this.sessions.values()].filter((s) => s.child).map((s) => this.stop(s.id)));
  }
}
