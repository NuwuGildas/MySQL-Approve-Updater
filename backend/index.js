'use strict';
/* Git Connectors - backend.
 *
 * A connector is a saved account on a git provider whose personal access token
 * lives in the host's encrypted vault. The token never leaves this process
 * except as an Authorization header to the provider: the API only ever returns
 * the secret's NAME.
 *
 * This module is independent of Deployments. It shares the vault with it, which
 * is host infrastructure, not a dependency: connectors are usable on their own,
 * and removing Deployments does not take them with it.
 *
 * connectors.json already exists for users who had this feature built in, so it
 * is read from the application's data directory rather than started empty. */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const PROVIDERS = {
  github: {
    id: 'github', label: 'GitHub', defaultBase: 'https://api.github.com', web: 'https://github.com',
    tokenHint: 'Fine-grained or classic personal access token with repository read access (Settings → Developer settings → Personal access tokens).',
    headers: (token) => ({ authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'server-tools-connectors/1.0' }),
    userPath: '/user',
    parseUser: (json, response) => ({ login: json.login, name: json.name || json.login, url: json.html_url, avatar: json.avatar_url, scopes: (response.headers.get('x-oauth-scopes') || '').split(',').map((s) => s.trim()).filter(Boolean) }),
    reposPath: () => '/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member',
    parseRepos: (rows, q) => rows.filter((r) => !q || r.full_name.toLowerCase().includes(q)).map((r) => ({ name: r.full_name, url: r.clone_url, sshUrl: r.ssh_url, webUrl: r.html_url, defaultBranch: r.default_branch, private: !!r.private, pushedAt: r.pushed_at, description: r.description || '', language: r.language || '' })),
  },
  gitlab: {
    id: 'gitlab', label: 'GitLab', defaultBase: 'https://gitlab.com', web: 'https://gitlab.com',
    tokenHint: 'Personal access token with the read_api and read_repository scopes (User settings → Access tokens). Self-managed instances: set the base URL.',
    headers: (token) => ({ 'private-token': token, accept: 'application/json', 'user-agent': 'server-tools-connectors/1.0' }),
    userPath: '/api/v4/user',
    parseUser: (json) => ({ login: json.username, name: json.name || json.username, url: json.web_url, avatar: json.avatar_url, scopes: [] }),
    reposPath: (q) => `/api/v4/projects?membership=true&per_page=100&order_by=last_activity_at&simple=true${q ? '&search=' + encodeURIComponent(q) : ''}`,
    parseRepos: (rows) => rows.map((r) => ({ name: r.path_with_namespace, url: r.http_url_to_repo, sshUrl: r.ssh_url_to_repo, webUrl: r.web_url, defaultBranch: r.default_branch, private: r.visibility !== 'public', pushedAt: r.last_activity_at, description: r.description || '', language: '' })),
  },
};

const fail = (status, message) => Object.assign(new Error(message), { status });
const slug = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'DEFAULT';
const secretNameOf = (ref) => String(ref || '').replace(/^\$\{vault:|\}$/g, '');

function normBase(kind, baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return PROVIDERS[kind].defaultBase;
  if (!/^https?:\/\/[^\s/]+/.test(base)) throw fail(400, 'baseUrl must be an http(s) URL');
  // GitHub Enterprise exposes the API under /api/v3
  if (kind === 'github' && !/api\.github\.com|\/api\/v3$/.test(base)) return base + '/api/v3';
  return base;
}

const friendly = (status, kind) => status === 401 ? `${PROVIDERS[kind].label} rejected the token (expired, revoked or wrong instance).`
  : status === 403 ? `${PROVIDERS[kind].label} refused the request: the token lacks the required scope or hit a rate limit.`
  : status === 404 ? 'The API endpoint was not found: check the base URL.' : `HTTP ${status} from ${PROVIDERS[kind].label}.`;

