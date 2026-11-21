// AI in the Git tab, powered by Claude Code (the `claude` CLI) running on this PC with the user's own login.
//
// Each job runs `claude -p` inside the environment's folder with a narrow, read-only tool set, streams its
// progress as JSON lines (shown in the Git tab's AI log), and returns a structured result.
// First job: write a commit message for the current changes. Nothing is committed by it.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isWin, run, killTree, openShellWindow, freshPath, adoptGit } from './system.js';

export const AI_MODELS = [
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (default): fast, good for everyday commits' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5: strongest, for tricky changes' },
];
export const DEFAULT_AI_MODEL = 'claude-sonnet-5-5';

// Secrets and keys Claude never reads (also left out of the diff the hub hands it).
const SECRET_PATTERNS = ['.env', '.env.*', '*.pem', '*.key', '*.pfx', '*.p12', 'id_rsa*', '*.keystore', 'secrets/**'];
const MAX_DIFF = 60 * 1024;
const JOB_TIMEOUT = 4 * 60 * 1000;

// ---------- finding Claude Code ----------
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/** An npm install's `claude.cmd` is a wrapper: run the package's own entry point instead (the wrapper mangles quotes). */
function npmEntry(cmdPath) {
  const pkgDir = path.join(path.dirname(cmdPath), 'node_modules', '@anthropic-ai', 'claude-code');
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.claude;
    if (bin && isFile(path.join(pkgDir, bin))) return path.join(pkgDir, bin);
  } catch { /* not an npm install */ }
  return null;
}

/**
 * Where Claude Code is, in this order:
 *   1. `claude` on the PATH (read fresh from Windows): the CLI from the official installer, winget, or npm
 *   2. the official installer's folder (%USERPROFILE%\.local\bin), npm's global folder, winget's links
 *   3. the copy bundled with the Claude desktop app (newest version)
 * -> { path, via: 'cli' | 'npm' | 'desktop' | 'override' }
 */
async function findClaude() {
  if (process.env.MCDH_CLAUDE_PATH) return { path: process.env.MCDH_CLAUDE_PATH, via: 'override' }; // tests only
  const hit = (p) => {
    if (!isFile(p)) return null;
    if (/\.cmd$/i.test(p)) { const entry = npmEntry(p); return entry ? { path: entry, via: 'npm' } : null; }
    return { path: p, via: 'cli' };
  };
  const exts = isWin ? ['.exe', '.cmd'] : [''];
  for (const dir of (await freshPath()).split(path.delimiter)) {
    if (!dir.trim()) continue;
    for (const ext of exts) { const h = hit(path.join(dir.replace(/^"|"$/g, ''), 'claude' + ext)); if (h) return h; }
  }
  if (isWin) {
    const local = process.env.LOCALAPPDATA || '';
    for (const p of [
      path.join(process.env.USERPROFILE || '', '.local', 'bin', 'claude.exe'),
      path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
      path.join(local, 'Microsoft', 'WinGet', 'Links', 'claude.exe'),
    ]) { const h = hit(p); if (h) return h; }
    // Claude desktop: %LOCALAPPDATA%\Claude-Data\<pkg>\claude-code\<version>\<hash>\claude.exe
    const found = [];
    try {
      for (const pkg of fs.readdirSync(path.join(local, 'Claude-Data'))) {
        const base = path.join(local, 'Claude-Data', pkg, 'claude-code');
        let versions = [];
        try { versions = fs.readdirSync(base); } catch { continue; }
        for (const v of versions) {
          let hashes = [];
          try { hashes = fs.readdirSync(path.join(base, v)); } catch { continue; }
          for (const h of hashes) {
            const p = path.join(base, v, h, 'claude.exe');
            if (fs.existsSync(p)) found.push({ p, v });
          }
        }
      }
    } catch { /* no desktop app */ }
    const cmp = (a, b) => { const x = a.v.split('.').map(Number); const y = b.v.split('.').map(Number); for (let i = 0; i < 4; i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0); return 0; };
    found.sort(cmp);
    if (found[0]) return { path: found[0].p, via: 'desktop' };
  }
  return null;
}

/** How to start it: a .js entry point (npm installs, test stand-ins) goes through Node, anything else directly. */
function claudeSpawnArgs(bin, args) {
  if (/\.(c|m)?js$/i.test(bin)) return { file: process.execPath, args: [bin, ...args] };
  return { file: bin, args };
}

