'use strict';
/* Build every module package and the catalog that offers them.
 *
 *   node scripts/build-modules.js [--sign keys/<keyId>.private.pem --key-id <id>]
 *                                 [--source modules] [--out dist/modules]
 *                                 [--base-url http://127.0.0.1:8788/packages]
 *
 * With a key it produces signed packages a real installation will accept. With
 * no key it still builds, and the catalog says the versions are unsigned - the
 * host refuses them unless MODULES_ALLOW_UNSIGNED=1, which is a development
 * switch and nothing more. */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const arg = (name, fallback = null) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : fallback; };

function main() {
  const sourceRoot = path.resolve(ROOT, arg('source', 'modules'));
  const out = arg('out', path.join('dist', 'modules'));
  const key = arg('sign', defaultKey());
  const keyId = arg('key-id', key ? path.basename(key).replace(/\.private\.pem$/, '') : null);

  const ids = fs.readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(sourceRoot, entry.name, 'module.json')))
    .map((entry) => entry.name)
    .sort();
  if (!ids.length) throw new Error(`no module packages under ${sourceRoot}`);

  console.log(`building ${ids.length} module(s) from ${path.relative(ROOT, sourceRoot)}${key ? `, signed with ${keyId}` : ' (UNSIGNED)'}`);
  for (const id of ids) {
    const args = ['scripts/build-module.js', id, '--source', path.join(sourceRoot, id), '--out', out];
    if (key) args.push('--sign', key, '--key-id', keyId);
    execFileSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  }
  const catalogArgs = ['scripts/build-catalog.js', '--dir', out];
  const baseUrl = arg('base-url', null);
  if (baseUrl) catalogArgs.push('--base-url', baseUrl);
  execFileSync(process.execPath, catalogArgs, { cwd: ROOT, stdio: 'inherit' });
}

/** The only key in keys/, when there is exactly one. */
function defaultKey() {
  const dir = path.join(ROOT, 'keys');
  if (!fs.existsSync(dir)) return null;
  const keys = fs.readdirSync(dir).filter((name) => name.endsWith('.private.pem'));
  return keys.length === 1 ? path.join('keys', keys[0]) : null;
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exit(1); }
}
