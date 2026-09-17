'use strict';
/* Projects management. The project store belongs to the HOST - the assistant
   needs a project to hang a conversation on whether or not this module is
   installed - so what is tested here is only the management layer: it routes,
   it validates, and it keeps no copy of anything. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { activate } = require('../backend/index');

/** A host holding the project store this module manages but does not own. */
function createTestHost({ projects = [] } = {}) {
  const calls = [];
  const events = [];
  const store = new Map(projects.map((p) => [p.id, { description: '', color: null, resources: {}, ...p }]));
  const ids = (project, kind) => (project.resources[kind] ||= []);
  let counter = 0;
  const fail = (status, message) => Object.assign(new Error(message), { status });
  const need = (id) => { const p = store.get(id); if (!p) throw fail(404, 'project not found'); return p; };

  return {
    calls, events, store,
    host: {
      id: 'projects',
      version: '1.0.0',
      log() {},
      emit: (event, payload) => events.push({ event, payload }),
      // the worker host API routes audit() through the host service, and so does this
      audit(entry) { return this.call('audit.record', entry); },
      async call(method, params = {}) {
        calls.push({ method, params });
        switch (method) {
          case 'projects.list': return [...store.values()];
          case 'projects.create': {
            const project = { id: `project-${++counter}`, name: params.name, description: params.description ?? '', color: params.color ?? null, resources: {} };
            store.set(project.id, project);
            return project;
          }
          case 'projects.update': {
            const project = need(params.id);
            return Object.assign(project, { name: params.name ?? project.name, description: params.description ?? project.description, color: params.color ?? project.color });
          }
          case 'projects.remove': { need(params.id); store.delete(params.id); return { ok: true }; }
          case 'projects.link': {
            const project = need(params.id);
            if (!ids(project, params.kind).includes(params.resourceId)) ids(project, params.kind).push(params.resourceId);
            return project;
          }
          case 'projects.unlink': {
            const project = need(params.id);
            project.resources[params.kind] = ids(project, params.kind).filter((id) => id !== params.resourceId);
            return project;
          }
          case 'projects.resourcesFor':
            return [...store.values()].filter((p) => (p.resources[params.kind] || []).includes(params.resourceId));
          /* The host records what the assistant proposes and what approving it did; the module
             only asks for both, so the double just remembers that it was asked. */
          case 'audit.record': return true;
          case 'assistant.propose': return { ...params, status: 'pending' };
          default: throw new Error(`the module made an undeclared host call: ${method}`);
        }
      },
    },
  };
}

async function setup(t, options) {
  const fixture = createTestHost(options);
  const instance = await activate(fixture.host);
  t.after(() => instance.deactivate());
  return { ...fixture, instance, api: instance.methods };
}

test('saving creates or updates, depending on whether an id came with it', async (t) => {
  const ctx = await setup(t);

  const created = await ctx.api.save({ name: 'Website', description: 'the public site', color: '#3b82f6' });
  assert.equal(ctx.calls.at(-1).method, 'projects.create');
  assert.equal(created.name, 'Website');

  const renamed = await ctx.api.save({ id: created.id, name: 'Public website', description: 'the public site' });
  assert.equal(ctx.calls.at(-1).method, 'projects.update');
  assert.equal(ctx.calls.at(-1).params.id, created.id);
  assert.equal(renamed.id, created.id, 'renaming does not make a second project');
  assert.deepEqual((await ctx.api.list()).map((p) => p.name), ['Public website']);

  await assert.rejects(ctx.api.save({ id: 'gone', name: 'Ghost' }), (error) => error.status === 404);
});

test('linking stores an id and nothing else, and is idempotent', async (t) => {
  const ctx = await setup(t, { projects: [{ id: 'p1', name: 'Website' }] });

  const linked = await ctx.api.link({ id: 'p1', kind: 'server', resourceId: 'profile-7' });
  assert.deepEqual(linked.resources.server, ['profile-7'], 'an id, and nothing else about the resource');
  assert.equal(JSON.stringify(linked).includes('profile-7'), true);

  await ctx.api.link({ id: 'p1', kind: 'server', resourceId: 'profile-7' });
  assert.equal(ctx.store.get('p1').resources.server.length, 1, 'linking the same resource twice is not two links');

  assert.deepEqual(await ctx.api.forResource({ kind: 'server', resourceId: 'profile-7' }), [ctx.store.get('p1')]);
  assert.deepEqual(await ctx.api.forResource({ kind: 'server', resourceId: 'profile-9' }), []);

  const unlinked = await ctx.api.unlink({ id: 'p1', kind: 'server', resourceId: 'profile-7' });
  assert.deepEqual(unlinked.resources.server, []);
  assert.equal(ctx.events.filter((e) => e.event === 'changed').length, 3, 'the page is told to refresh after each change');
});