let statusCache = null;
/** { installed, path, via, version, loggedIn, authMethod, error } */
export async function claudeStatus(force = false) {
  if (!force && statusCache && Date.now() - statusCache.at < 30000) return statusCache.data;
  const found = await findClaude();
  let data;
  if (!found) data = { installed: false };
  else {
    const runIt = (args) => { const s = claudeSpawnArgs(found.path, args); return run(s.file, s.args, { timeout: 20000 }); };
    const [ver, auth] = await Promise.all([runIt(['--version']), runIt(['auth', 'status', '--json'])]);
    let a = {};
    try { a = JSON.parse(auth.stdout); } catch { a = {}; }
    data = {
      installed: true, path: found.path, via: found.via,
      version: (ver.stdout.match(/\d+\.\d+\.\d+/) || [''])[0],
      loggedIn: !!a.loggedIn, authMethod: a.authMethod || '',
      // an API key from the environment (ANTHROPIC_API_KEY) or an apiKeyHelper setting: `auth logout` can't remove it
      keySource: typeof a.apiKeySource === 'string' ? a.apiKeySource : '',
      // a saved login (`claude auth login`) that Sign out does remove
      storedLogin: a.storedClaudeAiLogin != null ? !!a.storedClaudeAiLogin : (!!a.loggedIn && !a.apiKeySource),
      error: ver.code !== 0 ? (ver.stderr || ver.stdout).trim().slice(0, 300) : '',
    };
  }
  statusCache = { at: Date.now(), data };
  return data;
}

/** Opens a window in the chosen shell running `claude auth login` with the copy that was found (browser prompts follow). */
export async function openSignIn(shell = 'powershell') {
  const st = await claudeStatus(true);
  if (!st.installed) throw Object.assign(new Error('Claude Code is not installed on this PC.'), { status: 400 });
  const s = claudeSpawnArgs(st.path, ['auth', 'login']);
  const used = await openShellWindow(shell === 'cmd' || shell === 'pwsh' ? shell : 'powershell', s.file, s.args, process.env.USERPROFILE || process.cwd());
  statusCache = null; // the next check reads the new sign-in state
  return { ok: true, shell: used };
}

/** Signs Claude Code out on this PC (`claude auth logout`, no prompts). -> the fresh status */
export async function signOut() {
  const st = await claudeStatus(true);
  if (!st.installed) throw Object.assign(new Error('Claude Code is not installed on this PC.'), { status: 400 });
  if (!st.storedLogin) {
    if (st.keySource) throw Object.assign(new Error(`Claude Code uses an API key from ${st.keySource}. Sign out can't remove it: remove the key where it's set (for ANTHROPIC_API_KEY, your environment variables), then restart MC Dev Hub.`), { status: 400 });
    return st; // nothing saved to sign out of
  }
  const s = claudeSpawnArgs(st.path, ['auth', 'logout']);
  const r = await run(s.file, s.args, { timeout: 20000 });
  const now = await claudeStatus(true);
  // still "signed in" through an API key is expected: the saved login is gone, the key stays where it's set
  if (now.storedLogin || (now.loggedIn && !now.keySource)) throw Object.assign(new Error(`Sign out didn't finish: ${(r.stderr || r.stdout || 'no output').trim().slice(0, 300)}`), { status: 500 });
  return now;
}

// ---------- what the hub hands Claude ----------
async function git(cwd, args) { return run('git', ['-c', 'core.quotepath=off', ...args], { cwd, timeout: 20000 }); }
const excludes = SECRET_PATTERNS.map((p) => `:(exclude,glob)**/${p}`);

