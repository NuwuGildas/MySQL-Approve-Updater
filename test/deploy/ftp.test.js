'use strict';
/* In-process FTP server (ftp-srv) exercising the FTP transport and the
   shared-hosting in-place strategy: swap, listing, prune, rollback. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FtpSrv } = require('ftp-srv');
const { createFtpConn } = require('../../backend/deploy/transports/ftp');
const shared = require('../../backend/deploy/targets/shared-hosting');

const PORT = 21210 + Math.floor(Math.random() * 200);
let root, server;

test.before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-ftp-test-'));
  fs.mkdirSync(path.join(root, 'public_html'));
  fs.writeFileSync(path.join(root, 'public_html', 'index.html'), 'old');
  fs.writeFileSync(path.join(root, 'public_html', 'stale.txt'), 'remove me');
  server = new FtpSrv({ url: `ftp://127.0.0.1:${PORT}`, pasv_url: '127.0.0.1', pasv_min: 31000, pasv_max: 31100, anonymous: false, log: require('bunyan').createLogger({ name: 'ftp-test', level: 100 }) });
  server.on('login', ({ username, password }, resolve, reject) => (username === 'u' && password === 'p' ? resolve({ root }) : reject(new Error('bad'))));
  server.on('client-error', () => {});
  await server.listen();
});
test.after(async () => { await server.close(); });

const target = { name: 't', type: 'shared-hosting', transport: { kind: 'ftp', host: '127.0.0.1', port: PORT, user: 'u', passwordRef: '${vault:X}', secure: false }, paths: { home: '/', docroot: '/public_html' }, docrootStrategy: 'in-place', keepReleases: 2 };
const cfg = () => ({ kind: 'ftp', host: '127.0.0.1', port: PORT, user: 'u', password: 'p', secure: false });

function stage(content) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'st-stage-'));
  fs.mkdirSync(path.join(d, 'assets'));
  fs.writeFileSync(path.join(d, 'index.html'), content);
  fs.writeFileSync(path.join(d, 'assets', 'app.js'), 'console.log(1)');
  return d;
}

test('ftp transport basics', async () => {
  const conn = await createFtpConn(cfg());
  try {
    assert.equal(conn.canExec, false);
    assert.throws(() => conn.exec('ls'), /cannot run remote commands/);
    assert.equal(await conn.readFile('/public_html/index.html'), 'old');
    assert.equal(await conn.readFile('/nope.txt'), null);
    assert.ok(await conn.exists('/public_html'));
    assert.ok(!(await conn.exists('/public_html-x')));
    await conn.writeFile('/note.txt', 'hi'); assert.equal(await conn.readFile('/note.txt'), 'hi');
    const l = await conn.list('/'); assert.ok(l.some((e) => e.name === 'public_html' && e.type === 'dir'));
    await conn.removeTree('/note.txt'); assert.ok(!(await conn.exists('/note.txt')));
  } finally { conn.close(); }
});

test('in-place swap → list → second ship prunes → rollback restores', async () => {
  const conn = await createFtpConn(cfg());
  try {
    const lines = [];
    assert.equal(await shared.canSwap(conn, target), true);
    const r1 = await shared.shipInPlace(conn, target, '20260907100000', stage('v1'), { onLine: (l) => lines.push(l), swap: true });
    assert.equal(r1.mode, 'swap');
    assert.equal(fs.readFileSync(path.join(root, 'public_html', 'index.html'), 'utf8'), 'v1');
    assert.equal(fs.readFileSync(path.join(root, 'public_html', 'assets', 'app.js'), 'utf8'), 'console.log(1)');
    assert.ok(fs.existsSync(r1.previous.replace(/^\//, root + '/')), 'old copy kept: ' + r1.previous);
    assert.equal(fs.readFileSync(path.join(root, path.basename(r1.previous), 'index.html'), 'utf8'), 'old');
    let list = await shared.listInPlace(conn, target);
    assert.equal(list.current, '20260907100000');
    assert.equal(list.releases.filter((r) => !r.current).length, 1);
    assert.ok(list.releases.every((r) => !r.path.startsWith('//')), 'no double slashes');
    // second ship: the swapped-out copy must be named after ITS release (100000), not the new one
    const r2 = await shared.shipInPlace(conn, target, '20260907110000', stage('v2'), { swap: true });
    assert.equal(r2.previous, '/public_html-old-20260907100000');
    assert.equal(fs.readFileSync(path.join(root, 'public_html', 'index.html'), 'utf8'), 'v2');
    list = await shared.listInPlace(conn, target);
    assert.deepEqual(list.releases.map((r) => r.ts + (r.current ? '*' : '')), ['20260907095959', '20260907100000', '20260907110000*']);
    // prune to keepReleases=2 → one old copy remains (the newest old)
    const removed = await shared.pruneInPlace(conn, target, 2, {});
    assert.equal(removed.length, 1);
    list = await shared.listInPlace(conn, target);
    assert.deepEqual(list.releases.map((r) => r.ts).sort(), ['20260907100000', '20260907110000']);
    // rollback to v1
    await shared.rollbackInPlace(conn, target, '/public_html-old-20260907100000', {});
    assert.equal(fs.readFileSync(path.join(root, 'public_html', 'index.html'), 'utf8'), 'v1');
    list = await shared.listInPlace(conn, target);
    assert.equal(list.current, '20260907100000');
    assert.ok(!fs.existsSync(path.join(root, 'public_html-failed-20260907100000')), 'failed copy removed');
  } finally { conn.close(); }
});

test('overwrite mode keeps the site up behind a maintenance page and removes stale files', async () => {
  const conn = await createFtpConn(cfg());
  try {
    // simulate: a previous in-place manifest listing a file that the new build no longer has
    await conn.writeFile('/public_html/.ship-manifest.json', JSON.stringify({ ts: '20260907110000', files: ['index.html', 'gone.txt'] }));
    await conn.writeFile('/public_html/gone.txt', 'x');
    await conn.writeFile('/public_html/.htaccess', '# user rules\nRewriteEngine On');
    const r = await shared.shipInPlace(conn, target, '20260907120000', stage('v3'), { swap: false, warn: () => {} });
    assert.equal(r.mode, 'overwrite');
    assert.equal(fs.readFileSync(path.join(root, 'public_html', 'index.html'), 'utf8'), 'v3');
    assert.ok(!fs.existsSync(path.join(root, 'public_html', 'gone.txt')), 'stale file removed');
    assert.ok(!fs.existsSync(path.join(root, 'public_html', '.st-maintenance.html')), 'maintenance page removed');
    assert.equal(fs.readFileSync(path.join(root, 'public_html', '.htaccess'), 'utf8'), '# user rules\nRewriteEngine On', 'user .htaccess restored');
    const m = JSON.parse(fs.readFileSync(path.join(root, 'public_html', '.ship-manifest.json'), 'utf8'));
    assert.equal(m.ts, '20260907120000');
    assert.ok(m.files.includes('assets/app.js'));
  } finally { conn.close(); }
});

test('overwrite mode leaves shared storage inside the docroot alone', async () => {
  const conn = await createFtpConn(cfg());
  try {
    /* What a WordPress media library looks like on FTP-only hosting: uploads live inside the
       docroot, are excluded from the artifact, and were never in a ship manifest. Shipping over
       the tree must not touch them - and swapping the docroot for a fresh one would strand them. */
    await conn.mkdirp('/public_html/wp-content/uploads/2026/09');
    await conn.writeFile('/public_html/wp-content/uploads/2026/09/photo.jpg', 'binary-ish');
    await conn.writeFile('/public_html/.ship-manifest.json', JSON.stringify({ ts: '20260907120000', files: ['index.html'] }));

    await shared.shipInPlace(conn, target, '20260907130000', stage('v4'), { swap: false, warn: () => {} });
    const photo = path.join(root, 'public_html', 'wp-content', 'uploads', '2026', '09', 'photo.jpg');
    assert.ok(fs.existsSync(photo), 'the media library survived the deploy');
    assert.equal(fs.readFileSync(photo, 'utf8'), 'binary-ish');
    assert.equal(fs.readFileSync(path.join(root, 'public_html', 'index.html'), 'utf8'), 'v4', 'and the code was still updated');
  } finally { conn.close(); }
});

test('a swap would strand that same shared storage, which is why the pipeline avoids it', async () => {
  const conn = await createFtpConn(cfg());
  try {
    await conn.mkdirp('/public_html/wp-content/uploads');
    await conn.writeFile('/public_html/wp-content/uploads/keep.jpg', 'x');
    const r = await shared.shipInPlace(conn, target, '20260907140000', stage('v5'), { swap: true });
    assert.equal(r.mode, 'swap');
    assert.ok(!fs.existsSync(path.join(root, 'public_html', 'wp-content', 'uploads', 'keep.jpg')),
      'the live docroot no longer has the uploads: exactly the outcome the manifest.shared check prevents');
    assert.ok(fs.existsSync(path.join(root, path.basename(r.previous), 'wp-content', 'uploads', 'keep.jpg')),
      'they are in the swapped-out copy, but the site cannot see them');
  } finally { conn.close(); }
});
