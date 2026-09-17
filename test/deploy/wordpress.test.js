'use strict';
/* Scaffolding a WordPress deployment: detection of the two repository layouts, the assembly of a
   release (verified core underneath, the repository on top, a generated wp-config.php) and the
   rules that make that safe - the checksum, the salts that must not change between deploys, and
   "anything the repository provides wins".

   Nothing here reaches the network: fetch is injected. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const tar = require('tar');

const wp = require('../../backend/deploy/wp');
const artifact = require('../../backend/deploy/artifact');
const manifestLib = require('../../backend/deploy/manifest');
const frameworks = require('../../backend/deploy/frameworks');
const wordpress = require('../../backend/deploy/stacks/wordpress');
const { detect } = require('../../backend/deploy/detect');
const { stackFor } = require('../../backend/deploy/stacks');

const fx = (n) => path.join(__dirname, '..', 'fixtures', 'repos', n);
const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `st-wp-${label}-`));
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');

/** A tar.gz shaped like a real WordPress release: everything under a "wordpress/" prefix. */
async function fakeCoreTarball(files = {}) {
  const dir = tmp('core');
  const root = path.join(dir, 'wordpress');
  const all = { 'wp-settings.php': '<?php // core', 'wp-login.php': '<?php // core', 'index.php': '<?php // core index', 'wp-includes/version.php': "<?php $wp_version = '9.9';", 'wp-content/themes/twentyx/style.css': '/* bundled */', ...files };
  for (const [rel, body] of Object.entries(all)) {
    const p = path.join(root, rel);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, body);
  }
  const file = path.join(dir, 'core.tar.gz');
  await tar.c({ gzip: true, file, cwd: dir, portable: true }, ['wordpress']);
  return { file, bytes: await fsp.readFile(file) };
}

/** fetch() double: serves the version API, a tarball and its .sha1 sidecar. */
function fakeFetch({ version = '9.9', tarball = null, sha1sum = null, omitSha1 = false } = {}) {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    if (String(url).includes('version-check')) {
      return { ok: true, status: 200, json: async () => ({ offers: [{ response: 'upgrade', current: version }] }) };
    }
    if (String(url).endsWith('.sha1')) {
      if (omitSha1) return { ok: false, status: 404, text: async () => 'not found' };
      return { ok: true, status: 200, text: async () => `${sha1sum || sha1(tarball)}\n` };
    }
    if (!tarball) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, arrayBuffer: async () => tarball.buffer.slice(tarball.byteOffset, tarball.byteOffset + tarball.byteLength) };
  };
  fn.calls = calls;
  return fn;
}

/** Vault double with the three methods the scaffold uses. */
function fakeVault(seed = {}) {
  const entries = { ...seed };
  return {
    entries,
    has: (n) => Object.prototype.hasOwnProperty.call(entries, n),
    get(n) { if (!this.has(n)) throw new Error(`Unknown secret "${n}"`); return entries[n]; },
    set(n, v) { entries[n] = v; },
  };
}

const DB_BLOCK = ['WORDPRESS_DB_NAME=acme_prod', 'WORDPRESS_DB_USER=acme', 'WORDPRESS_DB_PASSWORD=s3cr3t', 'WORDPRESS_DB_HOST=db.internal:3306'].join('\n');

/* ------------------------------------------------------------------ detect */

test('a repository holding wp-content is detected as WordPress, over the composer.json it also has', async () => {
  const det = await detect(fx('wp-site'));
  assert.equal(det.best.id, 'wordpress');
  assert.equal(det.ambiguous, false);
  assert.ok(det.best.score >= 0.9, `score ${det.best.score}`);
  assert.ok(det.candidates.some((c) => c.id === 'php-composer'), 'composer.json still produces a candidate');

  const m = manifestLib.resolve(det.best.fragment);
  assert.equal(m.stack.framework, 'wordpress');
  assert.equal(m.stack.wordpress.contentDir, 'wp-content');
  assert.equal(m.stack.wordpress.core, 'download');
  assert.equal(m.stack.wordpress.intoDir, '', 'its paths are already right: nothing is moved');
  assert.equal(m.runtime.docroot, '.', 'WordPress serves from the release root, not public/');
  assert.deepEqual(m.shared.dirs, ['wp-content/uploads']);
  // the composer.json is real, so its install step survives
  assert.ok(m.build.steps.some((s) => /^composer install/.test(s)), m.build.steps.join(' | '));
  assert.equal(m.stack.php, '8.2');
  assert.equal(stackFor(m).id, 'wordpress');
});

test('a repository that IS wp-content is detected, and its files are staged into wp-content/', async () => {
  const det = await detect(fx('wp-content-only'));
  assert.equal(det.best.id, 'wordpress');
  const m = manifestLib.resolve(det.best.fragment);
  assert.equal(m.stack.wordpress.contentDir, '.');
  assert.equal(m.stack.wordpress.intoDir, 'wp-content');
  assert.equal(m.build.steps.length, 0, 'no composer.json, nothing to install');
});

test('WordPress is not claimed by a plain PHP or Laravel repository', async () => {
  for (const name of ['composer-lib', 'symfony', 'laravel', 'php-web']) {
    const det = await detect(fx(name));
    assert.notEqual(det.best.id, 'wordpress', `${name} must not detect as WordPress`);
  }
});

