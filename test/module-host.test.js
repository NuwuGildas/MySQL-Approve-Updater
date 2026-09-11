'use strict';
/* The module host: manifests, catalogs, packages, installation and lifecycle.
 *
 * Everything here runs against real archives served by a real local registry,
 * because the point of the design is that installation is a download → verify →
 * unpack → activate sequence, not a flag being flipped. No network, no real
 * servers, no real publisher: a throwaway signing key is generated per run. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const tar = require('tar');

const semver = require('../lib/host/semver');
const { validateManifest, validateCatalog } = require('../lib/host/manifest');
const archive = require('../lib/host/archive');
const { createVerifier, signedPayload } = require('../lib/host/verify');
const { createRegistry } = require('../lib/host/registry');
const { createCatalogClient } = require('../lib/host/catalog');
const { toUrl } = require('../lib/host/download');
const { createInstaller } = require('../lib/host/installer');
const { createServices } = require('../lib/host/services');
const { createRegistryServer } = require('../scripts/module-registry');
const { HOST_SDK_VERSION } = require('../lib/host/sdk');

/* ---------------- a throwaway publisher and a package factory ---------------- */

function publisher() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const keyId = 'test-key';
  return {
    keyId, privateKey,
    trustFile(dir) {
      const file = path.join(dir, 'trusted-publishers.json');
      fs.writeFileSync(file, JSON.stringify({
        version: 1,
        publishers: [{ id: 'test', name: 'Test Publisher', keys: [{ keyId, algorithm: 'ed25519', publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }] }],
      }));
      return file;
    },
    sign: (id, version, digest) => crypto.sign(null, signedPayload(id, version, digest), privateKey).toString('base64'),
  };
}

const MANIFEST = (over = {}) => ({
  packageFormat: 1, id: 'demo', name: 'Demo', description: 'A demo module.',
  version: '1.0.0', publisher: 'Test Publisher', hostSdk: '^1.0.0',
  backend: 'backend/index.js', capabilities: [], ...over,
});

