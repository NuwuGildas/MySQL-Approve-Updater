'use strict';
/* A disposable Server Tools instance for the frontend checks.

   server.js keeps DATA_DIR === __dirname, so the only way to keep a check away from the user's
   real connections.json, settings.json and chat history is to run a COPY of the app from a temp
   directory with its own data files. node_modules is junctioned rather than copied.
   Two throwaway SSH servers (test/fixtures/ssh-server.js) stand in for real boxes, and a scripted
   fake `claude` CLI (fake-claude/) stands in for the model, so every turn is deterministic. */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const { startSshServer, fixtureConnections } = require(path.join(ROOT, 'test', 'fixtures', 'ssh-server.js'));

const COPY = ['server.js', 'package.json', 'lib', 'public', 'scripts'];
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

/**
 * @param {object} o
 * @param {number} [o.port] HTTP port for the app (never 3000: the user's dev server owns it)
 * @param {number} [o.servers] how many disposable SSH boxes to expose as server profiles
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
  fs.writeFileSync(scriptFile, '[]');

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
    base, dir, port, profiles, log,
    /** Queue what the fake CLI answers, one entry per model step. */
    script: (steps) => fs.writeFileSync(scriptFile, JSON.stringify(steps, null, 2)),
    async stop() {
      try { child.kill(); } catch {}
      for (const s of ssh) { try { await s.close(); } catch {} }
      await new Promise((r) => setTimeout(r, 400));
      rm(dir);
    },
  };
}

module.exports = { startSandbox, ROOT };
