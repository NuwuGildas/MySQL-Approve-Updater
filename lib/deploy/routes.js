'use strict';
/* REST API under /api/deploy. Secrets never leave the server: targets and
   repos are masked (vault refs shown by name), vault values are write-only. */

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { adapterFor, TARGETS } = require('./targets');
const { STACKS } = require('./stacks');
const { detect } = require('./detect');
const manifestLib = require('./manifest');
const git = require('./git');
const templates = require('./templates');
const { probeTool } = require('./exec');
const { isRef, refName, NAME_RE } = require('./vault');
const frameworks = require('./frameworks');

function maskRepo(r) {
  const s = { ...r.source };
  if (s.auth?.kind === 'https-token') s.auth = { kind: 'https-token', tokenRef: s.auth.tokenRef, user: s.auth.user || null };
  return { ...r, source: s };
}
function maskTarget(t, engine) {
  const out = JSON.parse(JSON.stringify(t));
  if (out.transport?.passwordRef) out.transport.passwordRef = out.transport.passwordRef; // already a ref, not a value
  out.locked = engine.isLocked(t.id);
  return out;
}

function sanitizeRepo(body, ctx, vault, existing) {
  const err = (m) => { throw ctx.httpError(400, m); };
  const name = String(body.name || '').trim();
  if (!name || name.length > 80) err('name is required (max 80 chars)');
  const src = body.source || {};
  let source;
  if (src.kind === 'local') {
    const p = String(src.path || '').trim();
    if (!p || !path.isAbsolute(p)) err('source.path must be an absolute folder path');
    source = { kind: 'local', path: p };
  } else if (src.kind === 'git') {
    const url = String(src.url || '').trim();
    if (!/^(https?:\/\/|git@|ssh:\/\/|[\w.-]+@[\w.-]+:)/.test(url)) err('source.url must be an https:// or ssh git URL');
    const branch = String(src.branch || '').trim() || null;
    if (branch && !/^[\w./+-]+$/.test(branch)) err('source.branch has invalid characters');
    let auth = null;
    if (src.auth?.kind === 'https-token') {
      if (!isRef(src.auth.tokenRef)) err('source.auth.tokenRef must be a ${vault:NAME} reference');
      if (!vault.has(refName(src.auth.tokenRef))) err(`secret ${refName(src.auth.tokenRef)} does not exist in the vault`);
      auth = { kind: 'https-token', tokenRef: src.auth.tokenRef, user: src.auth.user ? String(src.auth.user) : null };
    } else if (src.auth?.kind === 'ssh') {
      auth = { kind: 'ssh', keyPath: src.auth.keyPath ? String(src.auth.keyPath) : null };
    }
    source = { kind: 'git', url, branch, auth };
  } else err('source.kind must be git or local');
  let manifest = existing?.manifest || null;
  if (body.manifest !== undefined) manifest = body.manifest ? manifestLib.compact(manifestLib.validate(body.manifest)) : null;
  return { id: existing?.id || crypto.randomUUID(), name, source, manifest, lastFetch: existing?.lastFetch || null, provider: existing?.provider || null, createdAt: existing?.createdAt || new Date().toISOString() };
}

function sanitizeTarget(body, ctx, stores, existing) {
  const err = (m) => { throw ctx.httpError(400, m); };
  const name = String(body.name || '').trim();
  if (!name || name.length > 80) err('name is required (max 80 chars)');
  if (!/^[\w][\w .-]*$/.test(name)) err('name may contain letters, digits, spaces, dots, dashes and underscores');
  if (stores.targets.get().targets.some((t) => t.name === name && t.id !== existing?.id)) err(`a target named "${name}" already exists`);
  const repoId = String(body.repoId || existing?.repoId || '');
  if (!stores.findRepo(repoId)) err('repoId must reference a connected repo');
  if (!TARGETS[body.type]) err(`type must be one of ${Object.keys(TARGETS).join(', ')}`);
  let overrides = null;
  if (body.overrides != null && body.overrides !== '') {
    overrides = body.overrides;
    if (typeof overrides === 'string') { try { overrides = JSON.parse(overrides); } catch { err('overrides must be valid JSON'); } }
    manifestLib.validate(overrides); // must be a valid fragment
  }
  const draft = { ...body, id: existing?.id || crypto.randomUUID(), name, repoId, overrides, createdAt: existing?.createdAt || new Date().toISOString() };
  delete draft.locked; delete draft.lastRun;
  const norm = adapterFor(draft).validate(draft, ctx);
  norm.autoShip = require('./webhooks').normalizeAutoShip(body, existing);
  return norm;
}

