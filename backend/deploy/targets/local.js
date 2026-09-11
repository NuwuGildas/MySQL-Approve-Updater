'use strict';
/* "This computer": deploy into a folder on the machine that runs Server Tools.
   Same release layout as a VPS (releases/<ts>, current, shared/) but implemented with Node's fs so it
   works on Windows too: `current` and shared dirs are directory junctions there (no privilege needed),
   shared files are symlinks, hard links or copies, in that order of preference. Builds always run on
   this machine; hooks and the optional after-activation command run in the local shell. */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const tar = require('tar');
const { localExec, capture, probeTool } = require('../exec');
const { q } = require('../shell');
const { assertRelease, RELEASE_RE } = require('./layout');

const isWin = process.platform === 'win32';
const PROCESS_MANAGERS = ['none', 'pm2'];
const LOCK_STALE_MS = 2 * 3600e3;
const TOOLS = { git: '--version', php: '-v', composer: '--version', node: '-v', npm: '-v', pnpm: '-v', yarn: '-v', bun: '-v', pm2: '-v', docker: '--version', python3: '--version', python: '--version' };

const err = (m, status = 400) => { const e = new Error(m); e.status = status; return e; };
const qq = (s) => (isWin ? `"${String(s).replace(/"/g, '""')}"` : q(s)); // quoting for the local shell
const exampleRoot = (slug) => path.join(os.homedir(), 'www', slug);

/** Absolute native path, normalized; refuses drive roots, system and personal folders, shallow paths. */
function assertLocalRoot(root, label = 'paths.root') {
  if (typeof root !== 'string' || !root.trim()) throw err(`${label} is required`);
  let r = root.trim().replace(/^~(?=$|[\\/])/, os.homedir());
  if (/[\0\n\r]/.test(r)) throw err(`${label} contains invalid characters`);
  if (!path.isAbsolute(r)) throw err(`${label} must be an absolute path on this computer (got "${r}")`);
  if (r.split(/[\\/]/).includes('..')) throw err(`${label} must not contain ".."`);
  r = path.resolve(r).replace(/[\\/]+(?<=.)$/, '');
  const low = (s) => (isWin ? s.toLowerCase() : s);
  const home = low(os.homedir());
  const forbidden = new Set([home, low(path.join(os.homedir(), 'Desktop')), low(path.join(os.homedir(), 'Documents')), low(path.join(os.homedir(), 'Downloads')),
    ...(isWin ? ['c:\\users', 'c:\\programdata'] : ['/', '/home', '/root', '/var', '/etc', '/usr', '/opt', '/tmp', '/bin', '/sbin', '/lib', '/boot', '/dev', '/proc', '/sys', '/Applications', '/Library', '/System', '/private'])]);
  const n = low(r);
  if (forbidden.has(n) || /^[a-z]:\\?$/.test(n) || (isWin && /^[a-z]:\\(windows|program files( \(x86\))?)(\\|$)/.test(n)) || n === '/') {
    throw err(`${label} "${r}" is a system or personal folder; use a dedicated app folder like ${exampleRoot('myapp')}`);
  }
  const segs = r.split(/[\\/]/).filter((s) => s && !/^[A-Za-z]:$/.test(s));
  if (segs.length < 2) throw err(`${label} "${r}" is too shallow; use at least two folders (e.g. ${exampleRoot('myapp')})`);
  return r;
}

/** Native release layout under a root (string) or a target. */
function layout(t) {
  const root = typeof t === 'string' ? t : t?.paths?.root;
  const r = assertLocalRoot(root);
  const j = (...p) => path.join(r, ...p);
  return {
    root: r, releases: j('releases'), current: j('current'), currentTmp: j('current.tmp'), shared: j('shared'), cache: j('shared', 'cache'), lock: j('.ship-lock'), local: true,
    release: (ts) => j('releases', assertRelease(ts)),
    releaseTgz: (ts) => j('releases', assertRelease(ts) + '.tgz'),
    releaseSrcTgz: (ts) => j('releases', assertRelease(ts) + '.src.tgz'),
  };
}

