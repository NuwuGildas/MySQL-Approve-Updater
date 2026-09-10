'use strict';
/* A disposable SSH server for end-to-end checks: no cloud box, no credentials, nothing to clean up.
   It answers password auth, and each shell channel gets a real POSIX shell (Git Bash on Windows, sh
   elsewhere) so the marker protocol in lib/ssh-terminal.js is exercised against a genuine shell rather
   than a mock. `slowStart` and `dropAfter` let a check reproduce a sluggish or dying server. */

const { Server, utils } = require('ssh2');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SHELLS = [
  process.env.ST_TEST_SHELL,
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  '/bin/bash', '/bin/sh',
].filter(Boolean);
/* ssh2 occasionally emits an ed25519 key its own parser then rejects (about one in twelve), which
   would fail a regression run for no reason: generate until one parses. */
function freshHostKey(attempts = 10) {
  for (let i = 0; i < attempts; i++) {
    const key = utils.generateKeyPairSync('ed25519').private;
    if (!(utils.parseKey(key) instanceof Error)) return key;
  }
  return utils.generateKeyPairSync('rsa', { bits: 2048 }).private; // slower, but it always parses
}

const shellPath = () => SHELLS.find((p) => { try { return fs.existsSync(p); } catch { return false; } });

/**
 * @param {object} o
 * @param {string} [o.user] accepted username (default "test")
 * @param {string} [o.password] accepted password (default "test")
 * @param {number} [o.port] 0 = pick a free port
 * @param {number} [o.slowStart] ms to wait before the shell greets, to test slow connects
 * @param {string} [o.banner] first line the shell prints
 * @returns {Promise<{port:number, close:()=>Promise<void>, sessions:number, kill:()=>void}>}
 */
async function startSshServer(o = {}) {
  const user = o.user || 'test';
  const password = o.password || 'test';
  const shell = shellPath();
  if (!shell) throw new Error('no POSIX shell available for the SSH fixture (set ST_TEST_SHELL)');
  const hostKey = freshHostKey();
  const children = new Set();
  let sessions = 0;

  const clients = new Set();
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === user && ctx.password === password) return ctx.accept();
      if (ctx.method === 'none') return ctx.reject(['password']);
      ctx.reject();
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.once('shell', (acceptShell) => {
          const stream = acceptShell();
          sessions++;
          const start = () => {
            // --norc keeps a developer's own prompt and aliases out of the fixture
            const child = spawn(shell, ['--noprofile', '--norc', '-i', '-s'], {
              windowsHide: true,
              env: { ...process.env, PS1: '$ ', TERM: 'dumb', HISTFILE: '', PROMPT_COMMAND: '' },
              cwd: os.tmpdir(),
            });
            children.add(child);
            stream.write(`${o.banner || 'fixture shell ready'}\r\n$ `);
            child.stdout.on('data', (d) => { try { stream.write(d); } catch {} });
            child.stderr.on('data', (d) => { try { stream.write(d); } catch {} });
            stream.on('data', (d) => { try { child.stdin.write(d); } catch {} });
            stream.on('close', () => { children.delete(child); try { child.kill(); } catch {} });
            child.on('exit', () => { children.delete(child); try { stream.exit(0); stream.close(); } catch {} });
          };
          if (o.slowStart) setTimeout(start, o.slowStart); else start();
        });
        session.on('pty', (acceptPty) => acceptPty && acceptPty());
        session.on('window-change', (acceptWin) => acceptWin && acceptWin());
        session.on('exec', (acceptExec, reject, info) => {
          const stream = acceptExec();
          const child = spawn(shell, ['--noprofile', '--norc', '-c', info.command], { windowsHide: true, cwd: os.tmpdir() });
          children.add(child);
          child.stdout.on('data', (d) => stream.write(d));
          child.stderr.on('data', (d) => stream.stderr.write(d));
          child.on('exit', (code) => { children.delete(child); try { stream.exit(code ?? 0); stream.end(); } catch {} });
        });
      });
    });
    client.on('error', () => {}); // a viewer dropping mid-handshake must not take the fixture down
  });

  const port = await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(o.port || 0, '127.0.0.1', function () { resolve(this.address().port); });
  });
  const kill = () => { for (const c of children) { try { c.kill(); } catch {} } children.clear(); };
  return {
    port, kill,
    get sessions() { return sessions; },
    // server.close() alone waits for every live connection, so a check that forgets to disconnect
    // would hang: end the clients first and never let the fixture outlive its test.
    close: () => new Promise((resolve) => {
      kill();
      for (const c of clients) { try { c.end(); } catch {} }
      clients.clear();
      const timer = setTimeout(resolve, 1500); // a half-dead socket must not hold the process open
      server.close(() => { clearTimeout(timer); resolve(); });
    }),
  };
}

/** Write a temporary connections.json holding only fixture servers, for a disposable app instance. */
function fixtureConnections(dir, servers) {
  const profiles = servers.map((s, i) => ({
    id: s.id || `fixture-${i + 1}`, name: s.name || `fixture-${i + 1}`, sshOnly: true,
    db: { host: '', port: 3306, user: '', password: '', database: '' },
    ssh: { enabled: true, host: '127.0.0.1', port: s.port, user: s.user || 'test', password: s.password || 'test', authKind: 'password' },
  }));
  const file = path.join(dir, 'connections.json');
  fs.writeFileSync(file, JSON.stringify({ activeId: profiles[0]?.id || null, profiles }, null, 2));
  return { file, profiles };
}

module.exports = { startSshServer, fixtureConnections, shellPath };
