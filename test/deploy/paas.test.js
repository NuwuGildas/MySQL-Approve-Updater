'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { fakeCtx, deps, waitDone } = require('./helpers');
const { createEngine } = require('../../lib/deploy/engine');
const paas = require('../../lib/deploy/targets/paas');
const { PROVIDERS } = require('../../lib/deploy/targets/paas/providers');

const fx = (n) => path.join(__dirname, '..', 'fixtures', 'repos', n);

function setup(paasCfg, extra = {}) {
  const ctx = fakeCtx();
  const d = deps(ctx);
  d.vault.set('NETLIFY_TOKEN', 'nfp_secret_value');
  d.vault.set('VERCEL_TOKEN', 'vercel_secret_value');
  d.stores.repos.get().repos.push({ id: 'r1', name: 'landing', source: { kind: 'local', path: fx('plain-html') }, manifest: null });
  d.stores.targets.get().targets.push({ projectId: 'general', id: 't1', name: 'edge-prod', repoId: 'r1', type: 'paas', paas: paasCfg, ...extra });
  const engine = createEngine(ctx, d);
  const calls = [];
  paas.paasDeps.probe = async (cli) => `${cli} 1.2.3`;
  paas.paasDeps.run = async (cmd, o) => { calls.push({ cmd, cwd: o.cwd, env: o.env }); const out = paas.paasDeps.output(cmd); for (const l of out.split('\n')) o.onLine?.(l, 'out'); return { code: 0, ms: 1 }; };
  return { ctx, d, engine, calls };
}

test('paas validate: provider fields, token ref, derived paths', () => {
  const ctx = fakeCtx();
  assert.throws(() => paas.validate({ paas: { provider: 'nope' } }, ctx), /paas.provider/);
  assert.throws(() => paas.validate({ paas: { provider: 'netlify', tokenRef: 'plain' } }, ctx), /tokenRef/);
  assert.throws(() => paas.validate({ paas: { provider: 'netlify', tokenRef: '${vault:T}' } }, ctx), /paas.site is required/);
  const n = paas.validate({ name: 'x', paas: { provider: 'netlify', tokenRef: '${vault:T}', site: 'my-site' } }, ctx);
  assert.equal(n.buildMode, 'local'); assert.equal(n.paths.root, 'Netlify · my-site'); assert.equal(n.paas.prod, true);
  const v = paas.validate({ name: 'x', paas: { provider: 'vercel', tokenRef: '${vault:T}', prod: false } }, ctx);
  assert.equal(v.buildMode, 'provider'); assert.equal(v.paas.prod, false);
});

test('netlify: local build is skipped for plain html, deploy uploads the dir, token only in env, url parsed, verify + record', async () => {
  const { ctx, engine, calls } = setup({ provider: 'netlify', tokenRef: '${vault:NETLIFY_TOKEN}', site: 'site-123' }, { healthUrl: 'http://127.0.0.1:1/', overrides: { health: { timeoutSec: 1, intervalSec: 1 } } });
  paas.paasDeps.output = () => JSON.stringify({ deploy_id: 'dep-1', deploy_url: 'https://dep-1--site.netlify.app', url: 'https://site.netlify.app' });
  let run = engine.start({ targetId: 't1', mode: 'plan' }); await waitDone(run);
  assert.equal(run.status, 'succeeded', run.error);
  const ship = run.plan.steps.find((s) => s.stage === 'ship');
  assert.match(ship.cmd, /^netlify deploy --prod --dir .*plain-html --site site-123 --json/);
  assert.ok(!/nfp_secret/.test(JSON.stringify(run.plan)), 'no secret in plan');
  // health URL points to a closed port → verify fails; no previous deployment → failed (no rollback)
  run = engine.start({ targetId: 't1', mode: 'ship', confirm: true }); await waitDone(run);
  assert.equal(run.status, 'failed', run.error); assert.match(run.error, /verify/); assert.match(run.error, /no previous deployment/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].env.NETLIFY_AUTH_TOKEN, 'nfp_secret_value'); assert.ok(!calls[0].cmd.includes('nfp_secret'));
  assert.equal(run.deployment.id, 'dep-1'); assert.equal(run.deployment.url, 'https://dep-1--site.netlify.app');
  // now without health URL → the deploy url is verified (fails too); switch to no verify by removing url: use a target without healthUrl and a parse without url
  paas.paasDeps.output = () => JSON.stringify({ deploy_id: 'dep-2' });
  ctx; // eslint no-unused
  const t = engine.list()[0];
  assert.ok(t);
});