/** Build a real .tgz package in `dir` and return its artifact description. */
async function buildPackage(dir, { manifest = MANIFEST(), files = {}, corrupt = false } = {}) {
  const source = path.join(dir, `src-${manifest.id}-${manifest.version}-${crypto.randomUUID().slice(0, 8)}`);
  fs.mkdirSync(path.join(source, 'backend'), { recursive: true });
  fs.writeFileSync(path.join(source, 'module.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(source, 'backend', 'index.js'), files['backend/index.js'] ?? `
    'use strict';
    module.exports = { activate: async (host) => ({ methods: { ping: () => ({ pong: host.id }) }, busy: () => false }) };
  `);
  for (const [name, content] of Object.entries(files)) {
    if (name === 'backend/index.js') continue;
    fs.mkdirSync(path.dirname(path.join(source, name)), { recursive: true });
    fs.writeFileSync(path.join(source, name), content);
  }
  const entries = ['module.json', 'backend/index.js', ...Object.keys(files).filter((f) => f !== 'backend/index.js')];
  const file = path.join(dir, `${manifest.id}-${manifest.version}-${crypto.randomUUID().slice(0, 8)}.tgz`);
  await tar.c({ file, cwd: source, gzip: true, portable: true, mtime: new Date(0) }, [...new Set(entries)]);
  if (corrupt) { const bytes = fs.readFileSync(file); bytes[bytes.length - 20] ^= 0xff; fs.writeFileSync(file, bytes); }
  return { file, manifest, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), size: fs.statSync(file).size };
}

function catalogFor(entries, { origin }) {
  return {
    catalogVersion: 1, name: 'Test registry',
    modules: entries.map(({ artifact, sign, dependencies = {}, hostSdk, capabilities = [] }) => ({
      id: artifact.manifest.id, name: artifact.manifest.name, description: artifact.manifest.description, publisher: 'Test Publisher',
      versions: [{
        version: artifact.manifest.version,
        hostSdk: hostSdk || artifact.manifest.hostSdk,
        dependencies, capabilities,
        source: { branch: `modules/${artifact.manifest.id}`, commit: 'a'.repeat(40) },
        package: {
          url: `${origin}/packages/${path.basename(artifact.file)}`,
          size: artifact.size, sha256: artifact.sha256,
          signature: sign === null ? null : sign(artifact.manifest.id, artifact.manifest.version, artifact.sha256),
          keyId: sign === null ? null : 'test-key', algorithm: 'ed25519',
        },
      }],
    })),
  };
}

/** A registry directory plus a live HTTP server that serves it. */
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-module-host-'));
  const packages = path.join(root, 'packages');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(packages, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const pub = publisher();
  const trustFile = pub.trustFile(dataDir);
  const server = await createRegistryServer({ dir: packages, port: 0 });
  t.after(async () => { await server.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const publish = async (options) => {
    const artifact = await buildPackage(packages, options);
    return artifact;
  };
  const writeCatalog = (entries) => {
    fs.writeFileSync(path.join(packages, 'catalog.json'), JSON.stringify(catalogFor(entries, { origin: `http://127.0.0.1:${server.port}` }), null, 2));
  };
  const build = () => {
    const registry = createRegistry(dataDir, { hostSdkVersion: HOST_SDK_VERSION });
    const catalogClient = createCatalogClient({ registries: [server.catalogUrl], hostSdkVersion: HOST_SDK_VERSION, ttlMs: 0 });
    const verifier = createVerifier({ trustFiles: [trustFile] });
    const installer = createInstaller({ registry, catalogClient, verifier, hostSdkVersion: HOST_SDK_VERSION });
    return { registry, catalogClient, verifier, installer };
  };
  return { root, packages, dataDir, pub, server, publish, writeCatalog, build, sign: pub.sign };
}

/* ---------------- semver ---------------- */

test('the version range subset the host uses behaves like npm for the cases it accepts', () => {
  assert.ok(semver.satisfies('1.2.3', '^1.0.0'));
  assert.ok(!semver.satisfies('2.0.0', '^1.0.0'));
  assert.ok(semver.satisfies('0.2.9', '^0.2.0'));
  assert.ok(!semver.satisfies('0.3.0', '^0.2.0'));
  assert.ok(semver.satisfies('1.4.0', '~1.4.2') === false);
  assert.ok(semver.satisfies('1.4.3', '~1.4.2'));
  assert.ok(semver.satisfies('1.0.0', '*'));
  assert.ok(semver.satisfies('2.0.0', '>=1.5.0 <3.0.0'));
  assert.ok(!semver.validRange('not a range'));
  assert.equal(semver.maxSatisfying(['1.0.0', '1.2.0', '2.0.0'], '^1.0.0'), '1.2.0');
});

/* ---------------- manifests and catalogs ---------------- */

test('a manifest is validated field by field, and unknown capabilities are refused', () => {
  const manifest = validateManifest(MANIFEST({ frontend: 'frontend/index.js', capabilities: ['ui:pages'] }));
  assert.equal(manifest.id, 'demo');
  assert.equal(manifest.compatible, true);
  assert.deepEqual(manifest.capabilities, ['ui:pages']);

  assert.throws(() => validateManifest(MANIFEST({ packageFormat: 99 })), /packageFormat/);
  assert.throws(() => validateManifest(MANIFEST({ id: 'Not Valid' })), /id must be/);
  assert.throws(() => validateManifest(MANIFEST({ version: 'latest' })), /semantic version/);
  assert.throws(() => validateManifest(MANIFEST({ capabilities: ['root:everything'] })), /does not grant/);
  assert.throws(() => validateManifest(MANIFEST({ backend: '../../etc/passwd' })), /relative path inside/);
  assert.throws(() => validateManifest(MANIFEST({ backend: undefined, frontend: undefined })), /frontend entry, a backend entry/);
  assert.throws(() => validateManifest(MANIFEST({ dependencies: { demo: '^1.0.0' } })), /cannot depend on itself/);
  assert.throws(() => validateManifest(MANIFEST({ sharedDependencies: ['fs-extra'] })), /does not share/);

  // A module built for a future host is parsed, but reported as incompatible.
  assert.equal(validateManifest(MANIFEST({ hostSdk: '^9.0.0' })).compatible, false);
});

test('a catalog is validated before use, including its digests', () => {
  const good = {
    catalogVersion: 1, modules: [{
      id: 'demo', name: 'Demo', description: 'x', publisher: 'Test',
      versions: [{ version: '1.0.0', hostSdk: '^1.0.0', package: { url: 'http://x/y.tgz', size: 10, sha256: 'a'.repeat(64) } }],
    }],
  };
  assert.equal(validateCatalog(good).modules.length, 1);
  assert.throws(() => validateCatalog({ ...good, catalogVersion: 2 }), /catalogVersion/);
  assert.throws(() => validateCatalog({ catalogVersion: 1, modules: [{ ...good.modules[0], versions: [{ ...good.modules[0].versions[0], package: { url: 'http://x/y.tgz', size: 10, sha256: 'short' } }] }] }), /sha256/);
  assert.throws(() => validateCatalog({ catalogVersion: 1, modules: [{ ...good.modules[0], versions: [{ ...good.modules[0].versions[0], package: { url: 'javascript:alert(1)', size: 10, sha256: 'a'.repeat(64) } }] }] }), /http, https or file/);
});

test('a registry configured as a local path is read as a path, drive letter and all', async (t) => {
  /* "C:\registry\catalog.json" parses as the one-character scheme "c:", so a
     Windows path used to be handed to fetch() untouched and every local or
     offline catalog failed with "fetch failed". The decision - path, not URL -
     is the same everywhere; only the href a path turns into is per-platform,
     so that is asserted where those paths are real. */
  assert.match(toUrl('C:\\registry\\catalog.json'), /^file:/);
  assert.match(toUrl('D:/modules/catalog.json'), /^file:/);
  assert.equal(toUrl('http://127.0.0.1:8788/catalog.json'), 'http://127.0.0.1:8788/catalog.json');
  assert.equal(toUrl('file:///C:/registry/catalog.json'), 'file:///C:/registry/catalog.json');
  assert.match(toUrl('./registry/catalog.json'), /^file:\/\/\/.+\/registry\/catalog\.json$/);
  if (process.platform === 'win32') {
    assert.equal(toUrl('C:\\registry\\catalog.json'), 'file:///C:/registry/catalog.json');
    assert.equal(toUrl('D:/modules/catalog.json'), 'file:///D:/modules/catalog.json');
  } else {
    assert.equal(toUrl('/srv/registry/catalog.json'), 'file:///srv/registry/catalog.json');
  }

  /* And the client actually loads one, with no server anywhere. */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-local-catalog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'catalog.json');
  fs.writeFileSync(file, JSON.stringify({
    catalogVersion: 1, modules: [{
      id: 'demo', name: 'Demo', description: 'x', publisher: 'Test',
      versions: [{ version: '1.0.0', hostSdk: `^${HOST_SDK_VERSION.split('.')[0]}.0.0`, package: { url: 'http://x/y.tgz', size: 10, sha256: 'a'.repeat(64) } }],
    }],
  }));

  const client = createCatalogClient({ registries: [{ name: 'Local', url: file }], hostSdkVersion: HOST_SDK_VERSION });
  const catalog = await client.load();
  assert.deepEqual(catalog.failures, [], 'a local catalog is readable without a network');
  assert.equal(catalog.modules[0].id, 'demo');
});

