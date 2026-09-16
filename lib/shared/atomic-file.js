'use strict';
/* Replacing a file's contents without ever leaving a half-written one behind.
 *
 * Write a temp file, then rename it over the target: the rename is atomic, so a reader sees either
 * the old contents or the new ones, never a truncated file. Every store in this application saves
 * that way, and each one had its own copy of those three lines.
 *
 * On Windows the rename is the part that bites. `MoveFileEx` fails with EPERM, EACCES or EBUSY the
 * moment ANY process holds a handle on either file - a virus scanner reading the temp file it just
 * saw appear, the search indexer, a file watcher, an editor, or a second copy of this application.
 * None of that is a real failure: the handle is gone again milliseconds later. So the rename is
 * retried briefly before it is called a failure.
 *
 * The temp name carries the process id for the same reason. `data.json.tmp` is the same path in
 * every process, so two instances sharing a data directory - a dev server restarting over itself,
 * say - write over each other's temp file and then fail to rename it, which reads as file
 * corruption and is nothing of the kind.
 */

const nodeFs = require('node:fs');
const nodeFsp = require('node:fs/promises');

/** Not a failure, just something else holding the file for a moment. */
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);
const isTransient = (error) => TRANSIENT.has(error?.code);

/** 10, 20, 40, 80, 160ms: about a third of a second in all, which outlasts a scanner. */
const RETRIES = 5;
const FIRST_DELAY = 10;

/**
 * @param {object} [deps] injected for the tests; the defaults are the real filesystem
 */
function createAtomicWriter({ fsp = nodeFsp, fs = nodeFs, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), retries = RETRIES, firstDelay = FIRST_DELAY, pid = process.pid } = {}) {
  const tempName = (file) => `${file}.${pid}.tmp`;

  /**
   * Replace `file` with `contents`, atomically.
   * @param {string} file
   * @param {string} contents
   */
  async function writeFileAtomic(file, contents) {
    const tmp = tempName(file);
    await fsp.writeFile(tmp, contents, 'utf8');
    let delay = firstDelay;
    for (let attempt = 0; ; attempt++) {
      try { return await fsp.rename(tmp, file); }
      catch (error) {
        if (attempt >= retries || !isTransient(error)) {
          /* The temp file is ours and is now worthless; leaving it behind would litter the data
             directory with one per failure. Its removal can fail for the same reason, and that is
             not what the caller needs to hear about. */
          await fsp.unlink(tmp).catch(() => {});
          throw error;
        }
        await sleep(delay);
        delay *= 2;
      }
    }
  }

  /** The same, for the shutdown paths that cannot await. */
  function writeFileAtomicSync(file, contents) {
    const tmp = tempName(file);
    fs.writeFileSync(tmp, contents, 'utf8');
    let delay = firstDelay;
    for (let attempt = 0; ; attempt++) {
      try { return fs.renameSync(tmp, file); }
      catch (error) {
        if (attempt >= retries || !isTransient(error)) {
          try { fs.unlinkSync(tmp); } catch {}
          throw error;
        }
        // Synchronous by necessity: this runs where there is no turn of the loop left to wait in.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
        delay *= 2;
      }
    }
  }

  return { writeFileAtomic, writeFileAtomicSync };
}

const { writeFileAtomic, writeFileAtomicSync } = createAtomicWriter();

module.exports = { writeFileAtomic, writeFileAtomicSync, createAtomicWriter, isTransient, TRANSIENT };
