// OS helpers: terminals, file manager, editor, browser, folder picker, ports, process trees.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export const isWin = process.platform === 'win32';
export const isMac = process.platform === 'darwin';

export function run(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), err });
    });
  });
}

/** The PATH as Windows has it now (ours + HKCU + HKLM): a program installed after the hub started is on it, though not on ours. */
export async function freshPath() {
  if (!isWin) return process.env.PATH || '';
  const read = async (key) => {
    const r = await run('reg.exe', ['query', key, '/v', 'Path'], { timeout: 5000 });
    const m = r.stdout.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i);
    return m ? m[1].trim().replace(/%([^%]+)%/g, (all, name) => process.env[name] ?? all) : '';
  };
  const [user, machine] = await Promise.all([read('HKCU\\Environment'), read('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment')]);
  return [process.env.PATH || '', user, machine].join(path.delimiter);
}

/**
 * Windows' environment variables as they are now (user + system, from the registry), like a newly opened terminal
 * gets them. The hub's own process.env is frozen at its start, so without this, a variable added, changed or removed
 * in Windows later never reaches CLI commands, launchers or terminals until the whole hub restarts.
 * -> a copy of process.env with the registry's current values on top (and variables deleted from Windows removed)
 */
let envCache = null;      // { at, vars }
let envBaseline = null;   // registry variable names when the hub started: a name gone from there was deleted
export async function freshEnv() {
  const base = { ...process.env };
  if (!isWin) return base;
  if (envCache && Date.now() - envCache.at < 2000) return withVars(base, { ...envCache.vars.set, ...Object.fromEntries(envCache.vars.del.map((k) => [k, undefined])) });
  const read = async (key) => {
    const r = await run('reg.exe', ['query', key], { timeout: 5000 });
    const out = {};
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = /^\s{4}(\S(?:.*?\S)?)\s{4}(REG_SZ|REG_EXPAND_SZ)\s{4}(.*)$/.exec(line);
      if (m) out[m[1]] = { value: m[3], expand: m[2] === 'REG_EXPAND_SZ' };
    }
    return r.code === 0 ? out : null;
  };
  const [machine, user] = await Promise.all([read('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'), read('HKCU\\Environment')]);
  if (!machine || !user) return base; // can't read the registry: keep what we have
  const key = (o, name) => Object.keys(o).find((k) => k.toLowerCase() === name.toLowerCase()) ?? name; // Windows names ignore case
  const merged = {};
  for (const [k, v] of Object.entries(machine)) merged[k] = v;
  for (const [k, v] of Object.entries(user)) {
    const mk = key(merged, k);
    if (k.toLowerCase() === 'path' && merged[mk]) merged[mk] = { value: `${merged[mk].value};${v.value}`, expand: merged[mk].expand || v.expand }; // PATH = system's, then the user's
    else { delete merged[mk]; merged[k] = v; }
  }
  const set = {};
  const lookup = (name) => { const s = set[key(set, name)]; return s ?? process.env[name]; };
  for (const [k, v] of Object.entries(merged)) set[k] = v.value;
  for (let pass = 0; pass < 2; pass++) { // %VAR% inside values (twice, for one level of nesting)
    for (const [k, v] of Object.entries(merged)) if (v.expand) set[k] = set[k].replace(/%([^%]+)%/g, (all, n) => (n.toLowerCase() === k.toLowerCase() ? process.env[n] ?? all : lookup(n) ?? all));
  }
  // folders on the hub's own PATH that Windows' PATH doesn't list (given by whatever started the hub, or added since,
  // e.g. Git found later) stay on it, after Windows' own
  const pk = key(set, 'Path');
  const listed = new Set(String(set[pk] || '').toLowerCase().split(';'));
  const extra = (process.env.PATH || '').split(';').filter((d) => d && !listed.has(d.toLowerCase()));
  if (extra.length) set[pk] = [set[pk], ...extra].filter(Boolean).join(';');
  const names = Object.keys(set).map((k) => k.toLowerCase());
  if (!envBaseline) envBaseline = { names };
  const del = envBaseline.names.filter((n) => !names.includes(n)).map((n) => Object.keys(base).find((k) => k.toLowerCase() === n)).filter(Boolean);
  envCache = { at: Date.now(), vars: { set, del } };
  return freshEnv(); // apply from the cache (one code path)
}
/** freshEnv(), with keys merged case-insensitively onto a copy of the given variables. */
export function withVars(vars, extra) {
  const out = { ...vars };
  for (const [k, v] of Object.entries(extra)) {
    for (const old of Object.keys(out)) if (old !== k && old.toLowerCase() === k.toLowerCase()) delete out[old];
    if (v === undefined) delete out[k]; else out[k] = v;
  }
  return out;
}