/* ---- links: junctions on Windows, relative symlinks elsewhere ---- */
async function lstatOrNull(p) { try { return await fsp.lstat(p); } catch { return null; } }
/** Remove a link (never following it), a file, or a directory tree. */
async function rmLink(p) {
  const st = await lstatOrNull(p); if (!st) return;
  if (st.isSymbolicLink()) {
    if (isWin) { try { await fsp.rmdir(p); return; } catch {} }
    await fsp.unlink(p); return;
  }
  if (st.isDirectory()) await fsp.rm(p, { recursive: true, force: true }); else await fsp.unlink(p);
}
async function linkDir(target, link) {
  if (isWin) await fsp.symlink(path.resolve(target), link, 'junction');
  else await fsp.symlink(path.relative(path.dirname(link), target) || '.', link);
}
async function linkFile(target, link, warn) {
  try { await fsp.symlink(isWin ? path.resolve(target) : path.relative(path.dirname(link), target), link, 'file'); return 'symlink'; }
  catch (e) { if (!isWin) throw e; }
  try { await fsp.link(target, link); return 'hard link'; } catch {}
  await fsp.copyFile(target, link);
  if (warn) warn(`shared file ${path.basename(link)} was copied (this Windows account cannot create links): edits in shared/ apply on the next deploy`);
  return 'copy';
}
/** Remove every link inside a tree first so a recursive delete can never reach into shared/. */
async function unlinkAll(dir) {
  let ents = []; try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) await rmLink(p);
    else if (e.isDirectory()) await unlinkAll(p);
  }
}

/* ---- the "connection": local fs + local shell with the same surface as the SSH conn ---- */
function createLocalConn() {
  return {
    kind: 'local', canExec: true, user: (() => { try { return os.userInfo().username; } catch { return 'me'; } })(), host: os.hostname(), home: os.homedir(),
    async exec(cmd, o = {}) {
      const out = [];
      const cmds = Array.isArray(cmd) ? cmd.join(' && ') : cmd;
      const r = await localExec(cmds, { ...o, onLine: (l, s) => { if (s === 'out' && out.length < 5000) out.push(l); if (o.onLine) o.onLine(l, s); } });
      return { ...r, out: out.join('\n') };
    },
    capture: (cmd, o = {}) => capture(cmd, o),
    exists: async (p) => { try { await fsp.access(p); return true; } catch { return false; } },
    mkdirp: (p) => fsp.mkdir(p, { recursive: true }),
    readFile: (p) => fsp.readFile(p, 'utf8'),
    async writeFile(p, content, mode) { await fsp.mkdir(path.dirname(p), { recursive: true }); await fsp.writeFile(p, content, mode ? { mode } : undefined); },
    async uploadFile(src, dst, onProgress) { await fsp.mkdir(path.dirname(dst), { recursive: true }); await fsp.copyFile(src, dst); if (onProgress) { const s = (await fsp.stat(dst)).size; onProgress(s, s); } },
    close() {},
  };
}

/* ---- release operations (native) ---- */
async function prepare(conn, L) { for (const d of [L.releases, L.shared, L.cache]) await fsp.mkdir(d, { recursive: true }); }

async function lock(conn, L, owner, { force = false } = {}) {
  const ownerLine = `${owner.runId} ${owner.host} ${new Date().toISOString()}`;
  const tryLock = async () => { try { await fsp.mkdir(L.lock); await fsp.writeFile(path.join(L.lock, 'owner'), ownerLine); return true; } catch (e) { if (e.code === 'EEXIST') return false; throw e; } };
  if (await tryLock()) return;
  let prev = ''; try { prev = (await fsp.readFile(path.join(L.lock, 'owner'), 'utf8')).trim(); } catch {}
  const ts = Date.parse(prev.split(' ')[2] || '');
  const stale = !Number.isFinite(ts) || Date.now() - ts > LOCK_STALE_MS;
  if (!stale && !force) throw err(`target is locked by another deploy (${prev || 'unknown owner'}); wait for it or force-unlock`, 409);
  await fsp.rm(L.lock, { recursive: true, force: true });
  if (!(await tryLock())) throw err('could not acquire the deploy lock', 409);
}
async function unlock(conn, L) { try { await fsp.rm(L.lock, { recursive: true, force: true }); } catch {} }

async function extractTgz(conn, L, ts, localTgz, { onLine, onProgress, onEntry } = {}) {
  const rel = L.release(ts);
  await fsp.mkdir(rel, { recursive: true });
  let n = 0;
  await tar.x({ file: localTgz, cwd: rel, onReadEntry: () => { if (onEntry && ++n % 50 === 0) onEntry(n, null); } });
  if (onEntry) onEntry(n, n);
  if (onProgress) { const s = (await fsp.stat(localTgz)).size; onProgress(s, s); }
  if (onLine) onLine(`extracted ${path.basename(localTgz)} → ${rel}`);
}