/* ---------------- archives ---------------- */

/** A tar entry written by hand, so an archive can claim things the filesystem
    would not let this test create (a symlink, an absolute path). */
function handmadeTar(entries) {
  const blocks = [];
  for (const { name, type = '0', link = '', body = '' } of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('000644 \0', 100, 8);
    header.write('000000 \0', 108, 8);
    header.write('000000 \0', 116, 8);
    header.write(Buffer.byteLength(body).toString(8).padStart(11, '0') + ' ', 124, 12);
    header.write('00000000000 ', 136, 12);
    header.write('        ', 148, 8);          // checksum placeholder
    header.write(type, 156, 1);
    header.write(link, 157, 100, 'utf8');
    header.write('ustar\0' + '00', 257, 8);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    blocks.push(header);
    if (body) {
      const payload = Buffer.alloc(Math.ceil(Buffer.byteLength(body) / 512) * 512);
      payload.write(body);
      blocks.push(payload);
    }
  }
  blocks.push(Buffer.alloc(1024));            // end of archive
  return require('node:zlib').gzipSync(Buffer.concat(blocks));
}

test('an archive that could escape its directory, or is not plain files, is refused before anything is written', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-archive-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stage = path.join(dir, 'stage');
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(stage, 'ok.txt'), 'fine');

  const refused = {
    'a symbolic link': [{ name: 'evil', type: '2', link: '/etc/passwd' }],
    'a hard link': [{ name: 'evil', type: '1', link: 'ok.txt' }],
    'an absolute path': [{ name: '/etc/cron.d/evil', body: 'x' }],
    'a climbing path': [{ name: '../../evil.js', body: 'x' }],
    'a device node': [{ name: 'evil', type: '3' }],
  };
  for (const [what, entries] of Object.entries(refused)) {
    const file = path.join(dir, `${what.replace(/\W+/g, '-')}.tgz`);
    fs.writeFileSync(file, handmadeTar(entries));
    await assert.rejects(archive.inspect(file), /unsupported entry|absolute path|escapes the package/i, what);
    const out = path.join(dir, 'out-' + what.replace(/\W+/g, '-'));
    await assert.rejects(archive.extract(file, out), /unsupported entry|absolute path|escapes the package/i, what);
    assert.equal(fs.existsSync(path.join(dir, 'evil.js')), false, `${what} wrote nothing`);
  }

  const plain = path.join(dir, 'plain.tgz');
  await tar.c({ file: plain, cwd: stage, gzip: true, portable: true }, ['ok.txt']);
  const out = path.join(dir, 'out');
  const inspected = await archive.extract(plain, out);
  assert.deepEqual(inspected.files, ['ok.txt']);
  assert.equal(fs.readFileSync(path.join(out, 'ok.txt'), 'utf8'), 'fine');
});

