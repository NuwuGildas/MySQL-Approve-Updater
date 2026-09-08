'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { cloudInit, RECIPES } = require('../../lib/deploy/cloud/recipes');
const rest = require('../../lib/deploy/cloud/providers/rest');
const digitalocean = require('../../lib/deploy/cloud/providers/digitalocean');
const hetzner = require('../../lib/deploy/cloud/providers/hetzner');
const { PROVIDERS } = require('../../lib/deploy/cloud/providers');
const { createCloud, cloudDeps } = require('../../lib/deploy/cloud');
const { fakeCtx, deps, } = require('./helpers');

const PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGxKQ1dO5sT3XwYb0G2lY1lY1lY1lY1lY1lY1lY1lY1l test';

test('cloud-init recipe is well-formed and scoped', () => {
  const y = cloudInit({ recipe: 'php', publicKey: PUB, appName: 'Shop Prod' });
  assert.ok(y.startsWith('#cloud-config'));
  assert.match(y, /name: deploy/);
  assert.match(y, /php8\.3-fpm/);
  assert.match(y, /NOPASSWD: \/usr\/bin\/systemctl reload nginx, \/usr\/bin\/systemctl reload php8\.3-fpm/);
  assert.match(y, /\/var\/www\/shop-prod\/current\/public/);
  assert.match(y, /ufw allow 443\/tcp/);
  assert.ok(!/root ALL/.test(y), 'no blanket sudo');
  const node = cloudInit({ recipe: 'node', publicKey: PUB, appName: 'api' });
  assert.match(node, /nodesource\.com\/setup_22/); assert.match(node, /pm2/);
  const docker = cloudInit({ recipe: 'docker', publicKey: PUB });
  assert.match(docker, /get\.docker\.com/); assert.match(docker, /usermod -aG docker deploy/);
  assert.throws(() => cloudInit({ recipe: 'base', publicKey: 'not a key' }), /OpenSSH public key/);
  assert.equal(Object.keys(RECIPES).length, 5);
});

function fakeFetch(routes) {
  const calls = [];
  rest.deps.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
    const hit = routes.find((r) => r.method === (init.method || 'GET') && r.re.test(url));
    if (!hit) return { ok: false, status: 404, text: async () => JSON.stringify({ message: 'no route ' + url }) };
    const body = typeof hit.body === 'function' ? hit.body(url, init) : hit.body;
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return calls;
}

test('DigitalOcean: key reuse, droplet create with user-data, status → ready', async () => {
  const calls = fakeFetch([
    { method: 'GET', re: /account\/keys/, body: { ssh_keys: [{ id: 77, fingerprint: require('../../lib/deploy/cloud/providers/keys').fingerprintMd5(PUB) }] } },
    { method: 'POST', re: /droplets$/, body: { droplet: { id: 4242, name: 'web-1', status: 'new' } } },
    { method: 'GET', re: /droplets\/4242/, body: { droplet: { id: 4242, status: 'active', networks: { v4: [{ type: 'private', ip_address: '10.0.0.2' }, { type: 'public', ip_address: '203.0.113.5' }] } } } },
  ]);
  const created = await digitalocean.create('tok', { name: 'web-1', region: 'fra1', size: 's-1vcpu-1gb', image: 'ubuntu-24-04-x64', publicKey: PUB, userData: '#cloud-config\n' });
  assert.equal(created.id, '4242');
  const post = calls.find((c) => c.method === 'POST');
  assert.deepEqual(post.body.ssh_keys, [77]); assert.equal(post.body.user_data, '#cloud-config\n'); assert.equal(post.headers.authorization, 'Bearer tok');
  assert.ok(!calls.some((c) => c.method === 'POST' && /account\/keys/.test(c.url)), 'existing key reused, not re-uploaded');
  const st = await digitalocean.status('tok', '4242');
  assert.deepEqual([st.status, st.ip], ['ready', '203.0.113.5']);
});

