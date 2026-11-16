// Thin wrapper around the git CLI for the Git tab.
import { execFile } from 'node:child_process';

function git(cwd, args, timeout = 120000) {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd, timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), missing: err?.code === 'ENOENT' });
    });
  });
}

// git@github.com:me/repo.git | ssh://git@host:22/me/repo.git | https://user@host/me/repo.git -> https://host/me/repo
export function webUrl(url) {
  if (!url) return '';
  let m = url.match(/^[\w.-]+@([^:/]+):(?!\d+\/)(.+?)(?:\.git)?\/?$/);
  if (m) return `https://${m[1]}/${m[2]}`;
  m = url.match(/^(?:ssh|git|https?):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/);
  if (m) return `https://${m[1]}/${m[2]}`;
  return '';
}

function parseStatus(out) {
  const entries = out.split('\0');
  const head = { branch: '', upstream: '', ahead: 0, behind: 0, detached: false, noCommits: false };
  const files = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e) continue;
    if (e.startsWith('## ')) {
      const h = e.slice(3);
      let m;
      if ((m = h.match(/^No commits yet on (.+)$/))) { head.branch = m[1]; head.noCommits = true; continue; }
      if (h.startsWith('HEAD (no branch)')) { head.detached = true; head.branch = 'HEAD'; continue; }
      m = h.match(/^(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/);
      if (m) {
        head.branch = m[1];
        head.upstream = m[2] || '';
        const info = m[3] || '';
        head.ahead = +(info.match(/ahead (\d+)/)?.[1] || 0);
        head.behind = +(info.match(/behind (\d+)/)?.[1] || 0);
        head.gone = /gone/.test(info);
      }
      continue;
    }
    const x = e[0], y = e[1], p = e.slice(3);
    let from = '';
    if (x === 'R' || x === 'C') { from = entries[++i] || ''; }
    files.push({ x, y, path: p, from, staged: x !== ' ' && x !== '?', unstaged: y !== ' ', untracked: x === '?' });
  }
  return { head, files };
}

export async function info(cwd) {
  const probe = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (probe.missing) return { isRepo: false, gitMissing: true };
  if (!probe.ok) return { isRepo: false };
  const [status, remotes, log, branches, remoteBranches, stash, uname, uemail] = await Promise.all([
    git(cwd, ['status', '--porcelain=v1', '-b', '-z', '-uall']),
    git(cwd, ['remote', '-v']),
    git(cwd, ['log', '-n', '25', '--pretty=format:%H%x1f%h%x1f%an%x1f%ar%x1f%aI%x1f%s%x1f%D%x1e']),
    git(cwd, ['branch', '--format=%(refname:short)']),
    git(cwd, ['branch', '-r', '--format=%(refname:short)']),
    git(cwd, ['stash', 'list', '--format=%gd%x1f%s']),
    git(cwd, ['config', 'user.name']),
    git(cwd, ['config', 'user.email']),
  ]);

  const { head, files } = parseStatus(status.stdout);
  const remoteMap = {};
  for (const line of remotes.stdout.split(/\r?\n/)) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!m) continue;
    const r = (remoteMap[m[1]] ||= { name: m[1], fetchUrl: '', pushUrl: '' });
    r[m[3] === 'fetch' ? 'fetchUrl' : 'pushUrl'] = m[2];
  }
  const remoteList = Object.values(remoteMap).map((r) => ({ ...r, webUrl: webUrl(r.fetchUrl || r.pushUrl) }));
  remoteList.sort((a, b) => (a.name === 'origin' ? -1 : b.name === 'origin' ? 1 : a.name.localeCompare(b.name)));

  const commits = log.stdout.split('\x1e').map((s) => s.replace(/^\s+/, '')).filter(Boolean).map((s) => {
    const [hash, short, author, rel, date, subject, refs] = s.split('\x1f');
    return { hash, short, author, rel, date, subject, refs };
  });
  const local = branches.stdout.split(/\r?\n/).filter(Boolean);
  const remoteRefs = remoteBranches.stdout.split(/\r?\n/).filter((rb) => rb.includes('/') && !rb.endsWith('/HEAD'));
  const remoteOnly = [];
  for (const rb of remoteBranches.stdout.split(/\r?\n/).filter(Boolean)) {
    const slash = rb.indexOf('/');
    if (slash < 0) continue; // the bare "origin" HEAD entry
    const name = rb.slice(slash + 1);
    if (name === 'HEAD' || local.includes(name) || remoteOnly.includes(name)) continue;
    remoteOnly.push(name);
  }

  return {
    isRepo: true,
    root: probe.stdout.trim(),
    head,
    files,
    remotes: remoteList,
    commits,
    branches: local,
    remoteBranches: remoteOnly,
    remoteRefs, // as of the last fetch
    stashes: stash.stdout.split(/\r?\n/).filter(Boolean).map((s) => { const [ref, msg] = s.split('\x1f'); return { ref, msg }; }),
    user: { name: uname.stdout.trim(), email: uemail.stdout.trim() },
  };
}

