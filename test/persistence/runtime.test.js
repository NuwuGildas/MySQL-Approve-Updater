'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
const { createRuntime } = require('../../lib/persistence/runtime');

// Exercises the actual cross-thread sync/async transport and file routing.
// SQL semantics are covered separately by the opt-in real database tests.
function workerFactory() {
  return new Worker(`
    const { parentPort } = require('node:worker_threads');
    const records = new Map();
    parentPort.on('message', ({op,args,port,signal}) => {
      let value, error;
      const [key,body] = args;
      try {
        if (key === 'rules.json') throw Object.assign(new Error('database unavailable'), {code:'ECONNREFUSED'});
        switch(op) {
          case 'ready': break;
          case 'read': if (!records.has(key)) throw Object.assign(new Error('missing'),{code:'ENOENT'}); value=records.get(key); break;
          case 'exists': value=records.has(key); break;
          case 'write': records.set(key,Buffer.from(body)); break;
          case 'append': records.set(key,Buffer.concat([records.get(key)||Buffer.alloc(0),Buffer.from(body)])); break;
          case 'copy': case 'rename': records.set(body,records.get(key)); if(op==='rename') records.delete(key); break;
          case 'remove': records.delete(key); break;
          case 'close': break;
          default: throw new Error(op);
        }
      } catch(e) { error={message:e.message,code:e.code}; }
      port.postMessage({value,error});
      if(signal) {const a=new Int32Array(signal);Atomics.store(a,0,1);Atomics.notify(a,0);}
      port.close();
    });`, { eval: true });
}

test('MySQL runtime routes sync and async IO, preserves binary data, and never writes shadow files', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-runtime-'));
  const runtime = createRuntime({ root, env: { APP_STORAGE: 'mysql' }, workerFactory });
  t.after(async () => { await runtime.close(); await fs.rm(root, { recursive: true, force: true }); });
  const file = path.join(root, 'settings.json');
  assert.equal(runtime.fs.existsSync(file), false);
  assert.throws(() => runtime.fs.readFileSync(file), { code: 'ENOENT' });
  assert.equal(runtime.status.healthy, true, 'missing documents are not DB faults');
  runtime.fs.writeFileSync(file + '.tmp', '{"n":1}');
  runtime.fs.renameSync(file + '.tmp', file);
  assert.equal(await runtime.promises.readFile(file, 'utf8'), '{"n":1}');
  assert.equal(runtime.fs.existsSync(file + '.tmp'), false);
  const binary = path.join(root, 'deploy-secrets.enc');
  await runtime.promises.writeFile(binary, Buffer.from([255, 0, 42]));
  assert.deepEqual(runtime.fs.readFileSync(binary), Buffer.from([255, 0, 42]));
  const log = path.join(root, 'audit.log');
  await runtime.promises.appendFile(log, 'a\n');
  runtime.fs.appendFileSync(log, 'b\n');
  assert.equal(runtime.fs.readFileSync(log, 'utf8'), 'a\nb\n');
  await runtime.promises.copyFile(file, file + '.bak');
  await runtime.promises.unlink(file);
  assert.equal(runtime.fs.existsSync(file), false);
  assert.equal(runtime.fs.readFileSync(file + '.bak', 'utf8'), '{"n":1}');
  assert.deepEqual(await fs.readdir(root), [], 'managed data never touches the native filesystem');
  const machineKey = path.join(root, 'deploy-master.key');
  runtime.fs.writeFileSync(machineKey, 'external-key');
  assert.equal(await fs.readFile(machineKey, 'utf8'), 'external-key');
  assert.throws(() => runtime.fs.renameSync(file + '.bak', machineKey), /backends/);
});

test('DB errors latch unhealthy state: later reads/writes cannot silently continue with stale memory', async (t) => {
  const runtime = createRuntime({ root: os.tmpdir(), env: { APP_STORAGE: 'mysql' }, workerFactory });
  t.after(() => runtime.close());
  await assert.rejects(runtime.promises.writeFile(path.join(os.tmpdir(), 'rules.json'), '[]'), { code: 'ECONNREFUSED' });
  assert.equal(runtime.status.healthy, false);
  assert.throws(() => runtime.assertHealthy(), { status: 503 });
  assert.throws(() => runtime.fs.writeFileSync(path.join(os.tmpdir(), 'settings.json'), '{}'), { status: 503 });
});

test('mode is explicit and native filesystem exports are unchanged', () => {
  assert.throws(() => createRuntime({ root: os.tmpdir(), env: { APP_STORAGE: 'typo' } }), /APP_STORAGE/);
  const runtime = createRuntime({ root: os.tmpdir(), env: {} });
  assert.equal(runtime.mode, 'files');
  assert.notEqual(runtime.fs, require('node:fs'));
});
