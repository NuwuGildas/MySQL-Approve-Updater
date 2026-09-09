'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { fakeCtx, deps, fakeConn, registerFakeVps, waitDone } = require('./helpers');
const { createStores } = require('../../lib/deploy/store');
const { createProjectStore } = require('../../lib/projects');
const { sanitizeRepo, sanitizeTarget, createRouter } = require('../../lib/deploy/routes');
const { createConfig } = require('../../lib/deploy/config');
const { createEngine } = require('../../lib/deploy/engine');

function fixture() {
  const ctx = fakeCtx();
  const d = deps(ctx);
  const repo = { id: 'r1', name: 'site', source: { kind: 'local', path: path.join(__dirname, '..', 'fixtures', 'repos', 'plain-html') } };
  d.stores.repos.get().repos.push(repo);
  const target = { name: 'site-prod', projectId: 'general', repoId: repo.id, type: 'vps-ssh', ssh: { profileId: 'p1' }, paths: { root: '/var/www/site' } };
  return { ctx, d, repo, target, cfg: createConfig({ ctx, stores: d.stores, vault: d.vault, sanitizeRepo, sanitizeTarget }) };
}

const invalidProjects = [undefined, null, '', '   ', 'missing', 42, { id: 'general' }];
const projectError = (error) => error.status === 400 && /project/i.test(error.message);

test('new deployments require a real project; partial edits preserve ownership and explicit clearing is rejected', async () => {
  const { ctx, d, target } = fixture();
  for (const projectId of invalidProjects) {
    assert.throws(() => sanitizeTarget({ ...target, projectId }, ctx, d.stores, null), projectError, `create: ${JSON.stringify(projectId)}`);
  }
  const saved = sanitizeTarget(target, ctx, d.stores, null);
  d.stores.targets.get().targets.push(saved);
  assert.equal(saved.projectId, 'general');
  const { projectId: _owner, ...body } = saved;
  const updated = sanitizeTarget({ ...body, name: 'renamed' }, ctx, d.stores, saved);
  assert.equal(updated.projectId, 'general');
  for (const projectId of invalidProjects.filter((id) => id !== undefined)) {
    assert.throws(() => sanitizeTarget({ ...saved, projectId }, ctx, d.stores, saved), projectError);
    assert.equal(d.stores.findTarget(saved.id).projectId, 'general', 'rejected edits cannot detach the stored deployment');
  }
  const second = await d.stores.projects.create({ name: 'Shop' });
  assert.equal(sanitizeTarget({ ...saved, projectId: second.id }, ctx, d.stores, saved).projectId, second.id);
});

test('guided setup refuses missing or invalid ownership before creating repos, secrets, or targets', async () => {
  for (const projectId of invalidProjects) {
    const { ctx, d, target, cfg } = fixture();
    d.stores.repos.get().repos.length = 0;
    await assert.rejects(cfg.setup({
      secrets: { DEPLOY_TOKEN: 'do-not-save' },
      repo: { name: 'new-repo', source: { kind: 'local', path: process.cwd() } },
      target: { ...target, projectId },
    }), projectError);
    assert.deepEqual(d.stores.repos.get().repos, []);
    assert.deepEqual(d.stores.targets.get().targets, []);
    assert.deepEqual(d.vault.names(), []);
    assert.deepEqual(ctx._audits, []);
  }
});

test('duplicate inherits the source project and templates can be reused across projects', async () => {
  const { ctx, d, target, cfg } = fixture();
  const saved = sanitizeTarget(target, ctx, d.stores, null);
  d.stores.targets.get().targets.push(saved);
  const inherited = await cfg.duplicateTarget(saved.id, { name: 'site-staging' });
  assert.equal(inherited.projectId, saved.projectId);
  const second = await d.stores.projects.create({ name: 'Second' });
  const moved = await cfg.duplicateTarget(saved.id, { name: 'second-prod', projectId: second.id });
  assert.equal(moved.projectId, second.id);
  for (const projectId of invalidProjects.filter((id) => id !== undefined)) {
    await assert.rejects(cfg.duplicateTarget(saved.id, { name: 'invalid-copy', projectId }), projectError);
  }
  assert.equal(d.stores.targets.get().targets.length, 3);
  const template = await cfg.saveTemplate({ name: 'Reusable VPS', fromTargetId: saved.id });
  assert.equal(template.data.projectId, undefined);
  const explicitTemplate = await cfg.saveTemplate({ name: 'Imported template', data: { ...saved } });
  assert.equal(explicitTemplate.data.projectId, undefined, 'explicit template data must also drop ownership');
});

