'use strict';
/* Connectors: saved accounts on git providers (GitHub, GitLab) backed by a personal access token in the
   vault. A connector is verified against the provider's /user endpoint, lists the repositories the token
   can see, and hands a repository over to "connect a repository" with the right token reference. Tokens
   never leave the vault; the API only ever returns the secret name. */

const express = require('express');
const crypto = require('crypto');

const PROVIDERS = {
  github: {
    id: 'github', label: 'GitHub', defaultBase: 'https://api.github.com', web: 'https://github.com',
    tokenHint: 'Fine-grained or classic personal access token with repository read access (Settings → Developer settings → Personal access tokens).',
    headers: (token) => ({ authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'server-tools-connectors/1.0' }),
    userPath: '/user',
    parseUser: (j, res) => ({ login: j.login, name: j.name || j.login, url: j.html_url, avatar: j.avatar_url, scopes: (res.headers.get('x-oauth-scopes') || '').split(',').map((s) => s.trim()).filter(Boolean) }),
    reposPath: (q) => `/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member${q ? '' : ''}`,
    parseRepos: (rows, q) => rows.filter((r) => !q || r.full_name.toLowerCase().includes(q)).map((r) => ({ name: r.full_name, url: r.clone_url, sshUrl: r.ssh_url, webUrl: r.html_url, defaultBranch: r.default_branch, private: !!r.private, pushedAt: r.pushed_at, description: r.description || '', language: r.language || '' })),
  },
  gitlab: {
    id: 'gitlab', label: 'GitLab', defaultBase: 'https://gitlab.com', web: 'https://gitlab.com',
    tokenHint: 'Personal access token with the read_api and read_repository scopes (User settings → Access tokens). Self-managed instances: set the base URL.',
    headers: (token) => ({ 'private-token': token, accept: 'application/json', 'user-agent': 'server-tools-connectors/1.0' }),
    userPath: '/api/v4/user',
    parseUser: (j) => ({ login: j.username, name: j.name || j.username, url: j.web_url, avatar: j.avatar_url, scopes: [] }),
    reposPath: (q) => `/api/v4/projects?membership=true&per_page=100&order_by=last_activity_at&simple=true${q ? '&search=' + encodeURIComponent(q) : ''}`,
    parseRepos: (rows) => rows.map((r) => ({ name: r.path_with_namespace, url: r.http_url_to_repo, sshUrl: r.ssh_url_to_repo, webUrl: r.web_url, defaultBranch: r.default_branch, private: r.visibility !== 'public', pushedAt: r.last_activity_at, description: r.description || '', language: '' })),
  },
};

const normBase = (kind, baseUrl) => {
  const b = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!b) return PROVIDERS[kind].defaultBase;
  if (!/^https?:\/\/[^\s/]+/.test(b)) { const e = new Error('baseUrl must be an http(s) URL'); e.status = 400; throw e; }
  // GitHub Enterprise exposes the API under /api/v3
  if (kind === 'github' && !/api\.github\.com|\/api\/v3$/.test(b)) return b + '/api/v3';
  return b;
};
const slug = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'DEFAULT';
const friendly = (status, kind) => status === 401 ? `${PROVIDERS[kind].label} rejected the token (expired, revoked or wrong instance).`
  : status === 403 ? `${PROVIDERS[kind].label} refused the request: the token lacks the required scope or hit a rate limit.`
  : status === 404 ? 'The API endpoint was not found: check the base URL.' : `HTTP ${status} from ${PROVIDERS[kind].label}.`;

