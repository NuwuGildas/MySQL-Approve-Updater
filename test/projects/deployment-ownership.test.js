'use strict';
/* Deployment ownership, from the host's side.
 *
 * A deployment belongs to exactly one project. The project store is the host's,
 * and the module that owns deployments publishes which targets it holds; the
 * store refuses anything that would orphan them. That is why removing the
 * Deployments module cannot silently make a project deletable that was not.
 *
 * Moved here from the deploy suite when projects became host infrastructure. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProjectStore } = require('../../lib/projects');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-deploy-ownership-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const projects = createProjectStore(dir);
  /* What the Deployments module publishes while it is installed. */
  const owned = { targets: [], runs: [], pending: new Map() };
  projects.bindDeployments({
    targets: () => owned.targets,
    runs: () => owned.runs,
    pending: (id) => (owned.pending.get(id) || 0) > 0,
  });
  return { dir, projects, owned };
}

test('a project holding deployments, history or pending work cannot be deleted or unlinked', async (t) => {
  const { projects, owned } = fixture(t);
  const other = await projects.create({ name: 'Other' });
  owned.targets.push({ id: 't1', projectId: 'general' });

  await assert.rejects(projects.remove('general'), (error) => error.status === 409);
  await assert.rejects(projects.unlink('general', 'targets', 't1'), (error) => error.status === 409);
  await assert.rejects(projects.unlinkEverywhere('targets', 't1'), (error) => error.status === 409);
  await assert.rejects(projects.link(other.id, 'targets', 't1'), (error) => error.status === 409, 'a deployment cannot belong to two projects');

  await projects.link('general', 'targets', 't1');   // its actual owner: allowed, and a no-op
  assert.deepEqual(projects.resourcesFor(projects.get('general')).targets, ['t1']);

  /* Shared resources stay shared: only deployments are exclusive. */
  await projects.link('general', 'repos', 'r1');
  await projects.link(other.id, 'repos', 'r1');
  assert.equal(projects.projectsFor('repos', 'r1').length, 2);

  /* History keeps a project alive even after its deployment moved away. */
  owned.runs.push({ id: 'history', targetId: 't1', projectId: 'general' });
  owned.targets[0].projectId = other.id;
  await assert.rejects(projects.remove('general'), (error) => error.status === 409, 'moving a deployment preserves the old project history');

  owned.runs.length = 0;
  owned.pending.set('general', 1);
  await assert.rejects(projects.remove('general'), (error) => error.status === 409, 'provisioning in flight also holds the project');

  owned.pending.delete('general');
  await projects.remove('general');
  assert.equal(projects.get('general'), null);
});

test('with no module publishing deployments, projects are still whole and still deletable', async (t) => {
  const { dir } = fixture(t);
  /* A second store over the same file, with nothing bound: the Deployments
     module is not installed. Every link the user made is still there. */
  const store = createProjectStore(dir);
  const project = await store.create({ name: 'Alpha' });
  await store.link(project.id, 'connections', 'c1');
  assert.deepEqual(store.resourcesFor(store.get(project.id)).connections, ['c1']);
  assert.deepEqual(store.resourcesFor(store.get(project.id)).targets || [], [], 'no module is publishing deployments, so a project holds none');

  await store.remove(project.id);
  assert.equal(store.get(project.id), null);
  assert.deepEqual(store.list().map((p) => p.id), ['general'], 'the default project survives');
});