/* ---------------- integrity and authenticity ---------------- */

test('a package is only installed when its digest AND its publisher signature check out', async (t) => {
  const fx = await fixture(t);
  const artifact = await fx.publish({});

  const good = await fx.build().verifier.verifyPackage(artifact.file, {
    sha256: artifact.sha256, signature: fx.sign('demo', '1.0.0', artifact.sha256), keyId: 'test-key',
  }, { moduleId: 'demo', version: '1.0.0' });
  assert.equal(good.signed, true);
  assert.equal(good.publisher.name, 'Test Publisher');

  const verifier = fx.build().verifier;
  await assert.rejects(verifier.verifyPackage(artifact.file, { sha256: 'b'.repeat(64), signature: 'x', keyId: 'test-key' }, { moduleId: 'demo', version: '1.0.0' }), /does not match the digest/);
  await assert.rejects(verifier.verifyPackage(artifact.file, { sha256: artifact.sha256, signature: null, keyId: null }, { moduleId: 'demo', version: '1.0.0' }), /not signed by a publisher/);
  await assert.rejects(verifier.verifyPackage(artifact.file, { sha256: artifact.sha256, signature: fx.sign('demo', '1.0.0', artifact.sha256), keyId: 'someone-else' }, { moduleId: 'demo', version: '1.0.0' }), /unknown key/);
  // A signature for a different version cannot be replayed onto this one.
  await assert.rejects(verifier.verifyPackage(artifact.file, { sha256: artifact.sha256, signature: fx.sign('demo', '2.0.0', artifact.sha256), keyId: 'test-key' }, { moduleId: 'demo', version: '1.0.0' }), /signature is not valid/);
});

/* ---------------- installation ---------------- */

test('installing downloads, verifies, unpacks and records - and the code lands outside the app', async (t) => {
  const fx = await fixture(t);
  const artifact = await fx.publish({});
  fx.writeCatalog([{ artifact, sign: fx.sign }]);
  const { registry, installer } = fx.build();

  const phases = [];
  const result = await installer.install('demo', { onProgress: (p) => phases.push(p.phase) });
  assert.deepEqual(result.installed.map((r) => r.id), ['demo']);
  assert.ok(phases.includes('download') && phases.includes('verify') && phases.includes('extract'));

  const record = registry.get('demo');
  assert.equal(record.version, '1.0.0');
  assert.equal(record.signed, true);
  assert.equal(record.digest, artifact.sha256);
  assert.ok(record.dir.includes(path.join('module-data', 'installed', 'demo', '1.0.0')));
  assert.ok(fs.existsSync(path.join(record.dir, 'module.json')));
  // Nothing was left in staging or in the download cache.
  assert.deepEqual(fs.readdirSync(registry.layout.staging), []);
  assert.deepEqual(fs.readdirSync(registry.layout.cache), []);
});