async function linkShared(conn, L, ts, manifest, { onLine, warn } = {}) {
  const rel = L.release(ts);
  for (const d of manifest.shared?.dirs || []) {
    const src = path.join(rel, d), dst = path.join(L.shared, d);
    await fsp.mkdir(dst, { recursive: true }); await fsp.mkdir(path.dirname(src), { recursive: true });
    const st = await lstatOrNull(src);
    if (st && st.isDirectory() && !st.isSymbolicLink()) { // first deploy: seed shared/ from the release's own copy
      try { await fsp.cp(src, dst, { recursive: true, force: false, errorOnExist: false }); } catch {}
      await fsp.rm(src, { recursive: true, force: true });
    } else if (st) await rmLink(src);
    await linkDir(dst, src);
    if (onLine) onLine(`shared dir ${d} → ${dst}`);
  }
  for (const f of manifest.shared?.files || []) {
    const src = path.join(rel, f), dst = path.join(L.shared, f);
    await fsp.mkdir(path.dirname(dst), { recursive: true }); await fsp.mkdir(path.dirname(src), { recursive: true });
    const st = await lstatOrNull(src);
    if (st && st.isFile() && !fs.existsSync(dst)) await fsp.copyFile(src, dst);
    if (!fs.existsSync(dst)) { if (warn) warn(`shared file ${f} does not exist yet: create ${dst}`); await fsp.writeFile(dst, ''); }
    if (st) await rmLink(src);
    const how = await linkFile(dst, src, warn);
    if (onLine) onLine(`shared file ${f} → ${dst} (${how})`);
  }
}

/** current → releases/<ts>: rename over the old link where the OS allows it, otherwise remove + link. */
async function switchCurrent(conn, L, ts, { onLine } = {}) {
  assertRelease(ts);
  const rel = L.release(ts);
  if (!fs.existsSync(rel)) throw err(`release ${ts} does not exist`);
  await rmLink(L.currentTmp);
  await linkDir(rel, L.currentTmp);
  try { await fsp.rename(L.currentTmp, L.current); }
  catch { await rmLink(L.current); await fsp.rename(L.currentTmp, L.current); }
  if (onLine) onLine(`current → releases/${ts}`);
}

async function currentRelease(L) {
  let target = null;
  try { target = await fsp.readlink(L.current); } catch { try { target = await fsp.realpath(L.current); } catch { return null; } }
  const name = path.basename(String(target).replace(/[\\/]+$/, ''));
  return RELEASE_RE.test(name) ? name : null;
}

async function listReleases(conn, L) {
  let names = [];
  try { names = (await fsp.readdir(L.releases, { withFileTypes: true })).filter((e) => e.isDirectory() && RELEASE_RE.test(e.name)).map((e) => e.name).sort(); } catch {}
  const current = await currentRelease(L);
  const releases = [];
  for (const ts of names) {
    let info = {}; try { info = JSON.parse(await fsp.readFile(path.join(L.releases, ts, '.release.json'), 'utf8')); } catch {}
    releases.push({ ts, ...info, current: ts === current });
  }
  return { current, releases };
}

async function discardRelease(conn, L, ts) {
  const rel = L.release(ts);
  await unlinkAll(rel).catch(() => {});
  for (const p of [rel, L.releaseTgz(ts), L.releaseSrcTgz(ts)]) { try { await fsp.rm(p, { recursive: true, force: true }); } catch {} }
}

async function prune(conn, L, keep, protect = [], { onLine } = {}) {
  const { current, releases } = await listReleases(conn, L);
  const keepSet = new Set([current, ...protect].filter(Boolean));
  const candidates = releases.map((r) => r.ts).filter((ts) => !keepSet.has(ts));
  const toRemove = candidates.slice(0, Math.max(0, releases.length - Math.max(2, keep)));
  for (const ts of toRemove) { await discardRelease(conn, L, ts); if (onLine) onLine(`pruned release ${ts}`); }
  return toRemove;
}

/* ---- probe (read-only) ---- */
async function probe(conn, target) {
  const root = target.paths.root;
  const L = layout(root);
  const tools = {};
  await Promise.all(Object.entries(TOOLS).map(async ([t, a]) => { try { const v = await probeTool(t, a); if (v) tools[t] = typeof v === 'string' ? v : 'present'; } catch {} }));
  const rootExists = fs.existsSync(root);
  // writable = the folder itself, or the nearest existing ancestor (prepare() creates the rest with mkdir -p)
  let probeDir = root; while (!fs.existsSync(probeDir) && path.dirname(probeDir) !== probeDir) probeDir = path.dirname(probeDir);
  let rootWritable = false; try { await fsp.access(probeDir, fs.constants.W_OK); rootWritable = true; } catch {}
  const { current, releases } = rootExists ? await listReleases(conn, L) : { current: null, releases: [] };
  let lockOwner = null; try { lockOwner = (await fsp.readFile(path.join(L.lock, 'owner'), 'utf8')).trim() || null; } catch {}
  let symlinkOk = null;
  try { const t = await fsp.mkdtemp(path.join(os.tmpdir(), 'st-link-')); await fsp.mkdir(path.join(t, 'd')); await linkDir(path.join(t, 'd'), path.join(t, 'l')); await rmLink(path.join(t, 'l')); await fsp.rm(t, { recursive: true, force: true }); symlinkOk = true; } catch { symlinkOk = false; }
  let disk = ''; try { const s = await fsp.statfs(rootExists ? root : path.dirname(root)); const fmt = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + 'G' : (n / 1e6).toFixed(0) + 'M'); disk = `${fmt(s.bavail * s.bsize)} free of ${fmt(s.blocks * s.bsize)}`; } catch {}
  const ver = (s) => (s && (String(s).match(/\d+\.\d+(\.\d+)?/) || [])[0]) || null;
  return {
    user: conn.user, home: os.homedir(), host: os.hostname(), os: `${os.type()} ${os.release()} (${os.arch()})`, arch: os.arch(), sudo: false, shell_ok: 'yes', local: true,
    tools, versions: Object.fromEntries(Object.entries(tools).map(([k, v]) => [k, ver(v)])),
    rootExists, rootWritable, disk, current, releases: releases.map((r) => r.ts), lock: lockOwner, symlinkOk, pulledAt: new Date().toISOString(),
  };
}

