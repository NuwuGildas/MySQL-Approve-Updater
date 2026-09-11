'use strict';
/* What the assistant is allowed to see.
 *
 * The assistant always works inside a project, and a resource attached to a
 * project exists only there. Two pieces decide that: which project a
 * conversation belongs to, and what that project can see. They are tested
 * together here because the composition is what a tool actually does - the
 * store's own rule has its own tests in test/projects/store.test.js. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProjectStore, DEFAULT_PROJECT } = require('../lib/projects');
const { projectOfConversation, conversationOfProject, isProjectConversation } = require('../lib/shared/conversation-project');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-scope-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return createProjectStore(dir);
}

test('a conversation belongs to a project: its own, its session\'s, or the default', () => {
  const sessions = { 'session-web': 'proj-site', 'session-loose': null };
  const resolve = (convoId) => projectOfConversation(convoId, {
    sessionProject: (id) => { if (!(id in sessions)) throw Object.assign(new Error('not found'), { status: 404 }); return sessions[id]; },
    defaultProjectId: DEFAULT_PROJECT.id,
  });

  assert.equal(resolve(conversationOfProject('proj-site')), 'proj-site');
  assert.equal(isProjectConversation(conversationOfProject('proj-site')), true);
  assert.equal(resolve('session-web'), 'proj-site', 'a terminal inherits the project it was opened from');
  assert.equal(resolve('session-loose'), DEFAULT_PROJECT.id, 'a session with no project is the default one');
  assert.equal(resolve('session-gone'), DEFAULT_PROJECT.id, 'a session whose module is gone is not an error');
  assert.equal(resolve(''), DEFAULT_PROJECT.id);
  assert.equal(resolve(null), DEFAULT_PROJECT.id);
  assert.equal(resolve(conversationOfProject('')), DEFAULT_PROJECT.id);
  assert.equal(isProjectConversation('session-web'), false);
});

test('a tool sees exactly what the conversation\'s project sees', async (t) => {
  const store = fixture(t);
  const site = await store.create({ name: 'Website' });
  const other = await store.create({ name: 'API' });
  await store.link(site.id, 'connections', 'db-site');
  await store.link(site.id, 'servers', 'srv-site');
  await store.link(other.id, 'servers', 'srv-api');

  /* Exactly what server.js does for list_servers: resolve the conversation's
     project, then filter the profiles through that project's scope. */
  const profiles = [
    { id: 'db-site', name: 'site db', sshOnly: false },
    { id: 'db-free', name: 'spare db', sshOnly: false },
    { id: 'srv-site', name: 'site box', sshOnly: true },
    { id: 'srv-api', name: 'api box', sshOnly: true },
    { id: 'srv-free', name: 'spare box', sshOnly: true },
  ];
  const kindOf = (p) => (p.sshOnly ? 'servers' : 'connections');
  const sessions = { 'session-on-site-box': site.id };
  const visibleTo = (convoId) => {
    const projectId = projectOfConversation(convoId, { sessionProject: (id) => sessions[id] || null, defaultProjectId: DEFAULT_PROJECT.id });
    const scope = store.scopeFor(store.get(projectId) ? projectId : DEFAULT_PROJECT.id);
    return profiles.filter((p) => scope.visible(kindOf(p), p.id)).map((p) => p.name).sort();
  };

  assert.deepEqual(visibleTo(conversationOfProject(site.id)), ['site box', 'site db', 'spare box', 'spare db']);
  assert.deepEqual(visibleTo(conversationOfProject(other.id)), ['api box', 'spare box', 'spare db']);
  assert.deepEqual(visibleTo(conversationOfProject(DEFAULT_PROJECT.id)), ['spare box', 'spare db']);

  /* Talking to the assistant inside a terminal does not widen what it can see. */
  assert.deepEqual(visibleTo('session-on-site-box'), ['site box', 'site db', 'spare box', 'spare db']);

  /* A conversation naming a project that no longer exists falls back to the
     default, which is not a way to see everything. */
  assert.deepEqual(visibleTo(conversationOfProject('deleted-project')), ['spare box', 'spare db']);

  /* Detaching returns the resource to every project. */
  await store.unlink(site.id, 'servers', 'srv-site');
  assert.deepEqual(visibleTo(conversationOfProject(other.id)), ['api box', 'site box', 'spare box', 'spare db']);
});
