'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { inventory, importData, verifyData, exportData } = require('../../lib/persistence/transfer');
const { createMysqlStore, connectionOptions, validateKey } = require('../../lib/persistence/mysql');

async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-storage-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function memoryStore() {
  let records = new Map();
  return {
    get: async (key) => records.get(key) || null,
    put: async (key, body) => { records.set(key, { body: Buffer.from(body) }); },
    keys: async () => [...records.keys()].sort(),
    async transaction(fn) {
      const before = new Map(records);
      try { return await fn(this); } catch (e) { records = before; throw e; }
    },
  };
}

test('inventory, idempotent import, verification and byte-exact export', async (t) => {
  const root = await temp(t);
  await fs.writeFile(path.join(root, 'projects.json'), '{"name":"é 😀"}\n');
  await fs.writeFile(path.join(root, 'deploy-secrets.enc'), Buffer.from([0, 255, 10, 128]));
  await fs.writeFile(path.join(root, '.env'), 'SECRET=excluded');
  await fs.writeFile(path.join(root, 'deploy-master.key'), 'excluded');
  const entries = await inventory(root);
  assert.equal(entries.length, 2);
  const store = memoryStore();
  assert.deepEqual(await importData(store, root, entries), { imported: 2, unchanged: 0 });
  assert.deepEqual(await importData(store, root, entries), { imported: 0, unchanged: 2 });
  assert.deepEqual(await verifyData(store, entries), { verified: 2 });
  const destination = path.join(root, 'export');
  assert.deepEqual(await exportData(store, destination), { exported: 2 });
  for (const { key } of entries) assert.deepEqual(await fs.readFile(path.join(destination, key)), await fs.readFile(path.join(root, key)));
  await assert.rejects(exportData(store, destination), { code: 'EEXIST' });
});

test('different destination data rolls back the entire import', async (t) => {
  const root = await temp(t);
  await fs.writeFile(path.join(root, 'settings.json'), '{}');
  await fs.writeFile(path.join(root, 'projects.json'), '[]');
  const store = memoryStore();
  await store.put('projects.json', Buffer.from('{"old":true}'));
  await assert.rejects(importData(store, root, await inventory(root)), /Destination differs/);
  assert.equal(await store.get('settings.json'), null);
  assert.equal((await store.get('projects.json')).body.toString(), '{"old":true}');
});

test('changed source and invalid JSON stop migration', async (t) => {
  const root = await temp(t);
  const file = path.join(root, 'projects.json');
  await fs.writeFile(file, '{}');
  const entries = await inventory(root);
  await fs.writeFile(file, '[]');
  await assert.rejects(importData(memoryStore(), root, entries), /Source changed/);
  await fs.writeFile(file, '{bad');
  await assert.rejects(inventory(root), SyntaxError);
  await assert.rejects(verifyData(memoryStore(), entries), /Verification failed/);
});

test('keys reject traversal and config never reuses target DB credentials', () => {
  for (const key of ['../x', '/x', 'a/../x', 'a\\x', 'a//x', 'x:stream']) assert.throws(() => validateKey(key));
  assert.throws(() => connectionOptions({ DB_HOST: 'target' }), /APP_DB_HOST/);
  assert.throws(() => connectionOptions({ APP_DB_HOST: 'h', APP_DB_USER: 'u', APP_DB_NAME: 'd', APP_DB_PORT: '-1' }), /PORT/);
});

test('revision conflicts and SQL values are parameterized', async () => {
  const calls = [];
  const store = createMysqlStore({ execute: async (...args) => { calls.push(args); return [{ affectedRows: 0 }]; } });
  await assert.rejects(store.writeJson('projects.json', { name: "x'; DROP TABLE test" }, 2), { code: 'storage_conflict' });
  assert.ok(!calls[0][0].includes('DROP'));
  assert.equal(calls[0][1][2], 2);
});

test('SQL transaction commits or rolls back and always releases connection', async () => {
  const calls = [];
  const connection = Object.fromEntries(['beginTransaction', 'commit', 'rollback', 'release'].map((name) => [name, async () => calls.push(name)]));
  const store = createMysqlStore({ getConnection: async () => connection });
  assert.equal(await store.transaction(async () => 42), 42);
  assert.deepEqual(calls.splice(0), ['beginTransaction', 'commit', 'release']);
  await assert.rejects(store.transaction(async () => { throw new Error('failed'); }), /failed/);
  assert.deepEqual(calls, ['beginTransaction', 'rollback', 'release']);
});

// Explicit opt-in only: use a disposable application database, never a target DB.
test('live MySQL round trip, concurrency and rollback', { skip: process.env.APP_DB_TEST !== '1' }, async () => {
  const pool = require('mysql2/promise').createPool(connectionOptions());
  const key = `test/${require('node:crypto').randomUUID()}.json`;
  try {
    const store = createMysqlStore(pool);
    await store.initialize();
    assert.equal(await store.writeJson(key, { text: 'é 😀' }), 1);
    assert.deepEqual(await store.readJson(key), { value: { text: 'é 😀' }, revision: 1 });
    await assert.rejects(store.writeJson(key, {}, 0), { code: 'storage_conflict' });
    await assert.rejects(store.transaction(async (tx) => { await tx.writeJson(key, { changed: true }, 1); throw new Error('rollback'); }), /rollback/);
    assert.equal((await store.readJson(key)).revision, 1);
    assert.equal(await store.writeJson(key, {}, 1), 2);
    await assert.rejects(store.writeJson(key, {}, 1), { code: 'storage_conflict' });
  } finally {
    try { await pool.execute('DELETE FROM st_documents WHERE document_key = ?', [key]); }
    finally { await pool.end(); }
  }
});
