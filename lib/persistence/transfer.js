'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { validateKey, digest } = require('./mysql');

// Application data only. Executable modules, build trees and machine credentials
// are deliberately outside this manifest. Add new persistent stores here.
const { files, directories, managedKey } = require('./paths');

async function inventory(root) {
  const entries = [];
  async function visit(key, optional = false) {
    validateKey(key);
    // Check ancestors too: a module-data junction must not escape the source.
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i++) {
      try {
        if ((await fs.lstat(path.join(root, ...parts.slice(0, i)))).isSymbolicLink()) {
          throw new Error(`Refusing symbolic link ancestor: ${key}`);
        }
      } catch (error) { if (optional && error.code === 'ENOENT') return; throw error; }
    }
    const target = path.join(root, key);
    let stat;
    try { stat = await fs.lstat(target); }
    catch (error) { if (optional && error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic link: ${key}`);
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(target)).sort()) await visit(`${key}/${name}`);
    } else if (stat.isFile()) {
      // Validate JSON before any database mutation; preserve its original bytes.
      const body = await fs.readFile(target);
      if (key.endsWith('.json')) {
        try { JSON.parse(body.toString('utf8')); }
        catch { throw new SyntaxError(`Invalid JSON in ${key}`); }
      }
      entries.push({ key, bytes: body.length, sha256: digest(body) });
    } else throw new Error(`Unsupported file: ${key}`);
  }
  for (const key of [...files, ...directories]) await visit(key, true);
  // Keep historical root-store backups as well, but never unfinished temp writes.
  for (const name of (await fs.readdir(root)).sort()) {
    if (!files.includes(name) && !name.endsWith('.tmp') && managedKey(root, path.join(root, name))) await visit(name);
  }
  return entries;
}

async function importData(store, root, entries) {
  return store.transaction(async (tx) => {
    let imported = 0;
    for (const entry of entries) {
      const body = await fs.readFile(path.join(root, validateKey(entry.key)));
      if (digest(body) !== entry.sha256) throw new Error(`Source changed during import: ${entry.key}`);
      const existing = await tx.get(entry.key);
      if (existing) {
        if (digest(existing.body) !== entry.sha256) throw new Error(`Destination differs: ${entry.key}; import will not overwrite it`);
      } else { await tx.put(entry.key, body); imported++; }
    }
    return { imported, unchanged: entries.length - imported };
  });
}

async function verifyData(store, entries) {
  for (const entry of entries) {
    const record = await store.get(entry.key);
    if (!record || digest(record.body) !== entry.sha256) throw new Error(`Verification failed: ${entry.key}`);
  }
  return { verified: entries.length };
}

async function exportData(store, destination) {
  // Require a NEW directory, preventing overwrite and existing symlink traversal.
  await fs.mkdir(destination, { recursive: false, mode: 0o700 });
  let exported = 0;
  for (const key of await store.keys()) {
    validateKey(key);
    const record = await store.get(key);
    const target = path.join(destination, key);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, record.body, { flag: 'wx', mode: 0o600 });
    exported++;
  }
  return { exported };
}

module.exports = { inventory, importData, verifyData, exportData };
