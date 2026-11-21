// Persists settings + environments (with their launchers) in <dataDir>/config.json.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { guessKind } from './apiscan.js';

export const newId = () => crypto.randomBytes(6).toString('hex');

const DEFAULT_SETTINGS = { terminal: 'auto', editor: 'code', openSitesIn: 'app' };

const str = (v, max = 4000) => (v == null ? '' : String(v)).slice(0, max);
const portNum = (v) => {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
};

export function cleanLauncher(input, existing = {}) {
  const l = { ...existing, ...input };
  return {
    id: existing.id || newId(),
    name: str(l.name, 80).trim() || 'launcher',
    command: str(l.command).trim(),
    cwd: str(l.cwd, 500).trim().replace(/^[.][\\/]?$/, ''),
    port: l.kind === 'app' ? null : portNum(l.port), // an App runs on this PC: no port or URL
    url: l.kind === 'app' ? '' : str(l.url, 500).trim(),
    envText: str(l.envText, 20000),
    openOnReady: l.kind !== 'app' && !!l.openOnReady,
    autoRestart: !!l.autoRestart,
    monitor: !!l.monitor,
    kind: ['web', 'api', 'both', 'app'].includes(l.kind) ? l.kind : '',
  };
}

// A saved request in a launcher's Custom collection (API tab). File contents are never stored.
export function cleanRequest(input, existing = {}) {
  const r = { ...existing, ...input };
  const rows = (list, max) => (Array.isArray(list) ? list : []).slice(0, max).map((x) => ({ k: str(x?.k, 300), v: str(x?.v, 8000), on: x?.on !== false }));
  return {
    id: existing.id || str(r.id, 40) || newId(),
    name: str(r.name, 120).trim() || 'Request',
    method: (str(r.method, 10).trim().toUpperCase() || 'GET').replace(/[^A-Z]/g, '') || 'GET',
    url: str(r.url, 4000).trim(),
    // secrets are never stored: the API tab's shared "Auth & headers" supply them when sending
    headers: rows(r.headers, 100).filter((x) => !/^(authorization|proxy-authorization|cookie|x-api-key|api-key|x-auth-token|x-access-token|x-csrf-token|x-xsrf-token)$/i.test(x.k.trim())),
    params: Object.fromEntries(Object.entries(r.params && typeof r.params === 'object' ? r.params : {}).slice(0, 50).map(([k, v]) => [str(k, 100), str(v, 2000)])),
    bodyMode: r.bodyMode === 'multipart' ? 'multipart' : 'raw',
    body: str(r.body, 1024 * 1024),
    multipart: (Array.isArray(r.multipart) ? r.multipart : []).slice(0, 100).map((p) => ({ name: str(p?.name, 300), kind: p?.kind === 'file' ? 'file' : 'text', value: p?.kind === 'file' ? '' : str(p?.value, 8000) })),
    createdAt: existing.createdAt || Number(r.createdAt) || Date.now(),
    updatedAt: Date.now(),
  };
}

export function cleanEnv(input, existing = {}) {
  const e = { ...existing, ...input };
  return {
    id: existing.id || newId(),
    name: str(e.name, 80).trim() || path.basename(str(e.path)) || 'Environment',
    path: str(e.path, 1000).trim(),
    launchers: Array.isArray(existing.launchers) ? existing.launchers : [],
    createdAt: existing.createdAt || new Date().toISOString(),
  };
}