test('an incomplete request is refused before it reaches the store', async (t) => {
  const ctx = await setup(t, { projects: [{ id: 'p1', name: 'Website' }] });
  const before = ctx.calls.length;

  await assert.rejects(ctx.api.remove({}), /project id is required/);
  for (const body of [{ kind: 'server', resourceId: 'x' }, { id: 'p1', resourceId: 'x' }, { id: 'p1', kind: 'server' }]) {
    await assert.rejects(ctx.api.link(body), /id, kind and resourceId are required/);
    await assert.rejects(ctx.api.unlink(body), /id, kind and resourceId are required/);
  }
  assert.equal(ctx.calls.length, before, 'nothing was written on the way to the refusal');
});

test('removing a project removes it once, and says so', async (t) => {
  const ctx = await setup(t, { projects: [{ id: 'p1', name: 'Website' }, { id: 'p2', name: 'API' }] });

  assert.deepEqual(await ctx.api.remove({ id: 'p1' }), { ok: true });
  assert.deepEqual((await ctx.api.list()).map((p) => p.id), ['p2']);
  assert.equal(ctx.events.at(-1).payload.removed, 'p1');
  await assert.rejects(ctx.api.remove({ id: 'p1' }), (error) => error.status === 404);
});

test('the assistant can list projects while this module is installed, and removal never blocks', async (t) => {
  const ctx = await setup(t, { projects: [{ id: 'p1', name: 'Website' }] });
  const tool = ctx.instance.assistantTools.list_projects;

  assert.match(tool.description, /Read-only/);
  assert.deepEqual((await tool.run()).projects.map((p) => p.name), ['Website']);

  assert.equal(ctx.instance.busy(), false);
  await ctx.instance.deactivate();
  assert.equal(ctx.store.size, 1, 'and the projects themselves are the host\'s: they outlive this module');
});

/* ------------------------------------- what the assistant may do with projects */

/* Reading is direct; every change is a card the user approves. These check both halves: the tool
   refuses what it can see is wrong BEFORE raising a card, and approving re-checks it. */

const proposalsOf = (h) => h.calls.filter((c) => c.method === 'assistant.propose').map((c) => c.params);

test('the assistant can see which projects hold a resource, and whether it is shared', async (t) => {
  const { instance, ...host } = await setup(t, { projects: [{ id: 'p1', name: 'Acme' }, { id: 'p2', name: 'Beta' }] });
  await instance.methods.link({ id: 'p1', kind: 'servers', resourceId: 's1' });

  const owned = await instance.assistantTools.project_for_resource.run({ kind: 'servers', resourceId: 's1' });
  assert.deepEqual(owned.projects, [{ id: 'p1', name: 'Acme' }]);
  assert.equal(owned.shared, false);

  const free = await instance.assistantTools.project_for_resource.run({ kind: 'servers', resourceId: 's9' });
  assert.deepEqual(free.projects, []);
  assert.equal(free.shared, true, 'a resource in no project is visible to every project');

  await assert.rejects(() => instance.assistantTools.project_for_resource.run({ kind: 'nonsense', resourceId: 's1' }), /kind must be one of/);
  await assert.rejects(() => instance.assistantTools.project_for_resource.run({ kind: 'servers' }), /resourceId is required/);
  assert.equal(proposalsOf(host).length, 0, 'reading proposes nothing');
});

test('every change is proposed, never done, and the card says what it would do', async (t) => {
  const { instance, ...host } = await setup(t, { projects: [{ id: 'p1', name: 'Acme' }, { id: 'p2', name: 'Beta' }] });
  const propose = (input) => instance.assistantTools.propose_project_change.run(input);

  const created = await propose({ action: 'create', name: 'Gamma', reason: 'to group the new client' });
  assert.equal(created.status, 'pending_user_approval');
  assert.match(created.note, /Nothing has changed/);
  assert.equal(host.store.size, 2, 'and nothing was created');

  const [card] = proposalsOf(host);
  assert.equal(card.kind, 'project-change');
  assert.equal(card.change, 'create');
  assert.equal(card.name, 'Gamma');
  assert.equal(card.reason, 'to group the new client');
  assert.equal(instance.proposalKinds['project-change'].label(card), 'proposal to create the project "Gamma"');
});

test('a proposal the workspace would refuse is refused before the user is asked', async (t) => {
  const { instance, ...host } = await setup(t, { projects: [{ id: 'p1', name: 'Acme', resources: { servers: ['s1'] } }] });
  const propose = (input) => instance.assistantTools.propose_project_change.run(input);

  await assert.rejects(() => propose({ action: 'explode' }), /action must be one of/);
  await assert.rejects(() => propose({ action: 'create' }), /a name is required/);
  await assert.rejects(() => propose({ action: 'create', name: 'acme' }), /already exists/);
  await assert.rejects(() => propose({ action: 'rename', id: 'gone', name: 'x' }), /no project with id "gone"/);
  await assert.rejects(() => propose({ action: 'rename', id: 'p1' }), /a new name is required/);
  await assert.rejects(() => propose({ action: 'rename', id: 'p1', name: 'Acme' }), /already called that/);
  await assert.rejects(() => propose({ action: 'delete' }), /a project id is required/);
  await assert.rejects(() => propose({ action: 'attach', id: 'p1', kind: 'servers' }), /resourceId is required/);
  await assert.rejects(() => propose({ action: 'attach', id: 'p1', kind: 'servers', resourceId: 's1' }), /already in "Acme"/);
  await assert.rejects(() => propose({ action: 'detach', id: 'p1', kind: 'servers', resourceId: 's9' }), /not in "Acme"/);
  assert.equal(proposalsOf(host).length, 0, 'not one card was raised for any of them');
});

