'use strict';
/* A disposable Server Tools instance for the frontend checks.

   server.js keeps DATA_DIR === __dirname, so the only way to keep a check away from the user's
   real connections.json, settings.json and chat history is to run a COPY of the app from a temp
   directory with its own data files. node_modules is junctioned rather than copied.
   Two throwaway SSH servers (test/fixtures/ssh-server.js) stand in for real boxes, and a scripted
   fake `claude` CLI (fake-claude/) stands in for the model, so every turn is deterministic.

   Servers, Terminals, Projects, Connectors, Deployments and History are MODULES, so a bare copy of
   the app has none of them and every page these checks look at is missing. installModules() puts
   them in, from modules/ as it stands right now - which is the point: a check must see the code
   being edited, not the last build and not what the user happens to have installed. */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
/* The SSH fixture moved into the Servers module when servers became one; keep the
   old path working so a checkout mid-refactor still runs. */
const SSH_FIXTURE = [
  path.join(ROOT, 'modules', 'servers', 'test', 'fixtures', 'ssh-server.js'),
  path.join(ROOT, 'test', 'fixtures', 'ssh-server.js'),
].find((p) => fs.existsSync(p));
const { startSshServer, fixtureConnections } = require(SSH_FIXTURE);

const COPY = ['server.js', 'package.json', 'lib', 'public', 'scripts', 'config'];
const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} };

function link(target, linkPath) {
  if (fs.existsSync(linkPath)) return;
  if (process.platform === 'win32') execFileSync('cmd', ['/c', 'mklink', '/J', linkPath, target], { stdio: 'ignore' });
  else fs.symlinkSync(target, linkPath, 'dir');
}

async function makeAppDir() {
  const dir = path.join(os.tmpdir(), 'st-ws-check-' + Date.now().toString(36));
  fs.mkdirSync(dir, { recursive: true });
  for (const item of COPY) {
    const from = path.join(ROOT, item);
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(dir, item), { recursive: true });
  }
  link(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
  return dir;
}

/* ---------------------------------------------------------------------------
   Installing the modules into the sandbox

   The real install path is download -> verify signature -> stage -> activate,
   and it has its own end-to-end test (test/e2e/module-install.e2e.js). What a
   frontend check needs is the result of that path, from the working tree, in
   under a second: the registry treats module-data/state.json as the only
   authority and reads the code from module-data/installed/<id>/<version>/, so
   writing both is a complete installation as far as the running app is
   concerned. Nothing is signed, which is honest - these are development
   installs of uncommitted code.
   --------------------------------------------------------------------------- */

const SKIP_IN_PACKAGE = new Set(['.git', '.github', 'test', 'tests', 'coverage', 'node_modules']);
const SKIP_IN_DEPENDENCY = /[\\/](test|tests|__tests__|\.github|docs?|example|examples)$/;

/** Copy a module's source the way build-module.js packages it: no tests, no git, no build output. */
function copyPackage(from, to) {
  fs.cpSync(from, to, {
    recursive: true,
    filter: (src) => {
      const name = path.basename(src);
      return !SKIP_IN_PACKAGE.has(name) && !name.startsWith('_moved') && !name.endsWith('.tgz');
    },
  });
}

/** A module's bundledDependencies, and theirs, copied out of this checkout. */
function bundleDependencies(manifest, into) {
  const seen = new Set();
  const copy = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    const from = path.join(ROOT, 'node_modules', name);
    if (!fs.existsSync(from)) throw new Error(`${manifest.id} bundles "${name}", which is not installed in this checkout`);
    fs.cpSync(from, path.join(into, 'node_modules', name), { recursive: true, filter: (e) => !SKIP_IN_DEPENDENCY.test(e) });
    const meta = JSON.parse(fs.readFileSync(path.join(from, 'package.json'), 'utf8'));
    for (const dependency of Object.keys(meta.dependencies || {})) copy(dependency);
  };
  for (const name of manifest.bundledDependencies || []) copy(name);
}

/**
 * Install modules into an app directory, straight from source.
 * @param {string} appDir the sandbox copy of the application
 * @param {string[]|null} only module ids to install, or null for every module in modules/
 * @returns {string[]} the ids installed
 */