// Splits `commit -m "a b"` into ['commit', '-m', 'a b']
export function splitArgs(s) {
  const out = [];
  let cur = '', q = null, any = false;
  for (const ch of String(s)) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; any = true; continue; }
    if (/\s/.test(ch)) { if (cur || any) { out.push(cur); cur = ''; any = false; } continue; }
    cur += ch;
  }
  if (cur || any) out.push(cur);
  return out;
}

const NAME_RE = /^(?!-)[^\s~^:?*[\\]+$/;
const REMOTE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export async function action(cwd, body) {
  const a = body.action;
  const steps = [];
  const exec = async (args, timeout) => {
    const r = await git(cwd, args, timeout);
    steps.push({ cmd: 'git ' + args.map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(' '), ...r });
    return r;
  };

  switch (a) {
    case 'fetch': await exec(['fetch', '--all', '--prune']); break;
    case 'pull': await exec(['pull']); break;
    case 'push': {
      const st = await info(cwd);
      if (st.head?.upstream && !st.head.gone) await exec(['push']);
      else {
        const remote = st.remotes?.[0]?.name;
        if (!remote) throw Object.assign(new Error('No remote configured. Add one with: remote add origin <url>'), { status: 400 });
        await exec(['push', '-u', remote, st.head.branch]);
      }
      break;
    }
    case 'commit': {
      const msg = String(body.message || '').trim();
      if (!msg) throw Object.assign(new Error('Write a commit message first'), { status: 400 });
      if (body.stageAll) { const r = await exec(['add', '-A']); if (!r.ok) break; }
      const r = await exec(['commit', '-m', msg]);
      if (r.ok && body.push) return { steps: [...steps, ...(await action(cwd, { action: 'push' })).steps] };
      break;
    }
    case 'stage': await exec(['add', '--', String(body.path)]); break;
    case 'unstage': await exec(['restore', '--staged', '--', String(body.path)]); break;
    case 'stageAll': await exec(['add', '-A']); break;
    case 'unstageAll': await exec(['reset', '-q']); break;
    case 'switch': {
      const b = String(body.branch || '');
      if (!NAME_RE.test(b)) throw Object.assign(new Error('Invalid branch name'), { status: 400 });
      if (body.mode === 'stash') { // put uncommitted changes (new files too) aside, then switch
        const cur = (await git(cwd, ['branch', '--show-current'])).stdout.trim() || 'HEAD';
        const s = await exec(['stash', 'push', '-u', '-m', `MC Dev Hub: changes on ${cur} before switching to ${b}`]);
        if (s.ok) await exec(['switch', b]);
        break;
      }
      if (body.mode === 'merge') { await exec(['switch', '--merge', b]); break; } // carry the changes over, merging them
      const r = await exec(['switch', b]);
      const text = `${r.stderr}\n${r.stdout}`;
      if (!r.ok && /would be overwritten by (checkout|switch)/i.test(text)) {
        // Git refused because of uncommitted work: say which files, and let the user choose what to do
        const m = /would be overwritten by (?:checkout|switch):\s*\r?\n([\s\S]*?)\r?\n\s*(?:Please|Aborting)/i.exec(text);
        const files = (m?.[1] || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
        return { steps, blocked: { branch: b, files, untracked: /untracked working tree files/i.test(text) } };
      }
      break;
    }
    case 'newBranch': {
      const b = String(body.branch || '').trim();
      if (!NAME_RE.test(b)) throw Object.assign(new Error('Invalid branch name'), { status: 400 });
      await exec(['switch', '-c', b]);
      break;
    }
    case 'stash': await exec(['stash', 'push', '-u', ...(body.message ? ['-m', String(body.message)] : [])]); break;
    case 'stashPop': await exec(['stash', 'pop']); break;
    case 'init': await exec(['init']); break;
    case 'remoteAdd': {
      const name = String(body.name || '').trim();
      const url = String(body.url || '').trim();
      if (!REMOTE_NAME_RE.test(name)) throw Object.assign(new Error('Remote name: letters, numbers, dot, dash or underscore, e.g. origin'), { status: 400 });
      if (!url || url.startsWith('-') || /\s/.test(url) || url.length > 2000) throw Object.assign(new Error('Enter the repository URL, e.g. https://github.com/you/project.git'), { status: 400 });
      await exec(['remote', 'add', name, url]);
      break;
    }
    case 'remoteRemove': {
      const name = String(body.name || '').trim();
      if (!REMOTE_NAME_RE.test(name)) throw Object.assign(new Error('Invalid remote name'), { status: 400 });
      await exec(['remote', 'remove', name]);
      break;
    }
    case 'custom': {
      let args = splitArgs(body.args || '');
      if (args[0] === 'git') args = args.slice(1);
      if (!args.length) throw Object.assign(new Error('Type a git command, e.g. log --oneline -5'), { status: 400 });
      await exec(args, 5 * 60 * 1000);
      break;
    }
    default: throw Object.assign(new Error(`Unknown git action: ${a}`), { status: 400 });
  }
  return { steps };
}
