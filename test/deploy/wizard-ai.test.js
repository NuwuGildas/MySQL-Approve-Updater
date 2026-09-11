'use strict';
/* Wizard "AI detect": prompt wording when heuristics are confident, and the framework fragment keeping detection details. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { detect } = require('../../backend/deploy/detect');
const { buildPrompt, parseReply } = require('../../backend/deploy/detect/ai');
const frameworks = require('../../backend/deploy/frameworks');
const manifest = require('../../backend/deploy/manifest');

const FIX = path.join(__dirname, '..', 'fixtures', 'repos');

test('AI prompt asks to confirm a confident heuristic result and to fill in details', async () => {
  const det = await detect(path.join(FIX, 'laravel'));
  assert.ok(det.best && !det.ambiguous);
  const p = buildPrompt(det);
  assert.match(p, /Heuristic detection suggests php-laravel at root "\."/);
  assert.match(p, /Confirm or correct it/);
  assert.match(p, /composer\.json/);
  const unsure = buildPrompt({ ...det, best: null, ambiguous: true, reason: 'no known stack markers found', candidates: [] });
  assert.match(unsure, /was not confident: no known stack markers found/);
  assert.deepEqual(parseReply('```json\n{"a":1}\n```'), { a: 1 });
});

test('fragmentFor keeps shared paths, hooks, env, package manager and root from a detected base manifest', () => {
  const base = manifest.compact(manifest.validate({ root: 'apps/web', stack: { type: 'node', framework: 'next', packageManager: 'pnpm' }, build: { steps: ['pnpm install --frozen-lockfile', 'pnpm build'], env: { NEXT_TELEMETRY_DISABLED: '1' } }, shared: { files: ['.env'], dirs: ['uploads'] }, hooks: { after_activate: ['echo done'] }, runtime: { kind: 'node', start: 'node server.js', port: 3000 }, health: { path: '/api/health', expectStatus: [200, 204] } }));
  const form = frameworks.formFrom(base);
  assert.equal(form.install, 'pnpm install --frozen-lockfile'); assert.equal(form.build, 'pnpm build'); assert.equal(form.healthPath, '/api/health');
  const frag = manifest.validate(frameworks.fragmentFor('nextjs', { ...form, base }));
  assert.equal(frag.root, 'apps/web');
  assert.equal(frag.stack.packageManager, 'pnpm');
  assert.deepEqual(frag.shared.files, ['.env']); assert.deepEqual(frag.shared.dirs, ['uploads']);
  assert.deepEqual(frag.hooks.after_activate, [{ cmd: 'echo done', run: 'auto' }]); // hooks are normalised by validate()
  assert.equal(frag.build.env.NEXT_TELEMETRY_DISABLED, '1'); assert.equal(frag.build.env.NODE_ENV, 'production');
  assert.deepEqual(frag.build.steps, ['pnpm install --frozen-lockfile', 'pnpm build']);
  assert.deepEqual(frag.health.expectStatus, [200, 204]);
  // without a base the catalog defaults stand
  const plain = manifest.validate(frameworks.fragmentFor('nextjs', form));
  assert.equal(plain.root, '.'); assert.equal(plain.stack.packageManager, 'npm');
  assert.equal(frameworks.catalogIdFor(base), 'nextjs');
});
