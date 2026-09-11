'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const shell = require('../../backend/deploy/shell');
const layout = require('../../backend/deploy/targets/layout');
const { createVault, isRef, refName } = require('../../backend/deploy/vault');
const { createRedactor } = require('../../backend/deploy/redact');
const { localExec, capture } = require('../../backend/deploy/exec');

test('shell.q quotes only when needed', () => {
  assert.equal(shell.q('plain/path-1.0'), 'plain/path-1.0');
  assert.equal(shell.q('a b'), "'a b'");
  assert.equal(shell.q("it's"), "'it'\\''s'");
  assert.equal(shell.q('$HOME'), "'$HOME'");
  assert.equal(shell.q(''), "''");
});

test('shell.script builds a fail-fast script', () => {
  const s = shell.script({ cwd: '/var/www/app/releases/20260907120000', env: { APP_ENV: 'production', 'bad-key': 'x' }, cmds: ['composer install', '', 'php artisan migrate --force'] });
  assert.equal(s, 'set -e; export APP_ENV=production; cd /var/www/app/releases/20260907120000; composer install; php artisan migrate --force');
});

test('layout.assertSafeRoot matrix', () => {
  assert.equal(layout.assertSafeRoot('/var/www/app/'), '/var/www/app');
  assert.equal(layout.assertSafeRoot('/home/deploy/apps/shop'), '/home/deploy/apps/shop');
  for (const bad of ['/', '/var/www', '/home', '/etc', 'relative/path', '/var/www/../etc', '/opt', '/tmp', 'C:\\x\\y', '']) {
    assert.throws(() => layout.assertSafeRoot(bad), layout.LayoutError, `should reject ${JSON.stringify(bad)}`);
  }
});

test('layout release names and paths', () => {
  const l = layout.layout('/var/www/app');
  assert.equal(l.release('20260907120000'), '/var/www/app/releases/20260907120000');
  assert.throws(() => l.release('../../etc'), layout.LayoutError);
  assert.throws(() => l.release('2026'), layout.LayoutError);
  assert.match(layout.newReleaseName(new Date('2026-09-07T14:12:33Z')), /^20260907141233$/);
  assert.equal(layout.assertInside('/home/acme', '/home/acme/public_html'), '/home/acme/public_html');
  assert.throws(() => layout.assertInside('/home/acme', '/home/acme2/public_html'), layout.LayoutError);
  assert.throws(() => layout.assertInside('/home/acme', '/home/acme'), layout.LayoutError);
});

test('vault roundtrip, key sources, tamper detection, names', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-vault-'));
  const envKey = Buffer.alloc(32, 7).toString('hex');
  const v = createVault(dir, { DEPLOY_MASTER_KEY: envKey });
  assert.equal(v.keySource, 'env');
  v.set('GH_TOKEN', 'ghp_abcdefghijklmnopqrstuvwxyz0123');
  v.set('FTP_PASS', 'p#ss w0rd');
  assert.equal(v.get('FTP_PASS'), 'p#ss w0rd');
  assert.deepEqual(v.names().map((n) => n.name), ['FTP_PASS', 'GH_TOKEN']);
  assert.ok(!JSON.stringify(v.names()).includes('p#ss'));
  assert.throws(() => v.set('lower', 'x'), /UPPER_SNAKE_CASE/);
  assert.throws(() => v.get('NOPE'), /Unknown secret/);
  assert.equal(v.resolveRef('${vault:FTP_PASS}'), 'p#ss w0rd');
  assert.equal(v.resolveRef('literal'), 'literal');
  assert.ok(isRef('${vault:A_B}')); assert.equal(refName('${vault:A_B}'), 'A_B'); assert.ok(!isRef('x${vault:A}'));
  // reopen with the same key
  const v2 = createVault(dir, { DEPLOY_MASTER_KEY: envKey });
  assert.equal(v2.get('GH_TOKEN'), 'ghp_abcdefghijklmnopqrstuvwxyz0123');
  // wrong key
  const v3 = createVault(dir, { DEPLOY_MASTER_KEY: Buffer.alloc(32, 9).toString('hex') });
  assert.throws(() => v3.names(), /wrong master key|tampered/);
  // tamper one ciphertext byte
  const buf = fs.readFileSync(v.file); buf[buf.length - 1] ^= 0xff; fs.writeFileSync(v.file, buf);
  assert.throws(() => v2.names(), /wrong master key|tampered/);
  // generated key file when no env key
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'st-vault2-'));
  const g = createVault(dir2, {});
  assert.equal(g.keySource, 'none');
  g.set('X', 'y-value');
  assert.equal(g.keySource, 'file');
  assert.ok(fs.existsSync(g.keyFile));
  assert.equal(createVault(dir2, {}).get('X'), 'y-value');
  assert.equal(g.remove('X'), true); assert.equal(g.remove('X'), false);
});

test('redactor masks vault values and generic token shapes', () => {
  const redact = createRedactor(() => ['s3cr3t-value', 'p#ss w0rd']);
  assert.equal(redact('token is s3cr3t-value here'), 'token is *** here');
  assert.equal(redact('pw=p#ss w0rd;'), 'pw=***;');
  assert.equal(redact('https://x-access-token:ghp_abc@github.com/a/b.git'), 'https://***@github.com/a/b.git');
  assert.equal(redact('using ghp_abcdefghijklmnopqrstuvwxyz0123 now'), 'using gh*_*** now');
  assert.equal(redact('DB_PASSWORD=supersecret'), 'DB_PASSWORD=***');
  assert.equal(redact('plain line'), 'plain line');
});

test('exec.localExec streams lines and reports failures', async () => {
  const lines = [];
  const r = await localExec(process.platform === 'win32' ? 'echo hello&& echo world' : 'echo hello && echo world', { onLine: (l) => lines.push(l) });
  assert.equal(r.code, 0);
  assert.deepEqual(lines.map((l) => l.trim()), ['hello', 'world']);
  await assert.rejects(localExec('exit 3'), (e) => e.name === 'ExecError' && e.code === 3);
  assert.equal(await capture('echo captured'), 'captured');
  const ac = new AbortController();
  const p = localExec(process.platform === 'win32' ? 'ping -n 10 127.0.0.1 >nul' : 'sleep 10', { signal: ac.signal });
  setTimeout(() => ac.abort(), 200);
  await assert.rejects(p, /cancelled/);
});