test('a lone themes/ folder is too weak to claim the stack', () => {
  const tree = ['themes/', 'themes/acme/', 'themes/acme/style.css', 'README.md'];
  assert.equal(wordpress.detect(tree, {}, '.'), null);
});

test('a full WordPress tree with core committed downloads nothing', () => {
  const tree = ['wp-admin/', 'wp-content/', 'wp-content/themes/', 'wp-includes/', 'wp-includes/version.php', 'wp-settings.php', 'index.php'];
  const r = wordpress.detect(tree, {}, '.');
  assert.equal(r.fragment.stack.wordpress.core, 'repo');
  assert.ok(r.evidence.includes('wp-settings.php'));
});

/* ----------------------------------------------------------------- version */

test('a pinned version is taken as given; "latest" asks wordpress.org; nonsense is refused', async () => {
  const f = fakeFetch({ version: '9.9' });
  assert.equal(await wp.resolveVersion('6.8.3', { fetchImpl: f }), '6.8.3');
  assert.equal(f.calls.length, 0, 'a pinned version needs no network');
  assert.equal(await wp.resolveVersion('latest', { fetchImpl: f }), '9.9');
  await assert.rejects(() => wp.resolveVersion('trunk', { fetchImpl: f }), /not a WordPress version/);
});

/* ---------------------------------------------------------------- download */

test('core is verified against the checksum wordpress.org publishes, and cached', async () => {
  const core = await fakeCoreTarball();
  const cache = tmp('cache');
  const f = fakeFetch({ tarball: core.bytes });

  const first = await wp.fetchCore('9.9', cache, { fetchImpl: f });
  assert.equal(first.cached, false);
  assert.equal(first.sha1, sha1(core.bytes));
  assert.ok(fs.existsSync(first.file));

  const downloads = f.calls.filter((u) => u.endsWith('.tar.gz')).length;
  const second = await wp.fetchCore('9.9', cache, { fetchImpl: f });
  assert.equal(second.cached, true);
  assert.equal(f.calls.filter((u) => u.endsWith('.tar.gz')).length, downloads, 'the cached copy was not downloaded again');
});

test('a download that does not match its checksum is refused and nothing is written', async () => {
  const core = await fakeCoreTarball();
  const cache = tmp('cache-bad');
  const f = fakeFetch({ tarball: core.bytes, sha1sum: '0'.repeat(40) });
  await assert.rejects(() => wp.fetchCore('9.9', cache, { fetchImpl: f }), /does not match the checksum/);
  assert.deepEqual(fs.readdirSync(cache), [], 'no file, not even a partial one, was left behind');
});

test('a corrupted cache entry is replaced rather than shipped', async () => {
  const core = await fakeCoreTarball();
  const cache = tmp('cache-corrupt');
  const f = fakeFetch({ tarball: core.bytes });
  const first = await wp.fetchCore('9.9', cache, { fetchImpl: f });
  await fsp.writeFile(first.file, 'not a tarball any more');

  const warnings = [];
  const again = await wp.fetchCore('9.9', cache, { fetchImpl: f, onLine: (l) => warnings.push(l) });
  assert.equal(again.cached, false);
  assert.equal(again.sha1, sha1(core.bytes));
  assert.ok(warnings.some((l) => /does not match its checksum/.test(l)), warnings.join(' | '));
});

test('a release with no published checksum downloads, and says it could not be verified', async () => {
  const core = await fakeCoreTarball();
  const lines = [];
  const got = await wp.fetchCore('9.9', tmp('cache-nosha'), { fetchImpl: fakeFetch({ tarball: core.bytes, omitSha1: true }), onLine: (l) => lines.push(l) });
  assert.equal(got.bytes, core.bytes.length);
  assert.ok(lines.some((l) => /WARN .*cannot be verified/.test(l)), lines.join(' | '));
});

test('extracting core drops the wordpress/ prefix every release tarball carries', async () => {
  const core = await fakeCoreTarball();
  const dest = tmp('extract');
  await wp.extractCore(core.file, dest);
  assert.ok(fs.existsSync(path.join(dest, 'wp-settings.php')));
  assert.ok(!fs.existsSync(path.join(dest, 'wordpress')), 'nothing is nested under wordpress/');
});

/* ------------------------------------------------------------------- salts */

test('salts are generated once and reused, so a deploy does not sign everyone out', () => {
  const vault = fakeVault();
  const first = wp.saltsFor(vault, 'WP_SALTS_PROD');
  assert.equal(first.created, true);
  assert.equal(Object.keys(first.salts).length, wp.SALT_KEYS.length);
  for (const k of wp.SALT_KEYS) assert.equal(first.salts[k].length, 64, k);
  assert.equal(new Set(Object.values(first.salts)).size, wp.SALT_KEYS.length, 'every key is distinct');

  const second = wp.saltsFor(vault, 'WP_SALTS_PROD');
  assert.equal(second.created, false);
  assert.deepEqual(second.salts, first.salts);
});

test('an incomplete stored salt block is regenerated rather than half-used', () => {
  const vault = fakeVault({ WP_SALTS_PROD: 'AUTH_KEY=short' });
  const r = wp.saltsFor(vault, 'WP_SALTS_PROD');
  assert.equal(r.created, true);
  for (const k of wp.SALT_KEYS) assert.equal(r.salts[k].length, 64, k);
});

