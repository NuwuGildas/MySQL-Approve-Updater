'use strict';
/* Conversations a module opened for one of its sessions.
 *
 * This store is the HOST's, not a module's, and that is the whole point: the
 * transcript, the notes and the command history are the user's data, so they
 * survive the module that created them being removed. What a module controls is
 * only whether a session can still be worked IN. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionConversations, FILE_NAME } = require('../lib/shared/session-conversations');

function fixture(t, { file } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-conversations-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (file !== undefined) fs.writeFileSync(path.join(dir, FILE_NAME), file);
  const proposals = [];
  const store = createSessionConversations({ dataDir: dir, proposals: () => proposals });
  /** What a module publishes about the sessions it owns. */
  const own = (...ids) => store.setSessionView({ snapshot: (id) => (ids.includes(id) ? { terminal: { sessionId: id, status: 'open', control: 'user', revision: 0 } } : null) });
  return { dir, store, proposals, own };
}

test('a session conversation is readable with no module installed, and workable only with one', async (t) => {
  const { store, own } = fixture(t);
  store.create('session-1', { profileId: 'p1', name: 'STAGING' });
  store.push('session-1', { role: 'user', text: 'what is eating the disk?' });

  /* Nothing owns it yet: readable, not workable. */
  assert.equal(store.history('session-1').at(-1).text, 'what is eating the disk?');
  assert.equal(store.status('session-1').attached, false);
  assert.equal(store.status('session-1').owned, false);
  assert.throws(() => store.requireSession('session-1'), /not installed/);

  /* A module claims it. */
  own('session-1');
  assert.equal(store.status('session-1').attached, true);
  assert.equal(store.requireSession('session-1').sessionId, 'session-1');

  /* The module is removed: the conversation is untouched, the session is not workable. */
  store.setSessionView(null);
  assert.equal(store.history('session-1').at(-1).text, 'what is eating the disk?');
  assert.throws(() => store.requireSession('session-1'), /not installed/);
  assert.equal(store.status('session-1').terminal.status, 'closed');
});

test('a session the owning module reports as unusable says why', async (t) => {
  const { store } = fixture(t);
  store.create('session-1', { profileId: 'p1' });
  store.setSessionView({ snapshot: () => ({ terminal: { sessionId: 'session-1', status: 'closed' }, unusable: 'This terminal session has ended.' }) });
  assert.throws(() => store.requireSession('session-1'), /has ended/);
  assert.equal(store.status('session-1').attached, false);
  assert.equal(store.history('session-1').length, 0, 'and it is still a readable, empty conversation');
});

test('conversations, notes and command memory stay separate and bounded', async (t) => {
  const { store, own } = fixture(t);
  store.create('a', { profileId: 'p1', name: 'STAGING' });
  store.create('b', { profileId: 'p1', name: 'STAGING' });
  own('a', 'b');

  store.push('a', { role: 'user', text: 'for a only' });
  store.push('b', { role: 'user', text: 'for b only' });
  assert.equal(store.history('a').some((m) => m.text === 'for b only'), false);
  assert.equal(store.history('b').some((m) => m.text === 'for a only'), false);

  for (let i = 0; i < 250; i++) store.push('a', { role: 'user', text: `line ${i}` });
  assert.equal(store.history('a').length, 200, 'a conversation cannot grow without limit');
  assert.equal(store.history('a').at(-1).text, 'line 249', 'and it keeps the most recent end');

  for (let i = 0; i < 80; i++) store.remember('a', { text: `note ${i}` });
  for (let i = 0; i < 60; i++) store.rememberCommand('a', { cmd: `cmd ${i}`, ok: true });
  const digest = store.digest('a', { notes: 100, commands: 100 });
  assert.equal(digest.notes.length, 60);
  assert.equal(digest.commands.length, 40);

  /* Listing what a server holds never carries the words. */
  const listed = store.listForProfile('p1');
  assert.equal(listed.length, 2);
  assert.equal(JSON.stringify(listed).includes('for a only'), false);
  assert.equal(JSON.stringify(listed).includes('note 1'), false);
});

test('resetting one conversation clears it alone, and rejects its pending cards', async (t) => {
  const { store, proposals, own } = fixture(t);
  store.create('a', { profileId: 'p1' });
  store.create('b', { profileId: 'p1' });
  own('a', 'b');
  store.push('a', { role: 'user', text: 'first' });
  store.push('b', { role: 'user', text: 'second' });
  store.remember('a', { text: 'remembered' });
  proposals.push({ id: 'p1', sessionId: 'a', status: 'pending' }, { id: 'p2', sessionId: 'b', status: 'pending' });

  store.reset('a');
  assert.deepEqual(store.history('a'), []);
  assert.deepEqual(store.digest('a').notes, []);
  assert.equal(store.history('b').at(-1).text, 'second');
  assert.equal(proposals[0].status, 'rejected', 'a card in the cleared conversation cannot still be approved');
  assert.equal(proposals[1].status, 'pending');
});

test('what is stored survives a restart, and an unreadable file is never overwritten', async (t) => {
  const { dir, store } = fixture(t);
  store.create('session-1', { profileId: 'p1', name: 'STAGING' });
  store.push('session-1', { role: 'assistant', text: 'kept across restarts' });
  await store.flush();

  const reopened = createSessionConversations({ dataDir: dir });
  assert.equal(reopened.history('session-1').at(-1).text, 'kept across restarts');

  const broken = '{ not json';
  const { store: refused, dir: brokenDir } = fixture(t, { file: broken });
  assert.match(refused.readOnly, /cannot be read/);
  assert.throws(() => refused.create('x', {}), /cannot be read/);
  assert.equal(fs.readFileSync(path.join(brokenDir, FILE_NAME), 'utf8'), broken, 'the file is left exactly as it was');
});

test('only a real conversation message is accepted, and an unknown session is a 404', async (t) => {
  const { store } = fixture(t);
  store.create('session-1', { profileId: 'p1' });
  assert.throws(() => store.push('session-1', { role: 'root', text: 'nope' }), /Invalid chat message role/);
  assert.throws(() => store.session('does-not-exist'), (error) => error.status === 404);
  assert.throws(() => store.create('session-1', {}), (error) => error.status === 409);
  assert.throws(() => store.create('not a valid id!', {}), (error) => error.status === 400);
  assert.deepEqual(store.status(null), { attached: false, sessionId: null });
  assert.equal(store.status('does-not-exist').missing, true);
});
