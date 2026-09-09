'use strict';
/* Project store: seeding, never-overwrite guarantees, migration, atomic persistence, CRUD and links.
   Each test gets its own temp DATA_DIR (same pattern as test/deploy/helpers.js fakeCtx). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createProjectStore, migrate, normalizeProject, FILE_NAME, VERSION, RESOURCE_KINDS, DEFAULT_PROJECT } = require('../../lib/projects');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'st-projects-'));
const readJson = (dir) => JSON.parse(fs.readFileSync(path.join(dir, FILE_NAME), 'utf8'));
const files = (dir) => fs.readdirSync(dir).sort();
const mk = (dir = tmpDir()) => { const logs = []; const store = createProjectStore(dir, { log: (l, m) => logs.push([l, m]) }); return { dir, store, logs }; };

test('first start: creates projects.json (v1) with the default General project, atomically', () => {
  const { dir, store } = mk();
  assert.equal(store.seeded, true);
  assert.equal(store.readOnly, null);
  const doc = readJson(dir);
  assert.equal(doc.version, VERSION);
  assert.equal(doc.projects.length, 1);
  assert.equal(doc.projects[0].id, DEFAULT_PROJECT.id);
  assert.equal(doc.projects[0].name, 'General');
  assert.deepEqual(Object.keys(doc.projects[0].resources).sort(), [...RESOURCE_KINDS].sort());
  assert.deepEqual(files(dir), [FILE_NAME], 'no .tmp left behind');
});

test('existing file: loaded as-is, no General added, bytes untouched', () => {
  const dir = tmpDir();
  const original = JSON.stringify({ version: 1, projects: [{ id: 'alpha', name: 'Alpha', description: 'x', color: '#112233', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', resources: { connections: ['c1'], servers: [], connectors: [], repos: [], targets: [] }, extra: { keep: true } }] }, null, 2);
  fs.writeFileSync(path.join(dir, FILE_NAME), original);
  const { store } = mk(dir);
  assert.equal(store.seeded, false);
  assert.equal(store.readOnly, null);
  assert.equal(store.migratedFrom, null);
  assert.equal(store.list().length, 1);
  assert.equal(store.get('alpha').name, 'Alpha');
  assert.deepEqual(store.get('alpha').resources.connections, ['c1']);
  assert.deepEqual(store.get('alpha').extra, { keep: true }, 'unknown fields survive');
  assert.equal(store.get(DEFAULT_PROJECT.id), null, 'General is not seeded next to existing data');
  assert.equal(fs.readFileSync(path.join(dir, FILE_NAME), 'utf8'), original, 'a current-version file is not rewritten at load');
  assert.deepEqual(files(dir), [FILE_NAME]);
});

test('corrupt file: read-only, writes rejected, file never touched', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, FILE_NAME), '{ this is not json');
  const { store, logs } = mk(dir);
  assert.match(store.readOnly, /could not be read/);
  assert.equal(store.list().length, 0);
  assert.ok(logs.some(([l, m]) => l === 'warn' && /read-only/.test(m)));
  await assert.rejects(store.create({ name: 'X' }), (e) => e.status === 503 && /read-only/.test(e.message));
  assert.equal(store.list().length, 0, 'a refused write leaves no phantom record in memory');
  assert.equal(fs.readFileSync(path.join(dir, FILE_NAME), 'utf8'), '{ this is not json');
  assert.deepEqual(files(dir), [FILE_NAME]);
});

test('newer file version: read-only, never downgraded', async () => {
  const dir = tmpDir();
  const original = JSON.stringify({ version: VERSION + 1, projects: [{ id: 'p', name: 'Future', resources: {}, futureField: 1 }] });
  fs.writeFileSync(path.join(dir, FILE_NAME), original);
  const { store } = mk(dir);
  assert.match(store.readOnly, /version 2/);
  await assert.rejects(store.link('p', 'repos', 'r1'), /read-only/);
  assert.equal(fs.readFileSync(path.join(dir, FILE_NAME), 'utf8'), original);
  assert.deepEqual(files(dir), [FILE_NAME]);
});

test('older document shapes migrate to v1 with a backup of the original', () => {
  // pre-versioned bare list with sloppy records
  const dir = tmpDir();
  const legacy = JSON.stringify([{ id: 'one', name: '  One  ', resources: { repos: ['r1', 'r1', 42], bogus: 'nope', custom: ['k1'] } }, { name: '' }, { id: 'one', name: 'dupe' }]);
  fs.writeFileSync(path.join(dir, FILE_NAME), legacy);
  const { store, logs } = mk(dir);
  assert.equal(store.readOnly, null);
  assert.equal(store.migratedFrom, 0);
  assert.equal(store.version, VERSION);
  const doc = readJson(dir);
  assert.equal(doc.version, VERSION);
  assert.equal(doc.projects.length, 2, 'duplicate ids collapse to the first record');
  const one = doc.projects[0];
  assert.equal(one.name, 'One');
  assert.deepEqual(one.resources.repos, ['r1'], 'ids de-duplicated, non-strings dropped');
  assert.deepEqual(one.resources.custom, ['k1'], 'unknown resource kinds are preserved');
  assert.equal(one.resources.bogus, undefined);
  for (const k of RESOURCE_KINDS) assert.ok(Array.isArray(one.resources[k]));
  assert.ok(doc.projects[1].id && doc.projects[1].name.startsWith('Project '), 'nameless record gets an id and a name');
  assert.ok(typeof one.createdAt === 'string' && typeof one.updatedAt === 'string');
  assert.deepEqual(files(dir), [FILE_NAME, `${FILE_NAME}.v0.bak`]);
  assert.equal(fs.readFileSync(path.join(dir, `${FILE_NAME}.v0.bak`), 'utf8'), legacy, 'backup is byte-identical to the original');
  assert.ok(logs.some(([l, m]) => l === 'info' && /Migrated/.test(m)));
  // a second migration would not clobber the first backup
  fs.writeFileSync(path.join(dir, FILE_NAME), legacy);
  mk(dir);
  assert.equal(files(dir).filter((f) => f.endsWith('.bak')).length, 2);
});

test('migrate() and normalizeProject() are pure and reject newer versions', () => {
  assert.equal(migrate(undefined).data.version, VERSION);
  assert.deepEqual(migrate(null).data.projects, []);
  assert.throws(() => migrate({ version: 99, projects: [] }), /version 99/);
  const p = normalizeProject({ id: 'bad id with spaces', name: 'N', color: 'red', resources: { targets: ['t1'] } }, '2026-09-09T00:00:00.000Z');
  assert.notEqual(p.id, 'bad id with spaces');
  assert.equal(p.color, null);
  assert.equal(p.createdAt, '2026-09-09T00:00:00.000Z');
  assert.deepEqual(p.resources.targets, ['t1']);
});

test('CRUD: validation, uniqueness, last-project guard, 404s', async () => {
  const { dir, store } = mk();
  await assert.rejects(store.create({}), (e) => e.status === 400 && /name is required/.test(e.message));
  await assert.rejects(store.create({ name: '   ' }), /name is required/);
  await assert.rejects(store.create({ name: 'x'.repeat(81) }), /too long/);
  await assert.rejects(store.create({ name: 'general' }), (e) => e.status === 409, 'names are unique case-insensitively');
  await assert.rejects(store.create({ name: 'Ok', color: 'blue' }), /#rrggbb/);
  await assert.rejects(store.create({ name: 'Ok', id: 'has space' }), /invalid characters/);
  await assert.rejects(store.create({ name: 'Ok', id: 'general' }), (e) => e.status === 409);
  const shop = await store.create({ name: ' Shop ', description: 'Store', color: '#ABCDEF' });
  assert.equal(shop.name, 'Shop'); assert.equal(shop.color, '#ABCDEF'); assert.match(shop.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(shop.resources, Object.fromEntries(RESOURCE_KINDS.map((k) => [k, []])));
  const before = shop.updatedAt;
  await new Promise((r) => setTimeout(r, 5));
  const upd = await store.update(shop.id, { description: 'Web store', color: null });
  assert.equal(upd.name, 'Shop'); assert.equal(upd.description, 'Web store'); assert.equal(upd.color, null);
  assert.notEqual(upd.updatedAt, before);
  await assert.rejects(store.update(shop.id, { name: 'GENERAL' }), (e) => e.status === 409);
  await assert.rejects(store.update('nope', { name: 'x' }), (e) => e.status === 404);
  await assert.rejects(store.remove('nope'), (e) => e.status === 404);
  const removed = await store.remove(DEFAULT_PROJECT.id);
  assert.equal(removed.name, 'General', 'the default project is not special once another exists');
  await assert.rejects(store.remove(shop.id), /last project cannot be deleted/);
  const doc = readJson(dir);
  assert.equal(doc.projects.length, 1); assert.equal(doc.projects[0].name, 'Shop'); assert.equal(doc.projects[0].description, 'Web store');
});

test('link/unlink: kind + id validation, idempotent, lookups, unlinkEverywhere; only ids are stored', async () => {
  const { dir, store } = mk();
  const shop = await store.create({ name: 'Shop' });
  await assert.rejects(store.link(shop.id, 'passwords', 'x'), (e) => e.status === 400 && /kind must be one of/.test(e.message));
  await assert.rejects(store.link(shop.id, 'repos', ''), /resourceId is required/);
  await assert.rejects(store.link(shop.id, 'repos', { id: 'r1', password: 'hunter2' }), /resourceId is required/, 'objects are refused: a link is an id');
  await assert.rejects(store.link('nope', 'repos', 'r1'), (e) => e.status === 404);
  await store.link(shop.id, 'repos', 'r1');
  await store.link(shop.id, 'repos', 'r1');
  await store.link(shop.id, 'targets', 't1');
  await store.link(shop.id, 'connections', 'c1');
  await store.link(shop.id, 'servers', 's1');
  await store.link(shop.id, 'connectors', 'k1');
  await store.link(DEFAULT_PROJECT.id, 'repos', 'r1');
  assert.deepEqual(store.get(shop.id).resources.repos, ['r1'], 'linking twice stores one id');
  assert.deepEqual(store.projectsFor('repos', 'r1').map((p) => p.name).sort(), ['General', 'Shop']);
  assert.deepEqual(store.projectsFor('repos', 'r9'), []);
  assert.throws(() => store.projectsFor('nope', 'r1'), /kind must be one of/);
  // unlink is idempotent
  await store.unlink(shop.id, 'targets', 't1');
  const p = await store.unlink(shop.id, 'targets', 't1');
  assert.deepEqual(p.resources.targets, []);
  await assert.rejects(store.unlink('nope', 'targets', 't1'), (e) => e.status === 404);
  // remove from every project
  assert.equal(await store.unlinkEverywhere('repos', 'r1'), 2);
  assert.equal(await store.unlinkEverywhere('repos', 'r1'), 0);
  assert.deepEqual(store.projectsFor('repos', 'r1'), []);
  // persisted shape: arrays of id strings only
  const doc = readJson(dir);
  const saved = doc.projects.find((x) => x.id === shop.id);
  assert.deepEqual(saved.resources, { connections: ['c1'], servers: ['s1'], connectors: ['k1'], repos: [], targets: [] });
  for (const ids of Object.values(saved.resources)) for (const id of ids) assert.equal(typeof id, 'string');
  assert.ok(!JSON.stringify(doc).includes('hunter2'));
});

test('persistence: concurrent writes serialize, reload sees the same data, no temp files remain', async () => {
  const { dir, store } = mk();
  const created = await Promise.all(['A', 'B', 'C', 'D', 'E'].map((n) => store.create({ name: n })));
  await Promise.all(created.map((p, i) => store.link(p.id, 'targets', `t${i}`)));
  await store.save();
  assert.deepEqual(files(dir), [FILE_NAME], 'no .tmp left behind');
  const again = createProjectStore(dir);
  assert.equal(again.seeded, false);
  assert.deepEqual(again.list().map((p) => p.name), ['General', 'A', 'B', 'C', 'D', 'E']);
  for (let i = 0; i < 5; i++) assert.deepEqual(again.get(created[i].id).resources.targets, [`t${i}`]);
  assert.deepEqual(readJson(dir), JSON.parse(JSON.stringify({ version: VERSION, projects: again.list() })));
});

test('a failed write surfaces to the caller and does not poison later saves', async () => {
  const { dir, store, logs } = mk();
  const p = await store.create({ name: 'Shop' });
  // make the rename fail by turning the target path into a directory
  fs.rmSync(store.file); fs.mkdirSync(store.file);
  await assert.rejects(store.link(p.id, 'repos', 'r1'));
  assert.ok(logs.some(([l]) => l === 'error'));
  fs.rmSync(store.file, { recursive: true, force: true }); try { fs.rmSync(store.file + '.tmp'); } catch {}
  await store.link(p.id, 'repos', 'r2');
  assert.deepEqual(readJson(dir).projects.find((x) => x.id === p.id).resources.repos, ['r1', 'r2'], 'in-memory state was kept and is on disk after the next successful save');
});