function installModules(appDir, only = null) {
  const { validateManifest } = require(path.join(ROOT, 'lib', 'host', 'manifest'));
  const { HOST_SDK_VERSION } = require(path.join(ROOT, 'lib', 'host', 'sdk'));
  const source = path.join(ROOT, 'modules');
  if (!fs.existsSync(source)) return [];

  const ids = fs.readdirSync(source, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(source, e.name, 'module.json')))
    .map((e) => e.name)
    .filter((id) => !only || only.includes(id))
    .sort();

  const modules = {};
  for (const id of ids) {
    const raw = JSON.parse(fs.readFileSync(path.join(source, id, 'module.json'), 'utf8'));
    // Validate here rather than letting the registry mark it "broken" at boot, where the
    // reason would only show up as a missing page halfway through a check.
    const manifest = validateManifest(raw, { hostSdkVersion: HOST_SDK_VERSION });
    if (manifest.id !== id) throw new Error(`modules/${id}/module.json declares "${manifest.id}"`);

    const dir = path.join(appDir, 'module-data', 'installed', id, String(manifest.version));
    fs.mkdirSync(dir, { recursive: true });
    copyPackage(path.join(source, id), dir);
    bundleDependencies(manifest, dir);

    modules[id] = {
      id,
      version: manifest.version,
      manifest,
      installedAt: new Date().toISOString(),
      activationId: crypto.randomUUID(),
      digest: null,
      publisher: { id: 'checks', name: 'Workspace checks' },
      signed: false, // installed from the working tree, not from a signed package
      source: { branch: null, commit: null, repository: null },
      packageUrl: null,
    };
  }

  fs.mkdirSync(path.join(appDir, 'module-data'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'module-data', 'state.json'), JSON.stringify({ version: 1, modules }, null, 2));
  return ids;
}

/**
 * @param {object} o
 * @param {number} [o.port] HTTP port for the app (never 3000: the user's dev server owns it)
 * @param {number} [o.servers] how many disposable SSH boxes to expose as server profiles
 * @param {string[]|false} [o.modules] which modules to install; every module in modules/ by
 *   default, or false for a bare app with none (what the marketplace checks want).
 * @param {(dir: string) => void} [o.beforeStart] seed the app directory before the server boots.
 *   It runs after the fixture data files are written and after the modules are installed.
 */
async function startSandbox(o = {}) {
  const port = o.port || 3106;
  const dir = await makeAppDir();
  const ssh = [];
  for (let i = 0; i < (o.servers || 2); i++) ssh.push(await startSshServer({}));
  const { profiles } = fixtureConnections(dir, ssh.map((s, i) => ({ id: `srv-${i + 1}`, name: `Fixture ${i + 1}`, port: s.port })));

  // AI assistant: connected to the scripted CLI, allowed to PROPOSE read and write commands.
  // Approval is still required for every one of them - that is the behaviour under test.
  fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({ provider: 'claude', model: null, connectedAt: new Date().toISOString() }));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    aiAssist: { sshRead: true, sshWrite: true, sshMemory: false, sshDestructive: false, sshSudo: false, sshAuto: false },
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'rules.json'), '[]');
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify({ version: 1, projects: [{ id: 'p1', name: 'Checks', description: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), resources: {} }] }, null, 2));

  const fakeBin = path.join(__dirname, 'fake-claude');
  const scriptFile = path.join(fakeBin, 'script.json');
  const promptFile = path.join(fakeBin, 'prompts.json');
  fs.writeFileSync(scriptFile, '[]');
  fs.writeFileSync(promptFile, '[]');

  const modules = o.modules === false ? [] : installModules(dir, o.modules || null);

  if (o.beforeStart) await o.beforeStart(dir);

  const env = { ...process.env, PORT: String(port), PATH: fakeBin + path.delimiter + process.env.PATH, MAU_NO_OPEN: '1' };
  const child = spawn(process.execPath, [path.join(dir, 'server.js')], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 25000;
  for (;;) {
    if (child.exitCode !== null) throw new Error('server exited: ' + log.join(''));
    try { const r = await fetch(base + '/api/agent'); if (r.ok) break; } catch {}
    if (Date.now() > deadline) throw new Error('server did not start: ' + log.join(''));
    await new Promise((r) => setTimeout(r, 200));
  }

  return {
    base, dir, port, profiles, log, modules,
    /** Queue what the fake CLI answers, one entry per model step. */
    script: (steps) => fs.writeFileSync(scriptFile, JSON.stringify(steps, null, 2)),
    /** Every prompt the model was given, newest last: what it was TOLD, not what it answered. */
    prompts: () => { try { return JSON.parse(fs.readFileSync(promptFile, 'utf8')); } catch { return []; } },
    lastPrompt: () => { const all = (() => { try { return JSON.parse(fs.readFileSync(promptFile, 'utf8')); } catch { return []; } })(); return all.length ? all[all.length - 1].prompt : ''; },
    async stop() {
      try { child.kill(); } catch {}
      for (const s of ssh) { try { await s.close(); } catch {} }
      await new Promise((r) => setTimeout(r, 400));
      rm(dir);
    },
  };
}

module.exports = { startSandbox, installModules, ROOT };
