'use strict';
/* Streaming local command runner (build steps, git, provider CLIs).
   Unlike runCli() in server.js this streams lines, honours cwd/env per call
   and supports cancellation via AbortSignal. Commands are user-authored build
   steps, so they go through the platform shell on purpose. */

const { spawn } = require('child_process');
const os = require('os');

class ExecError extends Error {
  constructor(msg, { code, signal, cmd, tail } = {}) { super(msg); this.name = 'ExecError'; this.code = code; this.signal = signal; this.cmd = cmd; this.tail = tail; }
}

function splitLines(onLine, stream) {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i).replace(/\r$/, ''), stream); buf = buf.slice(i + 1); }
    },
    flush() { if (buf) { onLine(buf.replace(/\r$/, ''), stream); buf = ''; } },
  };
}

/**
 * Run a shell command locally.
 * @param {string} cmd
 * @param {{cwd?:string, env?:object, onLine?:(line:string, stream:'out'|'err')=>void, timeoutMs?:number, signal?:AbortSignal, input?:string}} o
 * @returns {Promise<{code:number, ms:number}>} rejects with ExecError on non-zero exit
 */
function localExec(cmd, o = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const isWin = process.platform === 'win32';
    const shell = isWin ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
    const args = isWin ? ['/d', '/s', '/c', `"${cmd}"`] : ['-c', cmd];
    const tail = [];
    const onLine = (line, stream) => {
      tail.push(line); if (tail.length > 40) tail.shift();
      if (o.onLine) o.onLine(line, stream);
    };
    let child;
    try {
      child = spawn(shell, args, {
        cwd: o.cwd || process.cwd(), windowsHide: true, windowsVerbatimArguments: isWin,
        env: { ...process.env, ...(o.env || {}) }, stdio: [o.input != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
    } catch (e) { return reject(new ExecError(`failed to start "${cmd}": ${e.message}`, { cmd })); }
    const out = splitLines(onLine, 'out'), err = splitLines(onLine, 'err');
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    if (o.input != null) { child.stdin.end(o.input); }
    let done = false, killedBy = null;
    const kill = (why) => {
      killedBy = why;
      // Windows: kill the whole tree while the parent is still alive (taskkill /T needs it to enumerate children)
      if (isWin) { try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('exit', () => { try { child.kill('SIGKILL'); } catch {} }); return; } catch {} }
      try { child.kill('SIGKILL'); } catch {}
    };
    const timer = o.timeoutMs ? setTimeout(() => kill('timeout'), o.timeoutMs) : null;
    const onAbort = () => kill('cancelled');
    if (o.signal) { if (o.signal.aborted) onAbort(); else o.signal.addEventListener('abort', onAbort, { once: true }); }
    const finish = (fn) => { if (done) return; done = true; if (timer) clearTimeout(timer); if (o.signal) o.signal.removeEventListener('abort', onAbort); out.flush(); err.flush(); fn(); };
    child.on('error', (e) => finish(() => reject(new ExecError(`failed to run "${cmd}": ${e.message}`, { cmd, tail }))));
    child.on('close', (code, signal) => finish(() => {
      const ms = Date.now() - start;
      if (killedBy) return reject(new ExecError(`"${cmd}" ${killedBy}`, { code, signal, cmd, tail }));
      if (code !== 0) return reject(new ExecError(`"${cmd}" exited with code ${code}`, { code, signal, cmd, tail }));
      resolve({ code: 0, ms });
    }));
  });
}

/** Run and capture stdout (trimmed). For short probing commands. */
async function capture(cmd, o = {}) {
  const lines = [];
  await localExec(cmd, { ...o, onLine: (l, s) => { if (s === 'out') lines.push(l); if (o.onLine) o.onLine(l, s); } });
  return lines.join('\n').trim();
}

/** Is a binary on PATH? Returns its --version first line or null. */
async function probeTool(bin, versionArg = '--version') {
  try { return (await capture(`${bin} ${versionArg}`, { timeoutMs: 15000 })).split('\n')[0] || 'present'; }
  catch { return null; }
}

module.exports = { localExec, capture, probeTool, ExecError, hostname: os.hostname };
