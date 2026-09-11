'use strict';
/* Publisher signing keys.
 *
 *   node scripts/module-keys.js init [--publisher server-tools] [--key-id st-1]
 *
 * Writes the PRIVATE key to keys/<keyId>.private.pem (git-ignored, never
 * distributed) and adds the PUBLIC half to config/trusted-publishers.json,
 * which ships with the base application and is the only trust anchor the
 * installer consults. */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const TRUST_FILE = path.join(ROOT, 'config', 'trusted-publishers.json');
const KEY_DIR = path.join(ROOT, 'keys');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] : fallback;
}

function init() {
  const publisherId = arg('publisher', 'server-tools');
  const publisherName = arg('name', 'Server Tools');
  const keyId = arg('key-id', `${publisherId}-${new Date().getFullYear()}`);

  fs.mkdirSync(KEY_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(TRUST_FILE), { recursive: true });
  const privatePath = path.join(KEY_DIR, `${keyId}.private.pem`);
  if (fs.existsSync(privatePath)) {
    console.error(`${privatePath} already exists; delete it deliberately before generating a new key.`);
    process.exit(1);
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

  let trust = { version: 1, publishers: [] };
  try { trust = JSON.parse(fs.readFileSync(TRUST_FILE, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let publisher = trust.publishers.find((p) => p.id === publisherId);
  if (!publisher) { publisher = { id: publisherId, name: publisherName, keys: [] }; trust.publishers.push(publisher); }
  publisher.name = publisherName;
  publisher.keys = publisher.keys.filter((k) => k.keyId !== keyId);
  publisher.keys.push({ keyId, algorithm: 'ed25519', publicKey: spki, addedAt: new Date().toISOString() });
  fs.writeFileSync(TRUST_FILE, JSON.stringify(trust, null, 2) + '\n');

  console.log(`private key : ${privatePath}  (keep this out of the repository)`);
  console.log(`trust anchor: ${TRUST_FILE}  (ships with the base application)`);
  console.log(`key id      : ${keyId}`);
}

if (process.argv[2] === 'init') init();
else { console.log('usage: node scripts/module-keys.js init [--publisher id] [--name "Name"] [--key-id id]'); process.exit(1); }