test('dependencies install first, cycles are refused, and an unmet version is refused', async (t) => {
  const fx = await fixture(t);
  const base = await fx.publish({ manifest: MANIFEST({ id: 'base' }) });
  const leaf = await fx.publish({ manifest: MANIFEST({ id: 'leaf', dependencies: { base: '^1.0.0' } }) });
  fx.writeCatalog([
    { artifact: base, sign: fx.sign },
    { artifact: leaf, sign: fx.sign, dependencies: { base: '^1.0.0' } },
  ]);
  const { registry, installer } = fx.build();

  const plan = await installer.plan('leaf');
  assert.deepEqual(plan.map((s) => s.id), ['base', 'leaf'], 'a dependency is installed before what needs it');

  const result = await installer.install('leaf');
  assert.deepEqual(result.installed.map((r) => r.id), ['base', 'leaf']);
  assert.deepEqual(registry.dependents('base').map((m) => m.id), ['leaf']);

  // A version nobody offers.
  await assert.rejects(installer.plan('leaf', { version: '^9.0.0' }), /No version of/);
  await assert.rejects(installer.plan('missing'), /does not offer/);
});

test('a cycle in the catalog is detected instead of installed', async (t) => {
  const fx = await fixture(t);
  const a = await fx.publish({ manifest: MANIFEST({ id: 'alpha' }) });
  const b = await fx.publish({ manifest: MANIFEST({ id: 'beta' }) });
  fx.writeCatalog([
    { artifact: a, sign: fx.sign, dependencies: { beta: '^1.0.0' } },
    { artifact: b, sign: fx.sign, dependencies: { alpha: '^1.0.0' } },
  ]);
  await assert.rejects(fx.build().installer.plan('alpha'), /Circular module dependency/);
});

test('corrupt, tampered, unsigned and incompatible packages all fail cleanly', async (t) => {
  const fx = await fixture(t);
  const { registry, installer } = fx.build();

  /* the archive does not match its digest */
  const tampered = await fx.publish({});
  const realDigest = tampered.sha256;
  fs.writeFileSync(tampered.file, Buffer.concat([fs.readFileSync(tampered.file), Buffer.from('extra')]));
  fx.writeCatalog([{ artifact: { ...tampered, sha256: realDigest }, sign: fx.sign }]);
  await assert.rejects(installer.install('demo'), /size|digest/i);
  assert.equal(registry.get('demo'), null, 'nothing was recorded');
  assert.deepEqual(fs.readdirSync(registry.layout.staging), []);

  /* not signed at all */
  const unsigned = await fx.publish({ manifest: MANIFEST({ id: 'unsigned' }) });
  fx.writeCatalog([{ artifact: unsigned, sign: null }]);
  await assert.rejects(fx.build().installer.install('unsigned'), /not signed by a publisher/);

  /* the archive is not a readable tar */
  const broken = await fx.publish({ manifest: MANIFEST({ id: 'broken' }), corrupt: true });
  fx.writeCatalog([{ artifact: broken, sign: fx.sign }]);
  await assert.rejects(fx.build().installer.install('broken'), /./);

  /* the manifest inside the package disagrees with the catalog */
  const lying = await fx.publish({ manifest: MANIFEST({ id: 'demo', version: '1.0.0', name: 'Demo' }) });
  const catalogEntry = catalogFor([{ artifact: lying, sign: fx.sign }], { origin: `http://127.0.0.1:${fx.server.port}` });
  catalogEntry.modules[0].id = 'other';
  catalogEntry.modules[0].versions[0].package.signature = fx.sign('other', '1.0.0', lying.sha256);
  fs.writeFileSync(path.join(fx.packages, 'catalog.json'), JSON.stringify(catalogEntry));
  await assert.rejects(fx.build().installer.install('other'), /declares module/);

  /* built for a host that does not exist yet */
  const future = await fx.publish({ manifest: MANIFEST({ id: 'future', hostSdk: '^9.0.0' }) });
  fx.writeCatalog([{ artifact: future, sign: fx.sign, hostSdk: '^9.0.0' }]);
  await assert.rejects(fx.build().installer.plan('future'), /No version of/);
});

