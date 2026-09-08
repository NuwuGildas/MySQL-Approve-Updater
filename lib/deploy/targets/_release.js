'use strict';
/* Release-layout operations shared by every target that has a shell:
   releases/<ts>, current symlink, shared/ files+dirs, lock, prune.
   All destructive paths come from layout.js (guarded). */

const { q } = require('../shell');
const { layout: mkLayout, assertRelease, RELEASE_RE } = require('./layout');

const LOCK_STALE_MS = 2 * 3600e3;

async function prepare(conn, L) {
  await conn.exec(`mkdir -p ${q(L.releases)} ${q(L.shared)} ${q(L.cache)}`);
}

/** mkdir-based lock with an owner file. Throws {status:409} when held and not stale. */
async function lock(conn, L, owner, { force = false } = {}) {
  const ownerLine = `${owner.runId} ${owner.host} ${new Date().toISOString()}`;
  const tryLock = `mkdir ${q(L.lock)} 2>/dev/null && printf %s ${q(ownerLine)} > ${q(L.lock + '/owner')} && echo LOCKED || { echo BUSY; cat ${q(L.lock + '/owner')} 2>/dev/null; }`;
  let out = await conn.capture(tryLock);
  if (out.startsWith('LOCKED')) return;
  const prev = out.replace(/^BUSY\s*/, '').trim();
  const ts = Date.parse(prev.split(' ')[2] || '');
  const stale = !Number.isFinite(ts) || Date.now() - ts > LOCK_STALE_MS;
  if (!stale && !force) {
    const e = new Error(`target is locked by another deploy (${prev || 'unknown owner'}); wait for it or force-unlock`);
    e.status = 409; throw e;
  }
  await conn.exec(`rm -rf ${q(L.lock)}`);
  out = await conn.capture(tryLock);
  if (!out.startsWith('LOCKED')) { const e = new Error('could not acquire the deploy lock'); e.status = 409; throw e; }
}
async function unlock(conn, L) { try { await conn.exec(`rm -rf ${q(L.lock)}`); } catch {} }

/** Upload a tar.gz and extract it into the release dir. */
async function extractTgz(conn, L, ts, localTgz, { onLine, onProgress } = {}) {
  const rel = L.release(ts), tgz = L.releaseTgz(ts);
  await conn.exec(`mkdir -p ${q(rel)}`);
  await conn.uploadFile(localTgz, tgz, onProgress);
  await conn.exec(`tar -xzf ${q(tgz)} -C ${q(rel)} && rm -f ${q(tgz)}`, { onLine });
}

/** Link shared files and dirs into a release (absolute symlinks into shared/). */
async function linkShared(conn, L, ts, manifest, { onLine, warn } = {}) {
  const rel = L.release(ts);
  const cmds = [];
  for (const d of manifest.shared?.dirs || []) {
    const src = `${rel}/${d}`, dst = `${L.shared}/${d}`;
    cmds.push(`mkdir -p ${q(dst)} ${q(require('path').posix.dirname(src))}`);
    // first deploy: seed shared dir from the release's own copy, then replace it with a link
    cmds.push(`if [ -d ${q(src)} ] && [ ! -L ${q(src)} ]; then cp -a ${q(src + '/.')} ${q(dst + '/')} 2>/dev/null || true; rm -rf ${q(src)}; fi`);
    cmds.push(`rm -rf ${q(src)}; ln -sfn ${q(dst)} ${q(src)}`);
  }
  for (const f of manifest.shared?.files || []) {
    const src = `${rel}/${f}`, dst = `${L.shared}/${f}`;
    cmds.push(`mkdir -p ${q(require('path').posix.dirname(dst))} ${q(require('path').posix.dirname(src))}`);
    cmds.push(`if [ -f ${q(src)} ] && [ ! -L ${q(src)} ] && [ ! -f ${q(dst)} ]; then cp ${q(src)} ${q(dst)}; fi`);
    cmds.push(`if [ ! -f ${q(dst)} ]; then echo "WARN shared file ${f} does not exist yet: create ${dst} on the server"; touch ${q(dst)}; fi`);
    cmds.push(`rm -f ${q(src)}; ln -sfn ${q(dst)} ${q(src)}`);
  }
  if (!cmds.length) return;
  await conn.exec(cmds, { onLine: (l, s) => { if (l.startsWith('WARN ')) { if (warn) warn(l.slice(5)); } else if (onLine) onLine(l, s); } });
}

/** Atomic-ish symlink swap: current -> releases/<ts>. */
async function switchCurrent(conn, L, ts, { onLine } = {}) {
  assertRelease(ts);
  const relTarget = `releases/${ts}`;
  await conn.exec(`cd ${q(L.root)} && ln -sfn ${q(relTarget)} current.tmp && { mv -Tf current.tmp current 2>/dev/null || { rm -f current.tmp; ln -sfn ${q(relTarget)} current; }; }`, { onLine });
}

/** Parse releases/ + current. */
async function listReleases(conn, L) {
  const out = await conn.capture(
    `cd ${q(L.root)} 2>/dev/null || exit 0; echo "CURRENT=$(readlink current 2>/dev/null)"; ` +
    `for d in releases/*/; do [ -d "$d" ] || continue; n=$(basename "$d"); echo "R=$n|$(cat "$d/.release.json" 2>/dev/null | tr -d '\\n')"; done`);
  let current = null; const releases = [];
  for (const line of out.split('\n')) {
    if (line.startsWith('CURRENT=')) current = line.slice(8).replace(/^releases\//, '').replace(/^.*\/releases\//, '').trim() || null;
    else if (line.startsWith('R=')) {
      const [name, meta] = [line.slice(2, line.indexOf('|')), line.slice(line.indexOf('|') + 1)];
      if (!RELEASE_RE.test(name)) continue;
      let info = {}; try { info = JSON.parse(meta); } catch {}
      releases.push({ ts: name, ...info });
    }
  }
  releases.sort((a, b) => a.ts.localeCompare(b.ts));
  for (const r of releases) r.current = r.ts === current;
  return { current, releases };
}

/** Remove old releases beyond `keep`, never the current one or `protect`ed ones. Returns removed names. */
async function prune(conn, L, keep, protect = [], { onLine } = {}) {
  const { current, releases } = await listReleases(conn, L);
  const keepSet = new Set([current, ...protect].filter(Boolean));
  const candidates = releases.map((r) => r.ts).filter((ts) => !keepSet.has(ts));
  const total = releases.length;
  const removeCount = Math.max(0, total - Math.max(2, keep));
  const toRemove = candidates.slice(0, removeCount);
  for (const ts of toRemove) {
    await conn.exec(`rm -rf ${q(L.release(ts))} ${q(L.releaseTgz(ts))} ${q(L.releaseSrcTgz(ts))}`);
    if (onLine) onLine(`pruned release ${ts}`);
  }
  return toRemove;
}

/** Delete a never-activated release dir (failed ship). */
async function discardRelease(conn, L, ts) {
  try { await conn.exec(`rm -rf ${q(L.release(ts))} ${q(L.releaseTgz(ts))} ${q(L.releaseSrcTgz(ts))}`); } catch {}
}

module.exports = { prepare, lock, unlock, extractTgz, linkShared, switchCurrent, listReleases, prune, discardRelease, mkLayout, LOCK_STALE_MS };
