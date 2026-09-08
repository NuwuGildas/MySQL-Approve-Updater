'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { detect } = require('../../lib/deploy/detect');
const manifest = require('../../lib/deploy/manifest');

const fx = (n) => path.join(__dirname, '..', 'fixtures', 'repos', n);

const CASES = {
  laravel: { id: 'php-laravel', type: 'php', framework: 'laravel', pm: 'composer', docroot: 'public', health: '/up', stepsMatch: /composer install .*--no-dev/, extraStep: 'npm ci' },
  'composer-lib': { id: 'php-composer', type: 'php', framework: 'composer', pm: 'composer', docroot: '.' },
  symfony: { id: 'php-composer', type: 'php', framework: 'symfony', pm: 'composer', docroot: 'public' },
  vite: { id: 'static-site', type: 'static', framework: 'vite', pm: 'pnpm', outputDir: 'public_out', extraStep: 'pnpm install --frozen-lockfile' },
  cra: { id: 'static-site', type: 'static', framework: 'cra', pm: 'yarn', outputDir: 'build' },
  next: { id: 'node-app', type: 'node', framework: 'next', pm: 'npm', start: 'node .next/standalone/server.js', node: '20' },
  express: { id: 'node-app', type: 'node', framework: 'express', pm: 'npm', start: 'npm run start' },
  'plain-html': { id: 'static-site', type: 'static', framework: 'plain', pm: null, outputDir: '.' },
  'compose-app': { id: 'docker', type: 'docker', framework: 'compose', pm: null, runtime: 'docker', port: 8081, stepsMatch: /docker compose -f compose.yaml build/ },
  'django-app': { id: 'python', type: 'python', framework: 'django', pm: 'pip', runtime: 'python', start: '.venv/bin/gunicorn mysite.wsgi:application --bind 127.0.0.1:$PORT --workers 2', stepsMatch: /collectstatic/ },
  'fastapi-app': { id: 'python', type: 'python', framework: 'fastapi', pm: 'uv', runtime: 'python', health: '/docs', stepsMatch: /uv sync --frozen --no-dev/ },
  'flask-app': { id: 'python', type: 'python', framework: 'flask', pm: 'pip', runtime: 'python', start: '.venv/bin/gunicorn app:app --bind 127.0.0.1:$PORT --workers 2' },
};

for (const [name, exp] of Object.entries(CASES)) {
  test(`detect fixture ${name}`, async () => {
    const r = await detect(fx(name));
    assert.ok(r.best, 'has a best candidate');
    assert.equal(r.best.id, exp.id);
    assert.equal(r.ambiguous, false, `not ambiguous: ${r.reason}`);
    const f = r.best.fragment;
    assert.equal(f.stack.type, exp.type);
    assert.equal(f.stack.framework, exp.framework);
    assert.equal(f.stack.packageManager ?? null, exp.pm);
    if (exp.docroot) assert.equal(f.runtime.docroot, exp.docroot);
    if (exp.outputDir) assert.equal(f.build.outputDir, exp.outputDir);
    if (exp.health) assert.equal(f.health.path, exp.health);
    if (exp.runtime) assert.equal(f.runtime.kind, exp.runtime);
    if (exp.port) assert.equal(f.runtime.port, exp.port);
    if (exp.start) assert.equal(f.runtime.start, exp.start);
    if (exp.node) assert.equal(f.stack.node, exp.node);
    if (exp.stepsMatch) assert.ok(f.build.steps.some((s) => exp.stepsMatch.test(s)), `steps ${f.build.steps}`);
    if (exp.extraStep) assert.ok(f.build.steps.includes(exp.extraStep), `steps ${f.build.steps}`);
    assert.ok(r.best.evidence.length > 0);
    // every fragment must produce a valid manifest on its own
    const m = manifest.resolve(f);
    assert.equal(m.stack.type, exp.type);
  });
}

test('detect monorepo is ambiguous with per-root candidates', async () => {
  const r = await detect(fx('monorepo'));
  assert.equal(r.ambiguous, true);
  const roots = new Set(r.candidates.map((c) => c.root));
  assert.ok(roots.has('apps/api') && roots.has('apps/web'), [...roots].join(','));
  assert.match(r.reason, /multiple app roots|no known/);
});

test('detect empty dir has no candidates', async () => {
  const r = await detect(path.join(__dirname, '..', 'fixtures'));
  assert.equal(r.best, null);
  assert.equal(r.ambiguous, true);
});

test('manifest validate/merge/compact/interpolate', () => {
  const m = manifest.resolve({ stack: { type: 'php', framework: 'laravel', packageManager: 'composer' }, build: { steps: ['composer install'] }, runtime: { kind: 'php-fpm', docroot: 'public' } }, { build: { env: { APP_URL: 'https://x' } } });
  assert.equal(m.runtime.docroot, 'public');
  assert.equal(m.build.env.APP_URL, 'https://x');
  assert.equal(m.keepReleases, 5);
  assert.throws(() => manifest.validate({ bogus: 1 }), /unknown key "bogus"/);
  assert.throws(() => manifest.validate({ build: { steps: ['echo ${vault:TOKEN}'] } }), /must not contain \$\{vault/);
  assert.throws(() => manifest.validate({ hooks: { after_ship: ['php artisan migrate ${vault:X}'] } }), /hooks.after_ship\[0\]/);
  assert.throws(() => manifest.validate({ keepReleases: 1 }), /keepReleases/);
  assert.throws(() => manifest.validate({ shared: { dirs: ['../x'] } }), /shared.dirs/);
  assert.throws(() => manifest.validate({ hooks: { nope: [] } }), /unknown hook/);
  // hooks normalize
  const h = manifest.validate({ hooks: { after_ship: ['a', { run: 'remote', cmd: 'b' }] } });
  assert.deepEqual(h.hooks.after_ship, [{ run: 'auto', cmd: 'a' }, { run: 'remote', cmd: 'b' }]);
  // interpolate
  const i = manifest.interpolate(manifest.validate({ build: { steps: ['echo ${release} ${nope}'], env: { T: '${vault:TOK}', R: '${root}' } }, hooks: { after_ship: ['ls ${current}'] } }), { release: '/r/1', current: '/r/cur', root: '/r' }, (n) => `secret-${n}`);
  assert.equal(i.build.steps[0], 'echo /r/1 ${nope}');
  assert.equal(i.build.env.T, 'secret-TOK');
  assert.equal(i.build.env.R, '/r');
  assert.equal(i.hooks.after_ship[0].cmd, 'ls /r/cur');
  // compact drops defaults
  const c = manifest.compact(manifest.validate({ name: 'x', runtime: { kind: 'node', port: 3000 } }));
  assert.deepEqual(Object.keys(c).sort(), ['name', 'runtime', 'version']);
  assert.deepEqual(c.runtime, { kind: 'node', port: 3000 });
  assert.equal(c.hooks, undefined);
});
