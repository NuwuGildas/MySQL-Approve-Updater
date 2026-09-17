'use strict';
const path = require('node:path');
const { fs } = require('./runtime');
const { writeFileAtomicSync } = require('../shared/atomic-file');
const validKey = (key) => /^(st-|mau-|servertools-)[A-Za-z0-9_.:-]{1,180}$/.test(key);
function createBrowserState(root) {
  const file = path.join(root, 'browser-state.json');
  function read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed.version !== 1 || !parsed.values || Array.isArray(parsed.values)) throw new Error('Unsupported browser preference format');
      return parsed;
    } catch (error) { if (error.code === 'ENOENT') return { version: 1, values: {} }; throw error; }
  }
  function update(changes, onlyMissing = false) {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw Object.assign(new Error('Expected preference changes'), { status: 400 });
    const state = read();
    for (const [key, value] of Object.entries(changes)) {
      if (!validKey(key) || (value !== null && (typeof value !== 'string' || value.length > 65536))) throw Object.assign(new Error('Invalid browser preference'), { status: 400 });
      if (!onlyMissing || !Object.hasOwn(state.values, key)) state.values[key] = value;
    }
    const text = JSON.stringify(state);
    if (Buffer.byteLength(text) > 524288) throw Object.assign(new Error('Browser preferences exceed 512 KiB'), { status: 400 });
    writeFileAtomicSync(file, text);
    return state.values;
  }
  return { read: () => read().values, update };
}
module.exports = { createBrowserState, validKey };