/** Status, the diff (staged if anything is staged, otherwise everything), recent history, and which rule files exist. */
async function gatherContext(cwd, { all = false } = {}) {
  const [status, branch, stagedNames, log, branches] = await Promise.all([
    git(cwd, ['status', '--short', '--branch']),
    git(cwd, ['branch', '--show-current']),
    git(cwd, ['diff', '--cached', '--name-only']),
    git(cwd, ['log', '-n', '20', '--pretty=format:%s']),
    git(cwd, ['for-each-ref', '--count=20', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads', 'refs/remotes']),
  ]);
  const staged = !all && !!stagedNames.stdout.trim(); // all: every uncommitted change, staged or not (a new branch takes them all)
  const diffArgs = staged ? ['diff', '--cached'] : ['diff', 'HEAD'];
  let diff = await git(cwd, [...diffArgs, '--stat', '--', '.', ...excludes]);
  let full = await git(cwd, [...diffArgs, '--', '.', ...excludes]);
  if (full.code !== 0 && !staged) { // no commits yet: everything is new
    diff = await git(cwd, ['diff', '--cached', '--stat', '--', '.', ...excludes]);
    full = { stdout: '' };
  }
  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '--', '.', ...excludes])).stdout.split(/\r?\n/).filter(Boolean);
  let body = full.stdout || '';
  const truncated = body.length > MAX_DIFF;
  if (truncated) body = body.slice(0, MAX_DIFF);
  const rules = ['CONTRIBUTING.md', 'CLAUDE.md', 'AGENTS.md', '.github/CONTRIBUTING.md', 'commitlint.config.js', 'commitlint.config.cjs', '.commitlintrc', '.commitlintrc.json', 'docs/CONTRIBUTING.md']
    .filter((f) => fs.existsSync(path.join(cwd, f)));
  try { // agent-rules/**/coding-standards.md and similar
    const ar = path.join(cwd, 'agent-rules');
    if (fs.existsSync(ar)) for (const f of fs.readdirSync(ar, { recursive: true })) if (/(coding-standards|git|contributing|conventions?)\.md$/i.test(String(f))) rules.push(path.join('agent-rules', String(f)).replace(/\\/g, '/'));
  } catch { /* unreadable */ }
  return { status: status.stdout.trim(), branch: branch.stdout.trim(), staged, stat: diff.stdout.trim(), diff: body, truncated, untracked, log: log.stdout.trim(), branches: branches.stdout.trim(), rules };
}

const COMMIT_SCHEMA = {
  type: 'object',
  properties: {
    message: { type: 'string', description: 'The commit message: one subject line of at most 72 characters, optionally followed by a blank line and ONE short sentence. Two sentences at most in total.' },
    source: { type: 'string', enum: ['repo-rules', 'history', 'default'], description: 'Where the style came from.' },
    rulesFile: { type: 'string', description: 'The rules file that was followed, if any; otherwise empty.' },
    notes: { type: 'string', description: 'One or two sentences for the user: what the changes are, and anything worth knowing (e.g. the changes look like two separate commits).' },
  },
  required: ['message', 'source', 'rulesFile', 'notes'],
  additionalProperties: false,
};

const SYSTEM = `You write git commit messages inside MC Dev Hub, a local developer tool. You only read: never edit files, stage, commit or push.
Follow the repository's own commit rules. Look in this order and report which one you used:
1. a rules file in the repo (listed in the context; read it if it exists),
2. otherwise the style of the recent commit subjects shown,
3. otherwise Conventional Commits: "type(scope): summary" with types feat, fix, refactor, docs, test, chore; imperative mood; subject at most 72 characters.
Keep it short: the message is at most two sentences. Usually the subject line alone is enough; add one short body sentence (after a blank line) only when the subject can't carry the key detail. No bullet lists, no file-by-file summaries, no restating the diff.
Say what the change does, based on the diff. Never mention secrets, tokens or file contents that look sensitive. Never read .env files or keys.`;

function buildPrompt(ctx) {
  const block = (text, empty) => (text ? '```\n' + text + '\n```' : empty); // git output fenced, so its own "##" lines can't pass for headings
  const untracked = ctx.untracked.slice(0, 50).join('\n') + (ctx.untracked.length > 50 ? `\n…and ${ctx.untracked.length - 50} more` : '');
  return [
    `Write a short commit message (two sentences at most) for the ${ctx.staged ? 'STAGED changes (only those will be committed)' : 'uncommitted changes (nothing is staged, so all of them)'} on branch "${ctx.branch || '(no branch yet)'}".`,
    '',
    '## git status', block(ctx.status, '(clean)'),
    '', '## Rule files in this repo', ctx.rules.length ? ctx.rules.join('\n') : '(none found)',
    '', '## Recent commit subjects', block(ctx.log, '(no commits yet)'),
    '', '## Recent branches', block(ctx.branches, '(none)'),
    '', '## Diff summary', block(ctx.stat, '(no tracked changes)'),
    ctx.untracked.length ? `\n## New files not tracked yet\n${block(untracked)}` : '',
    '', `## Diff${ctx.truncated ? ' (cut off; use git diff on specific files if you need more)' : ''}`, block(ctx.diff, '(none)'),
  ].join('\n');
}