test('imports validate the destination and can map deployments from an unavailable project', async () => {
  const source = fixture();
  const sourceProject = await source.d.stores.projects.create({ name: 'Source project' });
  const saved = sanitizeTarget({ ...source.target, projectId: sourceProject.id }, source.ctx, source.d.stores, null);
  source.d.stores.targets.get().targets.push(saved);
  const doc = source.cfg.exportConfig();
  assert.equal(doc.targets[0].projectId, sourceProject.id);

  const destination = fixture();
  for (const projectId of invalidProjects.filter((id) => id !== undefined)) {
    await assert.rejects(destination.cfg.importConfig(doc, { projectId }), projectError);
    assert.equal(destination.d.stores.targets.get().targets.length, 0);
    assert.equal(destination.d.stores.repos.get().repos.length, 1);
  }
  const skip = await destination.cfg.importConfig(doc);
  assert.equal(skip.targets.length, 0);
  assert.ok(skip.skipped.some((message) => /project/i.test(message)));
  const dry = await destination.cfg.importConfig(doc, { projectId: 'general', dryRun: true });
  assert.deepEqual(dry.targets, ['site-prod']);
  assert.equal(destination.d.stores.targets.get().targets.length, 0);
  const imported = await destination.cfg.importConfig(doc, { projectId: 'general' });
  assert.deepEqual(imported.targets, ['site-prod']);
  assert.equal(destination.d.stores.targets.get().targets[0].projectId, 'general');

  const legacy = fixture();
  const legacyDoc = structuredClone(doc);
  delete legacyDoc.targets[0].projectId;
  const rejected = await legacy.cfg.importConfig(legacyDoc);
  assert.equal(rejected.targets.length, 0);
  await legacy.cfg.importConfig(legacyDoc, { projectId: 'general' });
  assert.equal(legacy.d.stores.targets.get().targets[0].projectId, 'general');
});

test('legacy deployment migration preserves valid owners, uses links then General, backs up and is idempotent', async () => {
  const ctx = fakeCtx();
  const projects = createProjectStore(ctx.DATA_DIR);
  const alpha = await projects.create({ name: 'Alpha' });
  const beta = await projects.create({ name: 'Beta' });
  await projects.link(alpha.id, 'targets', 'linked');
  await projects.link(beta.id, 'targets', 'linked');
  await projects.link(alpha.id, 'targets', 'owned');
  const targetDocument = { targets: [
    { id: 'owned', projectId: beta.id, name: 'Owned' },
    { id: 'linked', name: 'Linked' },
    { id: 'unlinked', name: 'Unlinked' },
    { id: 'unknown-owner', projectId: 'missing', name: 'Unknown' },
  ], custom: { keep: true } };
  const runDocument = { runs: [
    { id: 'old-link', targetId: 'linked', status: 'succeeded' },
    { id: 'deleted-target', targetId: 'gone', status: 'failed' },
    { id: 'historical-owner', targetId: 'owned', projectId: alpha.id, projectName: 'Original Alpha', status: 'succeeded' },
  ] };
  const originals = {};
  for (const [name, data] of [['deploy-targets.json', targetDocument], ['deploy-runs.json', runDocument]]) {
    originals[name] = JSON.stringify(data, null, 2);
    fs.writeFileSync(path.join(ctx.DATA_DIR, name), originals[name]);
  }
  const stores = createStores(ctx.DATA_DIR, { projects });
  assert.equal(stores.projects, projects);
  assert.deepEqual(stores.targets.get().targets.map((t) => t.projectId), [beta.id, alpha.id, 'general', 'general']);
  assert.deepEqual(stores.targets.get().custom, { keep: true });
  assert.deepEqual(stores.runs.get().runs.map((r) => r.projectId), [alpha.id, 'general', alpha.id]);
  assert.equal(stores.runs.get().runs[2].projectName, 'Original Alpha', 'past owner names are snapshots');
  assert.deepEqual(projects.resourcesFor(projects.get(alpha.id)).targets, ['linked']);
  assert.deepEqual(projects.projectsFor('targets', 'owned').map((p) => p.id), [beta.id]);
  const afterFirst = {};
  for (const name of Object.keys(originals)) {
    assert.equal(fs.readFileSync(path.join(ctx.DATA_DIR, `${name}.before-project-ownership.bak`), 'utf8'), originals[name]);
    afterFirst[name] = fs.readFileSync(path.join(ctx.DATA_DIR, name), 'utf8');
  }
  createStores(ctx.DATA_DIR);
  for (const name of Object.keys(originals)) {
    assert.equal(fs.readFileSync(path.join(ctx.DATA_DIR, name), 'utf8'), afterFirst[name]);
    assert.equal(fs.readFileSync(path.join(ctx.DATA_DIR, `${name}.before-project-ownership.bak`), 'utf8'), originals[name]);
  }
  assert.equal(fs.readdirSync(ctx.DATA_DIR).filter((name) => name.endsWith('.bak')).length, 2);
});

