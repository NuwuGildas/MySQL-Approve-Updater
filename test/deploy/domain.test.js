'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { fakeCtx, fakeConn, registerFakeVps, deps, waitDone } = require('./helpers');
const { createEngine } = require('../../lib/deploy/engine');
const vps = require('../../lib/deploy/targets/vps-ssh');
const frameworks = require('../../lib/deploy/frameworks');
const manifest = require('../../lib/deploy/manifest');
const { cloudInit } = require('../../lib/deploy/cloud/recipes');

const fx = (n) => path.join(__dirname, '..', 'fixtures', 'repos', n);

test('vps target validates the domain block', () => {
  const ctx = fakeCtx();
  const base = { name: 'x', ssh: { profileId: 'p1' }, paths: { root: '/var/www/x' } };
  assert.equal(vps.validate(base, ctx).domain, null);
  assert.throws(() => vps.validate({ ...base, domain: { name: 'not a host' } }, ctx), /hostname/);
  assert.throws(() => vps.validate({ ...base, domain: { name: 'shop.example.com', ssl: true } }, ctx), /email is required/);
  const d = vps.validate({ ...base, domain: { name: 'HTTPS://Shop.Example.com/path', ssl: true, email: 'ops@example.com', www: true } }, ctx).domain;
  assert.deepEqual(d, { name: 'shop.example.com', ssl: true, email: 'ops@example.com', www: true });
});

test('route stage writes the vhost, enables it, issues a certificate; certbot failure is action-required, not fatal', async () => {
  const ctx = fakeCtx(); const d = deps(ctx);
  const conn = fakeConn({ current: '20260901000000', releases: ['20260901000000'] });
  // make certbot fail on the fake box
  const origExec = conn.exec.bind(conn);
  conn.exec = async (cmd, o) => { const full = Array.isArray(cmd) ? cmd.join('; ') : cmd; if (/certbot/.test(full)) { const e = new Error('remote command exited with code 1: Challenge failed for domain'); throw e; } return origExec(cmd, o); };
  const type = registerFakeVps(conn, 'fake-vps-domain');
  d.stores.repos.get().repos.push({ id: 'r1', name: 'shop', source: { kind: 'local', path: fx('plain-html') }, manifest: null });
  d.stores.targets.get().targets.push({ projectId: 'general', id: 't1', name: 'prod', repoId: 'r1', type, buildMode: 'local', ssh: { profileId: 'p1' }, paths: { root: '/var/www/shop' }, web: { server: 'nginx', reloadCmd: 'sudo -n systemctl reload nginx' }, domain: { name: 'shop.example.com', ssl: true, email: 'ops@example.com' }, keepReleases: 3 });
  const engine = createEngine(ctx, d);
  const plan = engine.start({ targetId: 't1', mode: 'plan' }); await waitDone(plan);
  assert.equal(plan.status, 'succeeded', plan.error);
  const routeSteps = plan.plan.steps.filter((s) => s.stage === 'route');
  assert.equal(routeSteps.length, 4);
  assert.match(routeSteps[0].cmd, /write \/etc\/nginx vhost for shop.example.com/);
  assert.match(routeSteps[3].cmd, /certbot --nginx --non-interactive --agree-tos --redirect -m ops@example.com -d shop.example.com/);
  const run = engine.start({ targetId: 't1', mode: 'ship', confirm: true }); await waitDone(run);
  assert.equal(run.status, 'succeeded', run.error);
  const seq = conn.cmds.map((c) => c.cmd);
  assert.ok(seq.some((c) => /sudo -n tee \/etc\/nginx\/sites-available\/shop.example.com/.test(c)), 'vhost written via sudo tee');
  assert.ok(seq.some((c) => /server_name shop.example.com;/.test(c)), 'vhost content carries the domain');
  assert.ok(seq.some((c) => /sudo -n ln -sfn \/etc\/nginx\/sites-available\/shop.example.com/.test(c)), 'vhost enabled');
  assert.ok(seq.some((c) => /sudo -n nginx -t && sudo -n systemctl reload nginx/.test(c)), 'nginx reloaded');
  assert.equal(run.actionRequired.length, 1); assert.match(run.actionRequired[0], /Let's Encrypt certificate failed for shop.example.com/); assert.match(run.actionRequired[0], /DNS not pointing here yet/);
  assert.ok(run.stages.some((s) => s.name === 'route' && s.status === 'ok'));
});

test('route stage without sudo only reports what to run', async () => {
  const ctx = fakeCtx(); const d = deps(ctx);
  const conn = fakeConn({ sudo: false });
  const type = registerFakeVps(conn, 'fake-vps-nosudo');
  d.stores.repos.get().repos.push({ id: 'r1', name: 'shop', source: { kind: 'local', path: fx('plain-html') }, manifest: null });
  d.stores.targets.get().targets.push({ projectId: 'general', id: 't1', name: 'prod', repoId: 'r1', type, buildMode: 'local', ssh: { profileId: 'p1' }, paths: { root: '/var/www/shop' }, web: { server: 'none' }, domain: { name: 'shop.example.com', ssl: false }, keepReleases: 3 });
  const engine = createEngine(ctx, d);
  const run = engine.start({ targetId: 't1', mode: 'ship', confirm: true }); await waitDone(run);
  assert.equal(run.status, 'succeeded', run.error);
  assert.match(run.actionRequired[0], /passwordless sudo is missing/);
  assert.ok(!conn.cmds.some((c) => /sudo -n tee/.test(c.cmd)), 'nothing privileged attempted');
});

test('framework catalog: fragments validate, detection maps to catalog ids, form round-trips', () => {
  for (const c of frameworks.CATALOG) manifest.validate(frameworks.fragmentFor(c.id));
  const over = frameworks.fragmentFor('nextjs', { install: 'pnpm install --frozen-lockfile', build: 'pnpm build', port: '4000', outputDir: '' });
  assert.deepEqual(over.build.steps, ['pnpm install --frozen-lockfile', 'pnpm build']); assert.equal(over.runtime.port, 4000);
  assert.equal(frameworks.catalogIdFor({ stack: { type: 'php', framework: 'laravel' } }), 'laravel');
  assert.equal(frameworks.catalogIdFor({ stack: { type: 'static', framework: 'astro' }, runtime: { kind: 'static' } }), 'astro');
  assert.equal(frameworks.catalogIdFor({ stack: { type: 'node', framework: 'unknownfw' } }), 'nextjs', 'falls back to the first entry of the stack type');
  const form = frameworks.formFrom(manifest.validate(frameworks.fragmentFor('django')));
  assert.match(form.install, /venv/); assert.match(form.build, /collectstatic/); assert.equal(form.port, 8000);
  assert.throws(() => frameworks.fragmentFor('nope'), /unknown framework/);
});

test('cloud-init recipes grant only the routing/cert commands they need', () => {
  const y = cloudInit({ recipe: 'node', publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGxKQ1dO5sT3XwYb0G2lY1lY1lY1lY1lY1lY1lY1lY1l t', appName: 'api' });
  assert.match(y, /certbot/); assert.match(y, /python3-certbot-nginx/);
  assert.match(y, /\/usr\/bin\/tee \/etc\/nginx\/sites-available\/\*/); assert.match(y, /\/usr\/bin\/certbot \*/);
  assert.ok(!/ALL=\(root\) NOPASSWD: ALL/.test(y));
});
