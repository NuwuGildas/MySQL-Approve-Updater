'use strict';
/* VPS over SSH (Ubuntu/Debian-style). Reuses the app's SSH profiles.
   Layout: <root>/releases/<ts>, current -> releases/<ts>, shared/. */

const { q } = require('../shell');
const { assertSafeRoot } = require('./layout');
const R = require('./_release');
const { probe } = require('./_probe');
const { createSshConn } = require('../transports/ssh');

const WEB_SERVERS = ['nginx', 'apache', 'none'];
const PROCESS_MANAGERS = ['systemd', 'pm2', 'none'];

module.exports = {
  id: 'vps-ssh', label: 'VPS / server over SSH',
  capabilities: { exec: true, symlink: true, remoteBuild: true, hooksRemote: true, releases: true },

  /** Normalize + validate a target definition. Throws {status:400}. */
  validate(t, ctx) {
    const err = (m) => { const e = new Error(m); e.status = 400; throw e; };
    const profile = ctx.profileById(String(t.ssh?.profileId || ''));
    if (!profile || !profile.ssh?.enabled || !profile.ssh.host) err('ssh.profileId must reference a connection profile with SSH enabled');
    const root = assertSafeRoot(t.paths?.root, 'paths.root');
    const web = t.web || {};
    if (web.server && !WEB_SERVERS.includes(web.server)) err(`web.server must be one of ${WEB_SERVERS.join(', ')}`);
    const proc = t.process || {};
    if (proc.manager && !PROCESS_MANAGERS.includes(proc.manager)) err(`process.manager must be one of ${PROCESS_MANAGERS.join(', ')}`);
    if (proc.manager === 'systemd' && !/^[A-Za-z0-9_.@-]+$/.test(String(proc.unit || ''))) err('process.unit is required for systemd (e.g. myapp.service)');
    if (proc.manager === 'pm2' && !/^[A-Za-z0-9_.-]+$/.test(String(proc.name || ''))) err('process.name is required for pm2');
    if (t.healthUrl && !/^https?:\/\//.test(t.healthUrl)) err('healthUrl must start with http:// or https://');
    const bm = t.buildMode || 'auto';
    if (!['auto', 'local', 'remote'].includes(bm)) err('buildMode must be auto, local or remote');
    const envFile = t.envFile ? { target: String(t.envFile.target || 'shared/.env'), mode: ['keep', 'upload', 'always'].includes(t.envFile.mode) ? t.envFile.mode : 'keep', fromVault: t.envFile.fromVault ? String(t.envFile.fromVault) : null } : null;
    if (envFile && envFile.target.includes('..')) err('envFile.target must be relative to the app root');
    let domain = null;
    if (t.domain && t.domain.name) {
      const name = String(t.domain.name).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(name)) err('domain.name must be a hostname like shop.example.com');
      const email = t.domain.email ? String(t.domain.email).trim() : '';
      if (t.domain.ssl && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) err("domain.email is required for Let's Encrypt");
      domain = { name, ssl: !!t.domain.ssl, email, www: !!t.domain.www };
    }
    return {
      ...t, buildMode: bm, ssh: { profileId: profile.id }, paths: { root },
      web: { server: web.server || 'none', reloadCmd: web.reloadCmd ? String(web.reloadCmd) : '', phpFpmReload: web.phpFpmReload ? String(web.phpFpmReload) : '' },
      process: { manager: proc.manager || 'none', unit: proc.unit ? String(proc.unit) : '', name: proc.name ? String(proc.name) : '' },
      healthUrl: t.healthUrl ? String(t.healthUrl) : '', healthRemote: !!t.healthRemote,
      keepReleases: Math.min(50, Math.max(2, Number(t.keepReleases) || 5)), envFile, domain,
    };
  },

  async connect(ctx, target, vault, { signal } = {}) {
    const profile = ctx.profileById(target.ssh.profileId);
    if (!profile?.ssh?.enabled) { const e = new Error('SSH profile no longer exists'); e.status = 400; throw e; }
    const conn = await createSshConn(ctx, profile.ssh, { signal });
    if (!conn.canExec) { conn.close(); throw new Error('the SSH account has no shell access; a VPS target needs a shell'); }
    return conn;
  },

  probe(conn, target) { return probe(conn, target.paths.root); },
  layout(target) { return R.mkLayout(target.paths.root); },
  prepare: R.prepare, lock: R.lock, unlock: R.unlock, extractTgz: R.extractTgz, linkShared: R.linkShared,
  listReleases: R.listReleases, prune: R.prune, discardRelease: R.discardRelease,

  /** Build the list of reload/restart commands for this target+manifest. */
  reloadCommands(target, manifest, L) {
    const cmds = [];
    const kind = manifest.runtime?.kind;
    if (kind === 'php-fpm' && target.web.phpFpmReload) cmds.push({ cmd: target.web.phpFpmReload, label: 'reload PHP-FPM' });
    if (target.web.reloadCmd) cmds.push({ cmd: target.web.reloadCmd, label: `reload ${target.web.server === 'none' ? 'web server' : target.web.server}` });
    if (kind === 'node' || kind === 'python') {
      if (target.process.manager === 'systemd') cmds.push({ cmd: `sudo -n systemctl restart ${q(target.process.unit)}`, label: `restart ${target.process.unit}` });
      if (target.process.manager === 'pm2') cmds.push({ cmd: `cd ${q(L.current)} && pm2 startOrReload ecosystem.config.cjs --update-env --name ${q(target.process.name)}`, label: `pm2 reload ${target.process.name}` });
    }
    return cmds;
  },

  async activate(conn, L, ts, target, manifest, { onLine, warn, probe: pr } = {}) {
    await R.switchCurrent(conn, L, ts, { onLine });
    await this.reload(conn, L, target, manifest, { onLine, warn, probe: pr });
  },

  async reload(conn, L, target, manifest, { onLine, warn, probe: pr } = {}) {
    for (const { cmd, label } of this.reloadCommands(target, manifest, L)) {
      try { await conn.exec(cmd, { onLine, timeoutMs: 120000 }); if (onLine) onLine(`${label}: ok`); }
      catch (e) {
        if (/^sudo /.test(cmd) && pr && pr.sudo === false) { if (warn) warn(`${label} skipped: passwordless sudo is not available (${e.message})`); }
        else throw new Error(`${label} failed: ${e.message}`);
      }
    }
  },

  async rollback(conn, L, toTs, target, manifest, o = {}) {
    await R.switchCurrent(conn, L, toTs, o);
    await this.reload(conn, L, target, manifest, o);
  },

  /** Commands that bind the domain to the current release and issue a certificate (all via sudo -n). */
  routeCommands(target, manifest, L) {
    const d = target.domain; if (!d?.name) return [];
    const templates = require('../templates');
    const names = [d.name, ...(d.www ? ['www.' + d.name] : [])];
    const conf = manifest.runtime.kind === 'php-fpm' ? templates.nginxPhp({ domain: names.join(' '), current: L.current, docroot: manifest.runtime.docroot, phpVersion: manifest.stack.php })
      : ['node', 'python', 'docker'].includes(manifest.runtime.kind) ? templates.nginxNode({ domain: names.join(' '), port: manifest.runtime.port || 3000 })
      : templates.nginxStatic({ domain: names.join(' '), current: L.current, docroot: manifest.runtime.docroot });
    const site = d.name.replace(/[^a-z0-9.-]/g, '_');
    const cmds = [
      { cmd: `printf %s ${q(conf)} | sudo -n tee ${q('/etc/nginx/sites-available/' + site)} >/dev/null`, label: 'write nginx vhost' },
      { cmd: `sudo -n ln -sfn ${q('/etc/nginx/sites-available/' + site)} ${q('/etc/nginx/sites-enabled/' + site)}`, label: 'enable vhost' },
      { cmd: 'sudo -n nginx -t && sudo -n systemctl reload nginx', label: 'reload nginx' },
    ];
    if (d.ssl) cmds.push({ cmd: `sudo -n certbot --nginx --non-interactive --agree-tos --redirect -m ${q(d.email)} ${names.map((n) => '-d ' + q(n)).join(' ')}`, label: "Let's Encrypt certificate", optional: true });
    return cmds;
  },

  /** Where the web server should point (for templates). */
  webRoot(L, manifest) { const d = manifest.runtime?.docroot || '.'; return d === '.' ? L.current : `${L.current}/${d}`; },
};
