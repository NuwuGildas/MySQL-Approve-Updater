'use strict';
/* Shared helpers for the JavaScript-based stacks. */

const { json } = require('../detect/tree');

function pkgAt(keyFiles, root) {
  const rel = root === '.' ? 'package.json' : `${root}/package.json`;
  return keyFiles[rel] ? json(keyFiles[rel]) : null;
}
function deps(pkg) { return { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) }; }
function hasDep(pkg, ...names) { const d = deps(pkg); return names.some((n) => Object.prototype.hasOwnProperty.call(d, n)); }
function hasFile(keyFiles, root, name) { return Object.prototype.hasOwnProperty.call(keyFiles, root === '.' ? name : `${root}/${name}`); }

/** Lockfile → package manager. */
function packageManager(keyFiles, root, pkg) {
  if (hasFile(keyFiles, root, 'pnpm-lock.yaml')) return 'pnpm';
  if (hasFile(keyFiles, root, 'yarn.lock')) return 'yarn';
  if (hasFile(keyFiles, root, 'bun.lockb') || hasFile(keyFiles, root, 'bun.lock')) return 'bun';
  const pm = String(pkg?.packageManager || '').split('@')[0];
  if (['pnpm', 'yarn', 'bun', 'npm'].includes(pm)) return pm;
  return 'npm';
}

/** Install command (frozen lockfile when one exists), optionally production-only. */
function installCmd(pm, { prod = false, lock = true } = {}) {
  switch (pm) {
    case 'pnpm': return `pnpm install${lock ? ' --frozen-lockfile' : ''}${prod ? ' --prod' : ''}`;
    case 'yarn': return `yarn install${lock ? ' --frozen-lockfile' : ''}${prod ? ' --production' : ''}`;
    case 'bun': return `bun install${lock ? ' --frozen-lockfile' : ''}${prod ? ' --production' : ''}`;
    default: return `${lock ? 'npm ci' : 'npm install'}${prod ? ' --omit=dev' : ''}`;
  }
}
function runCmd(pm, script) { return pm === 'npm' ? `npm run ${script}` : `${pm} run ${script}`; }
function pruneCmd(pm) { return pm === 'npm' ? 'npm prune --omit=dev' : pm === 'pnpm' ? 'pnpm prune --prod' : pm === 'yarn' ? 'yarn install --production --frozen-lockfile' : null; }

/** Node version hint from .nvmrc/.node-version/engines. */
function nodeVersion(keyFiles, root, pkg) {
  for (const f of ['.nvmrc', '.node-version']) { const rel = root === '.' ? f : `${root}/${f}`; if (keyFiles[rel]) return keyFiles[rel].trim().replace(/^v/, ''); }
  const eng = pkg?.engines?.node; if (eng) return String(eng).replace(/[^0-9.]/g, '').split('.')[0] || null;
  return null;
}

/** Read a literal `outDir: 'x'` from a vite config if present. */
function viteOutDir(keyFiles, root) {
  for (const f of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']) {
    const s = keyFiles[root === '.' ? f : `${root}/${f}`];
    if (!s) continue;
    const m = /outDir\s*:\s*['"`]([^'"`]+)['"`]/.exec(s);
    if (m && !m[1].includes('..')) return m[1].replace(/^\.\//, '');
  }
  return 'dist';
}

module.exports = { pkgAt, deps, hasDep, hasFile, packageManager, installCmd, runCmd, pruneCmd, nodeVersion, viteOutDir };
