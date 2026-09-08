'use strict';
/* SSH key helpers: generate an ed25519 pair for a new server (private key
   saved 0600 under DATA_DIR/deploy-keys) or read an existing .pub. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { utils } = require('ssh2');

function fingerprintMd5(publicKey) {
  const b64 = String(publicKey).trim().split(/\s+/)[1] || '';
  const hex = crypto.createHash('md5').update(Buffer.from(b64, 'base64')).digest('hex');
  return hex.match(/../g).join(':');
}

/** @returns {{privateKeyPath, publicKey}} */
function generateKeyPair(dataDir, name) {
  const dir = path.join(dataDir, 'deploy-keys');
  fs.mkdirSync(dir, { recursive: true });
  const pair = utils.generateKeyPairSync('ed25519', { comment: `ascension-${name}` });
  const safe = String(name).replace(/[^A-Za-z0-9_.-]+/g, '-');
  const privateKeyPath = path.join(dir, `${safe}-${Date.now()}.key`);
  fs.writeFileSync(privateKeyPath, pair.private, { mode: 0o600 });
  fs.writeFileSync(privateKeyPath + '.pub', pair.public + '\n', { mode: 0o644 });
  return { privateKeyPath, publicKey: pair.public.trim() };
}

/** Read the public key next to a private key (or a given .pub path). */
function readPublicKey(privateKeyPath) {
  const candidates = [privateKeyPath + '.pub', privateKeyPath.replace(/\.key$/, '.pub')];
  for (const c of candidates) if (fs.existsSync(c)) return fs.readFileSync(c, 'utf8').trim();
  // derive from the private key when no .pub is around
  const parsed = utils.parseKey(fs.readFileSync(privateKeyPath));
  if (parsed instanceof Error) throw Object.assign(new Error(`cannot read ${privateKeyPath}: ${parsed.message}`), { status: 400 });
  const k = Array.isArray(parsed) ? parsed[0] : parsed;
  return `${k.type} ${k.getPublicSSH().toString('base64')}`;
}

module.exports = { fingerprintMd5, generateKeyPair, readPublicKey };
