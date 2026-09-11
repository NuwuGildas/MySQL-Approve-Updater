'use strict';
/* Release layout builders and path guards. Every remote path the pipeline
   deletes or overwrites is derived here: there is no free-form remote rm. */

const posix = require('path').posix;

const FORBIDDEN_ROOTS = new Set(['/', '/home', '/root', '/var', '/var/www', '/etc', '/usr', '/opt', '/srv', '/tmp', '/bin', '/sbin', '/lib', '/boot', '/dev', '/proc', '/sys']);
const RELEASE_RE = /^\d{14}$/;

class LayoutError extends Error { constructor(m) { super(m); this.name = 'LayoutError'; this.status = 400; } }

/** Absolute POSIX path, normalized, no `..`, at least two segments, not a system dir. */
function assertSafeRoot(root, label = 'root') {
  if (typeof root !== 'string' || !root.trim()) throw new LayoutError(`${label} is required`);
  const r = root.trim();
  if (!r.startsWith('/')) throw new LayoutError(`${label} must be an absolute POSIX path (got "${r}")`);
  if (/[\0\n\r]/.test(r)) throw new LayoutError(`${label} contains invalid characters`);
  if (r.split('/').includes('..')) throw new LayoutError(`${label} must not contain ".."`);
  const norm = posix.normalize(r).replace(/\/+$/, '') || '/';
  if (FORBIDDEN_ROOTS.has(norm)) throw new LayoutError(`${label} "${norm}" is a system directory; use a dedicated app folder like /var/www/myapp`);
  if (norm.split('/').filter(Boolean).length < 2) throw new LayoutError(`${label} "${norm}" is too shallow; use at least two path segments (e.g. /var/www/myapp)`);
  return norm;
}

/** `child` must be strictly inside `parent` (both normalized absolute). */
function assertInside(parent, child, label = 'path') {
  const p = posix.normalize(parent).replace(/\/+$/, '');
  const c = posix.normalize(child).replace(/\/+$/, '');
  if (c === p || !c.startsWith(p + '/')) throw new LayoutError(`${label} "${child}" must be inside "${parent}"`);
  return c;
}

function assertRelease(ts) {
  if (!RELEASE_RE.test(String(ts))) throw new LayoutError(`invalid release name "${ts}"`);
  return String(ts);
}

/** UTC timestamp release name YYYYMMDDHHmmss */
function newReleaseName(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** Standard release layout under a root. */
function layout(root) {
  const r = assertSafeRoot(root);
  return {
    root: r,
    releases: `${r}/releases`,
    current: `${r}/current`,
    currentTmp: `${r}/current.tmp`,
    shared: `${r}/shared`,
    cache: `${r}/shared/cache`,
    lock: `${r}/.ship-lock`,
    release: (ts) => `${r}/releases/${assertRelease(ts)}`,
    releaseTgz: (ts) => `${r}/releases/${assertRelease(ts)}.tgz`,
    releaseSrcTgz: (ts) => `${r}/releases/${assertRelease(ts)}.src.tgz`,
  };
}

module.exports = { assertSafeRoot, assertInside, assertRelease, newReleaseName, layout, LayoutError, RELEASE_RE };
