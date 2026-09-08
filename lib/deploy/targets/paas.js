'use strict';
/* PaaS target: the platform hosts and (mostly) builds the app; The Ascension
   fetches, detects, optionally builds locally, runs the provider CLI with the
   vault token in the environment, then verifies the deployment URL. */

const { PROVIDERS } = require('./paas/providers');
const { localExec, probeTool } = require('../exec');
const { isRef, refName } = require('../vault');

const paasDeps = { run: localExec, probe: probeTool };

module.exports = {
  id: 'paas', label: 'Platform (Vercel, Netlify, Cloudflare, Fly.io, Render)',
  capabilities: { exec: false, symlink: false, remoteBuild: false, hooksRemote: false, releases: false, paas: true },
  PROVIDERS,

  validate(t, ctx) {
    const err = (m) => { const e = new Error(m); e.status = 400; throw e; };
    const p = PROVIDERS[t.paas?.provider];
    if (!p) err(`paas.provider must be one of ${Object.keys(PROVIDERS).join(', ')}`);
    if (!isRef(t.paas.tokenRef)) err('paas.tokenRef must be a ${vault:NAME} reference');
    const paas = { provider: p.id, tokenRef: t.paas.tokenRef, prod: t.paas.prod !== false };
    for (const f of p.fields) { const v = String(t.paas[f.key] || '').trim(); if (f.required && !v) err(`paas.${f.key} is required for ${p.label}`); if (v && !/^[\w.@:\/-]{1,120}$/.test(v)) err(`paas.${f.key} has invalid characters`); paas[f.key] = v || null; }
    if (t.healthUrl && !/^https?:\/\//.test(t.healthUrl)) err('healthUrl must start with http:// or https://');
    return { ...t, type: 'paas', buildMode: p.buildLocal ? 'local' : 'provider', paas, healthUrl: t.healthUrl ? String(t.healthUrl) : '', healthRemote: false, keepReleases: 2, paths: { root: `${p.label} · ${paas.project || paas.site || paas.app || paas.serviceId || paas.accountId || ''}`.trim() }, web: { server: 'none', reloadCmd: '', phpFpmReload: '' }, process: { manager: 'none' } };
  },

  /** No remote shell: the "connection" is the CLI on this machine. */
  async connect(ctx, target, vault) {
    const p = PROVIDERS[target.paas.provider];
    const version = await paasDeps.probe(p.cli, p.cli === 'render' ? '--version' : '--version');
    if (!version) { const e = new Error(`${p.cli} CLI is not installed on this machine (${p.install})`); e.status = 400; throw e; }
    vault.get(refName(target.paas.tokenRef)); // fail early when the secret is missing
    return { kind: 'paas', canExec: false, paas: true, host: p.label, user: p.cli, cliVersion: version, close() {} };
  },
  probe(conn, target) { return { user: conn.user, tools: { [conn.user]: conn.cliVersion }, versions: { [conn.user]: (conn.cliVersion.match(/\d+\.\d+(\.\d+)?/) || [])[0] || null }, sudo: false, releases: [], rootWritable: true, symlinkOk: false, os: PROVIDERS[target.paas.provider].label, pulledAt: new Date().toISOString() }; },
  layout(target) { const r = `/paas/${target.paas.provider}`; return { root: r, releases: `${r}/deployments`, current: `${r}/production`, shared: `${r}/env`, cache: `${r}/cache`, lock: `${r}/.lock`, release: (ts) => `${r}/deployments/${ts}`, releaseTgz: (ts) => `${r}/deployments/${ts}.tgz`, releaseSrcTgz: (ts) => `${r}/deployments/${ts}.src.tgz` }; },
  reloadCommands() { return []; },

  /** Env for the CLI: token from the vault + provider extras; never logged. */
  env(target, vault) {
    const p = PROVIDERS[target.paas.provider];
    return { [p.tokenEnv]: vault.get(refName(target.paas.tokenRef)), CI: '1', ...(p.env ? p.env(target) : {}) };
  },
  /** Plan-time description of the deploy step (no secrets). */
  planStep(target, c) { const p = PROVIDERS[target.paas.provider]; const d = p.deploy(target, c); return { cmd: d.cmd.replace(/"\$\{[A-Z_]+\}"/g, '<token>'), cwd: d.cwd, label: `${p.label} deploy` }; },

  /** Run the deploy; returns {url, id, image?} */
  async deploy(target, vault, c, { onLine, signal } = {}) {
    const p = PROVIDERS[target.paas.provider];
    const d = p.deploy(target, c);
    let out = '';
    await paasDeps.run(d.cmd, { cwd: d.cwd, env: this.env(target, vault), onLine: (l, s) => { out += l + '\n'; if (onLine) onLine(l, s); }, signal, timeoutMs: 30 * 60000 });
    let info = p.parse(out, target) || {};
    if (p.afterDeploy) { let o2 = ''; try { await paasDeps.run(p.afterDeploy(target), { cwd: d.cwd, env: this.env(target, vault), onLine: (l) => { o2 += l + '\n'; }, signal, timeoutMs: 120000 }); info = { ...info, ...(p.parseAfter(o2) || {}) }; } catch {} }
    return info;
  },
  canRollback(target, prev) { const p = PROVIDERS[target.paas.provider]; return !!p.rollback(target, prev || {}); },
  async rollback(target, vault, prev, { onLine, signal } = {}) {
    const p = PROVIDERS[target.paas.provider];
    const r = p.rollback(target, prev || {});
    if (!r) throw new Error(`${p.label} has no rollback command for this deployment: redeploy a previous commit instead`);
    await paasDeps.run(r.cmd, { cwd: prev?.appDir || process.cwd(), env: this.env(target, vault), onLine, signal, timeoutMs: 15 * 60000 });
    return r.cmd.replace(/"\$\{[A-Z_]+\}"/g, '<token>');
  },
  paasDeps,
};