/** Targets never expose the webhook secret in list responses; it is fetched on demand. */
function maskAutoShip(t) {
  if (!t.autoShip) return t;
  return { ...t, autoShip: { ...t.autoShip, secret: undefined, hasSecret: !!t.autoShip.secret } };
}

/* ---- git provider browsing (token from the vault; no OAuth app registration needed) ---- */
async function providerRepos(kind, token, query) {
  const headers = { accept: 'application/json', 'user-agent': 'server-tools-deploy/1.0' };
  const get = async (url) => { const r = await fetch(url, { headers }); if (!r.ok) throw Object.assign(new Error(`${kind} API ${r.status}: ${(await r.text()).slice(0, 200)}`), { status: 400 }); return r.json(); };
  if (kind === 'github') {
    headers.authorization = `Bearer ${token}`; headers['x-github-api-version'] = '2022-11-28';
    const rows = await get(`https://api.github.com/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member`);
    return rows.filter((r) => !query || r.full_name.toLowerCase().includes(query)).map((r) => ({ name: r.full_name, url: r.clone_url, sshUrl: r.ssh_url, defaultBranch: r.default_branch, private: r.private, pushedAt: r.pushed_at, description: r.description || '' }));
  }
  if (kind === 'gitlab') {
    headers['private-token'] = token;
    const rows = await get(`https://gitlab.com/api/v4/projects?membership=true&per_page=100&order_by=last_activity_at&simple=true${query ? '&search=' + encodeURIComponent(query) : ''}`);
    return rows.map((r) => ({ name: r.path_with_namespace, url: r.http_url_to_repo, sshUrl: r.ssh_url_to_repo, defaultBranch: r.default_branch, private: r.visibility !== 'public', pushedAt: r.last_activity_at, description: r.description || '' }));
  }
  if (kind === 'bitbucket') {
    headers.authorization = `Bearer ${token}`;
    const j = await get('https://api.bitbucket.org/2.0/repositories?role=member&pagelen=100&sort=-updated_on');
    return (j.values || []).filter((r) => !query || r.full_name.toLowerCase().includes(query)).map((r) => ({ name: r.full_name, url: (r.links?.clone || []).find((c) => c.name === 'https')?.href, sshUrl: (r.links?.clone || []).find((c) => c.name === 'ssh')?.href, defaultBranch: r.mainbranch?.name, private: r.is_private, pushedAt: r.updated_on, description: r.description || '' }));
  }
  throw Object.assign(new Error('provider must be github, gitlab or bitbucket'), { status: 400 });
}