/**
 * Git installed while the hub runs isn't on the hub's PATH yet. Looks for it on the fresh PATH and in Git for Windows'
 * usual folders; when found, puts its folder on our PATH so every `git` call (Git tab, AI, CLI tabs) works without a restart.
 * -> the folder added, or '' (not found)
 */
export async function adoptGit() {
  if (!isWin) return '';
  const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  const dirs = [
    ...(await freshPath()).split(path.delimiter).map((d) => d.trim().replace(/^"|"$/g, '')).filter(Boolean),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'cmd'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'cmd'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'cmd'),
  ];
  const dir = dirs.find((d) => exists(path.join(d, 'git.exe')));
  if (!dir) return '';
  const cur = (process.env.PATH || '').split(path.delimiter).map((d) => d.toLowerCase());
  if (!cur.includes(dir.toLowerCase())) process.env.PATH = dir + path.delimiter + (process.env.PATH || '');
  return dir;
}

// Fire-and-forget a program that should outlive this server.
async function launch(file, args, opts = {}) {
  const env = opts.env || await freshEnv(); // a terminal or editor opened now gets Windows' variables as they are now
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: 'ignore', detached: !isWin, windowsHide: false, ...opts, env });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

// Windows: open things through cmd's "start", which always shows the new window normally.
// (This server usually runs without a console. Launching explorer/wt directly with the
// hidden-window flag made their windows open invisibly.) Built verbatim so the quotes reach cmd untouched.
function winShellStart(rest) {
  const line = `/d /s /c "start "" ${rest}"`;
  return launch(process.env.ComSpec || 'cmd.exe', [line], { windowsVerbatimArguments: true, windowsHide: true });
}
const winStart = (cwd, programAndArgs) => winShellStart(`/D "${cwd}" ${programAndArgs}`);

/**
 * Opens a new, visible console window in the chosen shell ('powershell' | 'pwsh' | 'cmd') that runs one program
 * and stays open afterwards, so its result can be read (e.g. an interactive sign-in). Goes through `start`, which
 * always gives the program its own window (as the Terminal button does).
 * -> the shell actually used
 */
export async function openShellWindow(shell, file, args = [], cwd = process.cwd()) {
  if (!isWin) throw new Error('Opening a console window is only supported on Windows for now');
  // characters cmd would act on even inside quotes are dropped (they don't occur in program paths or our arguments)
  const safe = (s) => String(s).replace(/["%\r\n^]/g, '');
  const dir = safe(path.resolve(cwd));
  if (shell === 'cmd') {
    // start "" /D "dir" "cmd.exe" /k ""C:\path\app.exe" "arg" …"  (cmd strips the outer quotes and keeps the window open)
    const quote = (s) => (/^[\w.:\\/-]+$/.test(s) ? s : `"${safe(s)}"`);
    const inner = [`"${safe(file)}"`, ...args.map(quote)].join(' ');
    await winShellStart(`/D "${dir}" "${safe(process.env.ComSpec || 'cmd.exe')}" /k "${inner}"`);
    return 'cmd';
  }
  // PowerShell: & 'C:\path\app.exe' 'arg'  (single quotes are literal there; a ' inside is doubled)
  const lit = (s) => `'${safe(s).replace(/'/g, "''")}'`;
  const used = shell === 'pwsh' && findPwsh() ? 'pwsh' : 'powershell';
  const exe = used === 'pwsh' ? findPwsh() : 'powershell.exe';
  await winShellStart(`/D "${dir}" "${safe(exe)}" -NoExit -NoLogo -NoProfile -Command "& ${[lit(file), ...args.map(lit)].join(' ')}"`);
  return used;
}

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
let wtPath;
function findWindowsTerminal() {
  if (wtPath !== undefined) return wtPath;
  const candidate = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'wt.exe');
  wtPath = exists(candidate) ? candidate : null;
  return wtPath;
}
function findGitBash() {
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], path.join(process.env.LOCALAPPDATA || '', 'Programs')];
  for (const r of roots) {
    if (!r) continue;
    const p = path.join(r, 'Git', 'git-bash.exe');
    if (exists(p)) return p;
  }
  return null;
}

