'use strict';
/* "This computer" target: root guards, and the whole native release flow in a temp folder
   (prepare → lock → extract → shared links → activate → list → second release → prune → rollback → discard). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const tar = require('tar');
const local = require('../../backend/deploy/targets/local');
const { TARGETS, adapterFor } = require('../../backend/deploy/targets');

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'st-local-'));

test('local target is registered and validates a safe root', () => {
  assert.equal(TARGETS.local, local);
  assert.equal(adapterFor({ type: 'local' }).id, 'local');
  const base = tmpRoot();
  const t = local.validate({ name: 'x', type: 'local', paths: { root: path.join(base, 'app') }, buildMode: 'remote', keepReleases: 1, web: { reloadCmd: 'echo reloaded' }, process: { manager: 'pm2', name: 'shop' }, ssh: { profileId: 'gone' } });
  assert.equal(t.buildMode, 'local'); assert.equal(t.keepReleases, 2); assert.equal(t.web.reloadCmd, 'echo reloaded'); assert.equal(t.process.manager, 'pm2');
  assert.equal(t.ssh, undefined); assert.equal(t.healthRemote, false);
  assert.throws(() => local.validate({ paths: { root: 'relative/app' } }), /absolute path/);
  assert.throws(() => local.validate({ paths: { root: os.homedir() } }), /system or personal folder/);
  assert.throws(() => local.validate({ paths: { root: process.platform === 'win32' ? 'C:\\' : '/' } }), /system or personal folder|too shallow/);
  assert.throws(() => local.validate({ paths: { root: base + path.sep + '..' + path.sep + 'x' } }), /\.\./);
  assert.throws(() => local.validate({ paths: { root: process.platform === 'win32' ? 'C:\\Windows\\x' : '/etc' } }), /system or personal folder|too shallow/);
  assert.throws(() => local.validate({ paths: { root: path.join(base, 'app') }, process: { manager: 'systemd' } }), /process.manager/);
  assert.throws(() => local.validate({ paths: { root: path.join(base, 'app') }, healthUrl: 'localhost:8080' }), /healthUrl/);
  fs.rmSync(base, { recursive: true, force: true });
});

async function makeArtifact(dir, files) {
  const stage = path.join(dir, 'stage'); await fsp.mkdir(stage, { recursive: true });
  for (const [rel, content] of Object.entries(files)) { const p = path.join(stage, rel); await fsp.mkdir(path.dirname(p), { recursive: true }); await fsp.writeFile(p, content); }
  const tgz = path.join(dir, 'release.tgz');
  await tar.c({ gzip: true, file: tgz, cwd: stage, portable: true }, ['.']);
  await fsp.rm(stage, { recursive: true, force: true });
  return tgz;
}

test('native release flow: extract, shared links, activate, prune, rollback', async () => {
  const base = tmpRoot();
  const root = path.join(base, 'www', 'shop');
  const target = local.validate({ name: 'shop', type: 'local', paths: { root }, keepReleases: 2, web: { reloadCmd: '' } });
  const conn = await local.connect();
  const L = local.layout(target.paths.root);
  const manifest = { shared: { files: ['.env'], dirs: ['storage/logs'] }, runtime: { kind: 'static', docroot: 'public' } };
  const lines = [], warns = [];
  const o = { onLine: (l) => lines.push(l), warn: (w) => warns.push(w) };

  // probe on a folder that does not exist yet
  let pr = await local.probe(conn, target);
  assert.equal(pr.rootExists, false); assert.equal(pr.sudo, false); assert.ok(pr.tools.node); assert.equal(pr.symlinkOk, true);

  await local.prepare(conn, L);
  await local.lock(conn, L, { runId: 'r1', host: 'me' });
  await assert.rejects(local.lock(conn, L, { runId: 'r2', host: 'me' }), /locked by another deploy/);
  await local.lock(conn, L, { runId: 'r2', host: 'me' }, { force: true }); // force takes it over

  const ts1 = '20260101000000', ts2 = '20260101000100';
  const tgz1 = await makeArtifact(base, { 'public/index.html': '<h1>v1</h1>', '.env': 'APP_KEY=one', 'storage/logs/old.log': 'seed', '.release.json': JSON.stringify({ commit: 'aaa' }) });
  await local.extractTgz(conn, L, ts1, tgz1, o);
  assert.equal(await fsp.readFile(path.join(L.release(ts1), 'public', 'index.html'), 'utf8'), '<h1>v1</h1>');
  await local.linkShared(conn, L, ts1, manifest, o);
  // the release's own copies seeded shared/, then became links
  assert.equal(await fsp.readFile(path.join(L.shared, '.env'), 'utf8'), 'APP_KEY=one');
  assert.equal(await fsp.readFile(path.join(L.shared, 'storage', 'logs', 'old.log'), 'utf8'), 'seed');
  assert.ok((await fsp.lstat(path.join(L.release(ts1), 'storage', 'logs'))).isSymbolicLink());
  await fsp.writeFile(path.join(L.shared, 'storage', 'logs', 'new.log'), 'x');
  assert.ok(fs.existsSync(path.join(L.release(ts1), 'storage', 'logs', 'new.log')), 'shared dir visible through the release link');

  await local.activate(conn, L, ts1, target, manifest, o);
  let ls = await local.listReleases(conn, L);
  assert.equal(ls.current, ts1); assert.equal(ls.releases.length, 1); assert.equal(ls.releases[0].commit, 'aaa'); assert.equal(ls.releases[0].current, true);
  assert.equal(await fsp.readFile(path.join(L.current, 'public', 'index.html'), 'utf8'), '<h1>v1</h1>');
  assert.equal(local.webRoot(L, manifest), path.join(L.current, 'public'));

  // second release with a reload command; shared .env keeps its edited content
  await fsp.writeFile(path.join(L.shared, '.env'), 'APP_KEY=edited');
  const t2 = { ...target, web: { ...target.web, reloadCmd: process.platform === 'win32' ? 'echo reloaded' : 'echo reloaded' } };
  const tgz2 = await makeArtifact(base, { 'public/index.html': '<h1>v2</h1>', '.env': 'APP_KEY=two', '.release.json': JSON.stringify({ commit: 'bbb' }) });
  await local.extractTgz(conn, L, ts2, tgz2, o);
  await local.linkShared(conn, L, ts2, manifest, o);
  assert.equal(await fsp.readFile(path.join(L.release(ts2), '.env'), 'utf8'), 'APP_KEY=edited', 'existing shared file wins over the release copy');
  await local.activate(conn, L, ts2, t2, manifest, o);
  assert.ok(lines.some((l) => /after-activation command: ok/.test(l)), 'reload command ran');
  ls = await local.listReleases(conn, L);
  assert.equal(ls.current, ts2); assert.deepEqual(ls.releases.map((r) => r.ts), [ts1, ts2]);
  assert.equal(await fsp.readFile(path.join(L.current, 'public', 'index.html'), 'utf8'), '<h1>v2</h1>');

  // probe now sees the layout
  pr = await local.probe(conn, target);
  assert.equal(pr.rootExists, true); assert.equal(pr.current, ts2); assert.deepEqual(pr.releases, [ts1, ts2]); assert.ok(/r2 me/.test(pr.lock));

  // rollback then prune: keep 2 never removes current or the protected one; a third release makes the oldest go
  await local.rollback(conn, L, ts1, t2, manifest, o);
  assert.equal((await local.listReleases(conn, L)).current, ts1);
  assert.deepEqual(await local.prune(conn, L, 2, [ts2], o), []);
  const ts3 = '20260101000200';
  const tgz3 = await makeArtifact(base, { 'public/index.html': '<h1>v3</h1>' });
  await local.extractTgz(conn, L, ts3, tgz3, o); await local.linkShared(conn, L, ts3, manifest, o);
  await local.activate(conn, L, ts3, target, manifest, o);
  assert.deepEqual(await local.prune(conn, L, 2, [ts1], o), [ts2]);
  assert.ok(!fs.existsSync(L.release(ts2)));
  assert.equal(await fsp.readFile(path.join(L.shared, 'storage', 'logs', 'new.log'), 'utf8'), 'x', 'pruning a release never deletes shared content through its links');
  assert.equal(await fsp.readFile(path.join(L.shared, '.env'), 'utf8'), 'APP_KEY=edited');

  await local.discardRelease(conn, L, ts1);
  assert.ok(!fs.existsSync(L.release(ts1)) && fs.existsSync(path.join(L.shared, 'storage', 'logs', 'new.log')));
  await local.unlock(conn, L);
  assert.ok(!fs.existsSync(L.lock));
  await assert.rejects(local.switchCurrent(conn, L, '20991231235959'), /does not exist/);
  assert.throws(() => L.release('../x'), /invalid release name/);
  conn.close();
  await fsp.rm(base, { recursive: true, force: true });
});
