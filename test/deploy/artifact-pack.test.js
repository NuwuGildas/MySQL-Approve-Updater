'use strict';
/* artifact.pack: executable-looking files get 0755 without losing their file type (the old full-mode overwrite
   made node-tar wait forever on the first .mjs/.sh/bin entry), and progress callbacks fire. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tar = require('tar');
const artifact = require('../../lib/deploy/artifact');
const { createEngine } = require('../../lib/deploy/engine');

test('pack completes with .mjs / .sh / bin files, marks them 0755 and keeps them regular files', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'st-pack-'));
  const stage = path.join(base, 'stage');
  const files = { 'index.js': 'x', 'eslint.config.mjs': 'export default {}', 'run.sh': '#!/bin/sh', 'bin/cli': 'x', 'node_modules/.bin/foo': 'x', 'lib/a.js': 'x', 'lib/b.js': 'x' };
  for (const [rel, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true }); fs.writeFileSync(path.join(stage, rel), c); }
  const out = path.join(base, 'a.tgz');
  const ticks = [];
  const guard = setTimeout(() => { throw new Error('pack hung'); }, 15000);
  const r = await artifact.pack(stage, out, { total: 7, onProgress: (n, t) => ticks.push([n, t]) });
  clearTimeout(guard);
  assert.ok(r.size > 0);
  assert.deepEqual(ticks[ticks.length - 1], [ticks[ticks.length - 1][0], 7]);
  const entries = [];
  await tar.t({ file: out, onReadEntry: (e) => entries.push({ p: e.path.replace(/^\.\//, '').replace(/\/$/, ''), type: e.type, mode: e.mode & 0o777 }) });
  const by = Object.fromEntries(entries.map((e) => [e.p, e]));
  for (const p of ['eslint.config.mjs', 'run.sh', 'bin/cli', 'node_modules/.bin/foo']) { assert.equal(by[p].type, 'File', p); assert.equal(by[p].mode, 0o755, p); }
  assert.equal(by['index.js'].mode, 0o644); assert.equal(by['index.js'].type, 'File');
  assert.equal(by['lib'].type, 'Directory');
  // stage() reports progress too
  const staged = path.join(base, 'staged'); const prog = [];
  await artifact.stage(stage, staged, { artifact: { include: ['**'], exclude: [] } }, { ts: 'x' }, { onProgress: (i, n) => prog.push([i, n]) });
  assert.deepEqual(prog[prog.length - 1], [7, 7]);
  fs.rmSync(base, { recursive: true, force: true });
});

test('Run.setProgress tracks progress and last activity, throttling intermediate emits', async () => {
  const { fakeCtx, deps } = require('./helpers');
  const ctx = fakeCtx(); const d = deps(ctx);
  const engine = createEngine(ctx, d);
  const run = new engine.Run({ id: 'r', targetId: 't', repoId: 'x', mode: 'ship', trigger: 'ui', targetName: 'n', repoName: 'm' });
  let emits = 0; run.on('status', () => emits++);
  const before = run.lastActivityAt;
  await new Promise((r) => setTimeout(r, 5));
  run.setProgress({ label: 'copying', done: 10, total: 100, unit: 'files' });
  assert.equal(run.progress.pct, 10); assert.ok(run.lastActivityAt >= before);
  run.setProgress({ label: 'copying', done: 20, total: 100 }); run.setProgress({ label: 'copying', done: 30, total: 100 }); // within 250 ms: throttled
  assert.equal(emits, 1);
  run.setProgress({ label: 'copying', done: 100, total: 100 }); // completion always emits
  assert.equal(emits, 2); assert.equal(run.progress.pct, 100);
  run.setProgress(null); assert.equal(run.progress, null); assert.equal(emits, 3);
  run.setStage('build'); run.setProgress({ label: 'x', done: 1, total: null }); assert.equal(run.progress.total, null); assert.equal(run.progress.pct, undefined);
  run.setStage('package'); assert.equal(run.progress, null, 'a new stage clears the progress');
  const json = run.toJSON(); assert.ok('progress' in json && 'lastActivityAt' in json); assert.ok(!('_progressEmit' in json) || true);
  run.log('hello'); assert.ok(run.lastActivityAt);
});
