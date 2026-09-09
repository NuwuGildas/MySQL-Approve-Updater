#!/usr/bin/env node
'use strict';
/* Development runner: restarts the server when its own source actually changes.

   Why not `node --watch`? It restarts on *any* file-system event for a loaded module, and on Windows
   directory watches also fire when NTFS refreshes a file's last-access time, which happens whenever an
   IDE, an antivirus or the search indexer merely reads the file. Every such restart kills deploys that
   are in flight. This runner compares size + mtime instead, ignores data folders, and restarts a crashed
   server only when a file really changes.

   usage: node scripts/dev.js [entry.js]   (default: server.js, cwd = project root) */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const entry = path.resolve(root, process.argv[2] || 'server.js');
const WATCH = [entry, path.join(root, 'lib'), path.join(root, 'package.json')];
const IGNORE = /[\\/](node_modules|\.git|deploy-work|deploy-runs|deploy-keys|public|test|scripts|\.idea|\.ui-audit)([\\/]|$)/;
const DEBOUNCE_MS = 250;

const sig = (p) => { try { const s = fs.statSync(p); return s.isFile() ? `${s.size}:${Math.floor(s.mtimeMs)}` : null; } catch { return null; } };
const seen = new Map(); // file → size:mtime
function snapshot(dir) {
  let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (IGNORE.test(p)) continue;
    if (e.isDirectory()) snapshot(p); else if (e.isFile() && /\.(c|m)?js$|\.json$/.test(e.name)) seen.set(p, sig(p));
  }
}
for (const w of WATCH) { if (fs.existsSync(w)) { if (fs.statSync(w).isDirectory()) snapshot(w); else seen.set(w, sig(w)); } }

let child = null, restarting = false, pendingTimer = null, exitedOnItsOwn = false;
const log = (m) => process.stdout.write(`\x1b[36m[dev]\x1b[0m ${m}\n`);

function start() {
  exitedOnItsOwn = false;
  child = spawn(process.execPath, [entry], { stdio: 'inherit', env: process.env });
  const me = child;
  me.on('exit', (code, signal) => {
    if (child !== me) return;
    child = null;
    if (restarting) { restarting = false; start(); return; }
    exitedOnItsOwn = true;
    log(code === 0 ? 'server exited; waiting for a change to start it again' : `server ${signal ? 'was killed by ' + signal : 'crashed with code ' + code}; waiting for a change before restarting`);
  });
}
function restart(reason) {
  log(`${reason} → restarting`);
  if (!child) { start(); return; }
  restarting = true;
  child.kill(); // SIGTERM (TerminateProcess on Windows); 'exit' handler starts the new one
}

/** A change counts only when size or mtime differs from what we last saw (access-time updates do not). */
function onEvent(dir, fileName) {
  if (!fileName) return; // overflow: cannot tell; a real change will fire again
  const p = path.resolve(dir, String(fileName));
  if (IGNORE.test(p) || !/\.(c|m)?js$|\.json$/.test(p)) return;
  const now = sig(p), before = seen.get(p);
  if (now === before) return;
  if (now === null) seen.delete(p); else seen.set(p, now);
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => restart(`${path.relative(root, p)} ${now === null ? 'removed' : before === undefined ? 'added' : 'changed'}`), DEBOUNCE_MS);
}
for (const w of WATCH) {
  if (!fs.existsSync(w)) continue;
  const isDir = fs.statSync(w).isDirectory();
  try { fs.watch(isDir ? w : path.dirname(w), { recursive: isDir }, (ev, f) => { if (isDir || (f && path.resolve(path.dirname(w), f) === w)) onEvent(isDir ? w : path.dirname(w), f); }); }
  catch (e) { log(`cannot watch ${w}: ${e.message}`); }
}
log(`watching ${WATCH.map((w) => path.relative(root, w) || '.').join(', ')} (size + mtime; access-time updates are ignored)`);
start();
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { if (child) { child.once('exit', () => process.exit(0)); child.kill(); } else process.exit(0); });
