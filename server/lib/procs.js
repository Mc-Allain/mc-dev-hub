// Runs launcher commands as child processes, keeps their logs and tracks their state.
//
// Status flow: starting -> running (process alive) -> ready (its port answers)
//              -> stopping -> stopped | exited (non-zero code = crashed)
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { isWin, isPortOpen, killTree } from './system.js';

const MAX_LINES = 5000;

export function parseEnvText(text = '') {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

export function launcherDir(env, launcher) {
  return path.resolve(env.path, launcher.cwd || '.');
}

export function launcherUrl(launcher) {
  if (launcher.url) return launcher.url;
  return launcher.port ? `http://localhost:${launcher.port}` : '';
}

export class ProcessManager extends EventEmitter {
  constructor() {
    super();
    this.runs = new Map(); // launcherId -> run
    this.timer = setInterval(() => this.#checkPorts(), 1500);
    this.timer.unref();
  }

  #run(id) {
    let r = this.runs.get(id);
    if (!r) {
      r = { id, envId: null, status: 'stopped', pid: null, child: null, startedAt: null, exitCode: null,
            lines: [], seq: 0, partial: '', partialTimer: null, port: null, restarts: 0, wantStop: false, launcher: null, env: null };
      this.runs.set(id, r);
    }
    return r;
  }

  info(id) {
    const r = this.runs.get(id);
    if (!r) return { id, status: 'stopped' };
    return { id, envId: r.envId, status: r.status, pid: r.pid, startedAt: r.startedAt, exitCode: r.exitCode, port: r.port, restarts: r.restarts, monitored: !!r.monitored };
  }

  snapshot() {
    const out = {};
    for (const id of this.runs.keys()) out[id] = this.info(id);
    return out;
  }

  isActive(id) {
    const s = this.runs.get(id)?.status;
    return s === 'starting' || s === 'running' || s === 'ready' || s === 'stopping';
  }

  logs(id) {
    const r = this.runs.get(id);
    return r ? { lines: r.lines, endSeq: r.seq } : { lines: [], endSeq: 0 };
  }

  clearLogs(id) {
    const r = this.runs.get(id);
    if (!r) return;
    r.lines = [];
    this.emit('clear', { id });
  }

  #setStatus(r, status, extra = {}) {
    r.status = status;
    Object.assign(r, extra);
    this.emit('status', this.info(r.id));
  }

  #push(r, text, kind = 'out') {
    const lines = [];
    for (const raw of text) {
      r.seq += 1;
      const line = { s: r.seq, k: kind, t: raw };
      r.lines.push(line);
      lines.push(line);
    }
    if (r.lines.length > MAX_LINES) r.lines.splice(0, r.lines.length - MAX_LINES);
    if (lines.length) this.emit('log', { id: r.id, lines });
  }

  // Splits a stream chunk into lines. Carriage returns (progress bars) keep only the last redraw.
  #onData(r, chunk, kind) {
    clearTimeout(r.partialTimer);
    const text = r.partial + chunk.toString('utf8');
    const parts = text.split('\n');
    r.partial = parts.pop();
    const done = parts.map((p) => {
      p = p.replace(/\r$/, '');
      const i = p.lastIndexOf('\r');
      return i >= 0 ? p.slice(i + 1) : p;
    });
    this.#push(r, done, kind);
    // Flush a dangling prompt ("Continue? (y/n)") that never ends with a newline
    if (r.partial) {
      r.partialTimer = setTimeout(() => {
        if (r.partial) { const p = r.partial; r.partial = ''; this.#push(r, [p.slice(p.lastIndexOf('\r') + 1)], kind); }
      }, 250);
    }
  }

  system(id, msg) {
    this.#push(this.#run(id), [msg], 'sys');
  }

  start(env, launcher) {
    const r = this.#run(launcher.id);
    if (this.isActive(launcher.id)) return this.info(launcher.id);
    if (!launcher.command) throw Object.assign(new Error('This launcher has no command yet. Edit it and add one, e.g. npm run dev'), { status: 400 });
    const cwd = launcherDir(env, launcher);
    if (!fs.existsSync(cwd)) throw Object.assign(new Error(`Working folder not found: ${cwd}`), { status: 400 });

    const vars = { ...process.env, FORCE_COLOR: '1', ...parseEnvText(launcher.envText) };
    delete vars.MCDH_DATA_DIR; delete vars.MCDH_WATCH_STDIN;
    // the console renders colors; an inherited NO_COLOR only makes Node warn about the conflict
    if (!('NO_COLOR' in parseEnvText(launcher.envText))) delete vars.NO_COLOR;
    if (launcher.port && !parseEnvText(launcher.envText).PORT) vars.PORT = String(launcher.port);
    // network monitor: load the capture hook into this launcher's Node processes
    r.monitored = !!(launcher.monitor && this.monitorEnv);
    if (r.monitored) Object.assign(vars, this.monitorEnv(launcher, vars.NODE_OPTIONS || ''));

    r.envId = env.id;
    r.env = env;
    r.launcher = launcher;
    r.wantStop = false;
    r.port = launcher.port || null;
    r.partial = '';
    this.#push(r, [`▶ ${launcher.command}`, `  in ${cwd}${launcher.port ? `  ·  port ${launcher.port}` : ''}${r.monitored ? '  ·  network monitor on' : ''}`], 'sys');
    if (r.monitored) this.emit('monitorStart', launcher.id);

    const child = spawn(launcher.command, {
      cwd, env: vars, shell: true, windowsHide: true, detached: !isWin, stdio: ['pipe', 'pipe', 'pipe'],
    });
    r.child = child;
    this.#setStatus(r, 'starting', { pid: child.pid ?? null, startedAt: Date.now(), exitCode: null });

    child.stdout.on('data', (c) => this.#onData(r, c, 'out'));
    child.stderr.on('data', (c) => this.#onData(r, c, 'err'));
    child.stdin.on('error', () => {});
    child.once('spawn', () => {
      if (r.child === child && r.status === 'starting' && !r.port) this.#setStatus(r, 'running');
    });
    child.once('error', (err) => {
      this.#push(r, [`✖ Could not start: ${err.message}`], 'sys');
    });
    child.once('close', (code, signal) => {
      if (r.child !== child) return;
      clearTimeout(r.partialTimer);
      if (r.partial) { this.#push(r, [r.partial], 'out'); r.partial = ''; }
      const stopped = r.wantStop;
      const exitCode = code ?? (signal ? 1 : 0);
      r.child = null;
      const ranFor = Date.now() - (r.startedAt || Date.now());
      if (stopped) {
        this.#push(r, ['■ Stopped'], 'sys');
        this.#setStatus(r, 'stopped', { pid: null, exitCode: null });
      } else {
        this.#push(r, [`■ Exited with code ${exitCode}${signal ? ` (${signal})` : ''}`], 'sys');
        this.#setStatus(r, 'exited', { pid: null, exitCode });
        if (exitCode !== 0 && r.launcher?.autoRestart) {
          if (ranFor > 30000) r.restarts = 0;
          if (r.restarts < 5) {
            r.restarts += 1;
            this.#push(r, [`↻ Restarting in 2s (attempt ${r.restarts} of 5)`], 'sys');
            setTimeout(() => {
              if (!this.isActive(r.id) && r.status === 'exited') {
                try { this.start(r.env, r.launcher); } catch (e) { this.#push(r, [`✖ ${e.message}`], 'sys'); }
              }
            }, 2000);
          } else {
            this.#push(r, ['✖ Crashed 5 times in a row, not restarting again'], 'sys');
          }
        }
      }
      this.emit('exit', this.info(r.id));
    });
    return this.info(launcher.id);
  }

  async stop(id) {
    const r = this.runs.get(id);
    if (!r || !r.child) {
      if (r && r.status !== 'stopped' && r.status !== 'exited') this.#setStatus(r, 'stopped', { pid: null });
      return;
    }
    const child = r.child;
    r.wantStop = true;
    r.restarts = 0;
    this.#setStatus(r, 'stopping');
    const closed = new Promise((res) => child.once('close', res));
    await killTree(child.pid);
    await Promise.race([closed, new Promise((res) => setTimeout(res, 6000))]);
    if (r.child === child) { // never reported close; give up on it
      r.child = null;
      this.#setStatus(r, 'stopped', { pid: null });
    }
  }

  async restart(env, launcher) {
    await this.stop(launcher.id);
    return this.start(env, launcher);
  }

  write(id, text) {
    const r = this.runs.get(id);
    if (!r?.child?.stdin?.writable) throw Object.assign(new Error('Process is not running'), { status: 409 });
    this.#push(r, [`› ${text}`], 'in');
    r.child.stdin.write(text + (isWin ? '\r\n' : '\n'));
  }

  async stopAll() {
    await Promise.all([...this.runs.values()].filter((r) => r.child).map((r) => this.stop(r.id)));
  }

  async #checkPorts() {
    for (const r of this.runs.values()) {
      if (!r.child || !r.port || r.status === 'stopping') continue;
      if (r.status !== 'starting' && r.status !== 'running' && r.status !== 'ready') continue;
      const open = await isPortOpen(r.port);
      if (!r.child) continue;
      if (open && r.status !== 'ready') {
        const first = r.status === 'starting';
        this.#setStatus(r, 'ready');
        if (first) {
          const url = launcherUrl(r.launcher || {});
          this.#push(r, [`✔ Ready on port ${r.port}${url ? ` · ${url}` : ''}`], 'sys');
          if (r.launcher?.openOnReady && url) this.emit('openSite', { url, title: r.launcher.name, launcherId: r.id });
        }
      } else if (!open && r.status === 'ready') {
        this.#setStatus(r, 'running');
      }
    }
  }
}
