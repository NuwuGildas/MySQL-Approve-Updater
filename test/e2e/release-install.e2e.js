'use strict';
/* Installing a module from a release, the way GitHub serves one.
 *
 * The published flow is: a module branch is tagged, CI builds and signs the
 * archive, the archive and its description become release assets, and
 * catalog.yml turns those descriptions into one catalog whose package URLs
 * point at the assets. This runs that exact shape against a local server that
 * answers the same paths GitHub does:
 *
 *   /<owner>/<repo>/releases/download/<id>-v<version>/<id>-<version>.tgz
 *
 * Everything but the hostname is real: a catalog built by build-catalog.js with
 * the release URL template, a download over HTTP, the digest and the publisher
 * signature checked against the application's own trust anchor.
 *
 * `node test/e2e/release-install.e2e.js`. Needs built packages (npm run modules:build).
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist', 'modules');
const REPO = 'NuwuGildas/MySQL-Approve-Updater';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, { timeout = 25000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { last = await predicate(); if (last) return last; } catch (error) { last = error.message; }
    await wait(150);
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}

/** GitHub's release asset paths, served from dist/modules. */
function releaseServer({ tamper = new Set() } = {}) {
  const server = http.createServer((req, res) => {
    const match = new RegExp(`^/${REPO}/releases/download/([^/]+)/([A-Za-z0-9._-]+)$`).exec(req.url.split('?')[0]);
    if (!match) { res.writeHead(404).end('not found'); return; }
    const [, tag, file] = match;
    const source = path.join(tag === 'catalog' ? os.tmpdir() : DIST, file);
    let body;
    try { body = fs.readFileSync(tag === 'catalog' ? server.catalogFile : source); }
    catch { res.writeHead(404).end('no such asset'); return; }
    // A byte flipped in transit must be caught by the catalog's digest.
    if (tamper.has(file)) body = Buffer.concat([body.subarray(0, body.length - 8), Buffer.from('tampered')]);
    res.writeHead(200, { 'content-type': file.endsWith('.json') ? 'application/json' : 'application/gzip', 'content-length': body.length });
    res.end(body);
  });
  return server;
}

async function main() {
  assert.ok(fs.existsSync(path.join(DIST, 'catalog.json')), 'build the modules first: npm run modules:build');

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-tools-release-'));
  const dataDir = path.join(workDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const tamper = new Set();
  const server = releaseServer({ tamper });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  /* The catalog exactly as catalog.yml builds it, only with this origin. */
  const catalogFile = path.join(workDir, 'catalog.json');
  execFileSync(process.execPath, [
    'scripts/build-catalog.js', '--dir', DIST, '--out', catalogFile,
    '--url-template', `${origin}/${REPO}/releases/download/{id}-v{version}/{file}`,
  ], { cwd: ROOT, stdio: 'pipe' });
  server.catalogFile = catalogFile;
  const catalogUrl = `${origin}/${REPO}/releases/download/catalog/catalog.json`;

  const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
  for (const module of catalog.modules) {
    for (const version of module.versions) {
      assert.match(version.package.url, /\/releases\/download\/[a-z-]+-v\d+\.\d+\.\d+\//, `${module.id} points at its own release tag`);
      assert.ok(version.package.signature, `${module.id} ${version.version} is signed`);
    }
  }
  console.log(`  catalog: ${catalog.modules.length} modules, every version signed, every URL a release asset`);

  const port = 3500 + Math.floor(Math.random() * 90);
  const base = `http://127.0.0.1:${port}`;
  const app = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), MAU_NO_OPEN: '1', MODULE_REGISTRIES: catalogUrl, SERVER_TOOLS_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  app.stdout.on('data', (c) => log.push(String(c)));
  app.stderr.on('data', (c) => log.push(String(c)));

  const api = async (route, options) => {
    const response = await fetch(base + route, options);
    const text = await response.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { ok: response.ok, status: response.status, body };
  };

  try {
    await until(async () => (await fetch(`${base}/api/modules`)).ok, { what: 'the application to start' });

    const state = (await api('/api/modules?refresh=1')).body;
    assert.deepEqual(state.registryFailures, [], 'the catalog was fetched over HTTP');
    assert.equal(state.modules.length, 5, 'all five modules are offered');
    assert.equal(state.registries[0].url, catalogUrl);
    console.log('  the application fetched the catalog from the release URL');

    /* A real install, over HTTP, from a release-shaped asset URL. */
    const installed = await api('/api/modules/history/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.ok(installed.ok, `install failed: ${JSON.stringify(installed.body)}`);
    const record = installed.body.state.modules.find((m) => m.id === 'history');
    assert.equal(record.installed, true);
    assert.equal(record.signed, true, 'installed only because the signature verified');
    assert.equal(record.publisher, 'Server Tools');
    assert.equal(record.status, 'active');
    console.log(`  installed history ${record.installedVersion} from the release, signature verified`);

    const answered = await api('/api/m/history/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.ok(answered.ok, 'the module downloaded from the release actually runs');
    console.log('  and it runs');

    /* The digest in the catalog is what makes the download trustworthy: a
       tampered asset must be refused even though the catalog is untouched. */
    tamper.add('projects-1.0.0.tgz');
    const refused = await api('/api/modules/projects/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(refused.ok, false, 'a tampered archive was installed');
    assert.match(String(refused.body.error), /digest|match/i, JSON.stringify(refused.body));
    const after = (await api('/api/modules')).body.modules.find((m) => m.id === 'projects');
    assert.equal(after.installed, false, 'nothing was left behind by the refused install');
    console.log(`  a tampered release asset is refused: "${refused.body.error}"`);

    console.log('release-install e2e: PASS');
  } finally {
    try { app.kill(); } catch {}
    await new Promise((resolve) => server.close(resolve));
    if (process.env.KEEP_E2E_LOG) console.log(log.join(''));
    await wait(400);
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error('release-install e2e: FAIL\n', error); process.exit(1); });