/** "Style: …" in the log: where the commit message / branch name style came from. */
function styleVia(out, what) {
  const fallback = what === 'branch' ? 'type/short-description (no rules or clear branch pattern found)' : 'Conventional Commits (no rules or clear history found)';
  return { 'repo-rules': `the repo's rules${out.rulesFile ? ` (${out.rulesFile})` : ''}`, history: what === 'branch' ? 'the repo\'s existing branch names' : 'the repo\'s recent commit history', default: fallback }[out.source] || out.source;
}

const BRANCH_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'The new branch name only, e.g. feat/add-login-page. Lowercase, words joined by dashes, no spaces.' },
    source: { type: 'string', enum: ['repo-rules', 'history', 'default'], description: 'Where the naming style came from.' },
    rulesFile: { type: 'string', description: 'The rules file that was followed, if any; otherwise empty.' },
    notes: { type: 'string', description: 'One or two sentences for the user: what the changes are about, and why this name.' },
  },
  required: ['name', 'source', 'rulesFile', 'notes'],
  additionalProperties: false,
};

const BRANCH_SYSTEM = `You name new git branches inside MC Dev Hub, a local developer tool. You only read: never edit files, create branches, stage, commit or push.
Name the branch after what the uncommitted changes do. Follow the repository's own branch naming rules. Look in this order and report which one you used:
1. a rules file in the repo (listed in the context; read it if it exists and look for branch naming rules),
2. otherwise the pattern of the existing branch names shown (prefixes, separators, ticket or iteration numbers),
3. otherwise "type/short-description": type is feat, fix, refactor, docs, test or chore; the description is 2 to 5 lowercase words joined by dashes.
Never use main, master, develop or a name from the list of existing branches. Keep it under 60 characters, with only lowercase letters, digits, "/", "-", "_" and ".". Never mention secrets, tokens or file contents that look sensitive. Never read .env files or keys.`;

function buildBranchPrompt(ctx, taken) {
  const block = (text, empty) => (text ? '```\n' + text + '\n```' : empty);
  const untracked = ctx.untracked.slice(0, 50).join('\n') + (ctx.untracked.length > 50 ? `\n…and ${ctx.untracked.length - 50} more` : '');
  return [
    `Suggest a name for a new branch, created from "${ctx.branch || '(no branch yet)'}", that will carry all of these uncommitted changes.`,
    '',
    '## git status', block(ctx.status, '(clean)'),
    '', '## Rule files in this repo', ctx.rules.length ? ctx.rules.join('\n') : '(none found)',
    '', '## Existing local branches (the name must not be one of these)', block(taken.join('\n'), '(none)'),
    '', '## Recent branches, local and remote', block(ctx.branches, '(none)'),
    '', '## Recent commit subjects', block(ctx.log, '(no commits yet)'),
    '', '## Diff summary', block(ctx.stat, '(no tracked changes)'),
    ctx.untracked.length ? `\n## New files not tracked yet\n${block(untracked)}` : '',
    '', `## Diff${ctx.truncated ? ' (cut off; use git diff on specific files if you need more)' : ''}`, block(ctx.diff, '(none)'),
  ].join('\n');
}

