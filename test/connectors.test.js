'use strict';
/* Git Connectors: a pasted token becomes a vault secret and nothing else keeps
   a copy of it. Everything here runs against a fake provider - no network, no
   real account, no real token. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { activate, normBase, slug, PROVIDERS } = require('../backend/index');
const { createTestHost, stubFetch, reply } = require('./host-fixture');

const GITHUB_USER = { login: 'octo', name: 'Octo Cat', html_url: 'https://github.com/octo', avatar_url: 'https://avatars/1' };

/** Activate the module against a fresh host. */
async function setup(t, options = {}) {
  const fixture = createTestHost(t, options);
  const instance = await activate(fixture.host);
  t.after(() => instance.deactivate());
  return { ...fixture, instance, api: instance.methods };
}

test('base URLs are normalized per provider and secret names are derived from the connector name', () => {
  assert.equal(normBase('github', ''), 'https://api.github.com');
  assert.equal(normBase('github', 'https://api.github.com'), 'https://api.github.com');
  assert.equal(normBase('github', 'https://git.acme.example/'), 'https://git.acme.example/api/v3', 'GitHub Enterprise serves the API under /api/v3');
  assert.equal(normBase('github', 'https://git.acme.example/api/v3'), 'https://git.acme.example/api/v3', 'and is not suffixed twice');
  assert.equal(normBase('gitlab', ''), 'https://gitlab.com');
  assert.equal(normBase('gitlab', 'https://gl.acme.example/'), 'https://gl.acme.example');
  assert.throws(() => normBase('github', 'not-a-url'), /http\(s\) URL/);

  assert.equal(slug('Work account'), 'WORK_ACCOUNT');
  assert.equal(slug('  !!  '), 'DEFAULT');
  assert.deepEqual(Object.keys(PROVIDERS).sort(), ['github', 'gitlab']);
});

test('a pasted token becomes a vault secret, and the connector keeps only the reference', async (t) => {
  const ctx = await setup(t);
  stubFetch(t, () => reply(200, GITHUB_USER, { 'x-oauth-scopes': 'repo, read:org' }));

  const saved = await ctx.api.save({ kind: 'github', name: 'Work account', token: 'ghp_pretend_secret' });

  assert.equal(saved.status, 'ok');
  assert.equal(saved.account.login, 'octo');
  assert.deepEqual(saved.account.scopes, ['repo', 'read:org']);
  assert.equal(saved.tokenRef, '${vault:GITHUB_TOKEN_WORK_ACCOUNT}');
  assert.equal(saved.secretName, 'GITHUB_TOKEN_WORK_ACCOUNT');
  assert.equal(ctx.vault.GITHUB_TOKEN_WORK_ACCOUNT, 'ghp_pretend_secret', 'the token went to the vault');

  /* The token is the one thing that must never come back out. */
  assert.equal(JSON.stringify(saved).includes('ghp_pretend_secret'), false);
  const listed = await ctx.api.list();
  assert.equal(JSON.stringify(listed).includes('ghp_pretend_secret'), false);
  assert.equal(listed.connectors.length, 1);
  assert.equal(listed.providers.length, 2);

  await ctx.instance.deactivate();
  const onDisk = fs.readFileSync(ctx.file, 'utf8');
  assert.equal(onDisk.includes('ghp_pretend_secret'), false, 'and connectors.json stores the reference, not the token');
  assert.equal(onDisk.includes('GITHUB_TOKEN_WORK_ACCOUNT'), true);
  assert.equal(ctx.audits.at(-1).action, 'connector-add');
});

test('an existing vault secret can be reused, and a missing one is refused', async (t) => {
  const ctx = await setup(t, { vault: { SHARED_TOKEN: 'glpat_pretend' } });
  stubFetch(t, () => reply(200, { username: 'dev', name: 'Dev', web_url: 'https://gitlab.com/dev' }));

  assert.deepEqual(await ctx.api.secrets(), { secrets: ['SHARED_TOKEN'] });
  const saved = await ctx.api.save({ kind: 'gitlab', name: 'Self hosted', baseUrl: 'https://gl.acme.example', tokenRef: '${vault:SHARED_TOKEN}' });
  assert.equal(saved.baseUrl, 'https://gl.acme.example');
  assert.equal(saved.account.login, 'dev');

  await assert.rejects(ctx.api.save({ kind: 'github', name: 'Ghost', tokenRef: '${vault:NOT_THERE}' }), /does not exist in the vault/);
  await assert.rejects(ctx.api.save({ kind: 'github', name: 'Bad ref', tokenRef: 'SHARED_TOKEN' }), /vault:NAME/);
  await assert.rejects(ctx.api.save({ kind: 'github', name: 'Nameless', token: 'x', secretName: 'lower case' }), /UPPER_SNAKE_CASE/);
  await assert.rejects(ctx.api.save({ kind: 'bitbucket', name: 'Other', token: 'x' }), /kind must be one of/);
  await assert.rejects(ctx.api.save({ kind: 'github', name: 'No token' }), /paste a personal access token/);
  await assert.rejects(ctx.api.save({ kind: 'gitlab', name: 'Self hosted', token: 'x' }), /already exists/);
  await assert.rejects(ctx.api.save({ id: 'nope', kind: 'github', name: 'Missing', token: 'x' }), /connector not found/);
});