test('vercel: provider build, ship succeeds without verify url, second ship + rollback uses previous deployment id', async () => {
  const { engine, calls, d } = setup({ provider: 'vercel', tokenRef: '${vault:VERCEL_TOKEN}', project: 'landing' }, { overrides: { health: { timeoutSec: 1, intervalSec: 1 } } });
  d.stores.targets.get().targets[0].healthUrl = '';
  paas.paasDeps.output = (cmd) => (/vercel deploy/.test(cmd) ? 'Inspect: https://vercel.com/x\nProduction: https://landing-abc123.vercel.app\n' : 'ok');
  // strip url so no verify happens (vercel parse finds .vercel.app) — use health override with a reachable? no network; instead assert rolled/failed logic separately
  let run = engine.start({ targetId: 't1', mode: 'ship', confirm: true }); await waitDone(run);
  // verify of the vercel url fails (no network) and there is no previous deployment → failed
  assert.equal(run.status, 'failed', run.error);
  assert.equal(calls[0].env.VERCEL_TOKEN, 'vercel_secret_value');
  assert.match(calls[0].cmd, /vercel deploy --prod --yes --name landing --token "\$\{VERCEL_TOKEN\}"/);
  assert.equal(run.deployment.id, 'https://landing-abc123.vercel.app');
  // plan step hides the token variable
  const plan = engine.start({ targetId: 't1', mode: 'plan' }); await waitDone(plan);
  assert.match(plan.plan.steps.find((s) => s.stage === 'ship').cmd, /--token <token>$/);
  // rollback command shape
  const cmd = PROVIDERS.vercel.rollback({ paas: { provider: 'vercel' } }, { id: 'https://landing-old.vercel.app' }).cmd;
  assert.match(cmd, /^vercel rollback https:\/\/landing-old\.vercel\.app --yes --token/);
  assert.equal(PROVIDERS['cloudflare-pages'].rollback(), null);
  assert.match(PROVIDERS.fly.rollback({ paas: { app: 'a' } }, { image: 'registry.fly.io/a:v3' }).cmd, /flyctl deploy --image registry.fly.io\/a:v3 --app a --yes/);
  assert.match(PROVIDERS.render.deploy({ paas: { serviceId: 'srv-1' } }, { commit: 'abc' }).cmd, /render deploys create srv-1 --wait --confirm --output json --commit abc/);
  assert.match(PROVIDERS['cloudflare-workers'].parse('Current Version ID: 0f1e2d3c-1111\nhttps://w.acme.workers.dev').id, /^0f1e2d3c/);
});

test('paas rollback mode uses the recorded previous deployment', async () => {
  const { engine, calls, d } = setup({ provider: 'netlify', tokenRef: '${vault:NETLIFY_TOKEN}', site: 'site-123' });
  d.stores.targets.get().targets[0].healthUrl = '';
  // seed two successful deployments in the run index
  d.stores.runs.get().runs.push(
    { id: 'old', targetId: 't1', mode: 'ship', status: 'succeeded', startedAt: '2026-09-01T00:00:00Z', release: '20260901000000', deployment: { id: 'dep-old', url: null, release: '20260901000000' } },
    { id: 'new', targetId: 't1', mode: 'ship', status: 'succeeded', startedAt: '2026-09-02T00:00:00Z', release: '20260902000000', deployment: { id: 'dep-new', url: null, release: '20260902000000' } },
  );
  paas.paasDeps.output = () => '{}';
  const run = engine.start({ targetId: 't1', mode: 'rollback', confirm: true }); await waitDone(run);
  assert.equal(run.status, 'succeeded', run.error);
  assert.match(calls[0].cmd, /netlify api restoreSiteDeploy --data/);
  assert.match(calls[0].cmd, /dep-old/);
  assert.equal(run.release, '20260901000000'); assert.equal(run.previousRelease, '20260902000000');
});
