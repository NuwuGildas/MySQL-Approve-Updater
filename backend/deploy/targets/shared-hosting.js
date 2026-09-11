'use strict';
/* Shared hosting (cPanel / Plesk / generic). Always local build.
   - SFTP with a shell: release layout under `home`, docroot strategy
     `symlink` (public_html -> current/<docroot>) or `htaccess` (rewrite into
     public_html/current/).
   - FTP(S) or SFTP without shell: `in-place` strategy: upload to a sibling
     dir and swap with two renames (fallback: maintenance page + overwrite). */

const posix = require('path').posix;
const { q } = require('../shell');
const { assertSafeRoot, assertInside, assertRelease, RELEASE_RE } = require('./layout');
const R = require('./_release');
const { probe } = require('./_probe');
const { createSshConn } = require('../transports/ssh');
const { createFtpConn } = require('../transports/ftp');
const templates = require('../templates');

const STRATEGIES = ['auto', 'symlink', 'htaccess', 'in-place'];

module.exports = {
  id: 'shared-hosting', label: 'Shared hosting (SFTP / FTP)',
  capabilities: { exec: 'maybe', symlink: 'maybe', remoteBuild: false, hooksRemote: 'maybe', releases: 'maybe' },

  validate(t, ctx) {
    const err = (m) => { const e = new Error(m); e.status = 400; throw e; };
    const tr = t.transport || {};
    let transport;
    if (tr.kind === 'sftp') {
      const profile = ctx.profileById(String(tr.profileId || ''));
      if (!profile || !profile.ssh?.enabled) err('transport.profileId must reference a connection profile with SSH enabled');
      transport = { kind: 'sftp', profileId: profile.id };
    } else if (tr.kind === 'ftp' || tr.kind === 'ftps') {
      if (!tr.host) err('transport.host is required');
      if (!tr.user) err('transport.user is required');
      if (!tr.passwordRef || !/^\$\{vault:[A-Z0-9_]+\}$/.test(tr.passwordRef)) err('transport.passwordRef must be a ${vault:NAME} reference');
      transport = { kind: tr.kind, host: String(tr.host), port: Number(tr.port) || (tr.kind === 'ftps' && tr.secure === 'implicit' ? 990 : 21), user: String(tr.user), passwordRef: tr.passwordRef, secure: tr.kind === 'ftps' ? (tr.secure === 'implicit' ? 'implicit' : true) : false, rejectUnauthorized: tr.rejectUnauthorized !== false };
    } else err('transport.kind must be sftp, ftp or ftps');
    const isFtp = transport.kind !== 'sftp';
    // FTP accounts are chrooted; "/" is a legitimate home there
    const home = isFtp ? (String(t.paths?.home || '/').trim() || '/') : assertSafeRoot(t.paths?.home, 'paths.home');
    if (!home.startsWith('/') || home.split('/').includes('..')) err('paths.home must be an absolute path');
    const docroot = String(t.paths?.docroot || '').trim();
    if (!docroot) err('paths.docroot is required (e.g. /home/acme/public_html)');
    const dr = home === '/' ? (docroot.startsWith('/') && docroot.length > 1 && !docroot.includes('..') ? posix.normalize(docroot).replace(/\/+$/, '') : err('paths.docroot must be an absolute path')) : assertInside(home, docroot, 'paths.docroot');
    const strategy = t.docrootStrategy || 'auto';
    if (!STRATEGIES.includes(strategy)) err(`docrootStrategy must be one of ${STRATEGIES.join(', ')}`);
    if (isFtp && !['auto', 'in-place'].includes(strategy)) err('FTP targets only support the in-place strategy');
    if (t.buildMode && t.buildMode !== 'local' && t.buildMode !== 'auto') err('shared hosting targets always build locally');
    if (t.healthUrl && !/^https?:\/\//.test(t.healthUrl)) err('healthUrl must start with http:// or https://');
    const envFile = t.envFile ? { target: String(t.envFile.target || 'shared/.env'), mode: ['keep', 'upload', 'always'].includes(t.envFile.mode) ? t.envFile.mode : 'keep', fromVault: t.envFile.fromVault ? String(t.envFile.fromVault) : null } : null;
    return { ...t, buildMode: 'local', transport, paths: { home, docroot: dr }, docrootStrategy: strategy, healthUrl: t.healthUrl ? String(t.healthUrl) : '', healthRemote: false, keepReleases: Math.min(20, Math.max(2, Number(t.keepReleases) || 2)), envFile, web: { server: 'apache', reloadCmd: '', phpFpmReload: '' }, process: { manager: 'none' } };
  },

  async connect(ctx, target, vault, { signal } = {}) {
    const tr = target.transport;
    if (tr.kind === 'sftp') {
      const profile = ctx.profileById(tr.profileId);
      if (!profile?.ssh?.enabled) { const e = new Error('SSH profile no longer exists'); e.status = 400; throw e; }
      return createSshConn(ctx, profile.ssh, { signal });
    }
    return createFtpConn({ ...tr, password: vault.resolveRef(tr.passwordRef) }, { signal });
  },

  probe(conn, target) { return probe(conn, target.paths.home); },

  /** Effective strategy once we know what the connection can do. */
  strategyFor(target, conn, pr) {
    if (!conn.canExec) return 'in-place';
    if (target.docrootStrategy !== 'auto') return target.docrootStrategy;
    return pr && pr.symlinkOk === false ? 'htaccess' : 'symlink';
  },

  layout(target) {
    if (target.transport.kind === 'sftp') return R.mkLayout(target.paths.home);
    // FTP: no shell, so the release layout is never created on the server; these paths only feed ${release}/${current} placeholders
    const r = target.paths.home.replace(/\/+$/, '');
    return { root: r || '/', releases: `${r}/releases`, current: `${r}/current`, currentTmp: `${r}/current.tmp`, shared: `${r}/shared`, cache: `${r}/shared/cache`, lock: `${r}/.ship-lock`, release: (ts) => `${r}/releases/${assertRelease(ts)}`, releaseTgz: (ts) => `${r}/releases/${assertRelease(ts)}.tgz`, releaseSrcTgz: (ts) => `${r}/releases/${assertRelease(ts)}.src.tgz` };
  },
  prepare: R.prepare, lock: R.lock, unlock: R.unlock, extractTgz: R.extractTgz, linkShared: R.linkShared,
  listReleases: R.listReleases, prune: R.prune, discardRelease: R.discardRelease,
  reloadCommands() { return []; },
  async reload() {},

  /** Point the docroot at the release (shell strategies). */
  async activate(conn, L, ts, target, manifest, { onLine, warn, strategy } = {}) {
    await R.switchCurrent(conn, L, ts, { onLine });
    await this.bindDocroot(conn, L, target, manifest, { onLine, warn, strategy });
  },
  async rollback(conn, L, toTs, target, manifest, o = {}) {
    await R.switchCurrent(conn, L, toTs, o);
    await this.bindDocroot(conn, L, target, manifest, o);
  },
  async bindDocroot(conn, L, target, manifest, { onLine, warn, strategy } = {}) {
    const docroot = target.paths.docroot;
    const inner = manifest.runtime?.docroot && manifest.runtime.docroot !== '.' ? `${L.current}/${manifest.runtime.docroot}` : L.current;
    if (strategy === 'symlink') {
      // one-time: move a real public_html aside, then keep the link fresh
      await conn.exec(`if [ -d ${q(docroot)} ] && [ ! -L ${q(docroot)} ]; then mv ${q(docroot)} ${q(docroot + '.pre-servertools')}; echo "moved existing ${docroot} to ${docroot}.pre-servertools"; fi; ln -sfn ${q(inner)} ${q(docroot)}`, { onLine });
    } else if (strategy === 'htaccess') {
      const ht = templates.htaccessRewrite({ target: 'current' });
      await conn.exec(`mkdir -p ${q(docroot)}; ln -sfn ${q(inner)} ${q(docroot + '/current')}`, { onLine });
      const existing = await conn.readFile(`${docroot}/.htaccess`);
      if (existing === null || existing.includes('Managed by Server Tools')) await conn.writeFile(`${docroot}/.htaccess`, ht);
      else if (warn) warn(`${docroot}/.htaccess exists and is not managed by Server Tools: add the rewrite into current/ yourself (see Setup tab)`);
    }
  },

  /* ---------------- in-place strategy (no shell) ---------------- */
  inPlacePaths(target, ts, prevTs) {
    assertRelease(ts);
    const d = target.paths.docroot;
    // the swapped-out copy is named after ITS OWN release (from its .ship-manifest.json); a pre-existing
    // site with no manifest gets a timestamp one second before the new release so listings stay ordered
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(ts);
    const oneSecondBefore = require('./layout').newReleaseName(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - 1000));
    const oldTs = prevTs && RELEASE_RE.test(prevTs) && prevTs !== ts ? prevTs : oneSecondBefore;
    return { docroot: d, next: `${d}-new-${ts}`, old: `${d}-old-${oldTs}`, oldTs, parent: posix.dirname(d) };
  },
  async readInPlaceManifest(conn, docroot) {
    try { return JSON.parse(await conn.readFile(`${docroot}/.ship-manifest.json`)); } catch { return null; }
  },
  /** Can we create a sibling dir next to the docroot? */
  async canSwap(conn, target) {
    const probeDir = `${target.paths.docroot}-st-probe-${Date.now().toString(36)}`;
    try { await conn.mkdirp(probeDir); await conn.removeTree(probeDir); return true; } catch { return false; }
  },
  async shipInPlace(conn, target, ts, stagingDir, { onLine, onProgress, warn, swap = true, previousManifest = null } = {}) {
    const prevManifest = previousManifest || await this.readInPlaceManifest(conn, target.paths.docroot);
    const P = this.inPlacePaths(target, ts, prevManifest?.ts);
    const files = await require('../transports/ssh').walkLocal(stagingDir);
    const fileList = files.map((f) => f.rel);
    if (swap) {
      await conn.uploadDir(stagingDir, P.next, { onProgress });
      await conn.writeFile(`${P.next}/.ship-manifest.json`, JSON.stringify({ ts, files: fileList }));
      const hadOld = await conn.exists(P.docroot);
      if (hadOld) await conn.rename(P.docroot, P.old);
      try { await conn.rename(P.next, P.docroot); }
      catch (e) { if (hadOld) { try { await conn.rename(P.old, P.docroot); } catch {} } throw new Error(`swap failed: ${e.message}`); }
      if (onLine) onLine(`swapped ${P.docroot} (previous kept as ${P.old})`);
      return { mode: 'swap', previous: hadOld ? P.old : null };
    }
    // overwrite mode: maintenance page, upload over, delete stale, clear maintenance
    if (warn) warn('docroot parent is not writable: using maintenance-page + overwrite mode (brief downtime, best-effort rollback)');
    const fs = require('fs'), path = require('path');
    await conn.mkdirp(P.docroot);
    const origHt = await conn.readFile(`${P.docroot}/.htaccess`);
    const userHt = origHt && !origHt.includes('Server Tools maintenance') ? origHt : null;
    const prev = prevManifest;
    await conn.writeFile(`${P.docroot}/.st-maintenance.html`, templates.maintenanceHtml({ name: target.name }));
    await conn.writeFile(`${P.docroot}/.htaccess`, templates.htaccessMaintenance() + (userHt ? '\n' + userHt : ''));
    try {
      await conn.uploadDir(stagingDir, P.docroot, { onProgress });
      const keep = new Set(fileList);
      for (const rel of prev?.files || []) if (!keep.has(rel) && rel !== '.htaccess' && !rel.includes('..')) { try { await conn.removeTree(`${P.docroot}/${rel}`); } catch {} }
      await conn.writeFile(`${P.docroot}/.ship-manifest.json`, JSON.stringify({ ts, files: fileList }));
    } finally {
      // restore the real .htaccess: the one we just uploaded, else the user's previous one, else none
      const shipped = fileList.includes('.htaccess') ? fs.readFileSync(path.join(stagingDir, '.htaccess'), 'utf8') : null;
      const finalHt = shipped ?? userHt;
      if (finalHt !== null) await conn.writeFile(`${P.docroot}/.htaccess`, finalHt); else { try { await conn.removeTree(`${P.docroot}/.htaccess`); } catch {} }
      try { await conn.removeTree(`${P.docroot}/.st-maintenance.html`); } catch {}
    }
    return { mode: 'overwrite', previous: null };
  },
  async rollbackInPlace(conn, target, toOld, { onLine } = {}) {
    // toOld = "<docroot>-old-<ts>" ; current docroot becomes "<docroot>-failed-<ts>"
    const ts = (toOld.match(/-old-(\d{14})$/) || [])[1];
    if (!ts) throw new Error('no previous in-place release to roll back to');
    const failed = `${target.paths.docroot}-failed-${ts}`;
    if (await conn.exists(target.paths.docroot)) await conn.rename(target.paths.docroot, failed);
    await conn.rename(toOld, target.paths.docroot);
    try { await conn.removeTree(failed); } catch {}
    if (onLine) onLine(`rolled back ${target.paths.docroot} to ${toOld}`);
  },
  async listInPlace(conn, target) {
    const P = { parent: posix.dirname(target.paths.docroot), base: posix.basename(target.paths.docroot) };
    const l = (await conn.list(P.parent)) || [];
    const re = new RegExp(`^${P.base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-old-(\\d{14})$`);
    const olds = l.filter((e) => e.type === 'dir' && re.test(e.name)).map((e) => ({ ts: re.exec(e.name)[1], path: posix.join(P.parent, e.name), current: false })).sort((a, b) => a.ts.localeCompare(b.ts));
    let cur = null; try { cur = JSON.parse(await conn.readFile(`${target.paths.docroot}/.ship-manifest.json`)); } catch {}
    return { current: cur?.ts || null, releases: [...olds, ...(cur?.ts ? [{ ts: cur.ts, path: target.paths.docroot, current: true }] : [])] };
  },
  async pruneInPlace(conn, target, keep, { onLine } = {}) {
    const { releases } = await this.listInPlace(conn, target);
    const olds = releases.filter((r) => !r.current);
    const remove = olds.slice(0, Math.max(0, olds.length - Math.max(1, keep - 1)));
    for (const r of remove) { if (RELEASE_RE.test(r.ts)) { try { await conn.removeTree(r.path); if (onLine) onLine(`pruned ${r.path}`); } catch {} } }
    return remove.map((r) => r.ts);
  },
};