test('two concurrent installations of the same module do not corrupt the state document', async (t) => {
  const fx = await fixture(t);
  const artifact = await fx.publish({});
  fx.writeCatalog([{ artifact, sign: fx.sign }]);
  const { registry, installer } = fx.build();

  const both = await Promise.allSettled([
    registry.withLock('install', () => installer.install('demo')),
    registry.withLock('install', () => installer.install('demo')),
  ]);
  assert.ok(both.some((r) => r.status === 'fulfilled'));
  const state = JSON.parse(fs.readFileSync(path.join(registry.layout.root, 'state.json'), 'utf8'));
  assert.deepEqual(Object.keys(state.modules), ['demo']);
  assert.equal(registry.get('demo').version, '1.0.0');
});

test('removal keeps module-owned data and forgets only the code', async (t) => {
  const fx = await fixture(t);
  const artifact = await fx.publish({});
  fx.writeCatalog([{ artifact, sign: fx.sign }]);
  const { registry, installer } = fx.build();
  await installer.install('demo');

  const dataDir = registry.dataDirFor('demo');
  fs.writeFileSync(path.join(dataDir, 'notes.json'), '{"kept":true}');
  const codeDir = registry.get('demo').dir;

  await registry.forget('demo');
  assert.equal(registry.get('demo'), null);
  assert.equal(fs.existsSync(codeDir), false, 'the code is gone');
  assert.equal(fs.readFileSync(path.join(dataDir, 'notes.json'), 'utf8'), '{"kept":true}', 'the data is not');

  // Adding it again finds the data where it left it.
  await installer.install('demo');
  assert.equal(fs.readFileSync(path.join(registry.dataDirFor('demo'), 'notes.json'), 'utf8'), '{"kept":true}');
});

test('a state document that is not one refuses to start rather than silently emptying itself', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-badstate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'module-data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'module-data', 'state.json'), '{"version": 7}');
  assert.throws(() => createRegistry(root, { hostSdkVersion: HOST_SDK_VERSION }), /state document/);
  assert.equal(fs.readFileSync(path.join(root, 'module-data', 'state.json'), 'utf8'), '{"version": 7}', 'the file is never overwritten');
});

/* ---------------- capabilities ---------------- */

test('a host service is refused unless the module asked for its capability', async () => {
  const calls = [];
  const services = createServices({
    audit: { record: (entry) => { calls.push(entry); return true; }, read: () => ({ entries: [] }) },
    connections: { credentials: () => ({ secret: 'do not leak' }) },
  });
  const record = (capabilities) => ({ manifest: { name: 'Demo', capabilities } });

  await assert.rejects(services.call('demo', 'audit.record', { action: 'x' }, record([])), /did not request the "audit:write"/);
  assert.equal(await services.call('demo', 'audit.record', { action: 'x' }, record(['audit:write'])), true);
  assert.equal(calls[0].module, 'demo', 'a recorded event always names the module that recorded it');

  await assert.rejects(services.call('demo', 'connections.credentials', { id: '1' }, record(['connections:read'])), /did not request the "connections:secrets"/);
  assert.deepEqual(await services.call('demo', 'connections.credentials', { id: '1' }, record(['connections:secrets'])), { secret: 'do not leak' });
  await assert.rejects(services.call('demo', 'nonsense.method', {}, record(['audit:write'])), /Unknown host service/);
});

test('a module that fails to activate is not recorded, and leaves the host exactly as it was', async (t) => {
  const fx = await fixture(t);
  const artifact = await fx.publish({});
  fx.writeCatalog([{ artifact, sign: fx.sign }]);
  const { registry, installer } = fx.build();

  /* Activation is the last thing that happens before the state document is
     written. When it throws, nothing is recorded and the code is rolled back. */
  await assert.rejects(
    installer.install('demo', { activate: async () => { throw new Error('the worker refused to start'); } }),
    /refused to start/,
  );
  assert.equal(registry.get('demo'), null, 'a module that could not start is not installed');
  assert.equal(fs.existsSync(registry.codeDirFor('demo', '1.0.0')), false, 'its code was rolled back');
  assert.deepEqual(fs.readdirSync(registry.layout.staging), []);

  /* And the same install, retried, succeeds: nothing was left in a bad state. */
  const result = await installer.install('demo');
  assert.deepEqual(result.installed.map((r) => r.id), ['demo']);
  assert.equal(registry.get('demo').version, '1.0.0');
});

