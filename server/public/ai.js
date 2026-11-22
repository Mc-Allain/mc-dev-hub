'use strict';
/* AI in the Git tab: Claude Code on this PC writes commit messages (more AI actions build on this).
 * Off until turned on in Settings; each person uses their own Claude login and picks the model. */

S.ai = { status: null, jobs: new Map(), undo: new Map() }; // jobs: "envId|kind" -> job snapshot (or { kind, setup: true }), one per panel

const AI_VIA = { cli: 'Claude Code CLI', npm: 'Claude Code (npm)', desktop: 'bundled with the Claude desktop app', override: 'test stand-in' };
const aiModelName = (id) => ({ 'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-opus-5-5': 'Opus 5.5' }[id] || id);
const AI_INSTALL_URL = 'https://code.claude.com/docs/en/setup';

async function loadAiStatus(refresh = false) {
  try { S.ai.status = await api('GET', '/api/ai/status' + (refresh ? '?refresh=1' : '')); }
  catch { /* the server may be restarting */ }
  if ($('#settingsDialog').open) renderAiSettings();
  if (S.tab === 'git') { updateAiButton(); renderAiCard(); }
}
const aiReady = () => !!(S.ai.status?.enabled && S.ai.status.claude?.installed && S.ai.status.claude.loggedIn);

// ---------- shell tabs: commands are shown for the shell the person uses ----------
const AI_SHELLS = { powershell: 'PowerShell', cmd: 'Command Prompt', bash: 'Git Bash' };
function aiShellList() {
  const list = ['powershell', 'cmd'];
  if (S.terminals?.some((t) => t.id === 'gitbash') || S.cliShells?.some((t) => t.id === 'bash')) list.push('bash');
  return list;
}
/** The chosen tab: what the person picked here before, else their Settings → Terminal choice. */
function aiShell() {
  const list = aiShellList();
  const picked = store.get('aiShell', null);
  if (list.includes(picked)) return picked;
  const t = S.settings?.terminal;
  return t === 'cmd' ? 'cmd' : t === 'gitbash' && list.includes('bash') ? 'bash' : 'powershell';
}
const aiShellTabs = (cur) => `<div class="ai-shells" role="tablist">${aiShellList().map((s) =>
  `<button type="button" role="tab" class="${s === cur ? 'on' : ''}" aria-selected="${s === cur}" data-ai-shell="${s}">${AI_SHELLS[s]}</button>`).join('')}</div>`;
const bashPath = (p) => String(p).replace(/^([A-Za-z]):/, (m, d) => '/' + d.toLowerCase()).replace(/\\/g, '/');