export function createStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'config.json');
  let state = { settings: { ...DEFAULT_SETTINGS }, environments: [], collections: {} };

  if (fs.existsSync(file)) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      state.settings = { ...DEFAULT_SETTINGS, ...(raw.settings || {}) };
      state.environments = (raw.environments || []).map((e) => ({
        ...cleanEnv(e, e),
        launchers: (e.launchers || []).map((l) => cleanLauncher(l, l)),
      }));
      for (const [lid, list] of Object.entries(raw.collections || {})) {
        if (Array.isArray(list)) state.collections[lid] = list.map((r) => cleanRequest(r, r));
      }
    } catch (err) {
      const bad = file + '.broken-' + Date.now();
      fs.copyFileSync(file, bad);
      console.error(`config.json could not be read (${err.message}); a copy was saved to ${bad}`);
    }
  }

  // launchers saved before the Website/API type existed get a guess; once, after "Both" was added,
  // launchers that turn out to be both a site and an API are upgraded (a manual choice is otherwise kept)
  let guessed = false;
  const recheck = (state.settings.kindCheck || 0) < 2;
  for (const env of state.environments) for (const l of env.launchers) {
    const dir = path.resolve(env.path, l.cwd || '.');
    if (!l.kind) { l.kind = guessKind(dir); guessed = true; }
    else if (recheck && (l.kind === 'web' || l.kind === 'api') && guessKind(dir) === 'both') { l.kind = 'both'; guessed = true; }
  }
  if (recheck) { state.settings.kindCheck = 2; guessed = true; }

  function save() {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
  }

  const findEnv = (id) => state.environments.find((e) => e.id === id);
  function findLauncher(lid) {
    for (const env of state.environments) {
      const l = env.launchers.find((x) => x.id === lid);
      if (l) return { env, launcher: l };
    }
    return null;
  }

  if (guessed) save();

  return {
    file,
    get state() { return state; },
    save,
    findEnv,
    findLauncher,
    updateSettings(patch) {
      const s = { ...state.settings };
      if (patch.terminal != null) s.terminal = str(patch.terminal, 40);
      if (patch.editor != null) s.editor = str(patch.editor, 200).trim() || 'code';
      if (patch.cliShell != null) s.cliShell = str(patch.cliShell, 20);
      // AI in the Git tab (Claude Code): off until someone turns it on, per PC
      if (patch.aiEnabled != null) s.aiEnabled = !!patch.aiEnabled;
      if (patch.aiModel != null) s.aiModel = ['claude-sonnet-5-5', 'claude-opus-5-5'].includes(patch.aiModel) ? patch.aiModel : 'claude-sonnet-5-5';
      if (patch.openSitesIn != null) s.openSitesIn = patch.openSitesIn === 'browser' ? 'browser' : 'app';
      state.settings = s;
      save();
      return s;
    },
    addEnv(input) {
      const env = cleanEnv(input);
      state.environments.push(env);
      save();
      return env;
    },
    updateEnv(id, input) {
      const env = findEnv(id);
      if (!env) return null;
      Object.assign(env, cleanEnv({ name: input.name, path: input.path }, env));
      save();
      return env;
    },
    // ---------- Custom request collections (per launcher) ----------
    requests(lid) { return state.collections[lid] || []; },
    saveRequest(lid, input) {
      const list = state.collections[lid] || (state.collections[lid] = []);
      const i = input.id ? list.findIndex((r) => r.id === input.id) : -1;
      if (i < 0 && list.length >= 500) throw Object.assign(new Error('This collection is full (500 requests)'), { status: 400 });
      const r = cleanRequest(input, i >= 0 ? list[i] : {});
      if (i >= 0) list[i] = r; else list.push(r);
      save();
      return r;
    },
    deleteRequest(lid, rid) {
      const list = state.collections[lid];
      if (!list) return;
      state.collections[lid] = list.filter((r) => r.id !== rid);
      save();
    },
    removeEnv(id) {
      for (const l of findEnv(id)?.launchers || []) delete state.collections[l.id];
      state.environments = state.environments.filter((e) => e.id !== id);
      save();
    },
    /** New order for the environment list (ids not mentioned keep their place at the end). */
    reorderEnvs(ids) {
      const byId = new Map(state.environments.map((e) => [e.id, e]));
      const next = ids.map((id) => byId.get(id)).filter(Boolean);
      for (const e of state.environments) if (!next.includes(e)) next.push(e);
      state.environments = next;
      save();
    },
    moveEnv(id, dir) {
      const list = state.environments;
      const i = list.findIndex((e) => e.id === id);
      const j = i + (dir < 0 ? -1 : 1);
      if (i < 0 || j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      save();
    },
    addLauncher(envId, input) {
      const env = findEnv(envId);
      if (!env) return null;
      const l = cleanLauncher(input);
      if (!l.kind) l.kind = guessKind(path.resolve(env.path, l.cwd || '.'));
      env.launchers.push(l);
      save();
      return l;
    },
    updateLauncher(envId, lid, input) {
      const env = findEnv(envId);
      const idx = env ? env.launchers.findIndex((l) => l.id === lid) : -1;
      if (idx < 0) return null;
      env.launchers[idx] = cleanLauncher(input, env.launchers[idx]);
      save();
      return env.launchers[idx];
    },
    removeLauncher(envId, lid) {
      const env = findEnv(envId);
      if (!env) return;
      env.launchers = env.launchers.filter((l) => l.id !== lid);
      delete state.collections[lid];
      save();
    },
    moveLauncher(envId, lid, dir) {
      const env = findEnv(envId);
      if (!env) return;
      const list = env.launchers;
      const i = list.findIndex((l) => l.id === lid);
      const j = i + (dir < 0 ? -1 : 1);
      if (i < 0 || j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      save();
    },
  };
}
