'use strict';
/* Package archives are gzipped tar. Nothing is written to disk until every
   entry has been inspected: a package may only contain regular files and
   directories, under relative paths that stay inside the staging directory.

   A refusal is reported as a rejected promise, never as a throw escaping the
   tar stream, so the caller can always clean up after it. */

const fs = require('node:fs');
const path = require('node:path');
const tar = require('tar');

const MAX_ENTRIES = 20_000;
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

const fail = (message, code = 'invalid_package') => Object.assign(new Error(message), { status: 400, code });

/** Anything that could escape the staging directory, or is not a plain file. */
function problemWith(entry, seen) {
  const name = String(entry.path || '');
  if (!name) return fail('Package contains an entry with no name');
  if (name.length > 512) return fail(`Package entry name is too long: ${name.slice(0, 64)}…`);
  if (path.isAbsolute(name) || /^[A-Za-z]:/.test(name) || name.startsWith('/') || name.startsWith('\\')) return fail(`Package entry uses an absolute path: ${name}`);
  const parts = name.split(/[\\/]/);
  if (parts.includes('..')) return fail(`Package entry escapes the package directory: ${name}`);
  if (!['File', 'Directory'].includes(entry.type)) return fail(`Package contains an unsupported entry (${entry.type}): ${name}`);
  if (entry.size > MAX_ENTRY_BYTES) return fail(`Package entry ${name} is larger than ${MAX_ENTRY_BYTES} bytes`);
  if (seen.has(name)) return fail(`Package lists ${name} twice`);
  seen.add(name);
  return null;
}

/** Read every entry header first and refuse the whole archive on the first problem. */
async function inspect(archivePath) {
  const seen = new Set();
  const files = [];
  let problem = null;
  let entries = 0;
  let unpacked = 0;

  try {
    await tar.t({
      file: archivePath,
      strict: true,
      onentry(entry) {
        if (!problem) {
          if (++entries > MAX_ENTRIES) problem = fail(`Package contains more than ${MAX_ENTRIES} entries`);
          else problem = problemWith(entry, seen);
          if (!problem) {
            unpacked += entry.size || 0;
            if (unpacked > MAX_UNPACKED_BYTES) problem = fail(`Package unpacks to more than ${MAX_UNPACKED_BYTES} bytes`);
            else if (entry.type === 'File') files.push(String(entry.path).replace(/\\/g, '/'));
          }
        }
        entry.resume();
      },
    });
  } catch (error) {
    throw problem || fail(`Package could not be read: ${error.message}`);
  }
  if (problem) throw problem;
  if (!files.length) throw fail('Package is empty');
  return { files, entries, unpackedBytes: unpacked };
}

/**
 * Extract into `destination` after inspection. `preservePaths` stays off and the
 * check runs again during extraction, so a header that changed between the two
 * passes still cannot write outside the directory.
 */
async function extract(archivePath, destination) {
  const inspection = await inspect(archivePath);
  fs.mkdirSync(destination, { recursive: true });
  const seen = new Set();
  let problem = null;
  try {
    await tar.x({
      file: archivePath,
      cwd: destination,
      strict: true,
      preservePaths: false,
      strip: 0,
      filter(entryPath, entry) {
        if (problem) return false;
        problem = problemWith({ ...entry, path: entryPath, type: entry.type }, seen);
        return !problem;
      },
    });
  } catch (error) {
    throw problem || error;
  }
  if (problem) throw problem;
  return inspection;
}

module.exports = { inspect, extract, MAX_ENTRIES, MAX_UNPACKED_BYTES, MAX_ENTRY_BYTES };