/** What's set up and what's missing, with the next step. Used in Settings and in the Git tab. */
function aiSetupHtml(c) {
  const copy = (cmd) => `<div class="ai-cmd"><code>${h(cmd)}</code><button type="button" class="plain small" data-ai-copy="${h(cmd)}">Copy</button></div>`;
  if (!c) return '<p class="muted small-text">Checking for Claude Code…</p>';
  const sh = aiShell();
  if (!c.installed) {
    const install = {
      powershell: `Recommended (updates itself):${copy('irm https://claude.ai/install.ps1 | iex')}`,
      cmd: `Recommended (updates itself):${copy('curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd')}`,
      bash: `Recommended (updates itself, runs the PowerShell installer):${copy('powershell -NoProfile -Command "irm https://claude.ai/install.ps1 | iex"')}`,
    }[sh];
    return `<div class="ai-state bad">✖ Claude Code isn't installed on this PC.</div>
      ${aiShellTabs(sh)}
      <ol class="ai-steps">
        <li>Install Claude Code in ${AI_SHELLS[sh]}. ${install}
          or with WinGet:${copy('winget install Anthropic.ClaudeCode')}
          More options: <a href="${AI_INSTALL_URL}" target="_blank" rel="noopener">Anthropic's setup guide</a>.</li>
        <li>Sign in: open a <b>new</b> ${AI_SHELLS[sh]} window and run${copy('claude')}then follow the browser prompts. It needs a Claude Pro, Max, Team or Enterprise plan, or an Anthropic Console account (the free plan doesn't include Claude Code).</li>
        <li>Come back here and press <b>Check again</b>.</li>
      </ol>`;
  }
  const where = `Claude Code ${h(c.version || '')} · ${h(AI_VIA[c.via] || c.via)}`;
  if (!c.loggedIn) {
    const desk = c.via === 'desktop';
    const cmd = {
      powershell: desk ? `& "${c.path}" auth login` : 'claude auth login', // a quoted path needs "&" in PowerShell
      cmd: desk ? `"${c.path}" auth login` : 'claude auth login',
      bash: desk ? `"${bashPath(c.path)}" auth login` : 'claude auth login',
    }[sh];
    const win = sh === 'bash' ? 'PowerShell' : AI_SHELLS[sh]; // the Sign in window opens in PowerShell for Git Bash
    return `<div class="ai-state warn">⚠ ${where}, but not signed in.</div>
      ${aiShellTabs(sh)}
      <ol class="ai-steps">
        <li><button type="button" class="primary small" data-ai="sign-in">Sign in to Claude Code…</button>
          opens a ${win} window that starts the sign-in; follow the browser prompts there. It needs a Claude Pro, Max, Team or Enterprise plan, or an Anthropic Console account.
          <div class="muted small-text" style="margin-top:4px">Or run this in ${AI_SHELLS[sh]} yourself:</div>${copy(cmd)}</li>
        ${c.via === 'desktop' ? `<li class="muted">Tip: the desktop app's copy changes folder when the app updates. Installing the Claude Code CLI (<a href="${AI_INSTALL_URL}" target="_blank" rel="noopener">setup guide</a>) gives you a stable <code>claude</code> command.</li>` : ''}
        <li>Press <b>Check again</b>.</li>
      </ol>`;
  }
  const how = c.keySource && !c.storedLogin ? `API key from ${c.keySource}` : c.authMethod;
  const signOutBtn = c.storedLogin
    ? `<button type="button" class="danger-solid small ai-signout" data-ai="sign-out" title="Signs Claude Code out on this PC and turns AI off">Sign out</button>` : '';
  const keyNote = c.keySource ? `<div class="ai-keynote">🔑 Claude Code has an API key from <code>${h(c.keySource)}</code>. When a key is set, Claude Code uses it, so AI usage can be billed to that key.
      ${c.storedLogin ? 'Sign out removes only the saved login; the key keeps working.' : 'There is no saved login to sign out of.'}
      To stop using the key, remove it where it's set${c.keySource === 'ANTHROPIC_API_KEY' ? ' (your environment variables)' : ''}, then restart MC Dev Hub.
      ${S.ai.status?.enabled ? '<button type="button" class="ghost small" data-ai="turn-off">Turn off AI</button>' : ''}</div>` : '';
  return `<div class="ai-state ok">✓ ${where} · signed in${how ? ` (${h(how)})` : ''} ${signOutBtn}</div>${keyNote}`;
}

/** reset: fill the form from what's saved (when the dialog opens). A status refresh keeps what the person has ticked/picked. */
function renderAiSettings(reset = false) {
  const st = S.ai.status;
  const f = $('#settingsForm');
  const signedIn = !!(st?.claude?.installed && st.claude.loggedIn);
  const model = reset || !f.aiModel.value ? (st?.model || 'claude-sonnet-5-5') : f.aiModel.value;
  if (reset) f.aiEnabled.checked = !!st?.enabled;
  if (!signedIn) f.aiEnabled.checked = false; // AI needs a signed-in Claude Code
  $('#aiToggle').hidden = !signedIn;
  $('#aiModelRow').hidden = !signedIn;
  $('#aiModelSelect').innerHTML = (st?.models || [{ id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' }, { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' }])
    .map((m) => `<option value="${m.id}" ${m.id === model ? 'selected' : ''}>${h(m.label)}</option>`).join('');
  $('#aiSetup').innerHTML = aiSetupHtml(st?.claude);
}

// ---------- Git tab ----------
// Each AI action has its own panel: commit messages in the Commit card, branch names in the Branch card.
const AI_CARDS = { 'commit-message': '#aiCard', 'branch-name': '#aiBranchCard' };
const aiKey = (envId, kind) => `${envId}|${kind}`;
const aiJob = (kind, envId = env()?.id) => S.ai.jobs.get(aiKey(envId, kind));
/** Claude Code runs one job per environment at a time, so both buttons wait while either works. */
const aiBusy = (envId = env()?.id) => Object.keys(AI_CARDS).some((k) => aiJob(k, envId)?.status === 'running');

function aiCommitButton() {
  if (!S.ai.status?.enabled) return '';
  const mine = aiJob('commit-message')?.status === 'running';
  const other = !mine && aiBusy();
  return `<button class="ghost ai-btn" data-git="aiMessage" ${mine || other ? 'disabled' : ''} title="${other ? 'Waiting: Claude is naming a branch' : 'Claude reads your changes and writes a commit message into the box. Nothing is committed.'}">✨ ${mine ? 'Writing…' : 'Commit message'}</button>`;
}
function aiBranchButton() {
  if (!S.ai.status?.enabled) return '';
  const mine = aiJob('branch-name')?.status === 'running';
  const other = !mine && aiBusy();
  return `<button class="ghost small ai-btn" data-git="aiBranch" ${mine || other || S.gitBusy ? 'disabled' : ''} title="${other ? 'Waiting: Claude is writing a commit message' : 'Claude reads your uncommitted changes and suggests a branch name. You confirm or edit it before the branch is created.'}">✨ ${mine ? 'Naming…' : 'Branch from changes'}</button>`;
}
/** Shown only while AI is off, so people know the feature exists. */
function aiOffNote() {
  const off = !!S.ai.status && !S.ai.status.enabled;
  return `<div class="ai-off-note" id="aiOffNote" ${off ? '' : 'hidden'}>✨ Claude can write commit messages and name new branches from your changes. Turn on
    <b>AI in the Git tab</b> in <button type="button" class="linklike" data-ai="settings">Settings</button>.</div>`;
}
function updateAiButton() {
  const n = $('#aiOffNote');
  if (n) n.outerHTML = aiOffNote();
  const b = $('#gitWrap [data-git="aiMessage"]');
  if (b) b.outerHTML = aiCommitButton();
  const bb = $('#gitWrap [data-git="aiBranch"]');
  if (bb) bb.outerHTML = aiBranchButton();
}

const aiCommitMessage = () => aiRun('commit-message');
const aiBranchName = () => aiRun('branch-name');
async function aiRun(kind) {
  const e = env();
  if (!e) return;
  const key = aiKey(e.id, kind);
  if (!aiReady()) { await loadAiStatus(true); }
  if (!aiReady()) { S.ai.jobs.set(key, { kind, setup: true }); return renderAiCard(); }
  // show it as working straight away: the server takes a moment to start Claude Code, and both buttons must wait meanwhile
  S.ai.jobs.set(key, { kind, status: 'running', log: [], model: S.ai.status?.model, startedAt: Date.now() });
  renderAiCard();
  updateAiButton();
  try {
    const job = await api('POST', `/api/envs/${e.id}/ai/${kind}`);
    if (S.ai.jobs.get(key)?.id !== job.id) S.ai.jobs.set(key, job); // live events may already have filled it in: keep those
  } catch (err) {
    if (/^AI_/.test(err.data?.code || '')) { await loadAiStatus(true); S.ai.jobs.set(key, { kind, setup: true, error: err.message }); }
    else S.ai.jobs.set(key, { kind, status: 'error', error: err.message, log: [], model: S.ai.status?.model });
  }
  renderAiCard();
  updateAiButton();
}

function aiLine(x) {
  const ico = { step: '▸', tool: '⚙', say: '💬', warn: '⚠', error: '✖', done: '✓' }[x.kind] || '·';
  return `<div class="ai-line ${x.kind}"><span class="ico">${ico}</span><span class="txt">${h(x.text)}</span></div>`;
}

/** Both panels (each shows only its own kind of job). */
function renderAiCard() { for (const kind of Object.keys(AI_CARDS)) renderAiCardOf(kind); }
function renderAiCardOf(kind) {
  const el = $(AI_CARDS[kind]);
  const e = env();
  if (!el || !e) return;
  const job = aiJob(kind);
  if (!job) { el.innerHTML = ''; el.hidden = true; return; }
  el.hidden = false;
  if (job.setup) {
    el.innerHTML = `<div class="ai-head"><b>✨ AI needs setting up on this PC</b><span class="grow"></span><button class="plain small" data-ai="close">✕</button></div>
      ${job.error ? `<div class="ai-line error"><span class="ico">✖</span><span class="txt">${h(job.error)}</span></div>` : ''}
      <div class="ai-setup">${aiSetupHtml(S.ai.status?.claude)}</div>
      <div class="row"><button class="ghost small" data-ai="recheck">Check again</button><button class="ghost small" data-ai="settings">Open Settings</button></div>`;
    return;
  }
  const running = job.status === 'running';
  const secs = job.startedAt ? Math.round(((job.endedAt || Date.now()) - job.startedAt) / 1000) : 0;
  const state = running ? 'working…' : job.status === 'done' ? `done in ${secs}s` : job.status === 'cancelled' ? 'cancelled' : 'failed';
  const undo = S.ai.undo.get(e.id);
  const branch = kind === 'branch-name';
  const doneText = branch
    ? `Suggested <code>${h(job.result?.name)}</code>${job.result?.from ? ` from <b>${h(job.result.from)}</b>` : ''}. Nothing is created until you confirm.`
    : 'Written into the message box. Edit it as you like, then press Commit.';
  el.innerHTML = `<div class="ai-head"><b>✨ ${branch ? 'Branch name' : 'Commit message'} · ${h(aiModelName(job.model))}</b><span class="ai-status ${h(job.status)}">${state}</span><span class="grow"></span>
      ${running ? '<button class="ghost small" data-ai="cancel">Cancel</button>' : '<button class="plain small" data-ai="close" title="Hide">✕</button>'}</div>
    <div class="ai-log">${(job.log || []).map(aiLine).join('')}${running ? '<div class="ai-line step pending"><span class="ico">…</span><span class="txt">Claude is working</span></div>' : ''}</div>
    ${job.status === 'error' ? `<div class="ai-error">✖ ${h(job.error)}</div>` : ''}
    ${!running ? `<div class="ai-foot">
      ${job.status === 'done' ? `<span class="muted small-text">${doneText}</span>` : ''}
      <span class="grow"></span>
      ${job.cost != null ? `<span class="muted small-text" title="Usage reported by Claude Code">≈ $${job.cost.toFixed(4)}</span>` : ''}
      ${!branch && undo != null ? '<button class="plain small" data-ai="undo" title="Put back the message you had typed">↶ My message</button>' : ''}
      <button class="ghost small" data-ai="again">↻ ${branch ? 'Suggest another' : 'Write another'}</button>
      ${branch && job.status === 'done' ? '<button class="primary small" data-ai="create-branch">Create branch…</button>' : ''}</div>` : ''}`;
  const log = $('.ai-log', el);
  if (log) log.scrollTop = log.scrollHeight;
}

function onAiEvent(x) {
  const kinds = Object.keys(AI_CARDS);
  if (x.type === 'log') { // goes to whichever panel holds that job
    const kind = kinds.find((k) => aiJob(k, x.envId)?.id === x.jobId);
    if (!kind) return;
    const job = aiJob(kind, x.envId);
    job.log = [...(job.log || []), x.entry];
    if (x.envId === env()?.id && S.tab === 'git') {
      const log = $(`${AI_CARDS[kind]} .ai-log`);
      const pending = log?.querySelector('.pending');
      if (log) { (pending ? pending.insertAdjacentHTML('beforebegin', aiLine(x.entry)) : log.insertAdjacentHTML('beforeend', aiLine(x.entry))); log.scrollTop = log.scrollHeight; }
    }
    return;
  }
  const job = x.job;
  if (!job || !kinds.includes(job.kind)) return;
  if (x.type === 'done' && job.status === 'done' && job.result?.message) {
    const prev = S.commitDraft[x.envId] || '';
    if (prev.trim() && prev !== job.result.message) S.ai.undo.set(x.envId, prev);
    setCommitDraft(x.envId, job.result.message);
    if (x.envId === env()?.id) { const ta = $('#commitMsg'); if (ta) { ta.value = job.result.message; ta.focus(); } }
    if (job.result.staged === false) { const all = $('#commitAll'); if (all && x.envId === env()?.id) all.checked = true; } // the message describes all changes
  }
  S.ai.jobs.set(aiKey(x.envId, job.kind), job);
  if (x.envId === env()?.id && S.tab === 'git') {
    renderAiCard(); updateAiButton();
    // a fresh branch name: ask right away (the panel keeps a "Create branch…" button if the dialog is dismissed)
    if (x.type === 'done' && job.kind === 'branch-name' && job.status === 'done') aiCreateBranch();
  }
}

/** Asks for the branch name (Claude's suggestion, editable), then creates and switches to it. Uncommitted changes come along. */
async function aiCreateBranch() {
  const e = env();
  const job = e && aiJob('branch-name', e.id);
  if (!job?.result?.name || $('#confirmDialog').open) return;
  const r = job.result;
  const name = await confirmBox({
    title: '✨ New branch from your changes',
    text: `${r.notes ? r.notes + '\n\n' : ''}Created from ${S.git?.head?.branch || r.from || 'the current branch'} and switched to. Your uncommitted changes come along.${r.exists ? '\n\n⚠ A branch with this name already exists: change it first.' : ''}`,
    ok: 'Create branch', input: { value: r.name, placeholder: 'feat/my-change' },
  });
  if (!name || !name.trim() || env()?.id !== e.id) return;
  const ok = await gitAction({ action: 'newBranch', branch: name.trim() }, 'New branch');
  if (ok) { S.ai.jobs.delete(aiKey(e.id, 'branch-name')); renderAiCard(); }
}

// ---------- events ----------
document.addEventListener('click', async (ev) => {
  const c = ev.target.closest('[data-ai-copy]');
  if (c) { navigator.clipboard.writeText(c.dataset.aiCopy).then(() => toast('Copied'), () => fail(new Error('Clipboard unavailable'))); return; }
  const tab = ev.target.closest('[data-ai-shell]');
  if (tab) {
    store.set('aiShell', tab.dataset.aiShell);
    if ($('#settingsDialog').open) $('#aiSetup').innerHTML = aiSetupHtml(S.ai.status?.claude);
    return renderAiCard();
  }
  const a = ev.target.closest('[data-ai]');
  if (!a) return;
  const e = env();
  // a button inside one of the panels acts on that panel's job
  const kind = a.closest('[data-ai-kind]')?.dataset.aiKind || 'commit-message';
  const job = e && aiJob(kind, e.id);
  switch (a.dataset.ai) {
    case 'close': S.ai.jobs.delete(aiKey(e.id, kind)); if (kind === 'commit-message') S.ai.undo.delete(e.id); return renderAiCard();
    case 'cancel': if (job?.id) api('POST', `/api/ai/jobs/${job.id}/cancel`).catch(fail); return;
    case 'again': return aiRun(kind);
    case 'create-branch': return aiCreateBranch();
    case 'recheck': case 'recheck-settings': {
      await loadAiStatus(true);
      if (aiReady() && e) for (const k of Object.keys(AI_CARDS)) if (aiJob(k, e.id)?.setup) S.ai.jobs.delete(aiKey(e.id, k));
      renderAiCard();
      if (aiReady() && a.dataset.ai === 'recheck') toast('Claude Code is ready');
      return;
    }
    case 'settings': $('#settingsBtn').click(); return;
    case 'sign-in': {
      const sh = aiShell();
      const shell = sh === 'cmd' ? 'cmd' : S.settings?.terminal === 'pwsh' ? 'pwsh' : 'powershell';
      try { await api('POST', '/api/ai/sign-in', { shell }); toast('A sign-in window opened. Finish signing in there, then press Check again.'); }
      catch (err) { fail(err); }
      return;
    }
    case 'sign-out': {
      const ok = await confirmBox({ title: 'Sign Claude Code out on this PC?', text: 'AI in the Git tab turns off. Claude Code used elsewhere on this PC (for example in a terminal) is signed out too.', ok: 'Sign out', danger: true });
      if (ok !== 'ok') return;
      a.disabled = true;
      try {
        S.ai.status = await api('POST', '/api/ai/sign-out');
        S.settings.aiEnabled = false;
        if ($('#settingsDialog').open) renderAiSettings(true);
        if (S.tab === 'git') renderGit();
        toast('Signed out. AI in the Git tab is off.');
      } catch (err) { a.disabled = false; fail(err); }
      return;
    }
    case 'turn-off': {
      try {
        S.settings = await api('POST', '/api/settings', { aiEnabled: false });
        await loadAiStatus();
        if ($('#settingsDialog').open) renderAiSettings(true);
        if (S.tab === 'git') renderGit();
        toast('AI in the Git tab is off.');
      } catch (err) { fail(err); }
      return;
    }
    case 'undo': {
      const prev = S.ai.undo.get(e.id);
      if (prev == null) return;
      setCommitDraft(e.id, prev);
      const ta = $('#commitMsg'); if (ta) ta.value = prev;
      S.ai.undo.delete(e.id);
      return renderAiCard();
    }
  }
});
$('#settingsForm').addEventListener('change', (ev) => { if (ev.target.name === 'aiEnabled' && ev.target.checked) loadAiStatus(true); });