async function activate(host) {
  /* The file users already have keeps its place; a fresh install creates it there too. */
  const file = path.join(host.appDataDir || host.dataDir, 'connectors.json');
  let data = { connectors: [] };
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') host.log('warn', `connectors.json is not readable (${error.message}); starting empty`); }
  if (!Array.isArray(data.connectors)) data = { connectors: [] };

  let chain = Promise.resolve();
  function save() {
    const snapshot = JSON.stringify(data, null, 2);
    chain = chain.then(async () => {
      const tmp = `${file}.tmp`;
      await fsp.writeFile(tmp, snapshot, 'utf8');
      await fsp.rename(tmp, file);
    }).catch((error) => host.log('error', `connectors.json could not be saved: ${error.message}`));
    return chain;
  }

  const list = () => data.connectors;
  const find = (id) => list().find((c) => c.id === id);
  const mask = (c) => ({ ...c, secretName: secretNameOf(c.tokenRef) });
  const tokenOf = (c) => host.call('vault.get', { name: secretNameOf(c.tokenRef) });

  async function call(connector, apiPath) {
    const provider = PROVIDERS[connector.kind];
    let response;
    try { response = await fetch(connector.baseUrl + apiPath, { headers: provider.headers(await tokenOf(connector)) }); }
    catch (error) { throw fail(502, `${provider.label} is unreachable: ${error.message}`); }
    if (!response.ok) throw fail(response.status === 401 || response.status === 403 ? 400 : 502, friendly(response.status, connector.kind));
    return { json: await response.json(), response };
  }

  /** Verify the token and record the account. Provider errors are stored, not thrown. */
  async function verify(connector) {
    const provider = PROVIDERS[connector.kind];
    try {
      const { json, response } = await call(connector, provider.userPath);
      Object.assign(connector, { account: provider.parseUser(json, response), status: 'ok', error: null, verifiedAt: new Date().toISOString() });
    } catch (error) {
      Object.assign(connector, { status: 'error', error: error.message, verifiedAt: new Date().toISOString() });
    }
    await save();
    return connector;
  }

  async function sanitize(body, existing) {
    const kind = String(body.kind || existing?.kind || '');
    if (!PROVIDERS[kind]) throw fail(400, `kind must be one of ${Object.keys(PROVIDERS).join(', ')}`);
    const name = String(body.name || existing?.name || PROVIDERS[kind].label).trim();
    if (!name || name.length > 60) throw fail(400, 'name is required (max 60 chars)');
    if (list().some((c) => c.name === name && c.id !== existing?.id)) throw fail(400, `a connector named "${name}" already exists`);
    const baseUrl = normBase(kind, body.baseUrl ?? existing?.baseUrl);

    let tokenRef = existing?.tokenRef || null;
    if (body.token) {
      // A pasted token becomes a vault secret; the connector only keeps the reference.
      const secretName = String(body.secretName || `${kind.toUpperCase()}_TOKEN_${slug(name)}`);
      if (!/^[A-Z0-9_]{2,64}$/.test(secretName)) throw fail(400, 'secretName must be UPPER_SNAKE_CASE');
      await host.call('vault.set', { name: secretName, value: String(body.token).trim() });
      tokenRef = `\${vault:${secretName}}`;
    } else if (body.tokenRef) {
      if (!/^\$\{vault:[A-Z0-9_]+\}$/.test(body.tokenRef)) throw fail(400, 'tokenRef must be a ${vault:NAME} reference');
      if (!(await host.call('vault.has', { name: secretNameOf(body.tokenRef) }))) throw fail(400, 'that secret does not exist in the vault');
      tokenRef = body.tokenRef;
    }
    if (!tokenRef) throw fail(400, 'paste a personal access token or pick an existing vault secret');

    return {
      id: existing?.id || crypto.randomUUID(), kind, name, baseUrl, tokenRef,
      account: existing?.account || null, status: existing?.status || 'unverified', error: null,
      verifiedAt: existing?.verifiedAt || null, createdAt: existing?.createdAt || new Date().toISOString(),
    };
  }

  return {
    methods: {
      list: async () => ({
        connectors: list().map(mask),
        providers: Object.values(PROVIDERS).map((p) => ({ id: p.id, label: p.label, defaultBase: p.defaultBase, web: p.web, tokenHint: p.tokenHint })),
      }),
      /** Vault secret names, so the form can offer a token that is already stored. */
      secrets: async () => ({ secrets: await host.call('vault.names', {}) }),

      save: async (body) => {
        const existing = body.id ? find(body.id) : null;
        if (body.id && !existing) throw fail(404, 'connector not found');
        const next = await sanitize(body, existing);
        if (existing) Object.assign(existing, next, { id: existing.id, createdAt: existing.createdAt });
        else list().push(next);
        await save();
        const connector = existing || find(next.id);
        await verify(connector);
        await host.audit({ action: existing ? 'connector-update' : 'connector-add', connector: connector.name, kind: connector.kind, status: connector.status });
        host.log(connector.status === 'ok' ? 'info' : 'warn', `Connector "${connector.name}" (${connector.kind}) ${existing ? 'updated' : 'added'}: ${connector.status === 'ok' ? `verified as ${connector.account?.login}` : connector.error}`);
        host.emit('changed', { id: connector.id });
        return mask(connector);
      },

      verify: async ({ id }) => {
        const connector = find(id);
        if (!connector) throw fail(404, 'connector not found');
        await verify(connector);
        await host.audit({ action: 'connector-verify', connector: connector.name, kind: connector.kind, status: connector.status });
        return mask(connector);
      },

      repos: async ({ id, q }) => {
        const connector = find(id);
        if (!connector) throw fail(404, 'connector not found');
        const provider = PROVIDERS[connector.kind];
        const { json } = await call(connector, provider.reposPath(q));
        return { repos: provider.parseRepos(Array.isArray(json) ? json : [], String(q || '').toLowerCase()), connector: mask(connector) };
      },

      remove: async ({ id, deleteSecret }) => {
        const index = list().findIndex((c) => c.id === id);
        if (index < 0) throw fail(404, 'connector not found');
        const [connector] = list().splice(index, 1);
        await save();
        // The secret stays unless asked for: repositories already connected reference it.
        if (deleteSecret) { try { await host.call('vault.remove', { name: secretNameOf(connector.tokenRef) }); } catch { /* already gone */ } }
        await host.audit({ action: 'connector-remove', connector: connector.name, kind: connector.kind });
        host.emit('changed', { removed: id });
        return { ok: true };
      },
    },

    /* Nothing here runs in the background, so removal is always safe. */
    busy: () => false,
    async deactivate() { await chain; },
  };
}

module.exports = { activate, PROVIDERS, normBase, slug };
