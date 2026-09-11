'use strict';
/* Integrity and authenticity, in that order, before a single byte of a package
   is executed.
 *
 * The trust anchor is trusted-publishers.json, which ships WITH the base
 * application and is never fetched. The catalog may say who published a version
 * and hand over a signature, but only a key already in the local trust store can
 * make that signature verify. A digest that travels next to the archive proves
 * nothing, so the digest used here is always the one from catalog metadata.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const fail = (message, code) => { throw Object.assign(new Error(message), { status: 400, code }); };

/** The canonical bytes a publisher signs: identity + version + archive digest. */
const signedPayload = (moduleId, version, sha256) => Buffer.from(`server-tools-module\n${moduleId}\n${version}\n${sha256}\n`, 'utf8');

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (c) => hash.update(c)).on('end', () => resolve(hash.digest('hex')));
  });
}

/** Load the trust store. A missing file means "trust nobody", not "trust anybody". */
function loadTrustStore(...files) {
  const publishers = new Map();
  for (const file of files.filter(Boolean)) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw new Error(`${path.basename(file)} is not readable: ${error.message}`); }
    for (const publisher of raw.publishers || []) {
      const entry = publishers.get(publisher.id) || { id: publisher.id, name: publisher.name || publisher.id, keys: new Map() };
      entry.name = publisher.name || entry.name;
      for (const key of publisher.keys || []) {
        if (key.algorithm && key.algorithm !== 'ed25519') continue;
        entry.keys.set(key.keyId, key.publicKey);
      }
      publishers.set(publisher.id, entry);
    }
  }
  return publishers;
}

function createVerifier({ trustFiles = [], requireSignature = true } = {}) {
  const publishers = loadTrustStore(...trustFiles);

  function keyFor(keyId) {
    for (const publisher of publishers.values()) {
      const material = publisher.keys.get(keyId);
      if (material) return { publisher, material };
    }
    return null;
  }

  return {
    publishers: () => [...publishers.values()].map((p) => ({ id: p.id, name: p.name, keyIds: [...p.keys.keys()] })),
    trusts: (keyId) => !!keyFor(keyId),

    /**
     * @param file       downloaded archive
     * @param reference  the catalog's package reference (digest, signature, keyId)
     */
    async verifyPackage(file, reference, { moduleId, version }) {
      const digest = await sha256File(file);
      if (digest !== reference.sha256) fail('The downloaded package does not match the digest in the module catalog.', 'digest_mismatch');
      if (!reference.signature || !reference.keyId) {
        if (requireSignature) fail('This package is not signed by a publisher this application trusts.', 'unsigned_package');
        return { digest, publisher: null, signed: false };
      }
      const found = keyFor(reference.keyId);
      if (!found) fail(`The package is signed with an unknown key (${reference.keyId}). Only trusted publishers can be installed.`, 'untrusted_publisher');
      let ok = false;
      try {
        const key = crypto.createPublicKey({ key: Buffer.from(found.material, 'base64'), format: 'der', type: 'spki' });
        ok = crypto.verify(null, signedPayload(moduleId, version, digest), key, Buffer.from(reference.signature, 'base64'));
      } catch (error) { fail(`The package signature could not be checked: ${error.message}`, 'signature_unreadable'); }
      if (!ok) fail('The package signature is not valid for this module and version.', 'signature_invalid');
      return { digest, publisher: { id: found.publisher.id, name: found.publisher.name }, signed: true };
    },
  };
}

module.exports = { createVerifier, sha256File, signedPayload, loadTrustStore };