test('salts contain nothing that needs escaping inside a PHP string', () => {
  const salts = wp.newSalts();
  for (const v of Object.values(salts)) assert.ok(!/['\\]/.test(v), `salt contains a quote or backslash: ${v}`);
});

test('the salt entry name is a legal vault name whatever the target is called', () => {
  const { NAME_RE } = require('../../backend/deploy/vault');
  for (const name of ['prod', 'Acme Site — production', '123', '', 'a'.repeat(120), 'staging/eu-west']) {
    assert.match(wp.saltSecretName(name), NAME_RE, `from ${JSON.stringify(name)}`);
  }
});

/* -------------------------------------------------------------- wp-config */

test('settings are read with the names the official WordPress image uses', () => {
  const s = wp.readSettings([DB_BLOCK, 'WORDPRESS_TABLE_PREFIX=acme_', 'WORDPRESS_DEBUG=1', '# a comment', '', 'WORDPRESS_CONFIG_EXTRA=define("X", 1);'].join('\n'));
  assert.equal(s.dbName, 'acme_prod');
  assert.equal(s.dbHost, 'db.internal:3306');
  assert.equal(s.tablePrefix, 'acme_');
  assert.equal(s.debug, true);
  assert.equal(s.extra, 'define("X", 1);');
  assert.deepEqual(wp.missingSettings(s), []);
  assert.deepEqual(wp.missingSettings(wp.readSettings('WORDPRESS_DB_PASSWORD=x')), ['dbName', 'dbUser']);
});

test('wp-config.php defines the database, the salts and the prefix, and ends by loading WordPress', () => {
  const settings = wp.readSettings(DB_BLOCK);
  const out = wp.renderConfig(settings, wp.newSalts());
  assert.match(out, /^<\?php/);
  assert.match(out, /define\( 'DB_NAME', 'acme_prod' \);/);
  assert.match(out, /define\( 'DB_HOST', 'db\.internal:3306' \);/);
  assert.match(out, /\$table_prefix = 'wp_';/);
  for (const k of wp.SALT_KEYS) assert.ok(out.includes(`define( '${k}',`), k);
  // ABSPATH has to be defined before wp-settings.php is required, and the require has to be last
  assert.ok(out.indexOf('ABSPATH') < out.indexOf("require_once ABSPATH . 'wp-settings.php';"));
  assert.match(out.trim(), /require_once ABSPATH \. 'wp-settings\.php';$/);
});

test('a password with a quote or a backslash is escaped, not left to break the file', () => {
  const settings = wp.readSettings(['WORDPRESS_DB_NAME=n', 'WORDPRESS_DB_USER=u', "WORDPRESS_DB_PASSWORD=it's\\fine"].join('\n'));
  const out = wp.renderConfig(settings, wp.newSalts());
  assert.ok(out.includes("define( 'DB_PASSWORD', 'it\\'s\\\\fine' );"), out.split('\n').find((l) => l.includes('DB_PASSWORD')));
});

test('editing files from wp-admin is off by default, because the next release would erase it', () => {
  const out = wp.renderConfig(wp.readSettings(DB_BLOCK), wp.newSalts());
  assert.match(out, /define\( 'DISALLOW_FILE_EDIT', true \);/);
  assert.match(out, /define\( 'DISALLOW_FILE_MODS', true \);/);
  const opted = wp.renderConfig(wp.readSettings([DB_BLOCK, 'WORDPRESS_ALLOW_FILE_MODS=true'].join('\n')), wp.newSalts());
  assert.match(opted, /define\( 'DISALLOW_FILE_MODS', false \);/);
});

/* ---------------------------------------------------------------- scaffold */

async function scaffoldInto(opts = {}) {
  const core = opts.core || await fakeCoreTarball();
  const baseDir = path.join(tmp('base'), 'wp-base');
  const vault = opts.vault || fakeVault({ WP_DB: DB_BLOCK });
  const lines = [], warnings = [];
  const result = await wp.scaffold({
    wp: { version: '9.9', core: 'download', configFromVault: 'WP_DB', ...(opts.wp || {}) },
    baseDir, cacheDir: tmp('cache'), targetName: opts.targetName || 'acme prod',
    hasOwnConfig: !!opts.hasOwnConfig, vault,
    fetchImpl: fakeFetch({ tarball: core.bytes }),
    onLine: (l) => lines.push(l), warn: (m) => warnings.push(m),
  });
  return { result, baseDir, vault, lines, warnings };
}

test('the scaffold lays down core, an uploads directory and a generated wp-config.php', async () => {
  const { result, baseDir, vault } = await scaffoldInto();
  assert.equal(result.version, '9.9');
  assert.equal(result.configWritten, true);
  assert.ok(fs.existsSync(path.join(baseDir, 'wp-settings.php')));
  assert.ok(fs.statSync(path.join(baseDir, 'wp-content', 'uploads')).isDirectory(), 'the shared-storage link needs somewhere to point');
  const config = fs.readFileSync(path.join(baseDir, 'wp-config.php'), 'utf8');
  assert.match(config, /define\( 'DB_NAME', 'acme_prod' \);/);
  assert.ok(vault.has('WP_SALTS_ACME_PROD'), Object.keys(vault.entries).join(','));
});

test('a wp-config.php in the repository wins: none is generated', async () => {
  const { result, baseDir, lines } = await scaffoldInto({ hasOwnConfig: true });
  assert.equal(result.configWritten, false);
  assert.ok(!fs.existsSync(path.join(baseDir, 'wp-config.php')));
  assert.ok(lines.some((l) => /using yours/.test(l)), lines.join(' | '));
});

test('with no vault entry named, the release is still assembled and the gap is stated plainly', async () => {
  const { result, baseDir, warnings } = await scaffoldInto({ wp: { configFromVault: null } });
  assert.equal(result.configWritten, false);
  assert.ok(fs.existsSync(path.join(baseDir, 'wp-settings.php')), 'core is still there');
  assert.ok(warnings.some((w) => /no wp-config\.php/.test(w) && /lost on the next deploy/.test(w)), warnings.join(' | '));
});

test('a vault entry that is missing or incomplete fails the build with the name to fix', async () => {
  await assert.rejects(() => scaffoldInto({ vault: fakeVault() }), /vault entry "WP_DB" does not exist/);
  await assert.rejects(() => scaffoldInto({ vault: fakeVault({ WP_DB: 'WORDPRESS_DB_PASSWORD=x' }) }), /missing WORDPRESS_DB_NAME and WORDPRESS_DB_USER/);
});

test('"latest" is resolved but warned about, because a redeploy would not ship the same core', async () => {
  const { warnings } = await scaffoldInto({ wp: { version: 'latest' } });
  assert.ok(warnings.some((w) => /pin stack\.wordpress\.version/.test(w)), warnings.join(' | '));
});

test('with core committed, nothing is downloaded but wp-config.php is still generated', async () => {
  const { result, baseDir } = await scaffoldInto({ wp: { core: 'repo' } });
  assert.equal(result.version, null);
  assert.ok(!fs.existsSync(path.join(baseDir, 'wp-settings.php')), 'core comes from the repository, not from here');
  assert.ok(fs.existsSync(path.join(baseDir, 'wp-config.php')));
});

/* -------------------------------------------------- assembling the release */

const STAGE_MANIFEST = manifestLib.resolve({ stack: { type: 'php' }, artifact: { include: ['**'], exclude: ['.git/**'] } });

test('the repository is laid over the base layer, and wins wherever the two overlap', async () => {
  const base = tmp('layer-base'), src = tmp('layer-src'), out = path.join(tmp('layer-out'), 'stage');
  await fsp.mkdir(path.join(base, 'wp-content', 'themes', 'twentyx'), { recursive: true });
  await fsp.writeFile(path.join(base, 'wp-settings.php'), 'core');
  await fsp.writeFile(path.join(base, 'index.php'), 'core index');
  await fsp.writeFile(path.join(base, 'wp-content', 'themes', 'twentyx', 'style.css'), 'bundled theme');
  await fsp.mkdir(path.join(src, 'wp-content', 'themes', 'acme'), { recursive: true });
  await fsp.writeFile(path.join(src, 'index.php'), 'MINE');
  await fsp.writeFile(path.join(src, 'wp-content', 'themes', 'acme', 'style.css'), 'my theme');

  const st = await artifact.stage(src, out, STAGE_MANIFEST, { ts: 't', runId: 'r' }, { baseDir: base });
  assert.equal(fs.readFileSync(path.join(out, 'index.php'), 'utf8'), 'MINE', 'the repository overrides core');
  assert.equal(fs.readFileSync(path.join(out, 'wp-settings.php'), 'utf8'), 'core', 'core survives where the repository is silent');
  assert.ok(fs.existsSync(path.join(out, 'wp-content', 'themes', 'twentyx', 'style.css')), 'the bundled theme is still there');
  assert.ok(fs.existsSync(path.join(out, 'wp-content', 'themes', 'acme', 'style.css')));
  assert.ok(st.base >= 3, `base file count ${st.base}`);
});

test('a repository that is wp-content is staged inside wp-content/', async () => {
  const base = tmp('into-base'), src = tmp('into-src'), out = path.join(tmp('into-out'), 'stage');
  await fsp.writeFile(path.join(base, 'wp-settings.php'), 'core');
  await fsp.mkdir(path.join(src, 'themes', 'acme'), { recursive: true });
  await fsp.writeFile(path.join(src, 'themes', 'acme', 'style.css'), 'my theme');

  await artifact.stage(src, out, STAGE_MANIFEST, { ts: 't', runId: 'r' }, { baseDir: base, intoDir: 'wp-content' });
  assert.ok(fs.existsSync(path.join(out, 'wp-content', 'themes', 'acme', 'style.css')));
  assert.ok(fs.existsSync(path.join(out, 'wp-settings.php')));
  assert.ok(!fs.existsSync(path.join(out, 'themes')), 'nothing is left at the release root');
});

test('intoDir may not climb out of the release', async () => {
  const src = tmp('esc-src'), out = path.join(tmp('esc-out'), 'stage');
  await fsp.writeFile(path.join(src, 'a.txt'), 'a');
  for (const bad of ['../escape', 'a/../../escape', '/abs', 'wp-content/../../out']) {
    await assert.rejects(() => artifact.stage(src, out, STAGE_MANIFEST, { ts: 't', runId: 'r' }, { intoDir: bad }), /must be a relative path/, bad);
  }
  // and the harmless shapes still work
  await artifact.stage(src, out, STAGE_MANIFEST, { ts: 't', runId: 'r' }, { intoDir: './wp-content/' });
  assert.ok(fs.existsSync(path.join(out, 'wp-content', 'a.txt')));
});

test('staging without a base layer is unchanged', async () => {
  const src = tmp('plain-src'), out = path.join(tmp('plain-out'), 'stage');
  await fsp.writeFile(path.join(src, 'a.txt'), 'a');
  const st = await artifact.stage(src, out, STAGE_MANIFEST, { ts: 't', runId: 'r' });
  assert.equal(st.base, 0);
  assert.ok(fs.existsSync(path.join(out, 'a.txt')));
  assert.ok(fs.existsSync(path.join(out, '.release.json')));
});

/* ------------------------------------------------- the stack's own surface */

test('the release is assembled here and shipped whole, so it lands anywhere', () => {
  assert.equal(wordpress.localOnly, true);
});

test('the plan says what will be downloaded and where the settings come from', () => {
  const m = manifestLib.resolve(wordpress.detect(['wp-content/', 'wp-content/themes/', 'wp-content/plugins/'], {}, '.').fragment);
  m.stack.wordpress.version = '6.8.3';
  m.stack.wordpress.configFromVault = 'WP_DB';
  const [line] = wordpress.planSteps(m);
  assert.match(line, /download WordPress 6\.8\.3/);
  assert.match(line, /checksum-verified/);
  assert.match(line, /vault WP_DB/);
});

test('uploads is made writable on a server with a shell; nothing else is run remotely', () => {
  const steps = wordpress.remoteSteps(manifestLib.resolve({ stack: { type: 'php', framework: 'wordpress' } }));
  assert.deepEqual(steps.afterShip, []);
  assert.deepEqual(steps.beforeActivate, []);
  assert.ok(steps.permissions.some((c) => /wp-content\/uploads/.test(c)), steps.permissions.join(' | '));
});

test('composer is only required when the repository actually uses it', () => {
  assert.deepEqual(wordpress.requiredTools(manifestLib.resolve({ stack: { type: 'php' }, build: { steps: [] } })), []);
  assert.deepEqual(wordpress.requiredTools(manifestLib.resolve({ stack: { type: 'php' }, build: { steps: ['composer install --no-dev'] } })), ['php', 'composer']);
});

/* --------------------------------------------------------- the wizard form */

test('picking WordPress in the wizard produces a valid manifest with the scaffold settings', () => {
  const frag = frameworks.fragmentFor('wordpress', { wpVersion: '6.8.3', wpConfigVault: 'WP_DB' });
  const m = manifestLib.validate(frag);
  assert.equal(m.stack.framework, 'wordpress');
  assert.equal(m.stack.wordpress.version, '6.8.3');
  assert.equal(m.stack.wordpress.configFromVault, 'WP_DB');
  assert.equal(m.runtime.docroot, '.');
  assert.deepEqual(m.shared.dirs, ['wp-content/uploads']);
  assert.ok(m.artifact.exclude.includes('wp-content/uploads/**'), 'uploads are shared storage, never shipped');
  assert.equal(frameworks.catalogIdFor(frag), 'wordpress');
  assert.equal(stackFor(m).id, 'wordpress');
});

test('the form keeps what detection found and only overrides what it was given', () => {
  const detected = { version: '6.7', contentDir: '.', core: 'repo', intoDir: 'wp-content', configFromVault: 'OLD' };
  assert.deepEqual(frameworks.wordpressBlock(detected, {}), detected, 'nothing typed, nothing changed');
  assert.deepEqual(frameworks.wordpressBlock(detected, { wpVersion: '6.8.3' }), { ...detected, version: '6.8.3' });
  assert.deepEqual(frameworks.wordpressBlock(detected, { wpConfigVault: '' }), { ...detected, configFromVault: null });
});

test('intoDir always follows contentDir and is never set by hand', () => {
  assert.equal(frameworks.wordpressBlock(null, { wpContentDir: '.' }).intoDir, 'wp-content');
  assert.equal(frameworks.wordpressBlock(null, { wpContentDir: 'wp-content' }).intoDir, '');
  assert.equal(frameworks.wordpressBlock({ contentDir: '.', intoDir: 'nonsense' }, {}).intoDir, 'wp-content');
});

test('the manifest survives a round trip through ship.json', () => {
  const frag = frameworks.fragmentFor('wordpress', { wpVersion: '6.8.3', wpConfigVault: 'WP_DB' });
  const compact = manifestLib.compact(manifestLib.validate(frag));
  assert.deepEqual(manifestLib.validate(compact).stack.wordpress, manifestLib.validate(frag).stack.wordpress);
});

/* ------------------------------------------- a whole ship, end to end */

const { fakeCtx, fakeConn, registerFakeVps, deps, waitDone } = require('./helpers');
const { createEngine } = require('../../backend/deploy/engine');

/** A WordPress repository shipped to a fake VPS, with core served from a fake wordpress.org. */
async function shipWordPress({ repo = 'wp-site', targetExtra = {}, vaultSeed = { WP_DB: DB_BLOCK }, mode = 'ship' } = {}) {
  const core = await fakeCoreTarball();
  const ctx = fakeCtx({ fetch: fakeFetch({ tarball: core.bytes }) });
  const d = deps(ctx);
  for (const [name, value] of Object.entries(vaultSeed)) d.vault.set(name, value);
  const conn = fakeConn({ tools: 'php composer git tar curl' });
  const type = registerFakeVps(conn, 'fake-vps-wp');
  d.stores.repos.get().repos.push({
    id: 'r-wp', name: 'acme', source: { kind: 'local', path: fx(repo) },
    // no build steps: the fixture's composer.json is there to prove detection picks WordPress over
    // php-composer, and running a real composer install would need the network and a composer binary
    manifest: { stack: { wordpress: { version: '9.9', configFromVault: 'WP_DB' } }, build: { steps: [] } },
  });
  d.stores.targets.get().targets.push({ projectId: 'general', id: 't-wp', name: 'acme prod', repoId: 'r-wp', type, buildMode: 'auto', ssh: { profileId: 'p1' }, paths: { root: '/var/www/acme' }, web: { server: 'nginx', reloadCmd: 'sudo -n systemctl reload nginx' }, keepReleases: 3, ...targetExtra });
  const engine = createEngine(ctx, d);
  const run = engine.start({ targetId: 't-wp', mode, trigger: 'cli', confirm: true });
  await waitDone(run);
  return { run, conn, ctx, d, core };
}

/** The files inside the artifact this run uploaded. */
async function shippedFiles(conn) {
  const up = conn.state.uploaded.find((u) => /release-\d{14}\.tgz$/.test(u.local));
  assert.ok(up, `no artifact was uploaded: ${JSON.stringify(conn.state.uploaded)}`);
  const out = [];
  await tar.t({ file: up.local, onentry: (e) => out.push(e.path.replace(/^\.\//, '')) });
  return { files: out, tgz: up.local };
}

test('planning a WordPress ship builds here and says what it will assemble', async () => {
  const { run } = await shipWordPress({ mode: 'plan' });
  assert.equal(run.status, 'succeeded', run.error);
  assert.equal(run.buildMode, 'local', 'core is assembled here, never on the server');
  const scaffold = run.plan.steps.find((s) => s.label === 'scaffold');
  assert.ok(scaffold, run.plan.steps.map((s) => s.label).join(', '));
  assert.match(scaffold.cmd, /download WordPress 9\.9/);
  assert.match(scaffold.cmd, /vault WP_DB/);
  const cmds = run.plan.steps.map((s) => `${s.stage}|${s.cmd}`);
  assert.ok(cmds.some((c) => /link wp-content\/uploads/.test(c)), cmds.join('\n'));
});

test('a shipped WordPress release contains core, the repository and a generated wp-config.php', async () => {
  const { run, conn, d } = await shipWordPress();
  assert.equal(run.status, 'succeeded', run.error);
  const { files } = await shippedFiles(conn);
  assert.ok(files.includes('wp-settings.php'), 'core');
  assert.ok(files.includes('wp-config.php'), 'generated config');
  assert.ok(files.includes('wp-content/themes/acme/style.css'), 'the repository theme');
  assert.ok(files.includes('wp-content/themes/twentyx/style.css'), 'the bundled theme from core');
  assert.ok(files.includes('composer.json'), 'the repository files are all there');
  // the empty directory ships so the shared-storage link has something to adopt; its CONTENT never does
  const uploads = files.filter((f) => f.startsWith('wp-content/uploads'));
  assert.deepEqual(uploads, ['wp-content/uploads/'], `uploads entries: ${uploads.join(', ')}`);
  assert.ok(d.vault.has('WP_SALTS_ACME_PROD'), 'the salts were stored under the target name');
});

test('the next ship reuses the stored salts, so nobody is signed out', async () => {
  const first = await shipWordPress();
  const salts = first.d.vault.get('WP_SALTS_ACME_PROD');
  const second = await shipWordPress({ vaultSeed: { WP_DB: DB_BLOCK, WP_SALTS_ACME_PROD: salts } });
  assert.equal(second.run.status, 'succeeded', second.run.error);
  const { tgz } = await shippedFiles(second.conn);
  const dir = tmp('unpack');
  await tar.x({ file: tgz, cwd: dir });
  const config = fs.readFileSync(path.join(dir, 'wp-config.php'), 'utf8');
  const stored = wp.parseEnvBlock(salts);
  for (const k of wp.SALT_KEYS) assert.ok(config.includes(`define( '${k}', '${stored[k]}' );`), `${k} was regenerated`);
});

test('a repository that is wp-content lands under wp-content/, with core around it', async () => {
  const { run, conn } = await shipWordPress({ repo: 'wp-content-only' });
  assert.equal(run.status, 'succeeded', run.error);
  const { files } = await shippedFiles(conn);
  assert.ok(files.includes('wp-content/themes/acme/style.css'), files.filter((f) => f.includes('acme')).join(', '));
  assert.ok(files.includes('wp-settings.php'));
  assert.ok(!files.includes('themes/acme/style.css'), 'nothing was left at the release root');
});

test('a missing database secret fails the build, naming the entry to create', async () => {
  const { run } = await shipWordPress({ vaultSeed: {} });
  assert.equal(run.status, 'failed');
  assert.equal(run.stage, 'build');
  assert.match(run.error, /vault entry "WP_DB" does not exist/);
});

test('a platform target is refused rather than shipping a bare wp-content folder', async () => {
  // the platform CLI is faked the way paas.test.js does it, so the run gets past connect and the
  // refusal that gets asserted is the pipeline's, not "vercel is not installed on this machine"
  const paas = require('../../backend/deploy/targets/paas');
  const realProbe = paas.paasDeps.probe, realRun = paas.paasDeps.run;
  paas.paasDeps.probe = async (cli) => `${cli} 1.2.3`;
  paas.paasDeps.run = async () => ({ code: 0, ms: 1 });
  try {
    const { run } = await shipWordPress({
      vaultSeed: { WP_DB: DB_BLOCK, T: 'tok' },
      targetExtra: { type: 'paas', paas: { provider: 'vercel', prod: true, tokenRef: '${vault:T}' }, ssh: undefined, paths: undefined, web: undefined },
    });
    assert.equal(run.status, 'failed');
    assert.match(run.error, /assembled before they ship/);
  } finally { paas.paasDeps.probe = realProbe; paas.paasDeps.run = realRun; }
});

/* ------------------------------------- starting a project from nothing */

const starter = require('../../backend/deploy/wp-starter');
const { execFileSync } = require('child_process');

const hasPhp = (() => { try { execFileSync('php', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const newProject = (opts = {}) => starter.createProject({ dir: path.join(tmp('new'), 'acme-site'), git: false, ...opts });

test('a new project is a working WordPress project, without WordPress in it', async () => {
  const r = await newProject({ name: 'Acme Studio', version: '6.8.3', configFromVault: 'WP_DB_ACME' });
  assert.equal(r.name, 'Acme Studio');
  assert.equal(r.themeSlug, 'acme-studio-theme');
  const has = (rel) => fs.existsSync(path.join(r.path, rel));
  for (const rel of ['ship.json', '.gitignore', 'README.md', 'wp-content/plugins/.gitkeep', 'wp-content/mu-plugins/.gitkeep']) assert.ok(has(rel), rel);
  for (const rel of ['style.css', 'index.php', 'functions.php', 'header.php', 'footer.php']) assert.ok(has(`wp-content/themes/acme-studio-theme/${rel}`), rel);
  // core is downloaded and verified on every deploy: committing it is the thing this avoids
  assert.ok(!has('wp-settings.php') && !has('wp-includes') && !has('wp-admin'), 'no core in the repository');
  assert.ok(!has('wp-config.php'), 'no config either: it is generated from the vault');
});

test('its ship.json is a valid manifest that resolves to the WordPress stack', async () => {
  const r = await newProject({ name: 'Acme', version: '6.8.3', configFromVault: 'WP_DB_ACME' });
  const m = manifestLib.validate(JSON.parse(fs.readFileSync(path.join(r.path, 'ship.json'), 'utf8')));
  assert.equal(stackFor(m).id, 'wordpress');
  assert.equal(m.stack.wordpress.version, '6.8.3');
  assert.equal(m.stack.wordpress.configFromVault, 'WP_DB_ACME');
  assert.deepEqual(m.shared.dirs, ['wp-content/uploads']);
});

test('the generated theme carries the headers WordPress reads', async () => {
  const r = await newProject({ name: 'Acme Studio' });
  const css = fs.readFileSync(path.join(r.path, 'wp-content/themes/acme-studio-theme/style.css'), 'utf8');
  assert.match(css, /^\/\*\r?\nTheme Name: Acme Studio Theme$/m, 'the Theme Name header must be in the opening comment');
  assert.match(css, /Text Domain: acme-studio-theme/);
  const functions = fs.readFileSync(path.join(r.path, 'wp-content/themes/acme-studio-theme/functions.php'), 'utf8');
  assert.match(functions, /add_theme_support\( 'title-tag' \)/);
  assert.match(functions, /if \( ! defined\( 'ABSPATH' \) \)/, 'a theme file must refuse to run outside WordPress');
  // PHP identifiers cannot contain dashes: the slug has to be translated for function names
  assert.ok(!/function [a-z0-9_]*-/.test(functions), functions.split('\n').filter((l) => l.includes('function ')).join(' | '));
  assert.match(functions, /function acme_studio_theme_setup\(\)/);
});

test('the generated PHP parses', { skip: hasPhp ? false : 'php is not on this machine' }, async () => {
  const r = await newProject({ name: 'Acme Studio' });
  const dir = path.join(r.path, 'wp-content/themes/acme-studio-theme');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.php'))) {
    execFileSync('php', ['-l', path.join(dir, f)], { stdio: 'pipe' });
  }
});

test('the .gitignore keeps core, uploads and the generated config out of the repository', async () => {
  const r = await newProject({ name: 'Acme' });
  const ignore = fs.readFileSync(path.join(r.path, '.gitignore'), 'utf8').split(/\r?\n/);
  for (const rule of ['/wp-admin/', '/wp-includes/', '/wp-*.php', '!/wp-content/', 'wp-config.php', 'wp-content/uploads/']) {
    assert.ok(ignore.includes(rule), `${rule} is missing`);
  }
});

test('a folder with anything of yours in it is refused, and left alone', async () => {
  const dir = path.join(tmp('busy'), 'site');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'notes.txt'), 'mine');
  await assert.rejects(() => starter.createProject({ dir, git: false }), /already has files in it/);
  assert.equal(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'), 'mine');
  assert.equal(fs.readdirSync(dir).length, 1, 'nothing was added either');
});

test('an existing but empty folder is fine, and so is one with only a .git', async () => {
  const empty = path.join(tmp('empty'), 'site');
  await fsp.mkdir(empty, { recursive: true });
  assert.ok((await starter.createProject({ dir: empty, git: false })).path);
  const cloned = path.join(tmp('cloned'), 'site');
  await fsp.mkdir(path.join(cloned, '.git'), { recursive: true });
  assert.ok((await starter.createProject({ dir: cloned, git: false })).path);
});

test('the folder must be a real project folder, not your home or a drive root', async () => {
  for (const dir of [os.homedir(), path.join(os.homedir(), 'Desktop'), 'relative/path']) {
    await assert.rejects(() => starter.createProject({ dir, git: false }), /system or personal folder|too shallow|absolute path/, String(dir));
  }
});

test('a name that makes no theme slug still makes a project', async () => {
  const r = await newProject({ name: '???' });
  assert.equal(r.themeSlug, 'my-theme');
  assert.ok(fs.existsSync(path.join(r.path, 'wp-content/themes/my-theme/style.css')));
});

test('a project created from nothing detects, plans and ships as WordPress', async () => {
  const created = await newProject({ name: 'Acme Studio', version: '9.9', configFromVault: 'WP_DB' });

  const det = await detect(created.path);
  assert.equal(det.best.id, 'wordpress', det.reason || '');

  const core = await fakeCoreTarball();
  const ctx = fakeCtx({ fetch: fakeFetch({ tarball: core.bytes }) });
  const d = deps(ctx);
  d.vault.set('WP_DB', DB_BLOCK);
  const conn = fakeConn({ tools: 'php git tar curl' });
  const type = registerFakeVps(conn, 'fake-vps-new');
  d.stores.repos.get().repos.push({ id: 'r-new', name: created.name, source: { kind: 'local', path: created.path }, manifest: null });
  d.stores.targets.get().targets.push({ projectId: 'general', id: 't-new', name: 'acme prod', repoId: 'r-new', type, buildMode: 'auto', ssh: { profileId: 'p1' }, paths: { root: '/var/www/acme' }, web: { server: 'nginx', reloadCmd: 'sudo -n systemctl reload nginx' }, keepReleases: 3 });
  const run = createEngine(ctx, d).start({ targetId: 't-new', mode: 'ship', trigger: 'cli', confirm: true });
  await waitDone(run);
  assert.equal(run.status, 'succeeded', run.error);

  // its own ship.json carried the version and the vault entry: nothing else was configured
  const { files } = await shippedFiles(conn);
  assert.ok(files.includes('wp-settings.php'), 'core');
  assert.ok(files.includes('wp-config.php'), 'generated config');
  assert.ok(files.includes('wp-content/themes/acme-studio-theme/style.css'), 'the generated theme');
  assert.ok(files.includes('wp-content/plugins/.gitkeep'), 'the place plugins go');
  assert.ok(!files.includes('ship.json'), 'the manifest is not part of the site');
});

/* ------------------------------------------------- POST /wordpress/new */

const { createRouter } = require('../../backend/deploy/routes');

/** The module's HTTP surface on a throwaway port. */
async function serveDeploy(t) {
  const express = require('express');
  const ctx = fakeCtx();
  ctx.wrap = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);
  const d = deps(ctx);
  const app = express();
  app.use(express.json());
  app.use('/api/deploy', createRouter({ ctx, ...d, config: {}, engine: { isLocked: () => false, activeIds: () => [], list: () => [] }, cloud: {} }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))));
  const request = async (method, suffix, body) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/deploy${suffix}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };
  return { ctx, d, request };
}

test('POST /wordpress/new writes the project and connects it as a repository', async (t) => {
  const { ctx, d, request } = await serveDeploy(t);
  const dir = path.join(tmp('route'), 'acme-site');
  const res = await request('POST', '/wordpress/new', { dir, name: 'Acme Studio', version: '6.8.3', configFromVault: 'WP_DB_ACME', git: false });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.name, 'Acme Studio');
  assert.ok(fs.existsSync(path.join(dir, 'ship.json')));

  const repos = d.stores.repos.get().repos;
  assert.equal(repos.length, 1);
  assert.equal(repos[0].source.kind, 'local');
  assert.equal(repos[0].source.path, res.data.path);
  assert.equal(res.data.repo.id, repos[0].id);
  assert.ok(ctx._audits.some((a) => a.action === 'deploy-wordpress-new' && a.theme === 'acme-studio-theme'), JSON.stringify(ctx._audits));
});

test('it refuses a folder with files in it, and connects nothing when it does', async (t) => {
  const { d, request } = await serveDeploy(t);
  const dir = path.join(tmp('route-busy'), 'site');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'mine.txt'), 'x');
  const res = await request('POST', '/wordpress/new', { dir, git: false });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /already has files in it/);
  assert.equal(d.stores.repos.get().repos.length, 0, 'no half-connected repository was left behind');
});

test('it refuses a vault name that is not one, before writing anything', async (t) => {
  const { request } = await serveDeploy(t);
  const dir = path.join(tmp('route-vault'), 'site');
  const res = await request('POST', '/wordpress/new', { dir, configFromVault: 'not a name', git: false });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /UPPER_SNAKE_CASE/);
  assert.ok(!fs.existsSync(dir), 'nothing was written');
});

test('connect:false writes the project and leaves the repository list alone', async (t) => {
  const { d, request } = await serveDeploy(t);
  const dir = path.join(tmp('route-noconnect'), 'site');
  const res = await request('POST', '/wordpress/new', { dir, connect: false, git: false });
  assert.equal(res.status, 201);
  assert.equal(res.data.repo, null);
  assert.equal(d.stores.repos.get().repos.length, 0);
  assert.ok(fs.existsSync(path.join(dir, 'ship.json')));
});
