'use strict';
/* Build one module package.
 *
 *   node scripts/build-module.js <id> [--source <dir>] [--out dist/modules]
 *                                     [--sign keys/<keyId>.private.pem --key-id <keyId>]
 *                                     [--commit <sha> --branch <name>]
 *
 * The result is a gzipped tar containing module.json, the declared entry points
 * and everything they need, plus a sidecar <name>.json describing the artifact.
 * The build is reproducible: file order is sorted, timestamps and ownership are
 * fixed, so the same source produces the same digest.
 *
 * The package is data, not a program: nothing in it runs during installation,
 * there are no lifecycle scripts, and any runtime dependency it needs must
 * already be inside it (vendor/ or node_modules/). */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const tar = require('tar');

const os = require('node:os');
const ROOT = path.join(__dirname, '..');
const { validateManifest } = require('../lib/host/manifest');
const { signedPayload } = require('../lib/host/verify');

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

/** Every file in the package directory, sorted, excluding build noise. */
function collect(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    // A module's own tests, git metadata and build output are not part of what ships.
    if (['.git', '.github', 'test', 'tests', 'coverage'].includes(entry.name) || entry.name.endsWith('.tgz')) continue;
    if (entry.name.startsWith('_moved')) continue;   // extraction scratch space, never shipped
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

/**
 * Copy the runtime dependencies a module declares (and theirs) into a staging
 * copy of the package, so the archive is self-contained: installation never runs
 * npm and never fetches anything.
 */
function bundleDependencies(manifest, source, files) {
  const wanted = JSON.parse(fs.readFileSync(path.join(source, 'module.json'), 'utf8')).bundledDependencies || [];
  if (!wanted.length) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `st-pack-${manifest.id}-`));
  fs.cpSync(source, dir, { recursive: true });
  const seen = new Set();
  const copy = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    const from = path.join(ROOT, 'node_modules', name);
    if (!fs.existsSync(from)) throw new Error(`${manifest.id} bundles "${name}", which is not installed in this checkout`);
    const to = path.join(dir, 'node_modules', name);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true, filter: (entry) => !SKIP_IN_DEPENDENCY.test(entry) });
    for (const relative of walkFiles(to)) files.push(`node_modules/${name}/${relative}`);
    const meta = JSON.parse(fs.readFileSync(path.join(from, 'package.json'), 'utf8'));
    for (const dependency of Object.keys(meta.dependencies || {})) copy(dependency);
  };
  for (const name of wanted) copy(name);
  return { dir, names: [...seen] };
}
const SKIP_IN_DEPENDENCY = /[\\/](test|tests|__tests__|\.github|docs?|example|examples)$/;
function walkFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

/**
 * The immutable source this package was built from. A module's source lives on
 * its own branch, so that branch's tip is the right reference; the path is only
 * consulted when the package happens to be tracked where it is being built.
 */
function gitInfo(id, source) {
  const at = (...args) => { try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return ''; } };
  const branch = `modules/${id}`;
  const onBranch = at('rev-parse', '--verify', '--quiet', branch);
  const inPath = at('log', '-1', '--format=%H', '--', source);
  return { commit: onBranch || inPath || null, branch: onBranch ? branch : at('rev-parse', '--abbrev-ref', 'HEAD') || null };
}

async function build(id) {
  const source = path.resolve(ROOT, arg('source', path.join('modules', id)));
  const outDir = path.resolve(ROOT, arg('out', path.join('dist', 'modules')));
  if (!fs.existsSync(path.join(source, 'module.json'))) throw new Error(`${source} has no module.json`);

  const manifest = validateManifest(JSON.parse(fs.readFileSync(path.join(source, 'module.json'), 'utf8')));
  if (manifest.id !== id) throw new Error(`${source}/module.json declares "${manifest.id}", not "${id}"`);

  const files = collect(source);
  for (const entry of [manifest.frontend, manifest.backend, ...manifest.styles].filter(Boolean)) {
    if (!files.includes(entry)) throw new Error(`declared entry point ${entry} is missing from ${source}`);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const name = `${manifest.id}-${manifest.version}.tgz`;
  const archivePath = path.join(outDir, name);

  /* A package ships with what it needs. Whatever the module declares in
     bundledDependencies is copied in from this checkout, so installation never
     runs npm and never fetches anything. */
  const bundled = bundleDependencies(manifest, source, files);

  await tar.c({
    file: archivePath,
    cwd: bundled ? bundled.dir : source,
    gzip: { level: 9 },
    portable: true,     // fixed mtime/uid/gid: the same source builds the same bytes
    noDirRecurse: true,
    mtime: new Date(0),
  }, files);

  if (bundled) fs.rmSync(bundled.dir, { recursive: true, force: true });
  const bytes = fs.statSync(archivePath).size;
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');

  let signature = null;
  let keyId = arg('key-id', null);
  const keyFile = arg('sign', null);
  if (keyFile) {
    const key = crypto.createPrivateKey(fs.readFileSync(path.resolve(ROOT, keyFile)));
    signature = crypto.sign(null, signedPayload(manifest.id, manifest.version, sha256), key).toString('base64');
    if (!keyId) keyId = path.basename(keyFile).replace(/\.private\.pem$/, '');
  }

  const git = gitInfo(manifest.id, path.relative(ROOT, source));
  const artifact = {
    id: manifest.id, name: manifest.name, description: manifest.description,
    publisher: manifest.publisher, version: manifest.version, hostSdk: manifest.hostSdk,
    dependencies: manifest.dependencies, capabilities: manifest.capabilities, pages: manifest.pages,
    source: { branch: arg('branch', git.branch || `modules/${manifest.id}`), commit: arg('commit', git.commit), repository: arg('repository', null) },
    package: { file: name, size: bytes, sha256, signature, keyId, algorithm: 'ed25519' },
    files: files.length,
    bundledDependencies: bundled ? bundled.names : [],
    builtAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, `${manifest.id}-${manifest.version}.json`), JSON.stringify(artifact, null, 2) + '\n');

  console.log(`${name}  ${bytes} bytes  sha256=${sha256}${signature ? `  signed by ${keyId}` : '  UNSIGNED'}  (${files.length} files)`);
  return artifact;
}

/** Positional arguments only: every `--flag value` pair is consumed by arg(). */
function positional() {
  const words = process.argv.slice(2);
  const ids = [];
  for (let i = 0; i < words.length; i++) {
    if (words[i].startsWith('--')) { i++; continue; }   // skip the flag's value
    ids.push(words[i]);
  }
  return ids;
}

if (require.main === module) {
  const ids = positional();
  if (!ids.length || has('help')) {
    console.log('usage: node scripts/build-module.js <id...> [--source dir] [--out dir] [--sign key.pem] [--key-id id] [--commit sha] [--branch name]');
    process.exit(ids.length ? 0 : 1);
  }
  (async () => { for (const id of ids) await build(id); })()
    .catch((error) => { console.error(error.message); process.exit(1); });
}

module.exports = { build, collect };
