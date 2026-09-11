'use strict';
/* Make the modules installable on this machine, with nothing published anywhere.
 *
 *   node scripts/modules-local.js [--data-dir <dir>...] [--no-build]
 *
 * The marketplace needs three things and this puts all three in place:
 *
 *   1. a publisher key whose PUBLIC half is in config/trusted-publishers.json,
 *      because the installer refuses a package no trusted key signed;
 *   2. signed package archives, built from modules/<id>;
 *   3. a catalog the application finds on its own.
 *
 * The catalog is written to <dataDir>/registry/catalog.json, which is where
 * server.js looks when MODULE_REGISTRIES is not set, and its package URLs are
 * file: URLs into dist/modules. So this works offline, survives restarts, and
 * needs no environment variable and no local HTTP server. It is a real
 * download → verify signature → stage → activate path; only the transport is
 * local.
 *
 * `npm run modules:registry` is still there for exercising the HTTP path. */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'modules');
const TRUST_FILE = path.join(ROOT, 'config', 'trusted-publishers.json');
const KEY_DIR = path.join(ROOT, 'keys');

const has = (name) => process.argv.includes(`--${name}`);
const node = (args) => execFileSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });

/** Every --data-dir given, or the two that matter by default. */
function dataDirs() {
  const given = [];
  for (let i = 0; i < process.argv.length; i++) if (process.argv[i] === '--data-dir') given.push(process.argv[i + 1]);
  if (given.length) return given.map((dir) => path.resolve(ROOT, dir));

  const dirs = [ROOT];                                   // npm start / npm run dev
  const exe = path.join(ROOT, 'dist', 'server-tools.exe');
  if (fs.existsSync(exe)) dirs.push(path.dirname(exe));  // the packaged executable, which keeps its data beside itself
  return dirs;
}

/** A signing key whose public half the application already trusts. */
function signingKey() {
  const keys = fs.existsSync(KEY_DIR) ? fs.readdirSync(KEY_DIR).filter((name) => name.endsWith('.private.pem')) : [];
  if (keys.length > 1) throw new Error(`keys/ holds ${keys.length} private keys; pass --sign to scripts/build-modules.js to choose one`);
  if (!keys.length) {
    console.log('no publisher key yet — generating a development one');
    node(['scripts/module-keys.js', 'init']);
    return signingKey();
  }
  const keyId = keys[0].replace(/\.private\.pem$/, '');
  const trust = JSON.parse(fs.readFileSync(TRUST_FILE, 'utf8'));
  const trusted = (trust.publishers || []).some((p) => (p.keys || []).some((k) => k.keyId === keyId));
  if (!trusted) throw new Error(`keys/${keys[0]} is not in config/trusted-publishers.json, so the installer would refuse everything it signs. Generate a key with: node scripts/module-keys.js init --key-id ${keyId}`);
  return keyId;
}

function main() {
  const keyId = signingKey();
  if (!has('no-build')) node(['scripts/build-modules.js']);
  if (!fs.existsSync(DIST)) throw new Error(`${path.relative(ROOT, DIST)} does not exist — run without --no-build`);

  /* One catalog per data directory, each pointing at the same archives. */
  const written = [];
  for (const dataDir of dataDirs()) {
    const out = path.join(dataDir, 'registry', 'catalog.json');
    node(['scripts/build-catalog.js', '--dir', DIST, '--out', out, '--name', 'Server Tools modules (local)']);
    written.push(out);
  }

  console.log(`\nsigned with ${keyId}, which config/trusted-publishers.json already trusts.`);
  console.log('catalog(s) the application will find on its own:');
  for (const file of written) console.log(`  ${path.relative(ROOT, file) || file}`);
  console.log('\nNow:  npm start   →  open Modules  →  Add');
  console.log('Rebuild after changing a module: npm run modules:local');
  console.log('Installed code and module data live under <dataDir>/module-data/ and are never committed.');
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exit(1); }
}