test('approving a create, a rename and a delete does exactly that, and says so', async (t) => {
  const { instance, ...host } = await setup(t, { projects: [{ id: 'p1', name: 'Acme' }, { id: 'p2', name: 'Beta' }] });
  const kind = instance.proposalKinds['project-change'];
  const propose = (input) => instance.assistantTools.propose_project_change.run(input);

  await propose({ action: 'create', name: 'Gamma', description: 'new client' });
  const created = await kind.approve(proposalsOf(host).at(-1));
  assert.equal(created.name, 'Gamma');
  assert.ok([...host.store.values()].some((p) => p.name === 'Gamma'));

  await propose({ action: 'rename', id: 'p2', name: 'Beta Ltd' });
  const renamedCard = proposalsOf(host).at(-1);
  assert.equal(kind.label(renamedCard), 'proposal to rename "Beta" to "Beta Ltd"');
  await kind.approve(renamedCard);
  assert.equal(host.store.get('p2').name, 'Beta Ltd');

  await propose({ action: 'delete', id: 'p1' });
  const deleteCard = proposalsOf(host).at(-1);
  assert.equal(kind.label(deleteCard), 'proposal to delete the project "Acme"');
  await kind.approve(deleteCard);
  assert.equal(host.store.has('p1'), false);
});

test('a delete card says what the project groups, and that those resources survive it', async (t) => {
  const { instance, ...host } = await setup(t, { projects: [{ id: 'p1', name: 'Acme', resources: { servers: ['s1', 's2'], repos: ['r1'] } }, { id: 'p2', name: 'Beta' }] });
  await instance.assistantTools.propose_project_change.run({ action: 'delete', id: 'p1' });
  const card = proposalsOf(host).at(-1);
  assert.deepEqual(card.holds.sort((a, b) => a.kind.localeCompare(b.kind)), [{ kind: 'repos', count: 1 }, { kind: 'servers', count: 2 }]);
});

test('attaching takes a resource out of the shared pool; detaching puts it back', async (t) => {
  const { instance, ...host } = await setup(t, { projects: [{ id: 'p1', name: 'Acme' }] });
  const kind = instance.proposalKinds['project-change'];

  await instance.assistantTools.propose_project_change.run({ action: 'attach', id: 'p1', kind: 'servers', resourceId: 's1', reason: 'it is theirs' });
  const attach = proposalsOf(host).at(-1);
  assert.equal(kind.label(attach), 'proposal to move server s1 into "Acme" only');
  await kind.approve(attach);
  assert.deepEqual(host.store.get('p1').resources.servers, ['s1']);

  await instance.assistantTools.propose_project_change.run({ action: 'detach', id: 'p1', kind: 'servers', resourceId: 's1' });
  const detach = proposalsOf(host).at(-1);
  assert.equal(kind.label(detach), 'proposal to return server s1 from "Acme" to every project');
  await kind.approve(detach);
  assert.deepEqual(host.store.get('p1').resources.servers, []);
});

test('approving a card the workspace has moved past fails instead of acting on the wrong thing', async (t) => {
  const { instance, ...host } = await setup(t, { projects: [{ id: 'p1', name: 'Acme' }, { id: 'p2', name: 'Beta' }] });
  const kind = instance.proposalKinds['project-change'];
  await instance.assistantTools.propose_project_change.run({ action: 'rename', id: 'p1', name: 'Acme Ltd' });
  const card = proposalsOf(host).at(-1);
  host.store.delete('p1'); // the user deleted it while the card sat in the chat
  await assert.rejects(() => kind.approve(card), /no project with id "p1"/);
});

test('every approved change is audited as the assistant proposal it was', async (t) => {
  const { instance, ...host } = await setup(t, { projects: [{ id: 'p1', name: 'Acme' }] });
  const kind = instance.proposalKinds['project-change'];
  await instance.assistantTools.propose_project_change.run({ action: 'create', name: 'Gamma' });
  await kind.approve(proposalsOf(host).at(-1));
  const audits = host.calls.filter((c) => c.method === 'audit.record').map((c) => c.params);
  assert.ok(audits.some((a) => a.action === 'projects-proposed' && a.change === 'create'), JSON.stringify(audits));
  assert.ok(audits.some((a) => a.action === 'projects-create' && a.by === 'agent-proposal'), JSON.stringify(audits));
});

test('the module asks for the capabilities its tools and cards need', () => {
  const manifest = require('../module.json');
  for (const capability of ['assistant:tools', 'assistant:proposals', 'projects:write', 'audit:write']) {
    assert.ok(manifest.capabilities.includes(capability), `${capability} is missing from module.json`);
  }
});
