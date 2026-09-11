'use strict';
/* SSH transport: strict streaming exec + SFTP file operations on one ssh2
   client. Produces the uniform "conn" object the target adapters use:
     { kind, canExec, exec, uploadFile, uploadDir, mkdirp, readFile, writeFile,
       rename, list, exists, removeTree, close }
   Unlike execOnClient() in server.js this surfaces stderr, rejects on
   non-zero exit and on timeout, and supports cancellation. */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { script: shScript, q } = require('../shell');

class RemoteExecError extends Error {
  constructor(msg, o = {}) { super(msg); this.name = 'RemoteExecError'; Object.assign(this, o); }
}

function lineSplitter(onLine, stream) {
  let buf = '';
  return {
    push(d) { buf += d.toString('utf8'); let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i).replace(/\r$/, ''), stream); buf = buf.slice(i + 1); } },
    flush() { if (buf) { onLine(buf.replace(/\r$/, ''), stream); buf = ''; } },
  };
}

/** Run one command; resolves {code, ms, out} (out = captured stdout, capped), rejects on non-zero exit. */
function execStrict(client, cmd, o = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tail = [], out = [];
    let outBytes = 0;
    const onLine = (line, stream) => {
      tail.push(line); if (tail.length > 40) tail.shift();
      if (stream === 'out' && outBytes < 512 * 1024) { out.push(line); outBytes += line.length + 1; }
      if (o.onLine) o.onLine(line, stream);
    };
    const so = lineSplitter(onLine, 'out'), se = lineSplitter(onLine, 'err');
    client.exec(cmd, { pty: false }, (err, stream) => {
      if (err) return reject(new RemoteExecError(`ssh exec failed: ${err.message}`, { cmd }));
      let done = false, killedBy = null;
      const finish = (fn) => { if (done) return; done = true; if (timer) clearTimeout(timer); if (o.signal) o.signal.removeEventListener('abort', onAbort); so.flush(); se.flush(); fn(); };
      const kill = (why) => { killedBy = why; try { stream.signal('KILL'); } catch {} try { stream.close(); } catch {} };
      const timer = o.timeoutMs ? setTimeout(() => kill('timed out'), o.timeoutMs) : null;
      const onAbort = () => kill('cancelled');
      if (o.signal) { if (o.signal.aborted) onAbort(); else o.signal.addEventListener('abort', onAbort, { once: true }); }
      stream.on('data', (d) => so.push(d));
      stream.stderr.on('data', (d) => se.push(d));
      stream.on('close', (code, signal) => finish(() => {
        const ms = Date.now() - start;
        if (killedBy) return reject(new RemoteExecError(`remote command ${killedBy}`, { cmd, tail, code, signal }));
        if (code !== 0) return reject(new RemoteExecError(`remote command exited with code ${code}${tail.length ? `: ${tail[tail.length - 1]}` : ''}`, { cmd, tail, code, signal }));
        resolve({ code: 0, ms, out: out.join('\n') });
      }));
      stream.on('error', (e) => finish(() => reject(new RemoteExecError(`ssh stream error: ${e.message}`, { cmd, tail }))));
    });
  });
}

function getSftp(client) {
  return new Promise((resolve, reject) => client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp))));
}

/** Walk a local dir → [{abs, rel}] files (posix rel). */
async function walkLocal(dir) {
  const files = [];
  async function walk(rel) {
    const ents = await fsp.readdir(path.join(dir, rel), { withFileTypes: true });
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(r);
      else if (e.isFile()) files.push({ abs: path.join(dir, r), rel: r });
    }
  }
  await walk('');
  return files;
}

/**
 * @param {object} ctx  deploy ctx (needs sshClientFor)
 * @param {object} sshCfg  profile.ssh
 */
