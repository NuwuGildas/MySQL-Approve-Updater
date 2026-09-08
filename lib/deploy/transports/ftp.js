'use strict';
/* FTP / FTPS transport (basic-ftp) exposing the same conn interface as the
   SSH transport, minus exec. Used for shared hosting without shell access. */

const fsp = require('fs/promises');
const ftp = require('basic-ftp');
const { walkLocal } = require('./ssh');

class FtpError extends Error { constructor(m, o = {}) { super(m); this.name = 'FtpError'; Object.assign(this, o); } }

/**
 * @param {{host, port, user, password, secure:'implicit'|boolean, timeoutMs?}} cfg
 */
async function createFtpConn(cfg, { signal, onLine } = {}) {
  const client = new ftp.Client(cfg.timeoutMs || 60000);
  client.ftp.verbose = false;
  const secure = cfg.kind === 'ftps' ? (cfg.secure === 'implicit' ? 'implicit' : true) : (cfg.secure === 'implicit' ? 'implicit' : !!cfg.secure);
  try {
    await client.access({ host: cfg.host, port: Number(cfg.port) || (secure === 'implicit' ? 990 : 21), user: cfg.user, password: cfg.password, secure, secureOptions: cfg.rejectUnauthorized === false ? { rejectUnauthorized: false } : undefined });
  } catch (e) { throw new FtpError(`FTP connection failed: ${e.message}`); }
  const onAbort = () => { try { client.close(); } catch {} };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  const home = await client.pwd().catch(() => '/');

  const conn = {
    kind: 'ftp', canExec: false, host: cfg.host, user: cfg.user, home, client,
    exec() { throw new FtpError('FTP targets cannot run remote commands'); },
    async uploadFile(local, remote, onProgress) {
      const size = (await fsp.stat(local)).size;
      if (onProgress) client.trackProgress((info) => onProgress(info.bytesOverall, size));
      try { await client.uploadFrom(local, remote); } finally { client.trackProgress(); }
    },
    async uploadDir(localDir, remoteDir, o = {}) {
      const files = await walkLocal(localDir);
      let done = 0, bytes = 0;
      await conn.mkdirp(remoteDir);
      // basic-ftp's uploadFromDir is convenient but gives no per-file progress; do it manually
      const dirs = new Set();
      for (const f of files) { const parts = f.rel.split('/'); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/')); }
      for (const d of [...dirs].sort()) await conn.mkdirp(`${remoteDir}/${d}`);
      for (const f of files) {
        if (signal?.aborted) throw new FtpError('upload cancelled');
        await client.uploadFrom(f.abs, `${remoteDir}/${f.rel}`);
        done++; bytes += (await fsp.stat(f.abs)).size;
        if (o.onProgress) o.onProgress(done, files.length, bytes, f.rel);
      }
      return { files: files.length, bytes };
    },
    async mkdirp(remote) { await client.ensureDir(remote); await client.cd(home).catch(() => {}); },
    async readFile(remote) {
      const chunks = [];
      const { Writable } = require('stream');
      const w = new Writable({ write(c, _e, cb) { chunks.push(c); cb(); } });
      try { await client.downloadTo(w, remote); return Buffer.concat(chunks).toString('utf8'); } catch { return null; }
    },
    async writeFile(remote, data) {
      const { Readable } = require('stream');
      await client.uploadFrom(Readable.from([Buffer.from(String(data))]), remote);
    },
    async rename(a, b) { await client.rename(a, b); },
    async list(dir) {
      try { const l = await client.list(dir); return l.map((e) => ({ name: e.name, type: e.isDirectory ? 'dir' : e.isSymbolicLink ? 'link' : 'file', size: e.size, mtime: e.modifiedAt ? e.modifiedAt.toISOString() : null })); }
      catch { return null; }
    },
    async exists(remote) {
      const parent = remote.replace(/\/[^/]+$/, '') || '/'; const name = remote.split('/').pop();
      const l = await conn.list(parent); return !!(l && l.some((e) => e.name === name));
    },
    async removeTree(remote) { try { await client.removeDir(remote); } catch (e) { try { await client.remove(remote); } catch { throw e; } } },
    async symlink() { throw new FtpError('FTP cannot create symlinks'); },
    async readlink() { return null; },
    close() { if (signal) signal.removeEventListener('abort', onAbort); try { client.close(); } catch {} },
  };
  return conn;
}

module.exports = { createFtpConn, FtpError };
