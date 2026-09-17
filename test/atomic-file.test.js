'use strict';
/* Replacing a file's contents when something else is holding it.
 *
 * On Windows the rename over the target fails with EPERM, EACCES or EBUSY whenever any other
 * process has a handle on either file - a virus scanner, the search indexer, a file watcher, an
 * editor, or a second copy of this application. It is over in milliseconds, and treating it as a
 * real failure is what turned a momentary lock into "ssh-session-chats.json could not be saved"
 * and a store that refused every write afterwards.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createAtomicWriter, writeFileAtomic, isTransient } = require('../lib/shared/atomic-file');

const err = (code) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });

/** A filesystem that fails the first `failures` renames with `code`, then works. */
function flakyFs({ failures, code = 'EPERM' }) {
  const calls = { writes: [], renames: 0, unlinks: [] };
  return {
    calls,
    fsp: {
      writeFile: async (file, contents) => { calls.writes.push(file); },
      rename: async (from, to) => { calls.renames++; if (calls.renames <= failures) throw err(code); calls.to = to; },
      unlink: async (file) => { calls.unlinks.push(file); },
    },
  };
}

test('a rename the operating system refuses for a moment is retried, not reported', async () => {
  const waits = [];
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    const flaky = flakyFs({ failures: 3, code });
    const { writeFileAtomic: write } = createAtomicWriter({ ...flaky, sleep: async (ms) => waits.push(ms), pid: 4242 });
    await write('/data/chats.json', '{"ok":true}');
    assert.equal(flaky.calls.renames, 4, `${code} gave up too early`);
    assert.equal(flaky.calls.to, '/data/chats.json');
    assert.deepEqual(flaky.calls.unlinks, [], 'the written file is not thrown away while it can still land');
  }
  assert.deepEqual(waits.slice(0, 3), [10, 20, 40], 'it backs off instead of spinning');
});

test('but a rename that keeps failing is still a failure, and leaves no litter behind', async () => {
  const flaky = flakyFs({ failures: Infinity });
  const { writeFileAtomic: write } = createAtomicWriter({ ...flaky, sleep: async () => {}, pid: 4242 });
  await assert.rejects(() => write('/data/chats.json', '{}'), /EPERM/);
  assert.equal(flaky.calls.renames, 6, 'the first try plus five retries');
  assert.deepEqual(flaky.calls.unlinks, ['/data/chats.json.4242.1.tmp'], 'the temp file is cleaned up');
});

test('a failure that is not about a held handle is reported at once', async () => {
  const flaky = flakyFs({ failures: Infinity, code: 'ENOSPC' });
  const { writeFileAtomic: write } = createAtomicWriter({ ...flaky, sleep: async () => {}, pid: 1 });
  await assert.rejects(() => write('/data/chats.json', '{}'), /ENOSPC/);
  assert.equal(flaky.calls.renames, 1, 'retrying a full disk only wastes time');
  assert.equal(isTransient(err('ENOSPC')), false);
  assert.equal(isTransient(err('EPERM')), true);
});

test('two processes sharing a data directory do not write over each other', async () => {
  /* The temp name used to be "<file>.tmp" in every process. A dev server restarting over itself,
     or a second instance, then wrote the same temp file and the rename failed - which read as
     corruption and was nothing of the kind. */
  const seen = [];
  const capture = (pid) => createAtomicWriter({
    pid,
    fsp: { writeFile: async (file) => seen.push(file), rename: async () => {}, unlink: async () => {} },
  }).writeFileAtomic;
  await capture(111)('/data/chats.json', '{}');
  await capture(222)('/data/chats.json', '{}');
  assert.deepEqual(seen, ['/data/chats.json.111.1.tmp', '/data/chats.json.222.1.tmp']);
});

test('on a real filesystem it replaces the file whole, and a reader never sees a partial one', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'st-atomic-'));
  const file = path.join(dir, 'doc.json');
  try {
    await writeFileAtomic(file, '{"a":1}');
    assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}');

    /* Overwrite repeatedly while reading: every read is one whole document or the file is absent,
       never half of one. */
    const long = JSON.stringify({ pad: 'x'.repeat(200000) });
    const writes = Promise.all([writeFileAtomic(file, long), writeFileAtomic(file, '{"b":2}'), writeFileAtomic(file, long)]);
    for (let i = 0; i < 40; i++) {
      try { JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') assert.fail(`a reader saw a partial file: ${error.message}`); }
    }
    await writes;
    JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(fs.readdirSync(dir), ['doc.json'], 'no temp files are left behind');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
