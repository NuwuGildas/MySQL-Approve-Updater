'use strict';
/* Engine startup: runs left queued/running by a previous process are marked interrupted, and the deploy lock a
   dead run left on a "This computer" target is released. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fakeCtx, deps } = require('./helpers');
const { createEngine } = require('../../lib/deploy/engine');

test('orphaned runs become failed/interrupted and a local target lock from that run is released', async () => {
  const ctx = fakeCtx();
  const d = deps(ctx);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'st-orphan-'));
  const root = path.join(base, 'www', 'shop');
  fs.mkdirSync(path.join(root, '.ship-lock'), { recursive: true });
  fs.writeFileSync(path.join(root, '.ship-lock', 'owner'), 'run-dead me 2026-01-01T00:00:00.000Z');
  d.stores.repos.get().repos.push({ id: 'r1', name: 'shop', source: { kind: 'local', path: base } });
  d.stores.targets.get().targets.push({ projectId: 'general', id: 't1', name: 'shop-local', repoId: 'r1', type: 'local', paths: { root } });
  const startedAt = new Date(Date.now() - 60000).toISOString();
  d.stores.runs.get().runs.push(
    { id: 'run-dead', targetId: 't1', repoId: 'r1', mode: 'ship', status: 'running', stage: 'package', startedAt, stages: [{ name: 'connect', status: 'ok', ms: 5 }, { name: 'package', status: 'running', _t: 1 }], logLines: 10, targetName: 'shop-local' },
    { id: 'run-queued', targetId: 't1', repoId: 'r1', mode: 'plan', status: 'queued', stage: null, startedAt, stages: [], logLines: 0, targetName: 'shop-local' },
    { id: 'run-ok', targetId: 't1', repoId: 'r1', mode: 'ship', status: 'succeeded', stage: 'cleanup', startedAt, stages: [], logLines: 3, targetName: 'shop-local' },
  );
  await d.stores.runs.save();
  const engine = createEngine(ctx, d);
  assert.deepEqual(engine.orphans.map((r) => r.id).sort(), ['run-dead', 'run-queued']);
  const idx = d.stores.runs.get().runs;
  const dead = idx.find((r) => r.id === 'run-dead');
  assert.equal(dead.status, 'failed'); assert.match(dead.error, /interrupted: the server restarted.*last stage: package/); assert.match(dead.error, /released the deploy lock/);
  assert.equal(dead.stages[1].status, 'failed'); assert.ok(dead.endedAt && dead.ms >= 0);
  assert.equal(idx.find((r) => r.id === 'run-queued').status, 'failed');
  assert.equal(idx.find((r) => r.id === 'run-ok').status, 'succeeded');
  assert.ok(!fs.existsSync(path.join(root, '.ship-lock')), 'lock released');
  assert.ok(ctx._logs.some(([l, m]) => l === 'warn' && /run-dead.*interrupted/.test(m)));
  const logged = fs.readFileSync(path.join(d.stores.runsDir, 'run-dead.log'), 'utf8').trim().split('\n').pop();
  assert.match(logged, /"n":11.*interrupted/);
  assert.equal(engine.activeIds().length, 0);
  // a lock owned by someone else is left alone
  fs.mkdirSync(path.join(root, '.ship-lock')); fs.writeFileSync(path.join(root, '.ship-lock', 'owner'), 'other-run me 2026-01-01T00:00:00.000Z');
  d.stores.runs.get().runs.push({ id: 'run-dead-2', targetId: 't1', repoId: 'r1', mode: 'ship', status: 'running', stage: 'ship', startedAt, stages: [], logLines: 0, targetName: 'shop-local' });
  engine.recoverOrphans();
  assert.ok(fs.existsSync(path.join(root, '.ship-lock')), 'foreign lock kept');
  fs.rmSync(base, { recursive: true, force: true });
});