test('migration uses an existing project when General was removed and leaves read-only project stores untouched', async () => {
  const ctx = fakeCtx();
  const projects = createProjectStore(ctx.DATA_DIR);
  const custom = await projects.create({ name: 'Custom' });
  await projects.remove('general');
  fs.writeFileSync(path.join(ctx.DATA_DIR, 'deploy-targets.json'), JSON.stringify({ targets: [{ id: 't1' }] }));
  const stores = createStores(ctx.DATA_DIR, { projects });
  assert.equal(stores.targets.get().targets[0].projectId, custom.id);
  assert.equal(projects.get('general'), null);

  for (const document of ['{invalid JSON', JSON.stringify({ version: 999, projects: [] })]) {
    const broken = fakeCtx();
    const rawTargets = JSON.stringify({ targets: [{ id: 'legacy' }] });
    const rawRuns = JSON.stringify({ runs: [{ id: 'history', targetId: 'legacy' }] });
    fs.writeFileSync(path.join(broken.DATA_DIR, 'projects.json'), document);
    fs.writeFileSync(path.join(broken.DATA_DIR, 'deploy-targets.json'), rawTargets);
    fs.writeFileSync(path.join(broken.DATA_DIR, 'deploy-runs.json'), rawRuns);
    const readOnly = createStores(broken.DATA_DIR);
    assert.ok(readOnly.projects.readOnly);
    assert.equal(fs.readFileSync(path.join(broken.DATA_DIR, 'projects.json'), 'utf8'), document);
    assert.equal(fs.readFileSync(path.join(broken.DATA_DIR, 'deploy-targets.json'), 'utf8'), rawTargets);
    assert.equal(fs.readFileSync(path.join(broken.DATA_DIR, 'deploy-runs.json'), 'utf8'), rawRuns);
    assert.equal(fs.readdirSync(broken.DATA_DIR).filter((name) => name.endsWith('.bak')).length, 0);
    assert.throws(() => sanitizeTarget({ projectId: 'general' }, broken, readOnly, null), (e) => e.status === 503);
  }
});

