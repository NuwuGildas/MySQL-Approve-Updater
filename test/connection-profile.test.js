'use strict';
/* What happens to a server's credential when its profile is edited.
 *
 * The password, the key and the passphrase are never sent to the browser, so an edit form cannot
 * show one and cannot send one back. A blank field means UNCHANGED. Read literally it means
 * "clear it", and then renaming a server strips the key it is reached with - and the save is
 * refused for having no way to authenticate, which is how the whole thing announces itself.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProfileSanitizer } = require('../lib/shared/connection-profile');

const httpError = (status, message) => Object.assign(new Error(message), { status });
const APP_KEY = '/keys/server-tools.key';
const sanitizeProfile = createProfileSanitizer({
  httpError,
  ensureAppKey: () => ({ privateKeyPath: APP_KEY }),
  storePastedKey: (id) => `/keys/${id}.key`,
});

const SERVER = { name: 'web-01', sshOnly: true, db: {}, ssh: { enabled: true, host: '10.0.0.1', port: 22, user: 'deploy' } };
const withAuth = (over) => sanitizeProfile({ ...SERVER, ssh: { ...SERVER.ssh, ...over } });
/** An edit that changes the name and sends no credential, which is what the form does. */
const rename = (existing, over = {}) => sanitizeProfile(
  { ...SERVER, name: 'renamed', id: existing.id, ssh: { ...SERVER.ssh, auth: existing.ssh.authKind, ...over } },
  existing,
);

test('a server can be created with each of the three ways in', () => {
  const key = withAuth({ auth: 'own-key', privateKeyInline: '-----BEGIN OPENSSH PRIVATE KEY-----' });
  assert.equal(key.ssh.authKind, 'own-key');
  assert.match(key.ssh.privateKeyPath, /\.key$/);
  assert.equal(key.ssh.password, '', 'a key server keeps no password');

  const password = withAuth({ auth: 'password', password: 's3cret' });
  assert.equal(password.ssh.authKind, 'password');
  assert.equal(password.ssh.password, 's3cret');
  assert.equal(password.ssh.privateKeyPath, '', 'a password server keeps no key');

  const app = withAuth({ auth: 'app-key' });
  assert.equal(app.ssh.authKind, 'app-key');
  assert.equal(app.ssh.privateKeyPath, APP_KEY);
});

test('renaming a server does not take away the credential it is reached with', () => {
  for (const existing of [
    withAuth({ auth: 'own-key', privateKeyInline: '-----BEGIN-----' }),
    withAuth({ auth: 'password', password: 's3cret' }),
    withAuth({ auth: 'app-key' }),
  ]) {
    const edited = rename(existing);
    assert.equal(edited.name, 'renamed');
    assert.equal(edited.id, existing.id, 'the same server, not a new one');
    assert.equal(edited.ssh.authKind, existing.ssh.authKind, existing.ssh.authKind);
    assert.equal(edited.ssh.privateKeyPath, existing.ssh.privateKeyPath, `key lost on a ${existing.ssh.authKind} server`);
    assert.equal(edited.ssh.password, existing.ssh.password, `password lost on a ${existing.ssh.authKind} server`);
  }
});

test('where the server is can be changed without touching how we get into it', () => {
  const existing = withAuth({ auth: 'own-key', privateKeyInline: '-----BEGIN-----' });
  const moved = sanitizeProfile(
    { ...SERVER, id: existing.id, ssh: { ...SERVER.ssh, host: '10.0.0.9', port: 2222, user: 'root', auth: 'own-key' } },
    existing,
  );
  assert.equal(moved.ssh.host, '10.0.0.9');
  assert.equal(moved.ssh.port, 2222);
  assert.equal(moved.ssh.user, 'root');
  assert.equal(moved.ssh.privateKeyPath, existing.ssh.privateKeyPath);
});

test('a new credential replaces the old one', () => {
  const existing = withAuth({ auth: 'password', password: 'old' });
  assert.equal(rename(existing, { password: 'rotated' }).ssh.password, 'rotated');

  const keyed = withAuth({ auth: 'own-key', privateKeyInline: 'first' });
  const rekeyed = rename(keyed, { privateKeyInline: 'second' });
  assert.equal(rekeyed.ssh.authKind, 'own-key');
  assert.match(rekeyed.ssh.privateKeyPath, /\.key$/);
});

test('choosing a different way in puts the old one away', () => {
  const keyed = withAuth({ auth: 'own-key', privateKeyInline: '-----BEGIN-----' });
  const toPassword = sanitizeProfile({ ...SERVER, id: keyed.id, ssh: { ...SERVER.ssh, auth: 'password', password: 'now-a-password' } }, keyed);
  assert.equal(toPassword.ssh.authKind, 'password');
  assert.equal(toPassword.ssh.privateKeyPath, '', 'the key is not left lying around');
  assert.equal(toPassword.ssh.password, 'now-a-password');

  const passworded = withAuth({ auth: 'password', password: 's3cret' });
  const toAppKey = sanitizeProfile({ ...SERVER, id: passworded.id, ssh: { ...SERVER.ssh, auth: 'app-key' } }, passworded);
  assert.equal(toAppKey.ssh.authKind, 'app-key');
  assert.equal(toAppKey.ssh.privateKeyPath, APP_KEY);
  assert.equal(toAppKey.ssh.password, '', 'and neither is the password');

  const toOwnKey = sanitizeProfile({ ...SERVER, id: passworded.id, ssh: { ...SERVER.ssh, auth: 'own-key', privateKeyInline: 'mine' } }, passworded);
  assert.equal(toOwnKey.ssh.authKind, 'own-key');
  assert.equal(toOwnKey.ssh.password, '', 'a password the user thinks they replaced is not kept');
});

test('a server with no way in at all is refused, on create and on edit', () => {
  assert.throws(() => withAuth({}), /Choose how to authenticate/);
  const passworded = withAuth({ auth: 'password', password: 's3cret' });
  // switching to "my own key" and giving none: there is now no way in, and saying so is the point
  assert.throws(
    () => sanitizeProfile({ ...SERVER, id: passworded.id, ssh: { ...SERVER.ssh, auth: 'password', password: '', privateKeyPath: '' } }, { ...passworded, ssh: { ...passworded.ssh, password: '' } }),
    /Choose how to authenticate/,
  );
});

test('the rest of the validation still holds', () => {
  assert.throws(() => sanitizeProfile({ ...SERVER, name: '' }), /name is required/);
  assert.throws(() => sanitizeProfile({ ...SERVER, ssh: { ...SERVER.ssh, host: '', auth: 'app-key' } }), /SSH host is empty/);
  assert.throws(() => sanitizeProfile({ name: 'db', db: { database: '', user: 'u' } }), /Database name is required/);
  assert.throws(() => sanitizeProfile({ name: 'db', db: { database: 'shop', user: '' } }), /Database user is required/);
  // a database profile is still a database profile
  const db = sanitizeProfile({ name: 'shop', db: { database: 'shop', user: 'root', password: 'p' } });
  assert.equal(db.sshOnly, false);
  assert.equal(db.db.port, 3306, 'and gets the usual defaults');
});

test('a database password is kept across an edit too', () => {
  const db = sanitizeProfile({ name: 'shop', db: { database: 'shop', user: 'root', password: 'p' } });
  const renamed = sanitizeProfile({ name: 'shop (staging)', id: db.id, db: { database: 'shop', user: 'root' } }, db);
  assert.equal(renamed.db.password, 'p');
});