test('a provider that refuses the token records the failure rather than throwing it away', async (t) => {
  const ctx = await setup(t);
  stubFetch(t, () => reply(401, { message: 'Bad credentials' }));

  const saved = await ctx.api.save({ kind: 'github', name: 'Expired', token: 'ghp_expired' });
  assert.equal(saved.status, 'error');
  assert.match(saved.error, /rejected the token/);
  assert.notEqual(saved.verifiedAt, null);
  assert.equal((await ctx.api.list()).connectors.length, 1, 'and it is still listed, so the user can fix it');

  /* Re-verifying after the token is replaced clears the error in place. */
  globalThis.fetch = async () => reply(200, GITHUB_USER);
  const verified = await ctx.api.verify({ id: saved.id });
  assert.equal(verified.status, 'ok');
  assert.equal(verified.error, null);
  assert.equal(verified.id, saved.id, 'the same connector, not a new one');
  await assert.rejects(ctx.api.verify({ id: 'unknown' }), (error) => error.status === 404);
});

test('repositories are fetched with the token in the header and returned without it', async (t) => {
  const ctx = await setup(t);
  const rows = [
    { full_name: 'octo/site', clone_url: 'https://github.com/octo/site.git', ssh_url: 'git@github.com:octo/site.git', html_url: 'https://github.com/octo/site', default_branch: 'main', private: false, pushed_at: '2026-01-01T00:00:00Z', description: 'a site', language: 'JavaScript' },
    { full_name: 'octo/api', clone_url: 'https://github.com/octo/api.git', ssh_url: 'git@github.com:octo/api.git', html_url: 'https://github.com/octo/api', default_branch: 'main', private: true, pushed_at: '2026-01-02T00:00:00Z', description: '', language: 'Go' },
  ];
  const calls = stubFetch(t, (url) => reply(200, url.endsWith('/user') ? GITHUB_USER : rows));

  const saved = await ctx.api.save({ kind: 'github', name: 'Work', token: 'ghp_pretend_secret' });
  const { repos, connector } = await ctx.api.repos({ id: saved.id });
  assert.deepEqual(repos.map((r) => r.name), ['octo/site', 'octo/api']);
  assert.deepEqual(repos[1], { name: 'octo/api', url: rows[1].clone_url, sshUrl: rows[1].ssh_url, webUrl: rows[1].html_url, defaultBranch: 'main', private: true, pushedAt: rows[1].pushed_at, description: '', language: 'Go' });
  assert.equal(connector.secretName, 'GITHUB_TOKEN_WORK');

  const listCall = calls.at(-1);
  assert.equal(listCall.headers.authorization, 'Bearer ghp_pretend_secret', 'the token only ever leaves as a request header');
  assert.equal(JSON.stringify({ repos, connector }).includes('ghp_pretend_secret'), false);

  const filtered = await ctx.api.repos({ id: saved.id, q: 'API' });
  assert.deepEqual(filtered.repos.map((r) => r.name), ['octo/api'], 'the query filter is case-insensitive');
  await assert.rejects(ctx.api.repos({ id: 'unknown' }), (error) => error.status === 404);
});

test('an unreachable provider is reported as such, not as a crash', async (t) => {
  const ctx = await setup(t);
  stubFetch(t, () => { throw new Error('getaddrinfo ENOTFOUND git.acme.example'); });
  const saved = await ctx.api.save({ kind: 'github', name: 'Offline', baseUrl: 'https://git.acme.example', token: 'ghp_pretend' });
  assert.equal(saved.status, 'error');
  assert.match(saved.error, /unreachable/);
});

test('removing a connector keeps its vault secret unless the user asks for it', async (t) => {
  const ctx = await setup(t);
  stubFetch(t, () => reply(200, GITHUB_USER));
  const keep = await ctx.api.save({ kind: 'github', name: 'Keep', token: 'ghp_keep' });
  const drop = await ctx.api.save({ kind: 'github', name: 'Drop', token: 'ghp_drop' });

  await ctx.api.remove({ id: keep.id });
  assert.equal(ctx.vault.GITHUB_TOKEN_KEEP, 'ghp_keep', 'other repositories may still reference the secret');

  await ctx.api.remove({ id: drop.id, deleteSecret: true });
  assert.equal(Object.hasOwn(ctx.vault, 'GITHUB_TOKEN_DROP'), false);

  assert.deepEqual((await ctx.api.list()).connectors, []);
  assert.deepEqual(ctx.audits.map((a) => a.action), ['connector-add', 'connector-add', 'connector-remove', 'connector-remove']);
  assert.equal(ctx.events.at(-1).payload.removed, drop.id);
  await assert.rejects(ctx.api.remove({ id: keep.id }), (error) => error.status === 404);
});

test('connectors saved before are still there after a restart, and removal never blocks', async (t) => {
  const ctx = await setup(t);
  stubFetch(t, () => reply(200, GITHUB_USER));
  await ctx.api.save({ kind: 'github', name: 'Work', token: 'ghp_pretend' });
  assert.equal(ctx.instance.busy(), false, 'nothing runs in the background, so removal is always safe');
  await ctx.instance.deactivate();

  const again = await activate(ctx.host);
  t.after(() => again.deactivate());
  const listed = await again.methods.list();
  assert.deepEqual(listed.connectors.map((c) => c.name), ['Work']);
  assert.equal(listed.connectors[0].secretName, 'GITHUB_TOKEN_WORK');
});

test('an unreadable connectors.json starts empty instead of destroying it', async (t) => {
  const ctx = createTestHost(t);
  fs.writeFileSync(ctx.file, '{ not json');
  const instance = await activate(ctx.host);
  t.after(() => instance.deactivate());

  assert.deepEqual((await instance.methods.list()).connectors, []);
  assert.match(ctx.logs.at(-1).message, /not readable/);
  assert.equal(fs.readFileSync(ctx.file, 'utf8'), '{ not json', 'the file is left exactly as it was until something is saved');
});
