'use strict';
/* Turning what a form submitted into a stored connection profile.
 *
 * The part worth reading twice is what happens to the credential. It is never sent to the browser -
 * not the password, not the key, not the passphrase - so an edit form cannot show one and cannot
 * send one back. A blank field therefore means UNCHANGED, and only an explicit choice replaces or
 * clears it. Get that wrong and renaming a server silently strips the key it is reached with, and
 * the save is then refused for having no way to authenticate.
 *
 * Extracted from server.js so those rules can be tested directly: this is the code that decides
 * whether someone's SSH key survives a rename.
 */

const crypto = require('node:crypto');

/**
 * @param {object} deps
 * @param {(status: number, message: string) => Error} deps.httpError
 * @param {() => {privateKeyPath: string}} deps.ensureAppKey       the app's own key pair
 * @param {(id: string, pem: string, passphrase: string) => string} deps.storePastedKey
 */
function createProfileSanitizer({ httpError, ensureAppKey, storePastedKey }) {
  /**
   * @param {object} body what was submitted
   * @param {object} [existing] the profile being edited, if any
   */
  return function sanitizeProfile(body, existing) {
    const name = String(body.name || '').trim();
    if (!name) throw httpError(400, 'Connection name is required');
    const db = body.db || {};
    const database = String(db.database || '').trim();
    const user = String(db.user || '').trim();
    const sshIn = body.ssh || {};
    // A profile is either a DB connection (needs database + user) or an SSH-only server (ssh enabled
    // + host). sshOnly profiles can't drive the database side but appear in the SSH servers view.
    const sshOnly = !!body.sshOnly || (!database && !user && sshIn.enabled);
    if (!sshOnly) {
      if (!database) throw httpError(400, 'Database name is required');
      if (!user) throw httpError(400, 'Database user is required');
    }
    const num = (v, dflt) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : dflt);
    const profile = {
      id: existing?.id || crypto.randomUUID(),
      name,
      sshOnly,
      db: {
        host: String(db.host || '127.0.0.1').trim() || '127.0.0.1',
        port: num(db.port, 3306),
        user,
        password: db.password ? String(db.password) : (existing?.db?.password || ''),
        database,
      },
      ssh: {
        enabled: !!sshIn.enabled,
        host: String(sshIn.host || '').trim(),
        port: num(sshIn.port, 22),
        user: String(sshIn.user || '').trim(),
        // blank means unchanged, for all three of these
        password: sshIn.password ? String(sshIn.password) : (existing?.ssh?.password || ''),
        privateKeyPath: String(sshIn.privateKeyPath || '').trim() || (existing?.ssh?.privateKeyPath || ''),
        passphrase: sshIn.passphrase ? String(sshIn.passphrase) : (existing?.ssh?.passphrase || ''),
      },
    };
    /* The authentication choice is the one thing that DOES clear a credential, because picking it is
       deliberate: choosing a password puts the key away, choosing a key puts the password away. */
    const auth = String(sshIn.auth || '').trim();
    if (auth === 'app-key') { profile.ssh.privateKeyPath = ensureAppKey().privateKeyPath; profile.ssh.password = ''; profile.ssh.authKind = 'app-key'; }
    else if (sshIn.privateKeyInline) { profile.ssh.privateKeyPath = storePastedKey(profile.id, sshIn.privateKeyInline, profile.ssh.passphrase); profile.ssh.password = ''; profile.ssh.authKind = 'own-key'; }
    else if (auth === 'password') { profile.ssh.privateKeyPath = ''; profile.ssh.passphrase = ''; profile.ssh.authKind = 'password'; }
    else profile.ssh.authKind = existing?.ssh?.authKind || (profile.ssh.privateKeyPath ? 'own-key' : profile.ssh.password ? 'password' : '');
    /* Switching TO a key on a server that had a password: the password is no longer how we get in,
       and leaving it behind would quietly keep a credential the user thinks they replaced. */
    if (auth === 'own-key' && profile.ssh.privateKeyPath) profile.ssh.password = '';
    if (profile.ssh.enabled && !profile.ssh.host) throw httpError(400, 'SSH is enabled but the SSH host is empty');
    if (sshOnly && !profile.ssh.enabled) throw httpError(400, 'An SSH server needs SSH enabled with a host');
    if (sshOnly && !profile.ssh.privateKeyPath && !profile.ssh.password) throw httpError(400, 'Choose how to authenticate: the Server Tools key, your own key, or a password');
    return profile;
  };
}

module.exports = { createProfileSanitizer };
