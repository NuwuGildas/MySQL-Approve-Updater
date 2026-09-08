'use strict';
/* Artifact packaging for local builds: select files by include/exclude
   globs, stage them (plus `extra` files and .release.json) and produce a
   Linux-friendly tar.gz (exec bits preserved, portable headers). */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const tar = require('tar');
const picomatch = require('picomatch');

const ALWAYS_EXCLUDE = ['.git', '.git/**'];

/**
 * Build the list of files to ship.
 * @param {string} srcDir absolute build dir (already includes root/outputDir logic)
 * @param {{include:string[], exclude:string[]}} rules
 * @returns {Promise<string[]>} posix-relative paths
 */
async function selectFiles(srcDir, rules) {
  const inc = picomatch(rules.include?.length ? rules.include : ['**'], { dot: true });
  const exc = picomatch([...ALWAYS_EXCLUDE, ...(rules.exclude || [])], { dot: true });
  const out = [];
  async function walk(rel) {
    const ents = await fsp.readdir(path.join(srcDir, rel), { withFileTypes: true });
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (exc(r) || exc(r + '/')) continue;
      if (e.isDirectory()) { await walk(r); continue; }
      if (!e.isFile() && !e.isSymbolicLink()) continue;
      if (inc(r)) out.push(r);
    }
  }
  await walk('');
  return out.sort();
}

/**
 * Stage the artifact into `stageDir` (copy): used for FTP uploads and as tar input.
 * @returns {Promise<{files:number, bytes:number}>}
 */
async function stage(srcDir, stageDir, manifest, meta, { onLine } = {}) {
  await fsp.rm(stageDir, { recursive: true, force: true });
  await fsp.mkdir(stageDir, { recursive: true });
  const files = await selectFiles(srcDir, manifest.artifact);
  let bytes = 0;
  for (const rel of files) {
    const from = path.join(srcDir, rel), to = path.join(stageDir, rel);
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.copyFile(from, to);
    bytes += (await fsp.stat(from)).size;
  }
  for (const x of manifest.artifact.extra || []) {
    const from = path.isAbsolute(x.from) ? x.from : path.join(meta.repoDir || srcDir, x.from);
    if (!fs.existsSync(from)) { if (onLine) onLine(`WARN artifact.extra source not found: ${x.from}`); continue; }
    const to = path.join(stageDir, x.to);
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.copyFile(from, to);
    files.push(x.to.replace(/\\/g, '/'));
  }
  await fsp.writeFile(path.join(stageDir, '.release.json'), JSON.stringify({ commit: meta.commit || null, shortCommit: meta.shortCommit || null, branch: meta.branch || null, ts: meta.ts, runId: meta.runId, builtAt: new Date().toISOString(), builtOn: require('os').hostname(), tool: 'server-tools' }));
  return { files: files.length + 1, bytes };
}

/** Executable-looking files get 0755 in the tarball even when built on Windows. */
const EXEC_RE = /(^|\/)(artisan|bin\/[^/]+|[^/]+\.sh|[^/]+\.mjs|node_modules\/\.bin\/[^/]+)$/;

async function pack(stageDir, outFile) {
  await fsp.mkdir(path.dirname(outFile), { recursive: true });
  await tar.c({
    gzip: { level: 6 }, file: outFile, cwd: stageDir, portable: true, follow: false,
    mode: 0o644, dmode: 0o755, noMtime: false,
    filter(p, st) { if (st && st.isFile() && EXEC_RE.test(p.replace(/\\/g, '/'))) st.mode = 0o755; return true; },
  }, ['.']);
  const size = (await fsp.stat(outFile)).size;
  return { file: outFile, size };
}

/** tar.gz of a whole directory (source upload for remote builds when git archive is unavailable). */
async function packDir(dir, outFile, exclude = ['.git/**', 'node_modules/**', 'vendor/**']) {
  const exc = picomatch(exclude, { dot: true });
  await fsp.mkdir(path.dirname(outFile), { recursive: true });
  await tar.c({ gzip: { level: 6 }, file: outFile, cwd: dir, portable: true, filter: (p) => { const r = p.replace(/^\.\//, '').replace(/\\/g, '/'); return !(exc(r) || exc(r + '/')); } }, ['.']);
  return { file: outFile, size: (await fsp.stat(outFile)).size };
}

const fmtBytes = (n) => (n >= 1 << 30 ? (n / (1 << 30)).toFixed(2) + ' GB' : n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(0) + ' KB' : n + ' B');

module.exports = { selectFiles, stage, pack, packDir, fmtBytes };
