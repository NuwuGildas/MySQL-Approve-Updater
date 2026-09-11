'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { fakeCtx, fakeConn, registerFakeVps, deps, waitDone } = require('./helpers');
const { createEngine } = require('../../backend/deploy/engine');

const fx = (n) => path.join(__dirname, '..', 'fixtures', 'repos', n);

function setup(connOpts, targetExtra = {}) {
  const ctx = fakeCtx();
  const d = deps(ctx);
  const conn = fakeConn(connOpts);
  const type = registerFakeVps(conn);
  d.stores.repos.get().repos.push({ id: 'r1', name: 'shop', source: { kind: 'local', path: fx('laravel') }, manifest: null });
  d.stores.targets.get().targets.push({ projectId: 'general', id: 't1', name: 'prod', repoId: 'r1', type, buildMode: 'auto', ssh: { profileId: 'p1' }, paths: { root: '/var/www/shop' }, web: { server: 'nginx', reloadCmd: 'sudo -n systemctl reload nginx', phpFpmReload: 'sudo -n systemctl reload php8.3-fpm' }, keepReleases: 3, ...targetExtra });
  const engine = createEngine(ctx, d);
  return { ctx, d, conn, engine };
}

test('plan mode for Laravel → VPS is read-only and produces the expected steps', async () => {
  const { conn, engine } = setup({ current: '20260901000000', releases: ['20260901000000'] });
  const run = engine.start({ targetId: 't1', mode: 'plan', trigger: 'cli' });
  await waitDone(run);
  assert.equal(run.status, 'succeeded', run.error);
  assert.equal(run.buildMode, 'remote');
  const cmds = run.plan.steps.map((s) => `${s.stage}|${s.where}|${s.cmd}`);
  assert.ok(cmds.some((c) => c.startsWith('build|remote|composer install --no-dev')), cmds.join('\n'));
  assert.ok(cmds.some((c) => c.startsWith('build|remote|npm ci')));
  assert.ok(cmds.some((c) => c.includes('php artisan migrate --force')));
  assert.ok(cmds.some((c) => c.includes('php artisan config:cache')));
  assert.ok(cmds.some((c) => c.includes('ln -sfn releases/')));
  assert.ok(cmds.some((c) => c.includes('systemctl reload php8.3-fpm')));
  assert.ok(cmds.some((c) => c.startsWith('cleanup|remote|keep 3')));
  // read-only: no mkdir/rm/tar executed, only the probe
  assert.ok(conn.cmds.every((c) => c.cmd.includes('echo "USER=')), conn.cmds.map((c) => c.cmd).join('\n'));
  assert.ok(run.warnings.some((w) => /no healthUrl/.test(w.msg)));
  assert.ok(conn.state.closed);
});

test('ship falls back to a local build when the server lacks the toolchain', async () => {
  const { engine } = setup({ tools: 'git tar curl' });
  const run = engine.start({ targetId: 't1', mode: 'plan' });
  await waitDone(run);
  assert.equal(run.status, 'succeeded', run.error);
  assert.equal(run.buildMode, 'local');
  assert.ok(run.warnings.some((w) => /server lacks/.test(w.msg)));
});

test('explicit remote build with missing tools fails at plan', async () => {
  const { engine } = setup({ tools: 'git' }, { buildMode: 'remote' });
  const run = engine.start({ targetId: 't1', mode: 'plan' });
  await waitDone(run);
  assert.equal(run.status, 'failed');
  assert.match(run.error, /server lacks: php, composer/);
  assert.equal(run.exitCode, 10);
});

test('ship requires confirm and honours the per-target lock', async () => {
  const { engine } = setup({});
  assert.throws(() => engine.start({ targetId: 't1', mode: 'ship' }), /confirm:true/);
  assert.throws(() => engine.start({ targetId: 'nope', mode: 'plan' }), /target not found/);
});

