'use strict';
/* The packaged Windows executable, with modules.
 *
 * The point of this test is the worker launch strategy. There is no `node` on an
 * end user's machine, so a module's backend runs in the SAME executable,
 * re-entered with the snapshot path of lib/host/worker-entry.js. That only works
 * if worker-entry.js is inside the snapshot (pkg.scripts in package.json) and if
 * a module's own code - which lives OUTSIDE the snapshot, in the data directory -
 * can still be required and can still resolve the libraries the host shares.
 *
 *   npm run build && node test/e2e/packaged-exe.e2e.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const EXE = process.env.SERVER_TOOLS_EXE || path.join(ROOT, 'dist', 'server-tools.exe');
const { createRegistryServer } = require('../../scripts/module-registry');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, { timeout = 40000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { last = await predicate(); if (last) return last; } catch (error) { last = error.message; }
    await wait(300);
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}

async function main() {
  if (!fs.existsSync(EXE)) {
    console.log(`packaged-exe e2e: SKIPPED (${path.relative(ROOT, EXE)} has not been built; run npm run build)`);
    return;
  }
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-tools-exe-'));
  const dataDir = path.join(workDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  /* The trust anchor is inside the executable; installation must work from there. */

  const distDir = path.join(ROOT, 'dist', 'modules');
  assert.ok(fs.existsSync(path.join(distDir, 'catalog.json')), 'build the modules first: npm run modules:build');
  const registry = await createRegistryServer({ dir: distDir, port: 0 });
  const port = 3900 + Math.floor(Math.random() * 90);
  const base = `http://127.0.0.1:${port}`;

  const output = [];
  const app = spawn(EXE, [], {
    cwd: workDir,
    env: { ...process.env, PORT: String(port), MAU_NO_OPEN: '1', MODULE_REGISTRIES: registry.catalogUrl, SERVER_TOOLS_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stdout.on('data', (chunk) => output.push(String(chunk)));
  app.stderr.on('data', (chunk) => output.push(String(chunk)));

  try {
    await until(async () => (await fetch(`${base}/api/modules`)).ok, { what: 'the packaged application to start' });
    console.log('  the executable is serving');

    /* A module with only RPC methods… */
    let response = await fetch(`${base}/api/modules/history/install`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    let body = await response.json();
    assert.ok(response.ok, `history failed to install in the packaged app: ${body.error}`);
    const listed = await (await fetch(`${base}/api/m/history/list?limit=5`)).json();
    assert.ok(Array.isArray(listed.entries), 'the history worker answered an RPC call');
    console.log('  history: worker started and answered');

    /* …and one with an HTTP surface, a WebSocket endpoint and a shared library. */
    response = await fetch(`${base}/api/modules/servers/install`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    body = await response.json();
    assert.ok(response.ok, `servers failed to install in the packaged app: ${body.error}`);
    const probe = await fetch(`${base}/api/m/servers/http/sessions`);
    const text = await probe.text();
    assert.equal(probe.status, 200, `servers HTTP surface: ${probe.status} ${text.slice(0, 300)}`);
    const sessions = JSON.parse(text);
    assert.ok(Array.isArray(sessions.sessions), 'the servers worker served its own HTTP surface');
    console.log('  servers: worker started, ssh2 resolved, HTTP surface proxied');

    /* …and the big one, which bundles its own dependencies. */
    response = await fetch(`${base}/api/modules/deployments/install`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    body = await response.json();
    assert.ok(response.ok, `deployments failed to install in the packaged app: ${body.error}`);
    const deployProbe = await fetch(`${base}/api/m/deployments/http/deploy/targets`);
    const deployText = await deployProbe.text();
    assert.equal(deployProbe.status, 200, `deployments HTTP surface: ${deployProbe.status} ${deployText.slice(0, 400)}`);
    const targets = JSON.parse(deployText);
    assert.ok(Array.isArray(targets.targets), 'the deployments worker served its own routes');
    console.log('  deployments: worker started, bundled dependencies resolved');

    /* The frontend of a module is served from the data directory, not the snapshot. */
    const state = await (await fetch(`${base}/api/modules`)).json();
    for (const id of ['history', 'servers', 'deployments']) {
      const module = state.modules.find((m) => m.id === id);
      assert.equal(module.status, 'active', `${id} is not active`);
      const asset = await fetch(`${base}${module.entryUrl}`);
      assert.equal(asset.status, 200, `${id}: its frontend entry point is not served`);
    }
    console.log('  module frontends are served from the data directory');

    /* Removing stops the worker cleanly. */
    for (const id of ['deployments', 'servers', 'history']) {
      const removed = await fetch(`${base}/api/modules/${id}/remove`, { method: 'POST' });
      assert.ok(removed.ok, `${id} could not be removed: ${(await removed.json()).error}`);
    }
    console.log('packaged-exe e2e: PASS');
  } catch (error) {
    console.error(output.join(''));
    throw error;
  } finally {
    try { app.kill(); } catch {}
    await registry.close();
    await wait(500);
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error('packaged-exe e2e: FAIL\n', error); process.exit(1); });
