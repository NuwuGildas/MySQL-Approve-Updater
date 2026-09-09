'use strict';
/* Per-project chat store: legacy import (agent-chat.json → General, once, with backup), project
   isolation, reset, backward compatibility (no projectId → General), atomic persistence, versioning.
   Each test gets its own temp DATA_DIR (same pattern as store.test.js). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createChatStore, migrate, normalizeMessages, FILE_NAME, LEGACY_FILE_NAME, VERSION, DEFAULT_PROJECT_ID, MAX_MESSAGES } = require('../../lib/projects/chat');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'st-chat-'));
const readJson = (dir, name = FILE_NAME) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
const files = (dir) => fs.readdirSync(dir).sort();
const mk = (dir = tmpDir(), opts = {}) => { const logs = []; const store = createChatStore(dir, { log: (l, m) => logs.push([l, m]), ...opts }); return { dir, store, logs }; };
const msg = (role, text) => ({ role, text, ts: '2026-09-09T00:00:00.000Z' });

/* ---------- migration of the legacy single conversation ---------- */

test('legacy agent-chat.json is imported once into General, then renamed to a .bak', () => {
  const dir = tmpDir();
  const legacy = [msg('user', 'hello'), msg('assistant', 'hi'), msg('note', 'a note')];
  fs.writeFileSync(path.join(dir, LEGACY_FILE_NAME), JSON.stringify(legacy));
  const { store, logs } = mk(dir);
  assert.equal(store.readOnly, null);
  assert.deepEqual(store.importedLegacy, { count: 3, backup: `${LEGACY_FILE_NAME}.bak` });
  assert.deepEqual(store.get(DEFAULT_PROJECT_ID), legacy);
  assert.deepEqual(store.get(), legacy, 'no project id → General');
  const doc = readJson(dir);
  assert.equal(doc.version, VERSION);
  assert.deepEqual(doc.chats[DEFAULT_PROJECT_ID].messages, legacy);
  assert.deepEqual(files(dir), [`${LEGACY_FILE_NAME}.bak`, FILE_NAME], 'legacy file renamed, no .tmp left behind');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, `${LEGACY_FILE_NAME}.bak`), 'utf8')), legacy, 'backup holds the original bytes');
  assert.ok(logs.some(([l, m]) => l === 'info' && /Imported 3 message/.test(m)));

  // second start: nothing to import, the history is simply loaded
  const second = mk(dir);
  assert.equal(second.store.importedLegacy, null);
  assert.deepEqual(second.store.get(), legacy);
  assert.deepEqual(files(dir), [`${LEGACY_FILE_NAME}.bak`, FILE_NAME]);
});

test('legacy import drops malformed entries and caps at MAX_MESSAGES', () => {
  const dir = tmpDir();
  const legacy = [];
  for (let i = 0; i < MAX_MESSAGES + 25; i++) legacy.push(msg('user', `m${i}`));
  legacy.splice(5, 0, null, 'junk', { text: 'no role' }, { role: 'system', text: 'unknown role' });
  fs.writeFileSync(path.join(dir, LEGACY_FILE_NAME), JSON.stringify(legacy));
  const { store } = mk(dir);
  const got = store.get();
  assert.equal(got.length, MAX_MESSAGES);
  assert.equal(got[got.length - 1].text, `m${MAX_MESSAGES + 24}`, 'newest messages are kept');
  assert.ok(got.every((m) => ['user', 'assistant', 'note'].includes(m.role)));
});

test('an existing project-chats.json wins over a leftover agent-chat.json (import never runs twice)', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, FILE_NAME), JSON.stringify({ version: VERSION, chats: { general: { messages: [msg('user', 'new world')], updatedAt: 'x' } } }));
  fs.writeFileSync(path.join(dir, LEGACY_FILE_NAME), JSON.stringify([msg('user', 'old world')]));
  const { store } = mk(dir);
  assert.equal(store.importedLegacy, null);
  assert.deepEqual(store.get().map((m) => m.text), ['new world']);
  assert.deepEqual(files(dir), [LEGACY_FILE_NAME, FILE_NAME], 'legacy file left untouched');
});

