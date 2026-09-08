'use strict';
/* Connectors: token → vault secret, provider verification and repository listing with a fake fetch. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeCtx, deps } = require('./helpers');
const { createConnectors, normBase, slug } = require('../../lib/deploy/connectors');

const jsonRes = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] || null }, json: async () => body });

function setup(handler) {
  const ctx = fakeCtx();
  const d = deps(ctx);
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, headers: opts.headers }); return handler(url, opts); };
  const c = createConnectors({ ctx, stores: d.stores, vault: d.vault, fetchImpl });
  return { ctx, d, c, calls };
}

test('base URL normalization and secret naming', () => {
  assert.equal(normBase('github', ''), 'https://api.github.com');
  assert.equal(normBase('github', 'https://ghe.example.com/'), 'https://ghe.example.com/api/v3');
  assert.equal(normBase('gitlab', 'https://git.example.com/'), 'https://git.example.com');
  assert.throws(() => normBase('gitlab', 'not a url'), /http\(s\) URL/);
  assert.equal(slug('My GitHub (work)'), 'MY_GITHUB_WORK');
});

test('GitHub: a pasted token lands in the vault, /user verifies the account, repos are listed', async () => {
  const { ctx, d, c, calls } = setup((url) => {
    if (url.endsWith('/user')) return jsonRes(200, { login: 'octo', name: 'Octo Cat', html_url: 'https://github.com/octo', avatar_url: 'https://a/x.png' }, { 'x-oauth-scopes': 'repo, read:org' });
    if (url.includes('/user/repos')) return jsonRes(200, [{ full_name: 'octo/site', clone_url: 'https://github.com/octo/site.git', ssh_url: 'git@github.com:octo/site.git', html_url: 'https://github.com/octo/site', default_branch: 'main', private: true, pushed_at: '2026-09-01T00:00:00Z', description: 'Site', language: 'PHP' }]);
    return jsonRes(404, {});
  });
  const conn = c.sanitize({ kind: 'github', name: 'Work GitHub', token: 'ghp_secret' }, null);
  assert.equal(conn.tokenRef, '${vault:GITHUB_TOKEN_WORK_GITHUB}');
  assert.equal(d.vault.get('GITHUB_TOKEN_WORK_GITHUB'), 'ghp_secret');
  c.list().push(conn);
  await c.verify(conn);
  assert.equal(conn.status, 'ok'); assert.equal(conn.account.login, 'octo'); assert.deepEqual(conn.account.scopes, ['repo', 'read:org']);
  assert.equal(calls[0].headers.authorization, 'Bearer ghp_secret');
  const repos = await c.repos(conn, '');
  assert.equal(repos.length, 1); assert.equal(repos[0].name, 'octo/site'); assert.equal(repos[0].defaultBranch, 'main'); assert.equal(repos[0].private, true);
  assert.ok(!JSON.stringify(ctx._audits).includes('ghp_secret'));
});

test('GitLab: private-token header, self-managed base URL, friendly 401', async () => {
  const { d, c } = setup((url) => (url.endsWith('/api/v4/user') ? jsonRes(401, {}) : jsonRes(200, [])));
  d.vault.set('GL_TOKEN', 'glpat-x');
  const conn = c.sanitize({ kind: 'gitlab', name: 'Company GitLab', baseUrl: 'https://git.example.com/', tokenRef: '${vault:GL_TOKEN}' }, null);
  assert.equal(conn.baseUrl, 'https://git.example.com');
  c.list().push(conn);
  await c.verify(conn);
  assert.equal(conn.status, 'error'); assert.match(conn.error, /rejected the token/);
  assert.throws(() => c.sanitize({ kind: 'gitlab', name: 'x', tokenRef: '${vault:MISSING}' }, null), /does not exist in the vault/);
  assert.throws(() => c.sanitize({ kind: 'gitlab', name: 'Company GitLab', token: 't' }, null), /already exists/);
  assert.throws(() => c.sanitize({ kind: 'bitbucket', name: 'x', token: 't' }, null), /kind must be one of/);
});
