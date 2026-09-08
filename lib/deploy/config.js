'use strict';
/* Saved configurations: target templates, environment duplication, the
   one-shot guided setup, and export/import of the whole deploy setup.
   Secrets are never exported: only their names, so an import can tell the
   user which ones to re-enter. */

const crypto = require('crypto');
const { adapterFor } = require('./targets');
const { isRef, refName } = require('./vault');

const TEMPLATE_STRIP = ['id', 'name', 'repoId', 'createdAt', 'locked', 'lastRun', 'autoShip'];

/** Fields of a target worth reusing on another one (everything but identity + repo). */
function templateDataFrom(target) {
  const d = JSON.parse(JSON.stringify(target));
  for (const k of TEMPLATE_STRIP) delete d[k];
  if (target.autoShip?.enabled) d.autoShip = { enabled: true, mode: target.autoShip.mode, branch: target.autoShip.branch || null, pollMinutes: target.autoShip.pollMinutes };
  return d;
}

/** Suggested defaults for a new target so the wizard needs few fields. */
function suggestTarget({ kind, name, repoName, env, web = 'nginx', stackType, host }) {
  const finalName = name || `${repoName || 'app'}-${env || 'prod'}`;
  const slug = String(finalName).toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'app';
  const isPhp = stackType === 'php';
  const base = { name: finalName, keepReleases: env === 'production' || env === 'prod' ? 5 : 3, healthUrl: '' };
  if (kind === 'vps-ssh') return { ...base, type: 'vps-ssh', buildMode: 'auto', paths: { root: `/var/www/${slug}` }, web: { server: web, reloadCmd: web === 'nginx' ? 'sudo -n systemctl reload nginx' : web === 'apache' ? 'sudo -n systemctl reload apache2' : '', phpFpmReload: isPhp ? 'sudo -n systemctl reload php8.3-fpm' : '' }, process: { manager: stackType === 'node' || stackType === 'python' ? 'systemd' : 'none', unit: stackType === 'node' || stackType === 'python' ? `${slug}.service` : '' } };
  if (kind === 'shared-hosting') return { ...base, type: 'shared-hosting', buildMode: 'local', paths: { home: host ? `/home/${host}` : '/', docroot: host ? `/home/${host}/public_html` : '/public_html' }, docrootStrategy: 'auto', keepReleases: 2 };
  if (kind === 'paas') return { ...base, type: 'paas', paas: { provider: 'vercel', prod: env !== 'staging' && env !== 'preprod' } };
  return base;
}

