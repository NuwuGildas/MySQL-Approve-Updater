'use strict';
/* Encrypted secret store: deploy-secrets.enc in DATA_DIR.
   Layout: "STV1" | 12-byte IV | 16-byte GCM tag | AES-256-GCM ciphertext of
   JSON {entries:{NAME:{value,updatedAt}}}. Whole-file encryption, fresh IV
   on every write, atomic replace.
   Key: DEPLOY_MASTER_KEY (hex or base64, 32 bytes) from the process env /
   .env; otherwise a generated deploy-master.key (0600) next to the data. */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAGIC = Buffer.from('STV1');
const NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

class VaultError extends Error { constructor(m, status = 400) { super(m); this.name = 'VaultError'; this.status = status; } }

function parseKey(s) {
  const str = String(s).trim();
  if (/^[0-9a-fA-F]{64}$/.test(str)) return Buffer.from(str, 'hex');
  const b = Buffer.from(str, 'base64');
  if (b.length === 32) return b;
  throw new VaultError('DEPLOY_MASTER_KEY must be 32 bytes as 64 hex chars or base64', 500);
}

function createVault(DATA_DIR, env = process.env) {
  const file = path.join(DATA_DIR, 'deploy-secrets.enc');
  const keyFile = path.join(DATA_DIR, 'deploy-master.key');
  let key, keySource;
  if (env.DEPLOY_MASTER_KEY) { key = parseKey(env.DEPLOY_MASTER_KEY); keySource = 'env'; }
  else if (fs.existsSync(keyFile)) { key = parseKey(fs.readFileSync(keyFile, 'utf8')); keySource = 'file'; }
  else { keySource = 'none'; } // generated lazily on first write so an unused module leaves no key file

  function ensureKey() {
    if (key) return key;
    key = crypto.randomBytes(32);
    fs.writeFileSync(keyFile, key.toString('hex') + '\n', { mode: 0o600 });
    keySource = 'file';
    return key;
  }

  function load() {
    if (!fs.existsSync(file)) return { entries: {} };
    if (!key) throw new VaultError('deploy-secrets.enc exists but no master key is available (set DEPLOY_MASTER_KEY or restore deploy-master.key)', 500);
    const buf = fs.readFileSync(file);
    if (buf.length < 4 + 12 + 16 || !buf.subarray(0, 4).equals(MAGIC)) throw new VaultError('deploy-secrets.enc is not a valid vault file', 500);
    const iv = buf.subarray(4, 16), tag = buf.subarray(16, 32), data = buf.subarray(32);
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    let plain;
    try { plain = Buffer.concat([d.update(data), d.final()]); }
    catch { throw new VaultError('vault decryption failed: wrong master key or tampered file', 500); }
    const j = JSON.parse(plain.toString('utf8'));
    return j && j.entries ? j : { entries: {} };
  }

  function persist(state) {
    const k = ensureKey();
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', k, iv);
    const data = Buffer.concat([c.update(JSON.stringify(state), 'utf8'), c.final()]);
    const out = Buffer.concat([MAGIC, iv, c.getAuthTag(), data]);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, out, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  function assertName(name) {
    if (!NAME_RE.test(String(name))) throw new VaultError('secret names must be UPPER_SNAKE_CASE (A-Z, 0-9, _), max 64 chars');
    return String(name);
  }

  return {
    file, keyFile,
    get keySource() { return keySource; },
    names() { return Object.entries(load().entries).map(([name, e]) => ({ name, updatedAt: e.updatedAt })).sort((a, b) => a.name.localeCompare(b.name)); },
    has(name) { return Object.prototype.hasOwnProperty.call(load().entries, String(name)); },
    get(name) {
      const e = load().entries[String(name)];
      if (!e) throw new VaultError(`Unknown secret "${name}"add it in Deploy → Secrets`);
      return e.value;
    },
    set(name, value) {
      const n = assertName(name);
      if (typeof value !== 'string' || !value.length) throw new VaultError('secret value must be a non-empty string');
      if (value.length > 65536) throw new VaultError('secret value too large (max 64 KB)');
      const st = load();
      st.entries[n] = { value, updatedAt: new Date().toISOString() };
      persist(st);
    },
    remove(name) {
      const st = load();
      if (!st.entries[String(name)]) return false;
      delete st.entries[String(name)];
      persist(st);
      return true;
    },
    /** All current values, for the redactor. */
    values() { try { return Object.values(load().entries).map((e) => e.value); } catch { return []; } },
    /** Resolve a `${vault:NAME}` reference, or return the input unchanged when it is not a ref. */
    resolveRef(s) {
      const m = /^\$\{vault:([A-Z0-9_]+)\}$/.exec(String(s || '').trim());
      return m ? this.get(m[1]) : s;
    },
  };
}

const REF_RE = /\$\{vault:([A-Z0-9_]+)\}/g;
const isRef = (s) => /^\$\{vault:[A-Z0-9_]+\}$/.test(String(s || '').trim());
const refName = (s) => (/^\$\{vault:([A-Z0-9_]+)\}$/.exec(String(s || '').trim()) || [])[1] || null;

module.exports = { createVault, VaultError, NAME_RE, REF_RE, isRef, refName };