test('Hetzner: key upload when missing, create returns ip, error surfaces provider message', async () => {
  const calls = fakeFetch([
    { method: 'GET', re: /ssh_keys\?fingerprint/, body: { ssh_keys: [] } },
    { method: 'POST', re: /ssh_keys$/, body: { ssh_key: { id: 9 } } },
    { method: 'POST', re: /servers$/, body: { server: { id: 555, name: 'web-2', status: 'initializing', public_net: { ipv4: { ip: '198.51.100.9' } } } } },
    { method: 'GET', re: /servers\/555/, body: { server: { id: 555, status: 'running', public_net: { ipv4: { ip: '198.51.100.9' } } } } },
  ]);
  const created = await hetzner.create('tok', { name: 'web-2', region: 'fsn1', size: 'cx22', image: 'ubuntu-24.04', publicKey: PUB, userData: 'x' });
  assert.equal(created.ip, '198.51.100.9');
  assert.ok(calls.some((c) => c.method === 'POST' && /ssh_keys$/.test(c.url)));
  assert.equal((await hetzner.status('tok', '555')).status, 'ready');
  rest.deps.fetch = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: { message: 'unauthorized token' } }) });
  await assert.rejects(hetzner.options('bad'), /401: unauthorized token/);
});

test('provision job: generates key, creates server, waits, registers profile + target', async () => {
  const ctx = fakeCtx();
  const d = deps(ctx);
  d.vault.set('DO_TOKEN', 'tok');
  d.stores.repos.get().repos.push({ id: 'r1', name: 'shop', source: { kind: 'local', path: process.cwd() }, manifest: null });
  // fake provider plugged into the registry
  let polls = 0;
  PROVIDERS.fakecloud = { id: 'fakecloud', label: 'Fake Cloud', auth: 'token', defaults: { region: 'r1', size: 's1', image: 'ubuntu' },
    async create(token, spec) { assert.equal(token, 'tok'); assert.match(spec.userData, /#cloud-config/); assert.match(spec.publicKey, /^ssh-ed25519 /); return { id: 'srv-1', name: spec.name }; },
    async status() { polls++; return polls < 2 ? { status: 'creating', ip: null } : { status: 'ready', ip: '192.0.2.10' }; },
    async destroy() { PROVIDERS.fakecloud.destroyed = true; }, console: () => 'https://fake/console' };
  const origTcp = cloudDeps.waitTcp, origCi = cloudDeps.waitCloudInit, origPoll = cloudDeps.pollMs; cloudDeps.pollMs = 30;
  cloudDeps.waitTcp = async (host) => { assert.equal(host, '192.0.2.10'); };
  cloudDeps.waitCloudInit = async (_c, ssh, { say }) => { assert.equal(ssh.user, 'deploy'); assert.ok(ssh.privateKeyPath.endsWith('.key')); say('cloud-init finished'); };
  const created = [];
  const cloud = createCloud({ ctx, stores: d.stores, vault: d.vault, engine: { list: () => [] }, createTarget: async (b) => { created.push(b); return { id: 't-new', name: b.name }; } });
  await assert.rejects(cloud.provision({ provider: 'fakecloud', name: 'Bad Name!' }), /name must be/);
  await assert.rejects(cloud.provision({ provider: 'fakecloud', name: 'web-1' }), /tokenRef/);
  const job = await cloud.provision({ provider: 'fakecloud', name: 'web-1', tokenRef: '${vault:DO_TOKEN}', recipe: 'php', createTarget: { repoId: 'r1', targetName: 'shop-prod' } });
  for (let i = 0; i < 100 && job.status === 'running'; i++) await new Promise((r) => setTimeout(r, 100));
  cloudDeps.waitTcp = origTcp; cloudDeps.waitCloudInit = origCi; cloudDeps.pollMs = origPoll;
  assert.equal(job.status, 'succeeded', job.error);
  assert.equal(ctx.connStore.profiles.length, 2);
  const prof = ctx.connStore.profiles[1];
  assert.equal(prof.ssh.host, '192.0.2.10'); assert.equal(prof.sshOnly, true); assert.equal(prof.ssh.user, 'deploy');
  assert.equal(created.length, 1); assert.equal(created[0].paths.root, '/var/www/shop-prod'); assert.equal(created[0].web.phpFpmReload.includes('php8.3-fpm'), true);
  const list = cloud.list();
  assert.equal(list[0].status, 'ready'); assert.equal(list[0].ip, '192.0.2.10'); assert.equal(list[0].targetId, 't-new');
  assert.ok(!JSON.stringify(job.toJSON()).includes('#cloud-config'), 'job JSON does not carry user-data');
  assert.ok(ctx._audits.some((a) => a.action === 'deploy-cloud-ready'));
  await cloud.destroy(list[0].id);
  assert.equal(PROVIDERS.fakecloud.destroyed, true);
  assert.equal(cloud.list()[0].status, 'destroyed');
  delete PROVIDERS.fakecloud;
});