export function terminalChoices() {
  if (isWin) {
    const list = [{ id: 'auto', label: 'Default (Windows Terminal, else PowerShell)' }];
    if (findWindowsTerminal()) list.push({ id: 'wt', label: 'Windows Terminal' });
    list.push({ id: 'powershell', label: 'Windows PowerShell' }, { id: 'pwsh', label: 'PowerShell 7 (pwsh)' }, { id: 'cmd', label: 'Command Prompt' });
    if (findGitBash()) list.push({ id: 'gitbash', label: 'Git Bash' });
    return list;
  }
  if (isMac) return [{ id: 'auto', label: 'Terminal' }, { id: 'iterm', label: 'iTerm' }];
  return [{ id: 'auto', label: 'Default terminal' }];
}

// ---------- shells for CLI tabs ----------
let pwshPath;
function findPwsh() {
  if (pwshPath !== undefined) return pwshPath;
  const dirs = (process.env.PATH || '').split(path.delimiter);
  dirs.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7'));
  pwshPath = dirs.map((d) => path.join(d, 'pwsh.exe')).find(exists) || null;
  return pwshPath;
}
function findGitBashShell() {
  const gb = findGitBash();
  if (!gb) return null;
  const p = path.join(path.dirname(gb), 'bin', 'bash.exe');
  return exists(p) ? p : null;
}

export function cliShells() {
  if (!isWin) return [{ id: 'sh', label: path.basename(process.env.SHELL || 'sh') }];
  const list = [{ id: 'powershell', label: 'Windows PowerShell' }];
  if (findPwsh()) list.push({ id: 'pwsh', label: 'PowerShell 7 (pwsh)' });
  list.push({ id: 'cmd', label: 'Command Prompt' });
  if (findGitBashShell()) list.push({ id: 'bash', label: 'Git Bash' });
  return list;
}

/** How to run one command line in a shell: { file, args, verbatim } */
export function cliShellCommand(shell, line) {
  if (!isWin) return { file: process.env.SHELL || '/bin/sh', args: ['-c', line] };
  if (shell === 'cmd') return { file: process.env.ComSpec || 'cmd.exe', args: [`/d /s /c "${line}"`], verbatim: true };
  if (shell === 'bash' && findGitBashShell()) return { file: findGitBashShell(), args: ['-c', line] };
  // PowerShell: UTF-8, errors as plain text on stderr (a redirected PowerShell otherwise writes them as XML),
  // and the exit code of the last program (or 1 if a cmdlet failed)
  const script = [
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference="SilentlyContinue"; $__failed=$false',
    `& {\n${line}\n} 2>&1 | ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { $__failed=$true; [Console]::Error.WriteLine($_.ToString()) } else { $_ } }`,
    'if ($LASTEXITCODE) { exit $LASTEXITCODE } elseif ($__failed) { exit 1 }',
  ].join('\n');
  const file = shell === 'pwsh' && findPwsh() ? findPwsh() : 'powershell.exe';
  return { file, args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] };
}

export async function openTerminal(dir, choice = 'auto') {
  if (!exists(dir)) throw new Error(`Folder not found: ${dir}`);
  const cwd = path.resolve(dir);
  if (isWin) {
    const wt = findWindowsTerminal();
    if ((choice === 'auto' || choice === 'wt') && wt) {
      // wt chokes on a trailing backslash before its closing quote
      return winStart(cwd, `"${wt}" -d "${cwd.replace(/\\+$/, '') || cwd}"`);
    }
    if (choice === 'pwsh') return winStart(cwd, 'pwsh.exe -NoLogo');
    if (choice === 'cmd') return winStart(cwd, 'cmd.exe');
    if (choice === 'gitbash') {
      const gb = findGitBash();
      if (gb) return winStart(cwd, `"${gb}" --cd="${cwd}"`);
    }
    return winStart(cwd, 'powershell.exe -NoLogo');
  }
  if (isMac) return launch('open', ['-a', choice === 'iterm' ? 'iTerm' : 'Terminal', cwd]);
  return launch('x-terminal-emulator', [], { cwd });
}

