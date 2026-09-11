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
  const store = new Map(projects.map((p) => [p.id, { links: [], ...p }]));
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
      async call(method, params = {}) {
        calls.push({ method, params });
        switch (method) {
          case 'projects.list': return [...store.values()];
          case 'projects.create': {
            const project = { id: `project-${++counter}`, name: params.name, description: params.description ?? '', color: params.color ?? null, links: [] };
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
            if (!project.links.some((l) => l.kind === params.kind && l.resourceId === params.resourceId)) project.links.push({ kind: params.kind, resourceId: params.resourceId });
            return project;
          }
          case 'projects.unlink': {
            const project = need(params.id);
            project.links = project.links.filter((l) => !(l.kind === params.kind && l.resourceId === params.resourceId));
            return project;
          }
          case 'projects.resourcesFor':
            return [...store.values()].filter((p) => p.links.some((l) => l.kind === params.kind && l.resourceId === params.resourceId));
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
  assert.deepEqual(linked.links, [{ kind: 'server', resourceId: 'profile-7' }]);
  assert.equal(JSON.stringify(linked).includes('profile-7'), true);

  await ctx.api.link({ id: 'p1', kind: 'server', resourceId: 'profile-7' });
  assert.equal(ctx.store.get('p1').links.length, 1, 'linking the same resource twice is not two links');

  assert.deepEqual(await ctx.api.forResource({ kind: 'server', resourceId: 'profile-7' }), [ctx.store.get('p1')]);
  assert.deepEqual(await ctx.api.forResource({ kind: 'server', resourceId: 'profile-9' }), []);

  const unlinked = await ctx.api.unlink({ id: 'p1', kind: 'server', resourceId: 'profile-7' });
  assert.deepEqual(unlinked.links, []);
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
