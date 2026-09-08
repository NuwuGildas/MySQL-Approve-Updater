'use strict';
/* Read-only, whitelisted view of a connected repo for the AI assistant:
   only well-known manifest/config files, size-capped, secret-looking values
   masked. Never .env itself, never arbitrary paths. */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const WHITELIST = ['ship.json', 'Dockerfile', 'compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml', 'package.json', 'composer.json', '.env.example', '.env.sample', 'requirements.txt', 'pyproject.toml', 'Procfile', 'nginx.conf', 'README.md'];
const MAX_BYTES = 32 * 1024;
const SECRET_KEY_RE = /(secret|password|passwd|pwd|token|api[_-]?key|private[_-]?key|client[_-]?secret|access[_-]?key|auth)/i;
const PLACEHOLDER_RE = /^(["']?\s*["']?|null|none|xxx+|changeme|your[-_a-z]*|<[^>]*>|\$\{[^}]*\}|\*+|example|todo|secret|password)$/i;

/** Mask values of secret-looking keys (KEY=value, KEY: value, "key": "value"). Placeholders stay visible. */
function maskSecrets(text) {
  return String(text).split('\n').map((line) => {
    const m = /^(\s*(?:export\s+)?"?([A-Za-z0-9_.-]+)"?\s*[=:]\s*)(.+?)\s*,?\s*$/.exec(line);
    if (!m || !SECRET_KEY_RE.test(m[2])) return line;
    const val = m[3].replace(/^["']|["']$/g, '');
    if (!val || PLACEHOLDER_RE.test(val)) return line;
    return `${m[1]}***`;
  }).join('\n');
}

function safeRel(rel) {
  const p = String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!p || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').some((seg) => seg === '..' || seg === '')) throw new Error('path must be relative to the repo root');
  if (!WHITELIST.includes(path.posix.basename(p))) throw new Error(`only these files can be read: ${WHITELIST.join(', ')}`);
  return p;
}

/** Whitelisted files present at the root and in one level of common monorepo folders. */
async function list(dir) {
  const roots = ['.'];
  for (const sub of ['apps', 'packages', 'services', 'backend', 'frontend', 'api', 'web']) {
    const d = path.join(dir, sub);
    try {
      const st = await fsp.stat(d);
      if (!st.isDirectory()) continue;
      if (['backend', 'frontend', 'api', 'web'].includes(sub)) roots.push(sub);
      else for (const e of await fsp.readdir(d, { withFileTypes: true })) if (e.isDirectory()) roots.push(`${sub}/${e.name}`);
    } catch {}
  }
  const out = [];
  for (const root of roots) for (const name of WHITELIST) {
    const rel = root === '.' ? name : `${root}/${name}`;
    try { const st = await fsp.stat(path.join(dir, rel)); if (st.isFile()) out.push({ path: rel, bytes: st.size }); } catch {}
  }
  return out;
}

async function read(dir, rel) {
  const p = safeRel(rel);
  const abs = path.join(dir, p);
  if (!fs.existsSync(abs)) throw new Error(`${p} does not exist in this repo (use the file list)`);
  const fh = await fsp.open(abs, 'r');
  try {
    const st = await fh.stat();
    const buf = Buffer.alloc(Math.min(st.size, MAX_BYTES));
    await fh.read(buf, 0, buf.length, 0);
    return { path: p, bytes: st.size, truncated: st.size > MAX_BYTES, content: maskSecrets(buf.toString('utf8')) };
  } finally { await fh.close(); }
}

module.exports = { WHITELIST, MAX_BYTES, maskSecrets, safeRel, list, read };