async function localBranches(cwd) {
  return (await git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}
/** Git's own check of a branch name. */
async function validBranchName(cwd, name) {
  if (!/^[\w./-]{1,100}$/.test(name) || name.startsWith('-')) return false;
  return (await git(cwd, ['check-ref-format', '--branch', name])).code === 0;
}

// ---------- jobs ----------
export class AiJobs extends EventEmitter {
  constructor() {
    super();
    this.jobs = new Map(); // jobId -> job
    this.byEnv = new Map(); // envId -> jobId (one at a time per environment)
  }

  snapshot(id) {
    const j = this.jobs.get(id);
    return j && { id: j.id, envId: j.envId, kind: j.kind, model: j.model, status: j.status, startedAt: j.startedAt, endedAt: j.endedAt, log: j.log, result: j.result, error: j.error, cost: j.cost };
  }
  current(envId) { const id = this.byEnv.get(envId); return id ? this.snapshot(id) : null; }

  #log(j, kind, text, extra = {}) {
    const entry = { t: Date.now(), kind, text: String(text).slice(0, 4000), ...extra };
    j.log.push(entry);
    if (j.log.length > 500) j.log.splice(0, j.log.length - 500);
    this.emit('event', { jobId: j.id, envId: j.envId, type: 'log', entry });
  }
  #finish(j, status, patch = {}) {
    if (j.endedAt) return;
    Object.assign(j, { status, endedAt: Date.now() }, patch);
    clearTimeout(j.timer);
    this.emit('event', { jobId: j.id, envId: j.envId, type: 'done', job: this.snapshot(j.id) });
  }

  /** Starts one AI job for an environment (one at a time per environment). work(j, st) does the job's steps. */
  async #start(env, model, kind, work) {
    const running = this.current(env.id);
    if (running && running.status === 'running') throw Object.assign(new Error('AI is already working on this environment'), { status: 409 });
    const st = await claudeStatus(true);
    if (!st.installed) throw Object.assign(new Error('Claude Code is not installed on this PC.'), { status: 400, code: 'AI_NOT_INSTALLED' });
    if (!st.loggedIn) throw Object.assign(new Error('Claude Code is installed but not signed in.'), { status: 400, code: 'AI_NOT_SIGNED_IN' });
    // the changes are read with git: it has to be there (it may have been installed since the hub started)
    if ((await run('git', ['--version'], { timeout: 10000 })).err?.code === 'ENOENT' && !(await adoptGit())) {
      throw Object.assign(new Error('Git isn\'t installed on this PC. Install it (see the Git tab), then try again.'), { status: 400 });
    }

    const j = { id: 'ai_' + crypto.randomBytes(5).toString('hex'), envId: env.id, kind, model, status: 'running', startedAt: Date.now(), endedAt: null, log: [], result: null, error: '', cost: null, child: null };
    this.jobs.set(j.id, j);
    this.byEnv.set(env.id, j.id);
    this.emit('event', { jobId: j.id, envId: j.envId, type: 'start', job: this.snapshot(j.id) });
    work(j, st).catch((err) => this.#finish(j, 'error', { error: err.message, ...(err.cost != null ? { cost: err.cost } : {}) }));
    return this.snapshot(j.id);
  }

  /** Writes a commit message for the current changes. Nothing is committed. */
  commitMessage(env, model) {
    return this.#start(env, model, 'commit-message', async (j, st) => {
      this.#log(j, 'step', `Reading the changes in ${env.name}…`);
      const ctx = await gatherContext(env.path);
      if (!ctx.stat && !ctx.untracked.length && !ctx.diff) return this.#finish(j, 'error', { error: 'There are no changes to describe.' });
      this.#log(j, 'step', `${ctx.staged ? 'Staged' : 'All uncommitted'} changes${ctx.truncated ? ' (diff cut to 60 kB)' : ''} · rules: ${ctx.rules.length ? ctx.rules.join(', ') : 'none written, will follow the commit history'}`);
      const r = await this.#ask(j, env, st, { system: SYSTEM, schema: COMMIT_SCHEMA, prompt: buildPrompt(ctx) });
      if (!r) return; // cancelled
      const { out, cost } = r;
      if (!out || typeof out.message !== 'string' || !out.message.trim()) return this.#finish(j, 'error', { cost, error: 'Claude Code answered, but not with a commit message.' });
      this.#log(j, 'done', `Commit message ready. Style: ${styleVia(out, 'commit')}.`);
      if (out.notes) this.#log(j, 'say', out.notes);
      this.#finish(j, 'done', { cost, result: { message: out.message.trim(), source: out.source, rulesFile: out.rulesFile || '', notes: out.notes || '', staged: ctx.staged } });
    });
  }

  /** Suggests a name for a new branch from all uncommitted changes. Nothing is created: the person confirms the name first. */
  branchName(env, model) {
    return this.#start(env, model, 'branch-name', async (j, st) => {
      this.#log(j, 'step', `Reading the changes in ${env.name}…`);
      const ctx = await gatherContext(env.path, { all: true });
      if (!ctx.stat && !ctx.untracked.length && !ctx.diff) return this.#finish(j, 'error', { error: 'There are no changes to name a branch after. Make some changes first, or use + New branch.' });
      this.#log(j, 'step', `All uncommitted changes${ctx.truncated ? ' (diff cut to 60 kB)' : ''} · rules: ${ctx.rules.length ? ctx.rules.join(', ') : 'none written, will follow the branch names here'}`);
      const taken = await localBranches(env.path);
      const r = await this.#ask(j, env, st, { system: BRANCH_SYSTEM, schema: BRANCH_SCHEMA, prompt: buildBranchPrompt(ctx, taken) });
      if (!r) return; // cancelled
      const { out, cost } = r;
      const name = String(out?.name || '').trim();
      if (!name) return this.#finish(j, 'error', { cost, error: 'Claude Code answered, but not with a branch name.' });
      if (!(await validBranchName(env.path, name))) return this.#finish(j, 'error', { cost, error: `Claude suggested "${name}", which git doesn't accept as a branch name. Try again, or use + New branch.` });
      const exists = taken.includes(name);
      if (exists) this.#log(j, 'warn', `A branch named ${name} already exists: change the name before creating it.`);
      this.#log(j, 'done', `Branch name ready: ${name}. Style: ${styleVia(out, 'branch')}.`);
      if (out.notes) this.#log(j, 'say', out.notes);
      this.#finish(j, 'done', { cost, result: { name, exists, source: out.source, rulesFile: out.rulesFile || '', notes: out.notes || '', from: ctx.branch } });
    });
  }

  /** Runs Claude Code headless and read-only in the environment's folder, streaming its steps into the job log.
   *  -> { out, cost }, or null when the job was cancelled; throws (with .cost) when it fails. */
  #ask(j, env, st, { system, schema, prompt }) {
    this.#log(j, 'step', `Asking ${(AI_MODELS.find((m) => m.id === j.model)?.label.split(/[:(]/)[0] || j.model).trim()} via Claude Code ${st.version}…`);
    return new Promise((resolve, reject) => {
      const fail = (error, cost = null) => reject(Object.assign(new Error(error), { cost }));
      const deny = SECRET_PATTERNS.flatMap((p) => [`Read(./${p})`, `Read(./**/${p})`]);
      const args = [
        '-p', '--model', j.model, '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
        '--setting-sources', 'user', // the user's own Claude settings, not the repo's (no repo hooks or plugins)
        '--tools', 'Read,Grep,Glob,Bash',
        '--allowedTools', 'Read', 'Grep', 'Glob', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git branch:*)',
        '--disallowedTools', ...deny,
        '--append-system-prompt', system,
        '--json-schema', JSON.stringify(schema),
      ];
      const s = claudeSpawnArgs(st.path, args);
      const child = spawn(s.file, s.args, { cwd: env.path, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } });
      j.child = child;
      j.timer = setTimeout(() => { this.#log(j, 'error', 'Stopped: it took longer than 4 minutes.'); killTree(child.pid); }, JOB_TIMEOUT);
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);

      let buf = '';
      let stderr = '';
      let final = null;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let m;
          try { m = JSON.parse(line); } catch { continue; }
          if (m.type === 'assistant') {
            for (const b of m.message?.content || []) {
              if (b.type === 'text' && b.text.trim()) this.#log(j, 'say', b.text.trim());
              else if (b.type === 'tool_use') {
                const inp = b.input || {};
                const what = inp.command || inp.file_path || inp.pattern || JSON.stringify(inp).slice(0, 200);
                this.#log(j, 'tool', `${b.name}: ${what}`);
              }
            }
          } else if (m.type === 'user') {
            for (const b of m.message?.content || []) {
              if (b.type === 'tool_result' && b.is_error) this.#log(j, 'warn', `Not allowed / failed: ${String(Array.isArray(b.content) ? b.content.map((c) => c.text || '').join(' ') : b.content).slice(0, 300)}`);
            }
          } else if (m.type === 'result') final = m;
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (err) => fail(`Could not start Claude Code: ${err.message}`));
      child.on('close', (code) => {
        j.child = null;
        if (j.endedAt) return resolve(null);
        if (j.cancelled) { this.#finish(j, 'cancelled', { error: 'Cancelled.' }); return resolve(null); }
        if (!final) return fail((stderr.trim().split(/\r?\n/).pop() || `Claude Code exited with code ${code}`).slice(0, 500));
        const cost = typeof final.total_cost_usd === 'number' ? final.total_cost_usd : null;
        if (final.is_error || final.subtype !== 'success') return fail(String(final.result || final.subtype || 'Claude Code reported an error').slice(0, 500), cost);
        let out = final.structured_output;
        if (!out) { try { out = JSON.parse(final.result); } catch { out = null; } }
        resolve({ out, cost });
      });
    });
  }

  async cancel(id) {
    const j = this.jobs.get(id);
    if (!j || j.endedAt) return;
    j.cancelled = true;
    if (j.child) await killTree(j.child.pid);
    else this.#finish(j, 'cancelled', { error: 'Cancelled.' });
  }
}