async function createSshConn(ctx, sshCfg, { signal } = {}) {
  const client = await ctx.sshClientFor(sshCfg);
  let sftp = null;
  const sf = async () => (sftp || (sftp = await getSftp(client)));
  const onAbort = () => { try { client.end(); } catch {} };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  let canExec = true;
  try { await execStrict(client, 'echo __st_ok__', { timeoutMs: 15000 }); } catch { canExec = false; }

  const p = (fn) => new Promise((res, rej) => fn((e, r) => (e ? rej(e) : res(r))));
  const stat = async (remote) => { const s = await sf(); try { return await p((cb) => s.stat(remote, cb)); } catch { return null; } };

  const conn = {
    kind: 'ssh', canExec, host: sshCfg.host, user: sshCfg.user, client,
    /** exec a command inside cwd with env; cmd may be a single string or array of commands */
    exec(cmd, o = {}) {
      if (!canExec) throw new RemoteExecError('this SSH account has no shell access (SFTP only)');
      const cmds = Array.isArray(cmd) ? cmd : [cmd];
      const full = shScript({ cwd: o.cwd, env: o.env, cmds });
      return execStrict(client, full, { onLine: o.onLine, timeoutMs: o.timeoutMs || 30 * 60000, signal: o.signal || signal });
    },
    /** capture stdout of a command (no cwd/env) */
    async capture(cmd, o = {}) { return (await this.exec(cmd, { ...o, onLine: o.onLine })).out.trim(); },
    async uploadFile(local, remote, onProgress) {
      const s = await sf();
      const size = (await fsp.stat(local)).size;
      let last = 0;
      await p((cb) => s.fastPut(local, remote, { step: (total) => { if (onProgress && (total - last > 1024 * 1024 || total === size)) { last = total; onProgress(total, size); } }, concurrency: 16, chunkSize: 32768 }, cb));
    },
    async uploadDir(localDir, remoteDir, o = {}) {
      const s = await sf();
      const files = await walkLocal(localDir);
      const dirs = new Set(['']);
      for (const f of files) { const parts = f.rel.split('/'); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/')); }
      for (const d of [...dirs].sort()) await conn.mkdirp(d ? `${remoteDir}/${d}` : remoteDir);
      let done = 0, bytes = 0;
      const total = files.length;
      const queue = [...files];
      const worker = async () => {
        while (queue.length) {
          if ((o.signal || signal)?.aborted) throw new RemoteExecError('upload cancelled');
          const f = queue.shift();
          await p((cb) => s.fastPut(f.abs, `${remoteDir}/${f.rel}`, cb));
          done++; bytes += (await fsp.stat(f.abs)).size;
          if (o.onProgress) o.onProgress(done, total, bytes, f.rel);
        }
      };
      await Promise.all(Array.from({ length: Math.min(o.concurrency || 4, files.length || 1) }, worker));
      return { files: total, bytes };
    },
    async mkdirp(remote) {
      if (canExec) { await this.exec(`mkdir -p ${q(remote)}`); return; }
      const s = await sf();
      const parts = remote.split('/').filter(Boolean);
      let cur = remote.startsWith('/') ? '' : '.';
      for (const part of parts) { cur += '/' + part; if (!(await stat(cur))) { try { await p((cb) => s.mkdir(cur, cb)); } catch (e) { if (!(await stat(cur))) throw e; } } }
    },
    async readFile(remote) {
      const s = await sf();
      try { const b = await p((cb) => s.readFile(remote, cb)); return b.toString('utf8'); } catch { return null; }
    },
    async writeFile(remote, data, mode = 0o644) {
      const s = await sf();
      await new Promise((res, rej) => { const w = s.createWriteStream(remote, { mode }); w.on('close', res); w.on('error', rej); w.end(data); });
    },
    async rename(a, b) { const s = await sf(); await p((cb) => s.rename(a, b, cb)); },
    async list(dir) {
      const s = await sf();
      try { const l = await p((cb) => s.readdir(dir, cb)); return l.map((e) => ({ name: e.filename, type: e.attrs.isDirectory() ? 'dir' : e.attrs.isSymbolicLink() ? 'link' : 'file', size: e.attrs.size, mtime: e.attrs.mtime ? new Date(e.attrs.mtime * 1000).toISOString() : null })); }
      catch { return null; }
    },
    async exists(remote) { return !!(await stat(remote)); },
    /** Recursive delete. Callers MUST path-guard; this is only reached through layout helpers. */
    async removeTree(remote) {
      if (canExec) { await this.exec(`rm -rf ${q(remote)}`); return; }
      const s = await sf();
      const rec = async (pth) => {
        const l = await conn.list(pth);
        if (l === null) { try { await p((cb) => s.unlink(pth, cb)); } catch {} return; }
        for (const e of l) { if (e.name === '.' || e.name === '..') continue; if (e.type === 'dir') await rec(`${pth}/${e.name}`); else await p((cb) => s.unlink(`${pth}/${e.name}`, cb)); }
        try { await p((cb) => s.rmdir(pth, cb)); } catch {}
      };
      await rec(remote);
    },
    async symlink(target, linkPath) {
      if (canExec) { await this.exec(`ln -sfn ${q(target)} ${q(linkPath)}`); return; }
      const s = await sf(); try { await p((cb) => s.unlink(linkPath, cb)); } catch {} await p((cb) => s.symlink(target, linkPath, cb));
    },
    async readlink(linkPath) {
      if (canExec) { try { return await this.capture(`readlink -f ${q(linkPath)}`); } catch { return null; } }
      const s = await sf(); try { return await p((cb) => s.readlink(linkPath, cb)); } catch { return null; }
    },
    close() { if (signal) signal.removeEventListener('abort', onAbort); try { client.end(); } catch {} },
  };
  return conn;
}

module.exports = { createSshConn, execStrict, RemoteExecError, walkLocal };