test('unreadable legacy file: start empty, leave it alone, stay writable', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, LEGACY_FILE_NAME), '{not json');
  const { store, logs } = mk(dir);
  assert.equal(store.readOnly, null);
  assert.equal(store.importedLegacy, null);
  assert.deepEqual(store.get(), []);
  assert.ok(logs.some(([l, m]) => l === 'warn' && m.includes(LEGACY_FILE_NAME)));
  store.push(undefined, msg('user', 'x'));
  await store.flush();
  assert.deepEqual(files(dir), [LEGACY_FILE_NAME, FILE_NAME]);
});

test('no files at all: starts empty and creates the file on first write only', async () => {
  const { dir, store } = mk();
  assert.deepEqual(files(dir), [], 'nothing written at start');
  assert.deepEqual(store.get('general'), []);
  store.push('general', msg('user', 'first'));
  await store.flush();
  assert.deepEqual(files(dir), [FILE_NAME]);
  assert.equal(readJson(dir).chats.general.messages.length, 1);
});

/* ---------- versioned document handling ---------- */

test('migrate(): bare array (v0) lands in General; unknown/malformed buckets are dropped; newer version throws', () => {
  const m0 = migrate([msg('user', 'a')]);
  assert.equal(m0.from, 0);
  assert.equal(m0.data.version, VERSION);
  assert.deepEqual(m0.data.chats.general.messages, [msg('user', 'a')]);

  const m1 = migrate({ version: 1, chats: { alpha: [msg('user', 'array form')], 'bad id!': { messages: [] }, beta: { messages: 'nope', extra: 1 } } });
  assert.equal(m1.from, 1);
  assert.deepEqual(Object.keys(m1.data.chats).sort(), ['alpha', 'beta']);
  assert.deepEqual(m1.data.chats.alpha.messages, [msg('user', 'array form')]);
  assert.deepEqual(m1.data.chats.beta.messages, []);
  assert.equal(m1.data.chats.beta.extra, 1, 'unknown fields survive');

  assert.throws(() => migrate({ version: VERSION + 1, chats: {} }), /version 2/);
});

test('older document version: migrated at start with a .bak of the original', () => {
  const dir = tmpDir();
  const original = JSON.stringify({ version: 0, chats: { general: [msg('user', 'old shape')] } });
  fs.writeFileSync(path.join(dir, FILE_NAME), original);
  const { store } = mk(dir);
  assert.equal(store.migratedFrom, 0);
  assert.deepEqual(store.get().map((m) => m.text), ['old shape']);
  assert.equal(readJson(dir).version, VERSION);
  assert.deepEqual(files(dir), [FILE_NAME, `${FILE_NAME}.v0.bak`]);
  assert.equal(fs.readFileSync(path.join(dir, `${FILE_NAME}.v0.bak`), 'utf8'), original);
});

test('newer or corrupt file: read-only, bytes never touched, chat still works in memory', async () => {
  for (const content of [JSON.stringify({ version: VERSION + 5, chats: {} }), '{corrupt']) {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, FILE_NAME), content);
    const { store, logs } = mk(dir);
    assert.ok(store.readOnly, 'read-only reason set');
    assert.ok(logs.some(([l]) => l === 'warn'));
    store.push('general', msg('user', 'in memory only'));
    store.reset('general');
    store.push('general', msg('user', 'again'));
    await store.flush();
    assert.deepEqual(store.get('general').map((m) => m.text), ['again']);
    assert.equal(fs.readFileSync(path.join(dir, FILE_NAME), 'utf8'), content, 'file untouched');
    assert.deepEqual(files(dir), [FILE_NAME], 'no .tmp, no .bak');
  }
});

/* ---------- isolation between projects ---------- */

test('projects have isolated conversations and both survive a restart', async () => {
  const { dir, store } = mk();
  store.push('general', msg('user', 'g1'));
  store.push('alpha', msg('user', 'a1'));
  store.push('alpha', msg('assistant', 'a2'));
  store.push('shop:eu', msg('note', 'ids with a colon are fine in one file'));
  assert.deepEqual(store.get('general').map((m) => m.text), ['g1']);
  assert.deepEqual(store.get('alpha').map((m) => m.text), ['a1', 'a2']);
  assert.deepEqual(store.get('shop:eu').length, 1);
  assert.deepEqual(store.get('unknown'), [], 'unknown project → empty, nothing created');
  assert.deepEqual(store.projectIds().sort(), ['alpha', 'general', 'shop:eu']);
  await store.flush();

  const again = mk(dir).store;
  assert.deepEqual(again.get('general').map((m) => m.text), ['g1']);
  assert.deepEqual(again.get('alpha').map((m) => m.text), ['a1', 'a2']);
  assert.equal(again.get('shop:eu')[0].role, 'note');
});