module.exports = {
  id: 'local', label: 'This computer',
  capabilities: { exec: true, symlink: true, remoteBuild: false, hooksRemote: true, releases: true, local: true },

  validate(t) {
    const root = assertLocalRoot(t.paths?.root);
    const proc = t.process || {};
    if (proc.manager && !PROCESS_MANAGERS.includes(proc.manager)) throw err(`process.manager must be one of ${PROCESS_MANAGERS.join(', ')}`);
    if (proc.manager === 'pm2' && !/^[A-Za-z0-9_.-]+$/.test(String(proc.name || ''))) throw err('process.name is required for pm2');
    if (t.healthUrl && !/^https?:\/\//.test(t.healthUrl)) throw err('healthUrl must start with http:// or https://');
    const envFile = t.envFile ? { target: String(t.envFile.target || 'shared/.env'), mode: ['keep', 'upload', 'always'].includes(t.envFile.mode) ? t.envFile.mode : 'keep', fromVault: t.envFile.fromVault ? String(t.envFile.fromVault) : null } : null;
    if (envFile && envFile.target.includes('..')) throw err('envFile.target must be relative to the app root');
    const out = {
      ...t, buildMode: 'local', paths: { root },
      web: { server: 'none', reloadCmd: t.web?.reloadCmd ? String(t.web.reloadCmd) : '', phpFpmReload: '' },
      process: { manager: proc.manager || 'none', unit: '', name: proc.name ? String(proc.name) : '' },
      healthUrl: t.healthUrl ? String(t.healthUrl) : '', healthRemote: false,
      keepReleases: Math.min(50, Math.max(2, Number(t.keepReleases) || 3)), envFile, domain: null,
    };
    delete out.ssh; delete out.transport; delete out.paas; delete out.docrootStrategy;
    return out;
  },

  async connect() { return createLocalConn(); },
  probe, layout,
  prepare, lock, unlock, extractTgz, linkShared, listReleases, prune, discardRelease, switchCurrent,

  reloadCommands(target, manifest, L) {
    const cmds = [];
    if ((manifest.runtime?.kind === 'node' || manifest.runtime?.kind === 'python') && target.process?.manager === 'pm2') {
      cmds.push({ cmd: `pm2 startOrReload ${qq(path.join(L.current, 'ecosystem.config.cjs'))} --update-env --name ${qq(target.process.name)}`, label: `pm2 reload ${target.process.name}` });
    }
    if (target.web?.reloadCmd) cmds.push({ cmd: target.web.reloadCmd, label: 'after-activation command' });
    return cmds;
  },
  async reload(conn, L, target, manifest, { onLine } = {}) {
    for (const { cmd, label } of this.reloadCommands(target, manifest, L)) {
      try { await conn.exec(cmd, { cwd: L.current, onLine, timeoutMs: 120000 }); if (onLine) onLine(`${label}: ok`); }
      catch (e) { throw new Error(`${label} failed: ${e.message}`); }
    }
  },
  async activate(conn, L, ts, target, manifest, o = {}) { await switchCurrent(conn, L, ts, o); await this.reload(conn, L, target, manifest, o); },
  async rollback(conn, L, toTs, target, manifest, o = {}) { await switchCurrent(conn, L, toTs, o); await this.reload(conn, L, target, manifest, o); },

  /** Where a local web server should point. */
  webRoot(L, manifest) { const d = manifest.runtime?.docroot || '.'; return d === '.' ? L.current : path.join(L.current, d); },

  assertLocalRoot, exampleRoot, createLocalConn,
};