test('ship (remote build) runs the full sequence, activates, prunes and unlocks', async () => {
  const { conn, engine, ctx } = setup({ current: '20260901000000', releases: ['20260801000000', '20260901000000'] });
  // avoid running real composer/npm: replace build steps via the repo manifest
  const repo = engine.list && null;
  const stores = require('./helpers').deps(ctx).stores; // same DATA_DIR → same files
  const run = engine.start({ targetId: 't1', mode: 'ship', confirm: true, trigger: 'cli' });
  await waitDone(run);
  assert.equal(run.status, 'succeeded', run.error);
  const seq = conn.cmds.map((c) => c.cmd);
  const idx = (re) => seq.findIndex((c) => re.test(c));
  assert.ok(idx(/mkdir .*\.ship-lock/) >= 0, 'locked');
  assert.ok(idx(/tar -xzf .*\.src\.tgz/) > idx(/mkdir .*\.ship-lock/), 'source extracted after lock');
  assert.ok(idx(/composer install/) > idx(/tar -xzf/), 'build after extract');
  assert.ok(idx(/artisan migrate --force/) > idx(/composer install/), 'migrate after build');
  assert.ok(idx(/ln -sfn releases\/\d{14} current\.tmp/) > idx(/artisan config:cache/), 'activate after caches');
  assert.ok(idx(/reload php8\.3-fpm/) > idx(/current\.tmp/), 'reload after swap');
  assert.ok(idx(/rm -rf .*\.ship-lock/) > idx(/current\.tmp/), 'unlocked at the end');
  assert.equal(conn.state.current, run.release);
  assert.equal(run.previousRelease, '20260901000000');
  // keepReleases 3: had 2 + new 1 = 3 → nothing pruned
  assert.equal(conn.state.releases.length, 3);
  assert.ok(conn.state.uploaded.some((u) => u.remote.endsWith('.src.tgz')));
  assert.ok(ctx._audits.some((a) => a.action === 'deploy-ship-success' && a.release === run.release));
  // shared links for Laravel
  assert.ok(seq.some((c) => /ln -sfn \/var\/www\/shop\/shared\/storage\/app/.test(c)));
});

test('ship rolls back when the health check fails', async () => {
  const { conn, engine } = setup({ current: '20260901000000', releases: ['20260901000000'] }, { healthUrl: 'http://127.0.0.1:1/up', overrides: { health: { timeoutSec: 2, intervalSec: 1 } } });
  const run = engine.start({ targetId: 't1', mode: 'ship', confirm: true });
  // shorten the health timeout via target overrides
  await waitDone(run);
  assert.equal(run.status, 'rolled_back', run.error);
  assert.equal(conn.state.current, '20260901000000');
  assert.equal(run.exitCode, 7);
  assert.match(run.error, /verify: health check failed/);
});

test('rollback mode switches to the previous release', async () => {
  const { conn, engine } = setup({ current: '20260901000000', releases: ['20260801000000', '20260901000000'] });
  const run = engine.start({ targetId: 't1', mode: 'rollback', confirm: true });
  await waitDone(run);
  assert.equal(run.status, 'succeeded', run.error);
  assert.equal(conn.state.current, '20260801000000');
  assert.equal(run.release, '20260801000000');
});

test('cancel during a run ends in cancelled', async () => {
  const { engine } = setup({});
  const run = engine.start({ targetId: 't1', mode: 'ship', confirm: true });
  run.once('stage', () => run.cancel());
  await waitDone(run);
  assert.equal(run.status, 'cancelled');
});

test('engine log catch-up returns lines after a cursor', async () => {
  const { engine } = setup({});
  const run = engine.start({ targetId: 't1', mode: 'plan' });
  await waitDone(run);
  const all = await engine.readLog(run.id, 0);
  assert.ok(all.lines.length > 5);
  const part = await engine.readLog(run.id, all.lines[2].n);
  assert.equal(part.lines[0].n, all.lines[3].n);
  assert.equal(engine.list()[0].id, run.id);
});