test('get() returns the live array, so a tail slice sees pushes (server builds prompts from it)', () => {
  const { store } = mk();
  const live = store.get('general');
  assert.deepEqual(live, []);
  store.push('general', msg('user', 'x'));
  assert.equal(store.get('general').length, 1);
  assert.equal(store.get('general'), store.get('general'), 'same reference across calls');
});

test('per-project cap: trimming one project never touches another', () => {
  const { store } = mk(undefined, { maxMessages: 3 });
  for (let i = 0; i < 5; i++) store.push('alpha', msg('user', `a${i}`));
  store.push('beta', msg('user', 'b0'));
  assert.deepEqual(store.get('alpha').map((m) => m.text), ['a2', 'a3', 'a4']);
  assert.deepEqual(store.get('beta').map((m) => m.text), ['b0']);
});

/* ---------- reset ---------- */

test('reset(projectId) clears only that project; resetAll clears everything; both persist', async () => {
  const { dir, store } = mk();
  store.push('general', msg('user', 'g'));
  store.push('alpha', msg('user', 'a'));
  assert.equal(store.reset('alpha'), true);
  assert.equal(store.reset('alpha'), false, 'second reset is a no-op');
  assert.deepEqual(store.get('alpha'), []);
  assert.deepEqual(store.get('general').map((m) => m.text), ['g']);
  await store.flush();
  assert.deepEqual(Object.keys(readJson(dir).chats), ['general']);

  assert.equal(store.reset(), true, 'no id → General');
  assert.deepEqual(store.get(), []);
  await store.flush();
  assert.deepEqual(readJson(dir).chats, {});

  store.push('a', msg('user', '1')); store.push('b', msg('user', '2'));
  assert.equal(store.resetAll(), 2);
  assert.deepEqual(store.projectIds(), []);
  await store.flush();
  assert.deepEqual(readJson(dir).chats, {});
});

/* ---------- backward compatibility / input validation ---------- */

test('resolveProjectId: missing, null, empty or blank → General; malformed → 400; valid ids pass', () => {
  const { store } = mk();
  for (const raw of [undefined, null, '', '   ']) assert.equal(store.resolveProjectId(raw), DEFAULT_PROJECT_ID);
  assert.equal(store.resolveProjectId(' alpha '), 'alpha');
  assert.equal(store.resolveProjectId('shop:eu.v2@x-1'), 'shop:eu.v2@x-1');
  for (const bad of ['../etc', 'has space', '-leading', 'x'.repeat(200), '{}']) {
    assert.throws(() => store.resolveProjectId(bad), (e) => e.status === 400);
  }
  assert.throws(() => store.push('general', { text: 'no role' }), (e) => e.status === 400);
});

test('custom default project id is honoured for legacy import and lookups', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, LEGACY_FILE_NAME), JSON.stringify([msg('user', 'x')]));
  const { store } = mk(dir, { defaultProjectId: 'home' });
  assert.equal(store.DEFAULT_PROJECT_ID, 'home');
  assert.deepEqual(store.get().map((m) => m.text), ['x']);
  assert.deepEqual(store.get('home').map((m) => m.text), ['x']);
  assert.deepEqual(store.get('general'), []);
});

/* ---------- atomic persistence ---------- */

test('writes are serialized and atomic: the last snapshot wins, no .tmp remains', async () => {
  const { dir, store } = mk();
  for (let i = 0; i < 50; i++) store.push(i % 2 ? 'alpha' : 'general', msg('user', `m${i}`));
  await store.flush();
  const doc = readJson(dir);
  assert.equal(doc.chats.general.messages.length, 25);
  assert.equal(doc.chats.alpha.messages.length, 25);
  assert.deepEqual(files(dir), [FILE_NAME]);
});

test('normalizeMessages keeps unknown fields and drops junk', () => {
  const out = normalizeMessages([{ role: 'assistant', text: 'a', actions: [{ tool: 't' }] }, 5, { role: 'x' }]);
  assert.deepEqual(out, [{ role: 'assistant', text: 'a', actions: [{ tool: 't' }] }]);
});