function createConfig({ ctx, stores, vault, sanitizeRepo, sanitizeTarget }) {
  const tpl = stores.templates;

  function listTemplates() { return tpl.get().templates; }
  async function saveTemplate({ name, fromTargetId, data }) {
    const n = String(name || '').trim();
    if (!n || n.length > 60) throw ctx.httpError(400, 'template name is required (max 60 chars)');
    let payload = data;
    if (fromTargetId) { const t = stores.findTarget(fromTargetId); if (!t) throw ctx.httpError(404, 'target not found'); payload = templateDataFrom(t); }
    if (!payload || typeof payload !== 'object' || !payload.type) throw ctx.httpError(400, 'template data must be a target definition');
    const list = tpl.get().templates;
    const existing = list.find((x) => x.name === n);
    const rec = { id: existing?.id || crypto.randomUUID(), name: n, kind: 'target', type: payload.type, data: payload, createdAt: existing?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
    if (existing) list[list.indexOf(existing)] = rec; else list.push(rec);
    await tpl.save();
    ctx.audit({ action: 'deploy-template-save', template: n, type: payload.type });
    return rec;
  }
  async function deleteTemplate(id) {
    const list = tpl.get().templates; const i = list.findIndex((x) => x.id === id);
    if (i < 0) throw ctx.httpError(404, 'template not found');
    const [rec] = list.splice(i, 1); await tpl.save();
    ctx.audit({ action: 'deploy-template-remove', template: rec.name });
  }

  /** Duplicate a target as another environment (new name, same repo unless given). */
  async function duplicateTarget(id, { name, repoId, env }) {
    const src = stores.findTarget(id); if (!src) throw ctx.httpError(404, 'target not found');
    const body = { ...templateDataFrom(src), name: String(name || `${src.name}-copy`).trim(), repoId: repoId || src.repoId };
    if (env && body.type === 'vps-ssh') body.paths = { root: `${body.paths.root}-${env}`.replace(/-prod(uction)?-/, '-') };
    if (env && body.type === 'paas') body.paas = { ...body.paas, prod: !/stag|pre|dev|test/.test(env) };
    if (body.autoShip?.enabled) body.autoShip = { ...body.autoShip, enabled: false }; // never clone a live trigger silently
    const t = sanitizeTarget(body, ctx, stores, null);
    stores.targets.get().targets.push(t); await stores.targets.save();
    ctx.audit({ action: 'deploy-target-add', target: t.name, type: t.type, by: 'duplicate', from: src.name });
    return t;
  }

  /**
   * One-shot guided setup: secrets first (so refs validate), then repo, then target.
   * Nothing is written unless everything validates.
   */
  async function setup(body) {
    const secrets = body.secrets && typeof body.secrets === 'object' ? body.secrets : {};
    for (const [k, v] of Object.entries(secrets)) { if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(k)) throw ctx.httpError(400, `secret name ${k} must be UPPER_SNAKE_CASE`); if (typeof v !== 'string' || !v) throw ctx.httpError(400, `secret ${k} has no value`); }
    // dry-validate with a temporary view of the vault (refs must resolve after creation)
    const vaultView = { ...vault, has: (n) => vault.has(n) || Object.prototype.hasOwnProperty.call(secrets, n), get: (n) => (Object.prototype.hasOwnProperty.call(secrets, n) ? secrets[n] : vault.get(n)), resolveRef: (s) => { const m = /^\$\{vault:([A-Z0-9_]+)\}$/.exec(String(s || '')); return m ? vaultView.get(m[1]) : s; } };
    let repo = null, existingRepo = null;
    if (body.repoId) { existingRepo = stores.findRepo(body.repoId); if (!existingRepo) throw ctx.httpError(404, 'repoId not found'); }
    else if (body.repo) repo = sanitizeRepo(body.repo, ctx, vaultView, null);
    else throw ctx.httpError(400, 'a repo (or repoId) is required');
    const repoId = existingRepo?.id || repo.id;
    // temporary store view so the target sanitizer sees the new repo
    const storesView = { ...stores, findRepo: (id) => (id === repoId ? (existingRepo || repo) : stores.findRepo(id)) };
    let target = null;
    if (body.target) {
      const t = { ...body.target, repoId };
      // vault refs inside the target (ftp password, paas token, env file) must exist after secrets are created
      const refs = [t.transport?.passwordRef, t.paas?.tokenRef].filter(Boolean);
      for (const r of refs) if (isRef(r) && !vaultView.has(refName(r))) throw ctx.httpError(400, `secret ${refName(r)} is referenced but not provided`);
      if (t.envFile?.fromVault && !vaultView.has(t.envFile.fromVault)) throw ctx.httpError(400, `secret ${t.envFile.fromVault} is referenced but not provided`);
      target = sanitizeTarget(t, ctx, storesView, null);
    }
    // commit
    for (const [k, v] of Object.entries(secrets)) { vault.set(k, v); ctx.audit({ action: 'deploy-secret-set', name: k, by: 'setup' }); }
    if (repo) { stores.repos.get().repos.push(repo); await stores.repos.save(); ctx.audit({ action: 'deploy-repo-add', repo: repo.name, kind: repo.source.kind, by: 'setup' }); }
    if (target) { stores.targets.get().targets.push(target); await stores.targets.save(); ctx.audit({ action: 'deploy-target-add', target: target.name, type: target.type, by: 'setup' }); }
    return { repo: existingRepo || repo, target, secrets: Object.keys(secrets) };
  }

  /** Export everything except secret values. */
  function exportConfig() {
    const targets = stores.targets.get().targets.map((t) => { const c = JSON.parse(JSON.stringify(t)); delete c.locked; delete c.lastRun; if (c.autoShip) delete c.autoShip.secret; return c; });
    const repos = stores.repos.get().repos.map((r) => { const c = JSON.parse(JSON.stringify(r)); delete c.lastFetch; return c; });
    const secretNames = new Set(vault.names().map((s) => s.name));
    return { format: 'ascension-config', version: 1, exportedAt: new Date().toISOString(), repos, targets, templates: listTemplates(), secrets: [...secretNames].map((name) => ({ name })), sshProfiles: (ctx.connStore.profiles || []).filter((p) => p.ssh?.enabled && p.ssh.host).map((p) => ({ id: p.id, name: p.name, host: p.ssh.host, port: p.ssh.port, user: p.ssh.user })) };
  }

  /**
   * Import (merge): repos/targets/templates whose names are new are created with fresh ids;
   * repo references are remapped; SSH profiles are matched by host+user against this
   * machine's connection profiles. Returns what was created and what still needs attention.
   */
  async function importConfig(doc, { dryRun = false } = {}) {
    if (!doc || doc.format !== 'ascension-config') throw ctx.httpError(400, 'not an Ascension configuration export');
    const report = { repos: [], targets: [], templates: [], skipped: [], missingSecrets: [], unresolvedProfiles: [] };
    const repoMap = new Map();
    const secretNames = new Set(vault.names().map((s) => s.name));
    for (const s of doc.secrets || []) if (!secretNames.has(s.name)) report.missingSecrets.push(s.name);
    const profByHost = new Map((ctx.connStore.profiles || []).filter((p) => p.ssh?.enabled).map((p) => [`${p.ssh.host}|${p.ssh.user}`, p.id]));
    const oldProfiles = new Map((doc.sshProfiles || []).map((p) => [p.id, p]));
    const newRepos = [], newTargets = [], newTemplates = [];
    for (const r of doc.repos || []) {
      const existing = stores.repos.get().repos.find((x) => x.name === r.name);
      if (existing) { repoMap.set(r.id, existing.id); report.skipped.push(`repo ${r.name} (exists)`); continue; }
      const view = { ...vault, has: (n) => secretNames.has(n) || true }; // allow missing secrets; reported above
      const clean = sanitizeRepo({ ...r, id: undefined }, ctx, view, null);
      repoMap.set(r.id, clean.id); newRepos.push(clean); report.repos.push(clean.name);
    }
    const storesView = { ...stores, findRepo: (id) => newRepos.find((x) => x.id === id) || stores.findRepo(id) };
    for (const t of doc.targets || []) {
      if (stores.targets.get().targets.some((x) => x.name === t.name)) { report.skipped.push(`target ${t.name} (exists)`); continue; }
      const body = JSON.parse(JSON.stringify(t)); delete body.id; body.repoId = repoMap.get(t.repoId) || t.repoId;
      const remap = (pid) => { const old = oldProfiles.get(pid); const hit = old ? profByHost.get(`${old.host}|${old.user}`) : null; if (!hit) report.unresolvedProfiles.push(`${t.name}: ${old ? old.user + '@' + old.host : pid}`); return hit || pid; };
      if (body.ssh?.profileId) body.ssh.profileId = remap(body.ssh.profileId);
      if (body.transport?.profileId) body.transport.profileId = remap(body.transport.profileId);
      try { const clean = sanitizeTarget(body, ctx, storesView, null); newTargets.push(clean); report.targets.push(clean.name); }
      catch (e) { report.skipped.push(`target ${t.name}: ${e.message}`); }
    }
    for (const tp of doc.templates || []) { if (listTemplates().some((x) => x.name === tp.name)) { report.skipped.push(`template ${tp.name} (exists)`); continue; } newTemplates.push({ ...tp, id: crypto.randomUUID() }); report.templates.push(tp.name); }
    if (!dryRun) {
      stores.repos.get().repos.push(...newRepos); await stores.repos.save();
      stores.targets.get().targets.push(...newTargets); await stores.targets.save();
      tpl.get().templates.push(...newTemplates); await tpl.save();
      ctx.audit({ action: 'deploy-config-import', repos: report.repos.length, targets: report.targets.length, templates: report.templates.length, skipped: report.skipped.length });
    }
    return report;
  }

  return { listTemplates, saveTemplate, deleteTemplate, duplicateTarget, setup, exportConfig, importConfig, suggestTarget, templateDataFrom };
}

module.exports = { createConfig, suggestTarget, templateDataFrom };