test('where a catalog comes from is asked again, not decided once at startup', async (t) => {
  /* A developer builds a local catalog, or deletes it. Either should take effect
     on the next refresh: resolving the registry list once at startup made
     deleting a local catalog leave the application pointing at a file that is no
     longer there, with nothing offered until it was restarted. */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-registry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const local = path.join(dir, 'local.json');
  const published = path.join(dir, 'published.json');
  const doc = (id) => JSON.stringify({
    catalogVersion: 1,
    modules: [{
      id, name: id, description: 'x', publisher: 'Test',
      versions: [{ version: '1.0.0', hostSdk: `^${HOST_SDK_VERSION.split('.')[0]}.0.0`, package: { url: 'http://x/y.tgz', size: 10, sha256: 'a'.repeat(64) } }],
    }],
  });
  fs.writeFileSync(local, doc('from-local'));
  fs.writeFileSync(published, doc('from-published'));

  /* Exactly what server.js does: prefer a local catalog when the file is there. */
  const registries = () => (fs.existsSync(local)
    ? [{ name: 'local', url: local }]
    : [{ name: 'published', url: published }]);
  const client = createCatalogClient({ registries, hostSdkVersion: HOST_SDK_VERSION, ttlMs: 0 });

  assert.deepEqual((await client.load()).modules.map((m) => m.id), ['from-local']);
  assert.deepEqual(client.sources.map((s) => s.name), ['local'], 'and it reports where it is looking');

  fs.rmSync(local);
  const after = await client.load({ force: true });
  assert.deepEqual(after.modules.map((m) => m.id), ['from-published'], 'deleting the local catalog falls back, with no restart');
  assert.deepEqual(after.failures, [], 'and the missing file is not reported as a broken registry');
  assert.deepEqual(client.sources.map((s) => s.name), ['published']);

  /* A plain array still works, for callers that have nothing to decide. */
  const fixed = createCatalogClient({ registries: [{ name: 'published', url: published }], hostSdkVersion: HOST_SDK_VERSION, ttlMs: 0 });
  assert.deepEqual((await fixed.load()).modules.map((m) => m.id), ['from-published']);
});

test('the assistant\'s own sign-in is its own capability, its own setting, and never cached', async () => {
  /* Lending the assistant's credential to an agent a module runs elsewhere is a
     serious privilege: it is the key to the user's AI account. Three gates, and
     every one of them must hold on its own. */
  const shared = [];
  let allowed = false;
  let token = 'sk-ant-oat-secret';
  const services = createServices({
    audit: { record: (entry) => { shared.push(entry); return true; }, read: () => ({ entries: [] }) },
  });
  services.extend({
    'assistant.credential': ['assistant:credential', (module) => {
      if (!allowed) throw Object.assign(new Error('sharing is off'), { status: 403 });
      if (!token) throw Object.assign(new Error('no token to share'), { status: 409 });
      shared.push({ action: 'assistant-credential-shared', module: module.id });
      return { token, kind: 'oauth' };
    }],
  });
  const record = (capabilities) => ({ id: 'demo', manifest: { name: 'Demo', capabilities } });

  /* 1. Declaring assistant:tools does not get you the credential. */
  await assert.rejects(
    services.call('demo', 'assistant.credential', {}, record(['assistant:tools'])),
    /did not request the "assistant:credential"/,
  );

  /* 2. With the capability, it is still off until the user turns it on. */
  await assert.rejects(
    services.call('demo', 'assistant.credential', {}, record(['assistant:credential'])),
    (error) => error.status === 403,
  );

  /* 3. On, but nothing to share - a CLI sign-in belongs to the CLI. */
  allowed = true;
  token = null;
  await assert.rejects(
    services.call('demo', 'assistant.credential', {}, record(['assistant:credential'])),
    (error) => error.status === 409,
  );

  /* All three satisfied: handed over one call at a time, and the fact recorded
     without the secret. */
  token = 'sk-ant-oat-secret';
  const got = await services.call('demo', 'assistant.credential', {}, record(['assistant:credential']));
  assert.deepEqual(got, { token: 'sk-ant-oat-secret', kind: 'oauth' });
  const entry = shared.find((e) => e.action === 'assistant-credential-shared');
  assert.equal(entry.module, 'demo');
  assert.equal(JSON.stringify(shared).includes('sk-ant-oat-secret'), false, 'the audit trail records that it happened, never what');
});
