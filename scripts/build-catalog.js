'use strict';
/* Assemble a marketplace catalog from built artifacts.
 *
 *   node scripts/build-catalog.js [--dir dist/modules] [--out dist/modules/catalog.json]
 *                                 [--base-url http://127.0.0.1:8788/packages]
 *                                 [--url-template 'https://host/{id}-v{version}/{file}']
 *
 * The catalog carries metadata only: which versions exist, what they need, what
 * they may do, where the archive is, its digest and the publisher signature over
 * that digest. Adding an entry never distributes code; the base application
 * fetches this file and downloads nothing else until the user adds a module. */

const fs = require('node:fs');
const path = require('node:path');
const { validateCatalog } = require('../lib/host/manifest');
const { CATALOG_VERSION } = require('../lib/host/sdk');

const ROOT = path.join(__dirname, '..');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : fallback; };

function build() {
  const dir = path.resolve(ROOT, arg('dir', path.join('dist', 'modules')));
  const baseUrl = arg('base-url', null);
  const urlTemplate = arg('url-template', null);   // {id} {version} {file}
  const out = path.resolve(ROOT, arg('out', path.join(dir, 'catalog.json')));

  const artifacts = fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json') && name !== 'catalog.json')
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
  if (!artifacts.length) throw new Error(`no built modules in ${dir} — run scripts/build-module.js first`);

  const byId = new Map();
  for (const artifact of artifacts) {
    if (!byId.has(artifact.id)) {
      byId.set(artifact.id, {
        id: artifact.id, name: artifact.name, description: artifact.description,
        publisher: artifact.publisher, versions: [],
      });
    }
    /* Where this exact version's archive lives. A template is what GitHub
       releases need: every module version is its own tag, so the location
       depends on the module and the version, not just on a shared prefix. */
    const url = urlTemplate
      ? urlTemplate.replace(/\{id\}/g, artifact.id).replace(/\{version\}/g, artifact.version).replace(/\{file\}/g, artifact.package.file)
      : baseUrl
        ? `${baseUrl.replace(/\/$/, '')}/${artifact.package.file}`
        : require('node:url').pathToFileURL(path.join(dir, artifact.package.file)).href;
    byId.get(artifact.id).versions.push({
      version: artifact.version,
      hostSdk: artifact.hostSdk,
      dependencies: artifact.dependencies,
      capabilities: artifact.capabilities,
      source: artifact.source,
      releasedAt: artifact.builtAt,
      package: {
        url,
        size: artifact.package.size,
        sha256: artifact.package.sha256,
        signature: artifact.package.signature,
        keyId: artifact.package.keyId,
        algorithm: artifact.package.algorithm,
      },
    });
  }

  const catalog = { catalogVersion: CATALOG_VERSION, name: arg('name', 'Server Tools modules'), modules: [...byId.values()] };
  validateCatalog(catalog);   // never publish a catalog the installer would refuse
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(catalog, null, 2) + '\n');
  console.log(`${out}: ${catalog.modules.length} module(s), ${catalog.modules.reduce((n, m) => n + m.versions.length, 0)} version(s)`);
  for (const module of catalog.modules) {
    console.log(`  ${module.id} ${module.versions.map((v) => v.version + (v.package.signature ? '' : ' (unsigned)')).join(', ')}`);
  }
  return catalog;
}

if (require.main === module) {
  try { build(); } catch (error) { console.error(error.message); process.exit(1); }
}
module.exports = { build };