function createConnectors({ ctx, stores, vault, fetchImpl = fetch }) {
  const store = stores.connectors;
  const list = () => store.get().connectors;
  const find = (id) => list().find((c) => c.id === id);
  const mask = (c) => ({ ...c, tokenRef: c.tokenRef, secretName: c.tokenRef.replace(/^\$\{vault:|\}$/g, '') });
  const tokenOf = (c) => vault.get(c.tokenRef.replace(/^\$\{vault:|\}$/g, ''));

  async function call(c, path) {
    const p = PROVIDERS[c.kind];
    let res;
    try { res = await fetchImpl(c.baseUrl + path, { headers: p.headers(tokenOf(c)) }); }
    catch (e) { const err = new Error(`${p.label} is unreachable: ${e.message}`); err.status = 502; throw err; }
    if (!res.ok) { const err = new Error(friendly(res.status, c.kind)); err.status = res.status === 401 || res.status === 403 ? 400 : 502; err.upstream = res.status; throw err; }
    return { json: await res.json(), res };
  }
  /** Verify the token, record the account; never throws for provider errors (the status is stored instead). */
  async function verify(c) {
    const p = PROVIDERS[c.kind];
    try {
      const { json, res } = await call(c, p.userPath);
      Object.assign(c, { account: p.parseUser(json, res), status: 'ok', error: null, verifiedAt: new Date().toISOString() });
    } catch (e) { Object.assign(c, { status: 'error', error: e.message, verifiedAt: new Date().toISOString() }); }
    await store.save();
    return c;
  }
  async function repos(c, q) {
    const p = PROVIDERS[c.kind];
    const { json } = await call(c, p.reposPath(q));
    return p.parseRepos(Array.isArray(json) ? json : [], String(q || '').toLowerCase());
  }

  function sanitize(body, existing) {
    const err = (m) => { throw ctx.httpError(400, m); };
    const kind = String(body.kind || existing?.kind || '');
    if (!PROVIDERS[kind]) err(`kind must be one of ${Object.keys(PROVIDERS).join(', ')}`);
    const name = String(body.name || existing?.name || PROVIDERS[kind].label).trim();
    if (!name || name.length > 60) err('name is required (max 60 chars)');
    if (list().some((c) => c.name === name && c.id !== existing?.id)) err(`a connector named "${name}" already exists`);
    let baseUrl; try { baseUrl = normBase(kind, body.baseUrl ?? existing?.baseUrl); } catch (e) { err(e.message); }
    let tokenRef = existing?.tokenRef || null;
    if (body.token) { // a pasted token becomes a vault secret; the connector only keeps the reference
      const secretName = String(body.secretName || `${kind.toUpperCase()}_TOKEN_${slug(name)}`);
      if (!/^[A-Z0-9_]{2,64}$/.test(secretName)) err('secretName must be UPPER_SNAKE_CASE');
      vault.set(secretName, String(body.token).trim());
      tokenRef = `\${vault:${secretName}}`;
    } else if (body.tokenRef) {
      if (!/^\$\{vault:[A-Z0-9_]+\}$/.test(body.tokenRef)) err('tokenRef must be a ${vault:NAME} reference');
      if (!vault.has(body.tokenRef.replace(/^\$\{vault:|\}$/g, ''))) err('that secret does not exist in the vault');
      tokenRef = body.tokenRef;
    }
    if (!tokenRef) err('paste a personal access token or pick an existing vault secret');
    return { id: existing?.id || crypto.randomUUID(), kind, name, baseUrl, tokenRef, account: existing?.account || null, status: existing?.status || 'unverified', error: null, verifiedAt: existing?.verifiedAt || null, createdAt: existing?.createdAt || new Date().toISOString() };
  }

  const router = express.Router();
  const { wrap, httpError } = ctx;
  router.get('/', (req, res) => res.json({ connectors: list().map(mask), providers: Object.values(PROVIDERS).map((p) => ({ id: p.id, label: p.label, defaultBase: p.defaultBase, web: p.web, tokenHint: p.tokenHint })) }));
  router.post('/', wrap(async (req, res) => {
    const c = sanitize(req.body || {}, null);
    list().push(c); await store.save();
    await verify(c);
    ctx.audit({ action: 'connector-add', connector: c.name, kind: c.kind, status: c.status });
    ctx.logEvent(c.status === 'ok' ? 'info' : 'warn', `Connector "${c.name}" (${c.kind}) added: ${c.status === 'ok' ? `verified as ${c.account?.login}` : c.error}`);
    res.status(201).json(mask(c));
  }));
  router.put('/:id', wrap(async (req, res) => {
    const cur = find(req.params.id); if (!cur) throw httpError(404, 'connector not found');
    const next = sanitize(req.body || {}, cur);
    Object.assign(cur, next, { id: cur.id, createdAt: cur.createdAt });
    await store.save(); await verify(cur);
    ctx.audit({ action: 'connector-update', connector: cur.name, kind: cur.kind, status: cur.status });
    res.json(mask(cur));
  }));
  router.post('/:id/verify', wrap(async (req, res) => { const c = find(req.params.id); if (!c) throw httpError(404, 'connector not found'); await verify(c); ctx.audit({ action: 'connector-verify', connector: c.name, kind: c.kind, status: c.status }); res.json(mask(c)); }));
  router.get('/:id/repos', wrap(async (req, res) => {
    const c = find(req.params.id); if (!c) throw httpError(404, 'connector not found');
    try { const rows = await repos(c, String(req.query.q || '')); res.json({ repos: rows, connector: mask(c) }); }
    catch (e) { throw httpError(e.status || 502, e.message); }
  }));
  router.delete('/:id', wrap(async (req, res) => {
    const i = list().findIndex((c) => c.id === req.params.id); if (i < 0) throw httpError(404, 'connector not found');
    const [c] = list().splice(i, 1); await store.save();
    if (req.query.deleteSecret === '1') { try { vault.remove(c.tokenRef.replace(/^\$\{vault:|\}$/g, '')); } catch {} }
    ctx.audit({ action: 'connector-remove', connector: c.name, kind: c.kind });
    res.json({ ok: true });
  }));

  return { router, PROVIDERS, verify, repos, sanitize, normBase, slug, list };
}

module.exports = { createConnectors, PROVIDERS, normBase, slug };
