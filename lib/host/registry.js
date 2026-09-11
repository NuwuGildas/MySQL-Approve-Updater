'use strict';
/* What is installed right now, and where its code lives.
 *
 * The record is the only authority: the browser never grants itself a module,
 * and nothing is considered installed until the state document has been
 * replaced atomically on disk. Installed code lives under a versioned directory
 * in the data area; module-owned user data lives beside it and is never touched
 * by install or remove. */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { validateManifest } = require('./manifest');
const semver = require('./semver');
const { createJsonStore, createLock } = require('./storage');

const STATE_KEY = 'state';
const STATE_VERSION = 1;
const fail = (status, message, code) => { throw Object.assign(new Error(message), { status, code }); };

function createRegistry(dataDir, { hostSdkVersion } = {}) {
  // Installed code and module-owned data, kept well away from the base app's
  // own files and out of the read-only executable snapshot.
  const root = path.join(dataDir, 'module-data');
  const layout = {
    root,
    installed: path.join(root, 'installed'),   // code, versioned, replaceable
    staging: path.join(root, 'staging'),       // half-built installs, never served
    data: path.join(root, 'data'),             // module-owned user data, survives removal
    cache: path.join(root, 'cache'),
  };
  for (const dir of Object.values(layout)) fs.mkdirSync(dir, { recursive: true });
  const store = createJsonStore(root);
  const withLock = createLock();

  let state = load();

  function load() {
    const raw = store.readSync(STATE_KEY, { version: STATE_VERSION, modules: {} });
    if (raw.version !== STATE_VERSION || !raw.modules || typeof raw.modules !== 'object') {
      fail(500, 'module-data/state.json is not a module state document; move it aside to start with no modules installed.', 'bad_state');
    }
    const modules = {};
    for (const [id, record] of Object.entries(raw.modules)) {
      // A record whose code is gone is reported as broken rather than silently dropped:
      // the user's configuration and data for it are still there to be recovered.
      const dir = path.join(layout.installed, id, String(record.version));
      let manifest = null, error = null;
      try { manifest = validateManifest(record.manifest, { hostSdkVersion }); }
      catch (e) { error = e.message; }
      const present = fs.existsSync(path.join(dir, 'module.json'));
      modules[id] = { ...record, id, dir, manifest, broken: error || (present ? null : 'Installed files are missing') };
    }
    return { version: STATE_VERSION, modules };
  }

  const list = () => Object.values(state.modules);
  const get = (id) => state.modules[id] || null;
  const has = (id) => !!state.modules[id] && !state.modules[id].broken;
  const installedVersion = (id) => state.modules[id]?.version || null;
  const dataDirFor = (id) => { const dir = path.join(layout.data, id); fs.mkdirSync(dir, { recursive: true }); return dir; };
  const codeDirFor = (id, version) => path.join(layout.installed, id, String(version));

  /** Installed modules that declare a dependency on `id`. */
  const dependents = (id) => list().filter((m) => m.manifest && Object.keys(m.manifest.dependencies || {}).includes(id));

  /** Every installed dependency of `id` is present and in range. */
  function unmetDependencies(manifest) {
    return Object.entries(manifest.dependencies || {})
      .filter(([depId, range]) => !has(depId) || !semver.satisfies(installedVersion(depId), range))
      .map(([depId, range]) => ({ id: depId, range, installed: installedVersion(depId) }));
  }

  async function commit(nextModules) {
    const document = { version: STATE_VERSION, modules: {} };
    for (const [id, entry] of Object.entries(nextModules)) {
      // `dir` and `broken` are derived on load; the manifest is stored in its
      // already-normalised form so a re-read validates the same document.
      const { dir, broken, ...persisted } = entry;
      document.modules[id] = persisted;
    }
    await store.write(STATE_KEY, document);
    state = load();
    return state;
  }

  /** Record a finished installation. The code directory must already exist. */
  function record(id, entry) {
    return withLock('state', async () => {
      const next = { ...state.modules, [id]: { ...entry, id } };
      await commit(next);
      return get(id);
    });
  }

  /** Forget a module. Its code directory is removed; its data directory is kept. */
  function forget(id) {
    return withLock('state', async () => {
      const existing = state.modules[id];
      if (!existing) return null;
      const next = { ...state.modules };
      delete next[id];
      await commit(next);
      // Code only. module-data/data/<id> is the user's and stays for a future re-install.
      await fsp.rm(path.join(layout.installed, id), { recursive: true, force: true }).catch(() => {});
      return existing;
    });
  }

  /** Drop staging directories left behind by an interrupted install. */
  async function sweepStaging() {
    for (const name of await fsp.readdir(layout.staging).catch(() => [])) {
      await fsp.rm(path.join(layout.staging, name), { recursive: true, force: true }).catch(() => {});
    }
  }

  return {
    layout, withLock, list, get, has, installedVersion, dependents, unmetDependencies,
    dataDirFor, codeDirFor, record, forget, sweepStaging, reload: () => { state = load(); return state; },
  };
}

module.exports = { createRegistry };
