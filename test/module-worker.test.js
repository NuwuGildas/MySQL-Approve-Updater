'use strict';
/* The worker a backend module runs in: startup, RPC, a crash that takes only
   its own module down, shutdown, and what the host does with an installation
   that is still recorded after a restart.
 *
 * Real child processes, real IPC, real packages on disk. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSupervisor } = require('../lib/host/supervisor');
const { createServices } = require('../lib/host/services');
const { validateManifest } = require('../lib/host/manifest');
const { HOST_SDK_VERSION } = require('../lib/host/sdk');

/** Write a module package straight to disk (installation is covered elsewhere). */
function moduleOnDisk(root, id, backend, extra = {}) {
  const dir = path.join(root, id);
  fs.mkdirSync(path.join(dir, 'backend'), { recursive: true });
  const manifest = validateManifest({
    packageFormat: 1, id, name: id, description: `${id} for tests`, version: '1.0.0',
    publisher: 'Test', hostSdk: '^1.0.0', backend: 'backend/index.js',
    capabilities: ['audit:write', 'storage:module'], ...extra,
  });
  fs.writeFileSync(path.join(dir, 'module.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, 'backend', 'index.js'), backend);
  return {
    id, manifest, dir,
    workerInfo: { id, version: '1.0.0', dir, entry: 'backend/index.js', dataDir: dir, appDataDir: root, capabilities: manifest.capabilities, sharedDependencies: manifest.sharedDependencies, hostSdkVersion: HOST_SDK_VERSION },
  };
}

function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-worker-'));
  const audits = [];
  const services = createServices({ audit: { record: (entry) => { audits.push(entry); return true; } }, settings: { get: () => ({ ok: true }) } });
  const exits = [];
  const events = [];
  const supervisor = createSupervisor({ services, log: () => {} });
  t.after(async () => { await supervisor.stopAll('test over'); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, supervisor, audits, exits, events };
}

const READY = `
  'use strict';
  module.exports = { activate: async (host) => ({
    methods: {
      echo: (params) => ({ saw: params, id: host.id }),
      recordSomething: async () => host.audit({ action: 'from-worker' }),
      settings: () => host.settings(),
      slow: () => new Promise(() => {}),
      boom: () => { throw Object.assign(new Error('nope'), { status: 418 }); },
      die: () => { setTimeout(() => process.exit(3), 5); return { ok: true }; },
    },
    busy: () => false,
  }) };
`;

test('a worker starts, answers, reports its methods and reaches host services it asked for', async (t) => {
  const h = harness(t);
  const record = moduleOnDisk(h.root, 'alpha', READY);
  const worker = await h.supervisor.start(record, { onEvent: (name, payload) => h.events.push({ name, payload }) });

  assert.equal(worker.state.status, 'ready');
  assert.deepEqual(worker.state.methods.sort(), ['boom', 'die', 'echo', 'recordSomething', 'settings', 'slow']);
  assert.deepEqual(await worker.call('echo', { a: 1 }), { saw: { a: 1 }, id: 'alpha' });

  await worker.call('recordSomething');
  assert.equal(h.audits[0].action, 'from-worker');
  assert.equal(h.audits[0].module, 'alpha', 'the host stamps who recorded it');

  // An error keeps its status all the way back to the host.
  await assert.rejects(worker.call('boom'), (error) => error.status === 418 && /nope/.test(error.message));
  await assert.rejects(worker.call('nosuch'), /Unknown method/);
});

test('a module that cannot start is reported, and leaves no running worker behind', async (t) => {
  const h = harness(t);
  const record = moduleOnDisk(h.root, 'bad', "module.exports = { activate: async () => { throw new Error('cannot start'); } };");
  await assert.rejects(h.supervisor.start(record), /cannot start/);
  assert.equal(h.supervisor.get('bad'), null);
});

test('a crashing worker takes down only its own module, and its in-flight call fails cleanly', async (t) => {
  const h = harness(t);
  const alpha = await h.supervisor.start(moduleOnDisk(h.root, 'alpha', READY), { onExit: (e) => h.exits.push(e) });
  const beta = await h.supervisor.start(moduleOnDisk(h.root, 'beta', READY), { onExit: (e) => h.exits.push(e) });

  const inFlight = alpha.call('slow');
  await alpha.call('die');
  await assert.rejects(inFlight, /stopped while handling this request/);

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(h.supervisor.get('alpha'), null, 'the crashed worker is gone');
  assert.equal(h.exits.find((e) => e.id === 'alpha').expected, false, 'the host knows it was not asked for');

  // The other module never noticed.
  assert.equal(beta.state.status, 'ready');
  assert.deepEqual(await beta.call('echo', { still: 'here' }), { saw: { still: 'here' }, id: 'beta' });
});

test('shutting a worker down is orderly, and calls afterwards are refused rather than hanging', async (t) => {
  const h = harness(t);
  const worker = await h.supervisor.start(moduleOnDisk(h.root, 'alpha', `
    'use strict';
    module.exports = { activate: async (host) => ({
      methods: { echo: (p) => p },
      busy: () => false,
      deactivate: async () => { host.log('info', 'goodbye'); },
    }) };
  `));
  assert.equal(await h.supervisor.stop('alpha', 'test'), true);
  assert.equal(h.supervisor.get('alpha'), null);
  await assert.rejects(worker.call('echo', {}), /not running|stopped/);
});

test('a module only reaches a host service its manifest asked for', async (t) => {
  const h = harness(t);
  const record = moduleOnDisk(h.root, 'nosy', `
    'use strict';
    module.exports = { activate: async (host) => ({
      methods: { peek: () => host.call('connections.credentials', { id: 'x' }) },
      busy: () => false,
    }) };
  `, { capabilities: ['storage:module'] });
  const worker = await h.supervisor.start(record);
  await assert.rejects(worker.call('peek'), /did not request the "connections:secrets"/);
});

test('a module that declares a shared library gets the host copy; one that does not, cannot', async (t) => {
  const h = harness(t);
  const allowed = moduleOnDisk(h.root, 'sharer', `
    'use strict';
    module.exports = { activate: async (host) => ({
      methods: { has: () => ({ ok: typeof host.shared('tar').create === 'function' || typeof host.shared('tar').c === 'function' }) },
      busy: () => false,
    }) };
  `, { sharedDependencies: ['tar'] });
  const worker = await h.supervisor.start(allowed);
  assert.deepEqual(await worker.call('has'), { ok: true });

  const denied = moduleOnDisk(h.root, 'greedy', `
    'use strict';
    module.exports = { activate: async (host) => ({
      methods: { has: () => host.shared('ssh2') },
      busy: () => false,
    }) };
  `);
  const other = await h.supervisor.start(denied);
  await assert.rejects(other.call('has'), /did not declare "ssh2"/);
});

test('busy() is what blocks removal, and it is the module that answers', async (t) => {
  const h = harness(t);
  const worker = await h.supervisor.start(moduleOnDisk(h.root, 'busybody', `
    'use strict';
    let working = false;
    module.exports = { activate: async () => ({
      methods: { start: () => { working = true; return { ok: true }; }, stop: () => { working = false; return { ok: true }; } },
      busy: () => working,
    }) };
  `));
  assert.equal(await worker.busy(), false);
  await worker.call('start');
  assert.equal(await worker.busy(), true);
  await worker.call('stop');
  assert.equal(await worker.busy(), false);
});
