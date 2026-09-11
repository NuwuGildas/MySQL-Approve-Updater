'use strict';
/* Scans a checkout (depth-limited) and reads the well-known manifest files
   the stack detectors and the AI fallback need. */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor', '.idea', '.vscode', 'dist', 'build', '.next', '.nuxt', '.output', 'storage', '__pycache__', '.venv', 'venv', 'coverage', '.cache', 'bootstrap/cache']);
const KEY_FILES = ['package.json', 'composer.json', 'composer.lock', 'artisan', 'requirements.txt', 'pyproject.toml', 'Pipfile', 'manage.py', 'Dockerfile', 'compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml', 'ship.json', 'index.html', 'vite.config.js', 'vite.config.ts', 'vite.config.mjs', 'next.config.js', 'next.config.mjs', 'next.config.ts', 'nuxt.config.ts', 'nuxt.config.js', 'astro.config.mjs', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', 'poetry.lock', 'uv.lock', '.nvmrc', '.node-version', '.htaccess', 'Procfile', 'README.md'];
const MAX_KEY_BYTES = 4096;
const MAX_ENTRIES = 400;

/** Relative paths (posix) of files and dirs up to `depth`, sorted. Dirs end with "/". */
async function scanTree(dir, { depth = 2, max = MAX_ENTRIES } = {}) {
  const out = [];
  async function walk(rel, d) {
    if (out.length >= max) return;
    let ents;
    try { ents = await fsp.readdir(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of ents) {
      if (out.length >= max) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.push(r + '/');
        if (d < depth && !SKIP_DIRS.has(e.name) && !SKIP_DIRS.has(r)) await walk(r, d + 1);
      } else out.push(r);
    }
  }
  await walk('', 1);
  return out;
}

/** Read key files (root + one level of common sub-roots) as {relPath: text} capped per file. */
async function readKeyFiles(dir, roots = ['.']) {
  const files = {};
  for (const root of roots) {
    for (const name of KEY_FILES) {
      const rel = root === '.' ? name : `${root}/${name}`;
      const abs = path.join(dir, rel);
      try {
        const st = await fsp.stat(abs);
        if (!st.isFile()) continue;
        if (name.endsWith('.lockb')) { files[rel] = ''; continue; }
        const fh = await fsp.open(abs, 'r');
        try {
          const buf = Buffer.alloc(Math.min(st.size, MAX_KEY_BYTES));
          const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
          files[rel] = buf.subarray(0, bytesRead).toString('utf8');
        } finally { await fh.close(); }
      } catch {}
    }
  }
  return files;
}

/** Parse JSON leniently (returns null on failure). */
function json(s) { try { return JSON.parse(s); } catch { return null; } }

/** Candidate sub-roots for monorepos: apps/*, packages/*, services/*, backend, frontend, api, web, client, server. */
function subRoots(tree) {
  const set = new Set();
  for (const e of tree) {
    const m = /^(apps|packages|services)\/([^/]+)\/$/.exec(e);
    if (m) set.add(m[0].slice(0, -1));
    const n = /^(backend|frontend|api|web|client|server|app|site)\/$/.exec(e);
    if (n) set.add(n[1]);
  }
  return [...set];
}

const has = (tree, rel) => tree.includes(rel) || tree.includes(rel + '/');

module.exports = { scanTree, readKeyFiles, json, subRoots, has, KEY_FILES, SKIP_DIRS };
