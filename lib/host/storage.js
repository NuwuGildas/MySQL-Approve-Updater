'use strict';
/* The small storage abstraction module installation state is persisted through.
   It is deliberately a seam, not a database: everything below is a JSON document
   with an atomic replace, and swapping the implementation later (the deferred
   database migration) means reimplementing read/write/withLock only. */

const fs = require('../persistence/runtime').fs;
const path = require('node:path');
const { writeFileAtomic, writeFileAtomicSync } = require('../shared/atomic-file');

/** Documents keyed by name inside one directory. */
function createJsonStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = (key) => path.join(dir, `${key}.json`);
  const chains = new Map();

  function readSync(key, fallback = null) {
    try { return JSON.parse(fs.readFileSync(file(key), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return fallback;
      // A corrupt document must not be silently replaced with a default: the
      // caller decides whether to recover or refuse to start.
      throw Object.assign(new Error(`${path.basename(file(key))} is not readable: ${error.message}`), { code: 'store_unreadable', cause: error });
    }
  }

  async function write(key, value) {
    const target = file(key);
    const previous = chains.get(key) || Promise.resolve();
    const next = previous.then(async () => {
      await writeFileAtomic(target, JSON.stringify(value, null, 2) + '\n');
      return value;
    });
    chains.set(key, next.catch(() => {}));
    return next;
  }

  function writeSync(key, value) {
    writeFileAtomicSync(file(key), JSON.stringify(value, null, 2) + '\n');
    return value;
  }

  return { dir, file, readSync, read: async (key, fallback = null) => readSync(key, fallback), write, writeSync };
}

/**
 * Serialises operations by name. Installation, removal and updates all run
 * through one lock so two browser tabs cannot interleave writes to the same
 * installation state.
 */
function createLock() {
  const queues = new Map();
  return function withLock(name, fn) {
    const previous = queues.get(name) || Promise.resolve();
    const run = previous.then(fn, fn);
    queues.set(name, run.then(() => {}, () => {}));
    return run;
  };
}

module.exports = { createJsonStore, createLock };