export async function openFolder(dir) {
  if (!exists(dir)) throw new Error(`Folder not found: ${dir}`);
  if (isWin) return winShellStart(`"${path.resolve(dir)}"`);
  if (isMac) return launch('open', [dir]);
  return launch('xdg-open', [dir]);
}

export async function openEditor(dir, editor = 'code') {
  if (!exists(dir)) throw new Error(`Folder not found: ${dir}`);
  const cmd = String(editor || 'code').trim();
  if (isWin) {
    // through cmd so "code" resolves to code.cmd from PATH
    return launch(process.env.ComSpec || 'cmd.exe', [`/d /s /c "${cmd} "${path.resolve(dir)}""`], { windowsVerbatimArguments: true, windowsHide: true });
  }
  return launch('/bin/sh', ['-c', `${cmd} "$0"`, dir]);
}

export async function openUrl(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs can be opened');
  if (isWin) return launch('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: false });
  if (isMac) return launch('open', [url]);
  return launch('xdg-open', [url]);
}

const PS_PICK = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; WindowState = 'Minimized' }
$owner.Show(); $owner.Activate()
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'Select a folder'
$d.ShowNewFolderButton = $true
if ($env:MCDH_INITIAL -and (Test-Path -LiteralPath $env:MCDH_INITIAL)) { $d.SelectedPath = $env:MCDH_INITIAL }
if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }
$owner.Close()
`;

// Native folder dialog, used when the UI runs in a normal browser (the desktop app has its own).
export async function pickFolder(initial = '') {
  if (isWin) {
    const r = await run('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-Command', PS_PICK], {
      env: { ...process.env, MCDH_INITIAL: initial || '' }, timeout: 10 * 60 * 1000,
    });
    return r.stdout.trim() || null;
  }
  if (isMac) {
    const r = await run('osascript', ['-e', 'POSIX path of (choose folder with prompt "Select a folder")'], { timeout: 10 * 60 * 1000 });
    return r.code === 0 ? r.stdout.trim().replace(/\/$/, '') || '/' : null;
  }
  const r = await run('zenity', ['--file-selection', '--directory']);
  return r.code === 0 ? r.stdout.trim() : null;
}

function tryConnect(host, port, timeout = 400) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeout, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

// Dev servers bind to 127.0.0.1, ::1 or 0.0.0.0 depending on the tool, so check both loopbacks.
export async function isPortOpen(port) {
  const [v4, v6] = await Promise.all([tryConnect('127.0.0.1', port), tryConnect('::1', port)]);
  return v4 || v6;
}

export async function portOwner(port) {
  let pid = null;
  if (isWin) {
    const r = await run('netstat.exe', ['-ano', '-p', 'tcp']);
    const r6 = await run('netstat.exe', ['-ano', '-p', 'tcpv6']);
    for (const line of (r.stdout + '\n' + r6.stdout).split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length >= 5 && /LISTEN/i.test(cols[3]) && cols[1].endsWith(':' + port)) { pid = parseInt(cols[4], 10); break; }
    }
  } else {
    const r = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
    pid = parseInt(r.stdout.split('\n')[0], 10) || null;
  }
  if (!pid) return null;
  let name = '';
  if (isWin) {
    const r = await run('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    const m = r.stdout.match(/^"([^"]+)"/m);
    name = m ? m[1] : '';
  } else {
    const r = await run('ps', ['-p', String(pid), '-o', 'comm=']);
    name = path.basename(r.stdout.trim());
  }
  return { pid, name };
}

export async function killTree(pid) {
  if (!pid) return;
  if (isWin) {
    await run('taskkill.exe', ['/pid', String(pid), '/T', '/F']);
    return;
  }
  try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  await new Promise((r) => setTimeout(r, 1500));
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}

export function pathInfo(p) {
  try {
    const st = fs.statSync(p);
    return { exists: true, isDir: st.isDirectory(), name: path.basename(path.resolve(p)) };
  } catch {
    return { exists: false, isDir: false, name: path.basename(p || '') };
  }
}
