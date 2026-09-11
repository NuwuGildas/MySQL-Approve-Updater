'use strict';
/* Cloud provisioning jobs: create a VM with a cloud-init recipe, wait for it
   to boot and accept SSH, register an SSH-only connection profile (and
   optionally a deploy target): then the normal pipeline takes over.
   Servers are remembered in deploy-servers.json so they can be listed and
   destroyed from the UI. */

const net = require('net');
const crypto = require('crypto');
const { providerFor, PROVIDERS } = require('./providers');
const { cloudInit, RECIPES } = require('./recipes');
const keys = require('./providers/keys');
const { refName } = require('../vault');
const { requireProject } = require('../projects');

const RECIPE_FOR_STACK = { php: 'php', node: 'node', static: 'base', python: 'python', docker: 'docker' };

function waitTcp(host, port, { timeoutMs = 300000, intervalMs = 5000, signal } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (signal?.aborted) return reject(new Error('cancelled'));
      const s = net.createConnection({ host, port, timeout: 4000 });
      s.once('connect', () => { s.destroy(); resolve(); });
      const fail = () => { s.destroy(); if (Date.now() > deadline) reject(new Error(`port ${port} on ${host} did not open within ${Math.round(timeoutMs / 1000)}s`)); else setTimeout(attempt, intervalMs); };
      s.once('error', fail); s.once('timeout', fail);
    };
    attempt();
  });
}