function createRouter({ ctx, engine, stores, vault, redact, agentApi, autoShip, cloud, config }) {
  const r = express.Router();
  const { wrap, httpError } = ctx;
  const audit = (entry) => ctx.audit(entry);
  const autoRefresh = () => { try { autoShip?.refresh(); } catch (e) { ctx.logEvent('warn', `auto-ship refresh failed: ${e.message}`); } };

  /* ---- provider browsing + auto-ship status ---- */
  r.get('/providers/repos', wrap(async (req, res) => {
    const kind = String(req.query.kind || ''); const ref = String(req.query.tokenRef || '');
    if (!isRef(ref)) throw httpError(400, 'tokenRef must be a ${vault:NAME} reference');
    const repos = await providerRepos(kind, vault.get(refName(ref)), String(req.query.q || '').toLowerCase());
    res.json({ repos });
  }));
  r.get('/autoship', (req, res) => res.json(autoShip ? autoShip.status() : { listener: null, pollers: [] }));

  /* ---- cloud provisioning ---- */
  r.get('/cloud/providers', (req, res) => res.json({ providers: cloud.providers(), recipes: cloud.recipes() }));
  r.get('/cloud/options', wrap(async (req, res) => {
    const provider = String(req.query.provider || ''); const tokenRef = String(req.query.tokenRef || '');
    if (tokenRef && !isRef(tokenRef)) throw httpError(400, 'tokenRef must be a ${vault:NAME} reference');
    try { res.json(await cloud.options(provider, tokenRef)); } catch (e) { throw httpError(e.status || 502, e.message); }
  }));
  r.post('/cloud/preview', (req, res) => { try { res.type('text/plain').send(cloud.preview(req.body || {})); } catch (e) { throw httpError(e.status || 400, e.message); } });
  r.get('/cloud/servers', (req, res) => res.json({ servers: cloud.list() }));
  r.post('/cloud/provision', wrap(async (req, res) => {
    let job;
    try { job = await cloud.provision(req.body || {}); } catch (e) { throw httpError(e.status || 400, e.message); }
    res.status(202).json({ jobId: job.id, job: job.toJSON() });
  }));
  r.get('/cloud/jobs/:id', (req, res) => { const j = cloud.getJob(req.params.id); if (!j) throw httpError(404, 'job not found'); res.json(j.toJSON()); });
  r.post('/cloud/jobs/:id/cancel', (req, res) => { if (!cloud.cancel(req.params.id)) throw httpError(409, 'job is not running'); res.json({ ok: true }); });
  r.delete('/cloud/servers/:id', wrap(async (req, res) => {
    try { res.json({ ok: true, server: await cloud.destroy(req.params.id) }); } catch (e) { throw httpError(e.status || 502, e.message); }
  }));
  r.get('/targets/:id/webhook', wrap(async (req, res) => {
    const t = stores.findTarget(req.params.id); if (!t) throw httpError(404, 'target not found');
    if (!t.autoShip?.enabled) return res.json({ enabled: false });
    const st = autoShip?.status();
    res.json({ enabled: true, mode: t.autoShip.mode, branch: t.autoShip.branch, pollMinutes: t.autoShip.pollMinutes, secret: t.autoShip.secret, url: st ? `http://${st.listener.bind}:${st.listener.port}/hooks/${t.id}` : null, listener: st?.listener || null, poller: st?.pollers.find((p) => p.targetId === t.id) || null });
  }));
  r.post('/targets/:id/poll-now', wrap(async (req, res) => {
    const t = stores.findTarget(req.params.id); if (!t) throw httpError(404, 'target not found');
    if (!t.autoShip?.enabled || t.autoShip.mode !== 'poll') throw httpError(400, 'polling is not enabled on this target');
    await autoShip.pollOnce(t);
    res.json({ ok: true, poller: autoShip.status().pollers.find((p) => p.targetId === t.id) || null });
  }));

  let toolsCache = { at: 0, tools: null };
  r.get('/status', wrap(async (req, res) => {
    // probing 8 binaries takes ~1-2 s; cache for a minute (the toolchain rarely changes while the app runs)
    if (!toolsCache.tools || Date.now() - toolsCache.at > 60000 || req.query.refresh === '1') {
      const tools = {};
      await Promise.all(Object.entries({ git: '--version', php: '-v', composer: '--version', node: '-v', npm: '-v', pnpm: '-v', yarn: '-v', docker: '--version', python3: '--version', uv: '--version' }).map(async ([t, arg]) => { tools[t] = await probeTool(t, arg); }));
      toolsCache = { at: Date.now(), tools };
    }
    const tools = toolsCache.tools;
    res.json({ git: { available: !!tools.git, version: tools.git }, tools, vault: { keySource: vault.keySource, file: path.basename(vault.file) }, activeRuns: engine.activeIds(), targetTypes: Object.values(TARGETS).map((t) => ({ id: t.id, label: t.label, capabilities: t.capabilities })), paasProviders: Object.values(TARGETS.paas.PROVIDERS).map((p) => ({ id: p.id, label: p.label, cli: p.cli, install: p.install, tokenEnv: p.tokenEnv, tokenHint: p.tokenHint, buildLocal: p.buildLocal, fields: p.fields })), stacks: STACKS.map((s) => ({ id: s.id, label: s.label })), ai: ctx.agent.isConnected(), aiAssist: { ...(ctx.settings.aiAssist || {}) }, platform: process.platform, autoShip: autoShip ? autoShip.status() : null });
  }));

  /* ---- repos ---- */
  r.get('/repos', (req, res) => res.json({ repos: stores.repos.get().repos.map(maskRepo) }));
  r.post('/repos', wrap(async (req, res) => {
    const repo = sanitizeRepo(req.body || {}, ctx, vault, null);
    stores.repos.get().repos.push(repo); await stores.repos.save();
    audit({ action: 'deploy-repo-add', repo: repo.name, kind: repo.source.kind });
    res.status(201).json(maskRepo(repo));
  }));
  r.put('/repos/:id', wrap(async (req, res) => {
    const list = stores.repos.get().repos; const i = list.findIndex((x) => x.id === req.params.id);
    if (i < 0) throw httpError(404, 'repo not found');
    list[i] = sanitizeRepo({ ...maskRepo(list[i]), ...req.body, source: req.body?.source || list[i].source }, ctx, vault, list[i]);
    await stores.repos.save();
    audit({ action: 'deploy-repo-update', repo: list[i].name });
    res.json(maskRepo(list[i]));
  }));
  r.delete('/repos/:id', wrap(async (req, res) => {
    const list = stores.repos.get().repos; const i = list.findIndex((x) => x.id === req.params.id);
    if (i < 0) throw httpError(404, 'repo not found');
    const used = stores.targets.get().targets.filter((t) => t.repoId === req.params.id);
    if (used.length) throw httpError(409, `repo is used by target(s): ${used.map((t) => t.name).join(', ')}`);
    const [repo] = list.splice(i, 1); await stores.repos.save();
    if (req.query.purgeWorkdir === '1') await require('fs/promises').rm(path.join(stores.workDir, repo.id), { recursive: true, force: true });
    audit({ action: 'deploy-repo-remove', repo: repo.name });
    res.json({ ok: true });
  }));
  r.post('/repos/:id/fetch', wrap(async (req, res) => {
    const repo = stores.findRepo(req.params.id); if (!repo) throw httpError(404, 'repo not found');
    if (repo.source.kind === 'local') { const info = await git.inspectLocal(repo.source.path); return res.json({ ...info, kind: 'local', path: repo.source.path }); }
    const token = repo.source.auth?.kind === 'https-token' ? vault.get(refName(repo.source.auth.tokenRef)) : null;
    const dir = path.join(stores.workDir, repo.id, 'src');
    const lines = [];
    let info;
    try { info = await git.sync(repo.source, dir, { ref: req.body?.ref, token, onLine: (l) => lines.push(redact(l)) }); }
    catch (e) { throw httpError(400, `git fetch failed: ${redact(e.message)}${lines.length ? ': ' + lines.slice(-3).join(' | ') : ''}`); }
    repo.lastFetch = { commit: info.commit, branch: info.branch, at: new Date().toISOString(), subject: info.subject }; await stores.repos.save();
    res.json({ ...info, kind: 'git' });
  }));
  r.get('/repos/:id/branches', wrap(async (req, res) => {
    const repo = stores.findRepo(req.params.id); if (!repo) throw httpError(404, 'repo not found');
    if (repo.source.kind !== 'git') return res.json({ branches: [] });
    const token = repo.source.auth?.kind === 'https-token' ? vault.get(refName(repo.source.auth.tokenRef)) : null;
    try { res.json({ branches: await git.listBranches(repo.source, { token }) }); }
    catch (e) { throw httpError(400, `ls-remote failed: ${redact(e.message)}`); }
  }));
  r.post('/repos/:id/detect', wrap(async (req, res) => {
    const repo = stores.findRepo(req.params.id); if (!repo) throw httpError(404, 'repo not found');
    const dir = repo.source.kind === 'local' ? repo.source.path : path.join(stores.workDir, repo.id, 'src');
    if (!require('fs').existsSync(dir)) throw httpError(409, repo.source.kind === 'local' ? `folder not found: ${dir}` : 'fetch the repo first');
    const det = await detect(dir);
    let suggestion = null;
    if (det.ambiguous && req.body?.ai && agentApi?.aiDetect && ctx.agent.isConnected()) {
      suggestion = await agentApi.aiDetect(det, null);
      audit({ action: 'deploy-ai-detect', repo: repo.name, confidence: suggestion?.confidence ?? null, ok: !!suggestion });
    }
    let resolved = null, resolveError = null;
    try { resolved = manifestLib.compact(manifestLib.resolve(det.best?.fragment, det.shipJson, repo.manifest)); } catch (e) { resolveError = e.message; }
    const { tree, keyFiles, ...rest } = det;
    res.json({ ...rest, tree: tree.slice(0, 150), suggestion, savedManifest: repo.manifest, resolved, resolveError, stacks: STACKS.map((s) => ({ id: s.id, label: s.label, type: s.type })) });
  }));
  r.get('/repos/:id/manifest', wrap(async (req, res) => {
    const repo = stores.findRepo(req.params.id); if (!repo) throw httpError(404, 'repo not found');
    res.json({ manifest: repo.manifest, example: manifestLib.compact(manifestLib.validate({ name: repo.name, stack: { type: 'php', framework: 'laravel', packageManager: 'composer' }, build: { steps: ['composer install --no-dev --optimize-autoloader'] }, shared: { files: ['.env'], dirs: ['storage'] }, runtime: { kind: 'php-fpm', docroot: 'public' }, health: { path: '/up' } })) });
  }));
  r.put('/repos/:id/manifest', wrap(async (req, res) => {
    const repo = stores.findRepo(req.params.id); if (!repo) throw httpError(404, 'repo not found');
    const m = req.body?.manifest;
    repo.manifest = m == null || (typeof m === 'object' && !Object.keys(m).length) ? null : manifestLib.compact(manifestLib.validate(m));
    await stores.repos.save();
    audit({ action: 'deploy-manifest-save', repo: repo.name, stack: repo.manifest?.stack?.type || null });
    res.json({ manifest: repo.manifest });
  }));
  r.get('/repos/:id/manifest/download', wrap(async (req, res) => {
    const repo = stores.findRepo(req.params.id); if (!repo) throw httpError(404, 'repo not found');
    res.setHeader('Content-Disposition', 'attachment; filename="ship.json"');
    res.type('application/json').send(JSON.stringify(repo.manifest || manifestLib.compact(manifestLib.defaults()), null, 2) + '\n');
  }));
  r.post('/manifest/validate', wrap(async (req, res) => {
    try { res.json({ ok: true, manifest: manifestLib.compact(manifestLib.validate(req.body?.manifest || {})) }); }
    catch (e) { res.status(400).json({ ok: false, errors: e.errors || [e.message] }); }
  }));

  /* ---- targets ---- */
  const lastRunFor = (t) => engine.list({ targetId: t.id, limit: 1 })[0] || null;
  r.get('/targets', (req, res) => res.json({ targets: stores.targets.get().targets.map((t) => ({ ...maskAutoShip(maskTarget(t, engine)), lastRun: lastRunFor(t) })) }));
  r.post('/targets', wrap(async (req, res) => {
    const t = sanitizeTarget(req.body || {}, ctx, stores, null);
    stores.targets.get().targets.push(t); await stores.targets.save(); autoRefresh();
    audit({ action: 'deploy-target-add', target: t.name, type: t.type, autoShip: t.autoShip?.enabled ? t.autoShip.mode : null });
    res.status(201).json(maskAutoShip(maskTarget(t, engine)));
  }));
  r.put('/targets/:id', wrap(async (req, res) => {
    const list = stores.targets.get().targets; const i = list.findIndex((x) => x.id === req.params.id);
    if (i < 0) throw httpError(404, 'target not found');
    if (engine.isLocked(list[i].id)) throw httpError(409, 'a deploy is running on this target');
    list[i] = sanitizeTarget({ ...list[i], ...req.body }, ctx, stores, list[i]);
    await stores.targets.save(); autoRefresh();
    audit({ action: 'deploy-target-update', target: list[i].name, autoShip: list[i].autoShip?.enabled ? list[i].autoShip.mode : null });
    res.json(maskAutoShip(maskTarget(list[i], engine)));
  }));
  r.delete('/targets/:id', wrap(async (req, res) => {
    const list = stores.targets.get().targets; const i = list.findIndex((x) => x.id === req.params.id);
    if (i < 0) throw httpError(404, 'target not found');
    if (engine.isLocked(list[i].id)) throw httpError(409, 'a deploy is running on this target');
    const [t] = list.splice(i, 1); await stores.targets.save(); autoRefresh();
    audit({ action: 'deploy-target-remove', target: t.name });
    res.json({ ok: true });
  }));
  r.post('/targets/:id/test', wrap(async (req, res) => {
    const t = stores.findTarget(req.params.id); if (!t) throw httpError(404, 'target not found');
    const adapter = adapterFor(t); const norm = adapter.validate(t, ctx);
    let conn;
    try { conn = await adapter.connect(ctx, norm, vault, {}); }
    catch (e) { throw httpError(400, `connection failed: ${redact(e.message)}`); }
    try {
      const probe = await adapter.probe(conn, norm);
      const strategy = adapter.strategyFor ? adapter.strategyFor(norm, conn, probe) : null;
      if (conn.canExec) { t.lastProbe = { current: probe.current || null, releases: probe.releases || [], user: probe.user || conn.user || null, os: probe.os || null, sudo: !!probe.sudo, lock: probe.lock || null, at: probe.pulledAt || new Date().toISOString() }; await stores.targets.save(); }
      res.json({ ok: true, canExec: conn.canExec, user: conn.user, host: conn.host, probe, strategy });
    } finally { conn.close(); }
  }));
  const startRun = (mode) => wrap(async (req, res) => {
    const t = stores.findTarget(req.params.id); if (!t) throw httpError(404, 'target not found');
    const b = req.body || {};
    let run;
    try {
      run = engine.start({ targetId: t.id, mode, ref: b.ref ? String(b.ref) : undefined, buildMode: ['local', 'remote'].includes(b.buildMode) ? b.buildMode : undefined, confirm: b.confirm === true, planHash: b.planHash ? String(b.planHash) : undefined, release: b.release ? String(b.release) : undefined, ai: b.ai !== false, force: b.force === true, trigger: 'ui' });
    } catch (e) { throw httpError(e.status || 400, e.message); }
    audit({ action: mode === 'plan' ? 'deploy-plan' : mode === 'ship' ? 'deploy-ship-start' : 'deploy-rollback-start', target: t.name, targetId: t.id, runId: run.id, ref: run.ref, trigger: 'ui' });
    res.status(202).json({ runId: run.id, run: run.toJSON() });
  });
  r.post('/targets/:id/plan', startRun('plan'));
  r.post('/targets/:id/ship', startRun('ship'));
  r.post('/targets/:id/rollback', startRun('rollback'));
  r.get('/targets/:id/releases', wrap(async (req, res) => {
    const t = stores.findTarget(req.params.id); if (!t) throw httpError(404, 'target not found');
    const adapter = adapterFor(t); const norm = adapter.validate(t, ctx);
    let conn;
    try { conn = await adapter.connect(ctx, norm, vault, {}); } catch (e) { throw httpError(400, `connection failed: ${redact(e.message)}`); }
    try {
      const out = conn.canExec ? await adapter.listReleases(conn, adapter.layout(norm)) : await adapter.listInPlace(conn, norm);
      res.json({ ...out, canExec: conn.canExec });
    } finally { conn.close(); }
  }));
  r.post('/targets/:id/unlock', wrap(async (req, res) => {
    const t = stores.findTarget(req.params.id); if (!t) throw httpError(404, 'target not found');
    if (engine.isLocked(t.id)) throw httpError(409, 'a deploy is running on this target right now');
    const adapter = adapterFor(t); const norm = adapter.validate(t, ctx);
    if (!adapter.unlock) return res.json({ ok: true });
    let conn;
    try { conn = await adapter.connect(ctx, norm, vault, {}); } catch (e) { throw httpError(400, `connection failed: ${redact(e.message)}`); }
    try { if (conn.canExec) await adapter.unlock(conn, adapter.layout(norm)); } finally { conn.close(); }
    audit({ action: 'deploy-force-unlock', target: t.name, targetId: t.id });
    res.json({ ok: true });
  }));
  r.get('/targets/:id/setup', wrap(async (req, res) => {
    const t = stores.findTarget(req.params.id); if (!t) throw httpError(404, 'target not found');
    const repo = stores.findRepo(t.repoId);
    const adapter = adapterFor(t); const norm = adapter.validate(t, ctx);
    let m; try { m = manifestLib.resolve(repo?.manifest || {}, norm.overrides); } catch { m = manifestLib.defaults(); }
    const L = adapter.layout(norm);
    const domain = (norm.healthUrl && (() => { try { return new URL(norm.healthUrl).hostname; } catch { return null; } })()) || 'example.com';
    const docroot = m.runtime.docroot && m.runtime.docroot !== '.' ? m.runtime.docroot : '';
    const user = ctx.profileById(norm.ssh?.profileId || norm.transport?.profileId || '')?.ssh?.user || 'deploy';
    if (norm.type === 'paas') { /* no server layout */ }
    const out = {};
    if (norm.type === 'vps-ssh') {
      if (m.runtime.kind === 'php-fpm') { out['nginx (PHP-FPM)'] = templates.nginxPhp({ domain, current: L.current, docroot, phpVersion: m.stack.php }); out['apache'] = templates.apachePhp({ domain, current: L.current, docroot }); }
      if (m.runtime.kind === 'node') { out['nginx (reverse proxy)'] = templates.nginxNode({ domain, port: m.runtime.port }); out['systemd unit'] = templates.systemdNode({ name: norm.process.unit || norm.name, user, current: L.current, start: m.runtime.start, port: m.runtime.port, envFile: `${L.shared}/.env` }); out['pm2 ecosystem.config.cjs'] = templates.pm2Ecosystem({ name: norm.process.name || norm.name, start: m.runtime.start, port: m.runtime.port }); }
      if (m.runtime.kind === 'static') out['nginx (static)'] = templates.nginxStatic({ domain, current: L.current, docroot });
      if (m.runtime.kind === 'python') { out['nginx (reverse proxy)'] = templates.nginxNode({ domain, port: m.runtime.port || 8000 }); out['systemd unit (gunicorn/uvicorn)'] = templates.systemdNode({ name: norm.process.unit || norm.name, user, current: L.current, start: m.runtime.start, port: m.runtime.port || 8000, envFile: `${L.shared}/.env` }); }
      if (m.runtime.kind === 'docker') { out['nginx (reverse proxy to the container)'] = templates.nginxNode({ domain, port: m.runtime.port || 8080 }); out['docker notes'] = `# The release dir is the compose project dir; "current" always points at the running one.
# Containers are (re)created by: docker compose up -d --remove-orphans   (run in ${L.current})
# Give the deploy user docker access:  sudo usermod -aG docker ${user}`; }
      out['sudoers (reload only)'] = templates.sudoers({ user, phpVersion: m.stack.php });
      out['first-time server prep'] = `sudo mkdir -p ${L.root} && sudo chown -R ${user}:${user} ${L.root}\n# create ${L.shared}/.env with your production settings before the first ship`;
    } else if (norm.type === 'paas') {
      const prov = adapter.PROVIDERS[norm.paas.provider];
      out[`${prov.label} · CLI`] = `# Install the CLI on this machine (the deploy runs here):\n${prov.install}\n\n# Token: store it in the vault and pick it as ${norm.paas.tokenRef}\n# It is passed to the CLI as ${prov.tokenEnv}: never on the command line.\n# ${prov.tokenHint}`;
      out['how a ship works'] = `fetch → detect → ${prov.buildLocal ? 'build locally → upload the output directory' : 'hand the checkout to the platform, which builds it'} → verify the deployment URL${prov.rollback(norm, { id: 'x', image: 'x', commit: 'x' }) ? ' → rollback available' : ' (rollback: redeploy a previous commit)'}`;
    } else {
      out['.htaccess (docroot rewrite strategy)'] = templates.htaccessRewrite({ target: 'current' });
      out['notes'] = `Symlink strategy: ${norm.paths.docroot} -> ${L.current}${docroot ? '/' + docroot : ''}\nIf your host forbids symlinked docroots use the .htaccess strategy, or FTP in-place mode.`;
    }
    res.json({ layout: L, templates: out });
  }));

  /* ---- framework catalog + detection on a local folder (wizard) ---- */
  r.get('/frameworks', (req, res) => res.json({ groups: frameworks.GROUPS, frameworks: frameworks.CATALOG.map(({ id, label, group, stackType, framework, install, build, start, port, outputDir, runtime, docroot, health }) => ({ id, label, group, stackType, framework, install: install || '', build: build || '', start: start || '', port: port || '', outputDir: outputDir || '', runtime, docroot: docroot || '.', health: health || '/' })) }));
  r.post('/frameworks/:id/fragment', (req, res) => { try { res.json({ manifest: manifestLib.compact(manifestLib.validate(frameworks.fragmentFor(req.params.id, req.body || {}))) }); } catch (e) { throw httpError(e.status || 400, e.message); } });
  r.post('/detect-path', wrap(async (req, res) => {
    const p = String(req.body?.path || '');
    if (!p || !path.isAbsolute(p) || !require('fs').existsSync(p)) throw httpError(400, 'path must be an existing absolute folder');
    const det = await detect(p);
    let resolved = null; try { resolved = manifestLib.validate(det.best?.fragment || {}); } catch {}
    res.json({ best: det.best, candidates: det.candidates.map((c) => ({ id: c.id, root: c.root, score: c.score, evidence: c.evidence })), ambiguous: det.ambiguous, reason: det.reason, shipJson: det.shipJson, catalogId: frameworks.catalogIdFor(det.best?.fragment), form: resolved ? frameworks.formFrom(resolved) : null });
  }));

  /* ---- guided setup, templates, duplicate, export/import ---- */
  r.post('/setup', wrap(async (req, res) => {
    let out;
    try { out = await config.setup(req.body || {}); } catch (e) { throw httpError(e.status || 400, e.message); }
    autoRefresh();
    res.status(201).json({ repo: out.repo ? maskRepo(out.repo) : null, target: out.target ? maskAutoShip(maskTarget(out.target, engine)) : null, secrets: out.secrets });
  }));
  r.get('/suggest', (req, res) => res.json(config.suggestTarget({ kind: String(req.query.kind || 'vps-ssh'), name: req.query.name, repoName: req.query.repoName, env: req.query.env, web: req.query.web, stackType: req.query.stackType, host: req.query.host })));
  r.get('/templates', (req, res) => res.json({ templates: config.listTemplates() }));
  r.post('/templates', wrap(async (req, res) => res.status(201).json(await config.saveTemplate(req.body || {}))));
  r.delete('/templates/:id', wrap(async (req, res) => { await config.deleteTemplate(req.params.id); res.json({ ok: true }); }));
  r.post('/targets/:id/duplicate', wrap(async (req, res) => { const t = await config.duplicateTarget(req.params.id, req.body || {}); autoRefresh(); res.status(201).json(maskAutoShip(maskTarget(t, engine))); }));
  r.get('/export', (req, res) => { const doc = config.exportConfig(); if (req.query.download === '1') res.setHeader('Content-Disposition', `attachment; filename="ascension-config-${new Date().toISOString().slice(0, 10)}.json"`); res.json(doc); });
  r.post('/import', wrap(async (req, res) => { const doc = req.body?.config || req.body; const report = await config.importConfig(doc, { dryRun: req.body?.dryRun === true || req.query.dryRun === '1' }); autoRefresh(); res.json(report); }));

  /* ---- runs ---- */
  r.get('/runs', (req, res) => res.json({ runs: engine.list({ targetId: req.query.target || undefined, limit: Math.min(200, Number(req.query.limit) || 50) }), active: engine.activeIds() }));
  r.get('/runs/:id', wrap(async (req, res) => {
    const live = engine.get(req.params.id);
    if (live) return res.json(live.toJSON());
    const idx = engine.list({ limit: 200 }).find((x) => x.id === req.params.id);
    if (!idx) throw httpError(404, 'run not found');
    res.json(idx);
  }));
  r.get('/runs/:id/log', wrap(async (req, res) => res.json(await engine.readLog(req.params.id, Number(req.query.since) || 0))));
  r.get('/runs/:id/log/search', wrap(async (req, res) => { // full-text search over the redacted log (same engine as the assistant's tool)
    const q = String(req.query.q || '').trim(); if (!q) throw httpError(400, 'q is required');
    let re; try { re = new RegExp(q, 'i'); } catch { re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
    const { lines } = await engine.readLog(req.params.id, 0);
    const hits = lines.filter((l) => re.test(l.line));
    res.json({ runId: req.params.id, q, matches: hits.length, lines: hits.slice(0, Math.min(500, Number(req.query.max) || 200)) });
  }));
  r.post('/targets/:id/preflight', wrap(async (req, res) => { // AI pre-ship review (opt-in): advisory, stored on the target
    const t = stores.findTarget(req.params.id); if (!t) throw httpError(404, 'target not found');
    res.json({ review: await agentApi.preShipReview(t.id) });
  }));
  r.post('/runs/:id/cancel', wrap(async (req, res) => { if (!engine.cancel(req.params.id)) throw httpError(409, 'run is not active'); res.json({ ok: true }); }));
  r.post('/runs/:id/explain', wrap(async (req, res) => {
    if (!agentApi?.explainRun) throw httpError(501, 'AI explain is not available');
    if (!ctx.agent.isConnected()) throw httpError(409, 'connect the AI assistant first');
    const r = await agentApi.explainRun(req.params.id);
    audit({ action: 'deploy-ai-explain', runId: req.params.id, proposed: r.proposal?.action || null });
    res.json(r);
  }));
  r.post('/runs/:id/to-chat', wrap(async (req, res) => { // "Send to AI chat": summary + redacted log tail as a conversation note
    if (!ctx.agent.isConnected()) throw httpError(409, 'connect the AI assistant first');
    res.json(await agentApi.runToChat(req.params.id, { lines: Number(req.body?.lines) || 150 }));
  }));

  /* ---- secrets (names only ever leave) ---- */
  r.get('/secrets', wrap(async (req, res) => res.json({ secrets: vault.names(), keySource: vault.keySource })));
  r.put('/secrets/:name', wrap(async (req, res) => {
    if (!NAME_RE.test(req.params.name)) throw httpError(400, 'secret names must be UPPER_SNAKE_CASE');
    try { vault.set(req.params.name, String(req.body?.value ?? '')); } catch (e) { throw httpError(e.status || 400, e.message); }
    audit({ action: 'deploy-secret-set', name: req.params.name });
    res.json({ ok: true });
  }));
  r.delete('/secrets/:name', wrap(async (req, res) => {
    const used = [...stores.repos.get().repos.filter((x) => x.source.auth?.tokenRef === `\${vault:${req.params.name}}`).map((x) => `repo ${x.name}`), ...stores.targets.get().targets.filter((t) => t.transport?.passwordRef === `\${vault:${req.params.name}}` || t.envFile?.fromVault === req.params.name).map((t) => `target ${t.name}`)];
    if (used.length && req.query.force !== '1') throw httpError(409, `secret is referenced by ${used.join(', ')}`);
    vault.remove(req.params.name);
    audit({ action: 'deploy-secret-remove', name: req.params.name });
    res.json({ ok: true });
  }));

  return r;
}

module.exports = { createRouter, maskRepo, maskTarget, maskAutoShip, sanitizeRepo, sanitizeTarget, providerRepos };