test('project deletion and resource unlinking cannot orphan deployments, history, or pending creation', async () => {
  const { ctx, d, target } = fixture();
  const projects = d.stores.projects;
  const other = await projects.create({ name: 'Other' });
  const saved = sanitizeTarget(target, ctx, d.stores, null);
  d.stores.targets.get().targets.push(saved);
  await assert.rejects(projects.remove('general'), (e) => e.status === 409);
  await assert.rejects(projects.unlink('general', 'targets', saved.id), (e) => e.status === 409);
  await assert.rejects(projects.unlinkEverywhere('targets', saved.id), (e) => e.status === 409);
  await assert.rejects(projects.link(other.id, 'targets', saved.id), (e) => e.status === 409);
  await projects.link('general', 'targets', saved.id);
  assert.equal(saved.projectId, 'general');
  assert.deepEqual(projects.resourcesFor(projects.get('general')).targets, [saved.id]);
  // Shared resources remain reusable by multiple projects.
  await projects.link('general', 'repos', 'r1');
  await projects.link(other.id, 'repos', 'r1');
  assert.equal(projects.projectsFor('repos', 'r1').length, 2);

  d.stores.runs.get().runs.push({ id: 'history', targetId: saved.id, projectId: 'general' });
  saved.projectId = other.id;
  await assert.rejects(projects.remove('general'), (e) => e.status === 409, 'moving a deployment preserves the old project history');
  d.stores.runs.get().runs.length = 0;
  d.stores.pendingProjects.set('general', 1);
  await assert.rejects(projects.remove('general'), (e) => e.status === 409);
  d.stores.pendingProjects.delete('general');
  await projects.remove('general');
  assert.equal(projects.get('general'), null);
});

test('engine refuses orphaned deployment runs and persists project snapshots independently of target moves', async () => {
  const { ctx, d, target } = fixture();
  const conn = fakeConn();
  const type = registerFakeVps(conn, 'project-ownership-vps');
  const saved = { ...target, type, id: 't1' };
  d.stores.targets.get().targets.push(saved);
  const engine = createEngine(ctx, d);
  for (const projectId of invalidProjects) {
    saved.projectId = projectId;
    for (const mode of ['plan', 'ship', 'rollback']) {
      assert.throws(() => engine.start({ targetId: saved.id, mode, confirm: true }), projectError);
    }
  }
  assert.equal(engine.activeIds().length, 0);
  assert.equal(d.stores.runs.get().runs.length, 0);
  assert.equal(conn.cmds.length, 0, 'invalid ownership must be rejected before connecting');
  saved.projectId = 'general';
  const run = engine.start({ targetId: saved.id, mode: 'plan' });
  assert.equal(run.projectId, 'general');
  assert.equal(run.projectName, 'General');
  await waitDone(run);
  assert.equal(run.status, 'succeeded', run.error);
  const second = await d.stores.projects.create({ name: 'Second' });
  saved.projectId = second.id;
  await d.stores.projects.update('general', { name: 'Renamed General' });
  await d.stores.runs.save();
  const persisted = JSON.parse(fs.readFileSync(d.stores.runs.file, 'utf8')).runs.find((r) => r.id === run.id);
  assert.equal(persisted.projectId, 'general');
  assert.equal(persisted.projectName, 'General');
  assert.equal(run.toJSON().projectId, 'general');
});

test('target routes reject invalid creates/edits and preserve owner on a partial PUT', async (t) => {
  const express = require('express');
  const { ctx, d, target, cfg } = fixture();
  ctx.wrap = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);
  const app = express();
  app.use(express.json());
  app.use('/api/deploy', createRouter({ ctx, ...d, config: cfg, engine: { isLocked: () => false, activeIds: () => [], list: () => [] }, cloud: {} }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const request = async (method, suffix, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/deploy${suffix}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  for (const projectId of [undefined, '', 'missing']) {
    assert.equal((await request('POST', '/targets', { ...target, projectId })).status, 400);
  }
  assert.equal(d.stores.targets.get().targets.length, 0);
  const created = await request('POST', '/targets', target);
  assert.equal(created.status, 201);
  assert.equal(created.data.projectId, 'general');
  const edited = await request('PUT', `/targets/${created.data.id}`, { name: 'renamed' });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.equal(edited.data.projectId, 'general');
  for (const projectId of ['', null, 'missing']) {
    assert.equal((await request('PUT', `/targets/${created.data.id}`, { projectId })).status, 400);
    assert.equal(d.stores.findTarget(created.data.id).projectId, 'general');
  }
});