function createCloud({ ctx, stores, vault, engine, createTarget }) {
  const jobs = new Map();
  const emit = (job) => ctx.sseBroadcast('deploy', { type: 'cloud', job: job.toJSON() });

  class Job {
    constructor(spec) { this.id = `prov-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${crypto.randomBytes(2).toString('hex')}`; this.spec = spec; this.status = 'running'; this.stage = 'prepare'; this.log = []; this.server = null; this.profileId = null; this.targetId = null; this.error = null; this.startedAt = new Date().toISOString(); this.endedAt = null; this.abort = new AbortController(); }
    say(line) { this.log.push({ t: new Date().toISOString(), stage: this.stage, line: String(line) }); if (this.log.length > 500) this.log.shift(); emit(this); }
    setStage(s) { this.stage = s; this.say(`── ${s} ──`); }
    finish(status, err) { this.status = status; this.error = err ? (err.message || String(err)) : null; this.endedAt = new Date().toISOString(); emit(this); }
    toJSON() { const { abort, ...rest } = this; return { ...rest, spec: { ...rest.spec, publicKey: undefined, token: undefined, userData: undefined } }; }
  }

  function tokenFor(spec) {
    const p = providerFor(spec.provider);
    if (p.auth !== 'token') return null;
    if (!spec.tokenRef) throw Object.assign(new Error(`${p.label} needs an API token from the vault`), { status: 400 });
    return vault.get(refName(spec.tokenRef));
  }

  /** Validate + normalize the provisioning request. */
  function normalize(body) {
    const err = (m) => { throw Object.assign(new Error(m), { status: 400 }); };
    const p = providerFor(String(body.provider || ''));
    const name = String(body.name || '').trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]{1,38}[a-z0-9]$/.test(name)) err('name must be 3-40 chars: lowercase letters, digits and dashes');
    if (stores.servers.get().servers.some((s) => s.name === name && s.status !== 'destroyed')) err(`a server named "${name}" already exists`);
    const recipe = RECIPES[body.recipe] ? body.recipe : 'base';
    const spec = {
      provider: p.id, name, recipe,
      projectId: body.projectId === undefined ? body.createTarget?.projectId : body.projectId,
      region: String(body.region || p.defaults.region), size: String(body.size || p.defaults.size), image: String(body.image || p.defaults.image),
      tokenRef: body.tokenRef ? String(body.tokenRef) : null,
      keyMode: body.privateKeyPath ? 'existing' : 'generate', privateKeyPath: body.privateKeyPath ? String(body.privateKeyPath) : null,
      createTarget: body.createTarget && typeof body.createTarget === 'object' ? { repoId: String(body.createTarget.repoId || ''), targetName: String(body.createTarget.targetName || name).trim(), healthUrl: body.createTarget.healthUrl ? String(body.createTarget.healthUrl) : '' } : null,
      user: p.defaultUser && recipe === 'none' ? p.defaultUser : 'deploy',
    };
    if (p.auth === 'token' && !/^\$\{vault:[A-Z0-9_]+\}$/.test(spec.tokenRef || '')) err(`${p.label} needs tokenRef as a \${vault:NAME} reference`);
    if (spec.createTarget && !stores.findRepo(spec.createTarget.repoId)) err('createTarget.repoId must reference a connected repo');
    if (spec.createTarget) spec.projectId = requireProject(stores, spec.projectId).id;
    return spec;
  }

  async function provision(body) {
    const spec = normalize(body);
    const p = providerFor(spec.provider);
    const token = tokenFor(spec);
    const job = new Job(spec);
    jobs.set(job.id, job);
    if (spec.createTarget) stores.pendingProjects.set(spec.projectId, (stores.pendingProjects.get(spec.projectId) || 0) + 1);
    const rec = { id: job.id, provider: spec.provider, name: spec.name, region: spec.region, size: spec.size, image: spec.image, recipe: spec.recipe, status: 'provisioning', ip: null, providerId: null, profileId: null, targetId: null, createdAt: job.startedAt, tokenRef: spec.tokenRef, privateKeyPath: null };
    stores.servers.get().servers.unshift(rec); stores.servers.save();
    ctx.audit({ action: 'deploy-cloud-provision', provider: spec.provider, name: spec.name, region: spec.region, size: spec.size, recipe: spec.recipe, jobId: job.id });
    (async () => {
      try {
        job.setStage('prepare');
        if (p.auth === 'cli' && p.available && !(await p.available())) throw new Error(`${p.cli} CLI is not installed on this machine`);
        let privateKeyPath, publicKey;
        if (spec.keyMode === 'existing') { privateKeyPath = spec.privateKeyPath; publicKey = keys.readPublicKey(privateKeyPath); job.say(`using existing key ${privateKeyPath}`); }
        else { ({ privateKeyPath, publicKey } = keys.generateKeyPair(ctx.DATA_DIR, spec.name)); job.say(`generated ed25519 key → ${privateKeyPath}`); }
        rec.privateKeyPath = privateKeyPath; stores.servers.save();
        const userData = cloudInit({ recipe: spec.recipe, publicKey, appName: spec.createTarget?.targetName || spec.name, user: 'deploy' });
        job.say(`cloud-init recipe: ${RECIPES[spec.recipe].label} (${userData.split('\n').length} lines)`);

        job.setStage('create');
        job.say(`${p.label}: creating ${spec.size} in ${spec.region} from ${spec.image}…`);
        const created = await p.create(token, { ...spec, publicKey, userData });
        rec.providerId = created.id; rec.ip = created.ip || null; stores.servers.save();
        job.server = { providerId: created.id, name: created.name, ip: rec.ip, console: p.console ? p.console(created.id, spec) : null };
        job.say(`created: id ${created.id}${rec.ip ? ', ip ' + rec.ip : ''}`);

        job.setStage('boot');
        const deadline = Date.now() + 10 * 60000;
        while (true) {
          if (job.abort.signal.aborted) throw new Error('cancelled');
          const st = await p.status(token, created.id, spec);
          if (st.ip) rec.ip = st.ip;
          job.say(`state ${st.raw || st.status}${st.ip ? ' · ' + st.ip : ''}`);
          if (st.status === 'ready') break;
          if (!['creating', 'new', 'initializing', 'starting', 'pending', 'provisioning', 'staging', 'off'].includes(String(st.status))) throw new Error(`provider reports "${st.status}"`);
          if (Date.now() > deadline) throw new Error('server did not become ready within 10 minutes');
          await new Promise((r) => setTimeout(r, cloudDeps.pollMs));
        }
        job.server.ip = rec.ip; stores.servers.save();

        job.setStage('ssh');
        job.say(`waiting for SSH on ${rec.ip}:22…`);
        await (cloudDeps.waitTcp)(rec.ip, 22, { timeoutMs: 300000, signal: job.abort.signal });
        job.say('port 22 open; waiting for cloud-init to finish (up to 10 min)…');
        const profile = { id: crypto.randomUUID(), name: `${spec.name} (${p.label.split(' ')[0]})`, sshOnly: true, db: { host: '127.0.0.1', port: 3306, user: '', password: '', database: '' }, ssh: { enabled: true, host: rec.ip, port: 22, user: 'deploy', password: '', privateKeyPath, passphrase: '' } };
        await (cloudDeps.waitCloudInit)(ctx, profile.ssh, { timeoutMs: 600000, signal: job.abort.signal, say: (l) => job.say(l) });

        job.setStage('register');
        ctx.connStore.profiles.push(profile); await ctx.saveConnections();
        rec.profileId = profile.id; job.profileId = profile.id;
        job.say(`SSH profile "${profile.name}" registered (deploy@${rec.ip})`);
        if (spec.createTarget && createTarget) {
          const t = await createTarget({ projectId: spec.projectId, name: spec.createTarget.targetName, repoId: spec.createTarget.repoId, type: 'vps-ssh', buildMode: 'auto', ssh: { profileId: profile.id }, paths: { root: `/var/www/${spec.createTarget.targetName.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-')}` }, web: { server: 'nginx', reloadCmd: 'sudo -n /usr/bin/systemctl reload nginx', phpFpmReload: spec.recipe === 'php' ? 'sudo -n /usr/bin/systemctl reload php8.3-fpm' : '' }, process: { manager: ['node', 'python'].includes(spec.recipe) ? 'systemd' : 'none', unit: ['node', 'python'].includes(spec.recipe) ? `${spec.createTarget.targetName}.service` : '' }, healthUrl: spec.createTarget.healthUrl || `http://${rec.ip}/`, keepReleases: 5 });
          rec.targetId = t.id; job.targetId = t.id;
          job.say(`target "${t.name}" created → /var/www/${spec.createTarget.targetName}`);
        }
        rec.status = 'ready'; stores.servers.save();
        job.finish('succeeded');
        ctx.logEvent('info', `cloud server ${spec.name} ready at ${rec.ip} (${p.label})`);
        ctx.audit({ action: 'deploy-cloud-ready', provider: spec.provider, name: spec.name, ip: rec.ip, profileId: rec.profileId, targetId: rec.targetId, jobId: job.id });
      } catch (e) {
        rec.status = job.abort.signal.aborted ? 'cancelled' : 'error'; rec.error = e.message; stores.servers.save();
        job.finish(job.abort.signal.aborted ? 'cancelled' : 'failed', e);
        ctx.logEvent('warn', `cloud provisioning of ${spec.name} ${rec.status}: ${e.message}`);
        ctx.audit({ action: 'deploy-cloud-failed', provider: spec.provider, name: spec.name, error: e.message, jobId: job.id });
      } finally {
        if (spec.createTarget) {
          const remaining = (stores.pendingProjects.get(spec.projectId) || 1) - 1;
          if (remaining) stores.pendingProjects.set(spec.projectId, remaining); else stores.pendingProjects.delete(spec.projectId);
        }
      }
    })();
    return job;
  }

  async function destroy(serverId) {
    const rec = stores.servers.get().servers.find((s) => s.id === serverId);
    if (!rec) throw Object.assign(new Error('server not found'), { status: 404 });
    const p = providerFor(rec.provider);
    const token = p.auth === 'token' ? vault.get(refName(rec.tokenRef)) : null;
    if (rec.providerId) await p.destroy(token, rec.providerId, rec);
    rec.status = 'destroyed'; rec.destroyedAt = new Date().toISOString(); stores.servers.save();
    ctx.audit({ action: 'deploy-cloud-destroy', provider: rec.provider, name: rec.name, ip: rec.ip });
    return rec;
  }

  async function options(providerId, tokenRef) {
    const p = providerFor(providerId);
    if (p.auth !== 'token') return { regions: [], sizes: [], images: [], defaults: p.defaults, freeText: true };
    return { ...(await p.options(vault.get(refName(tokenRef)))), defaults: p.defaults, freeText: false };
  }

  const list = () => stores.servers.get().servers.map((s) => ({ ...s, tokenRef: s.tokenRef, privateKeyPath: s.privateKeyPath, console: PROVIDERS[s.provider]?.console ? PROVIDERS[s.provider].console(s.providerId, s) : null }));
  const providers = () => Object.values(PROVIDERS).map((p) => ({ id: p.id, label: p.label, auth: p.auth, cli: p.cli || null, tokenHint: p.tokenHint, defaults: p.defaults }));
  const recipes = () => Object.entries(RECIPES).map(([id, r]) => ({ id, label: r.label }));
  const preview = (body) => cloudInit({ recipe: RECIPES[body.recipe] ? body.recipe : 'base', publicKey: body.publicKey || 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPLACEHOLDERKEYPLACEHOLDERKEYPLACEHOLDERKEY', appName: body.appName || body.name || 'app' });

  return { provision, destroy, options, list, providers, recipes, preview, getJob: (id) => jobs.get(id) || null, cancel: (id) => { const j = jobs.get(id); if (j && j.status === 'running') { j.abort.abort(); return true; } return false; }, RECIPE_FOR_STACK };
}

/* injectable for tests */
const cloudDeps = {
  pollMs: 6000,
  waitTcp,
  async waitCloudInit(ctx, sshCfg, { timeoutMs, signal, say }) {
    // poll: connect as deploy, check cloud-init's marker: works once the user + key exist
    const { createSshConn } = require('../transports/ssh');
    const deadline = Date.now() + timeoutMs;
    let lastErr = '';
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('cancelled');
      try {
        const conn = await createSshConn(ctx, sshCfg, { signal });
        try {
          const out = await conn.capture('cloud-init status 2>/dev/null || echo unknown; test -f /var/lib/cloud/instance/ascension-ready && echo READY', { timeoutMs: 30000 });
          if (/READY|status: done/.test(out)) { say('cloud-init finished'); return; }
          say(`cloud-init: ${out.split('\n')[0].trim() || 'running'}…`);
        } finally { conn.close(); }
      } catch (e) { lastErr = e.message; say(`ssh not ready yet (${e.message.split('\n')[0]})`); }
      await new Promise((r) => setTimeout(r, 10000));
    }
    throw new Error(`cloud-init did not finish in time${lastErr ? ': ' + lastErr : ''}`);
  },
};

module.exports = { createCloud, cloudDeps, waitTcp, RECIPE_FOR_STACK };
