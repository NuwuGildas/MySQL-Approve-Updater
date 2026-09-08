'use strict';
/* Framework catalog for the visual picker: each entry maps to a manifest
   fragment (install/build/start, port, output dir, runtime) so a user can
   pick a framework when detection is not possible yet (git URL not fetched)
   or override the guess. Detection results are mapped back to catalog ids. */

const F = (id, label, group, stackType, framework, o) => ({ id, label, group, stackType, framework, ...o });

const CATALOG = [
  // fullstack
  F('nextjs', 'Next.js', 'fullstack', 'node', 'next', { pm: 'npm', install: 'npm ci', build: 'npm run build', start: 'npx next start -p $PORT', port: 3000, runtime: 'node', outputDir: null }),
  F('nuxt', 'Nuxt', 'fullstack', 'node', 'nuxt', { pm: 'npm', install: 'npm ci', build: 'npm run build', start: 'node .output/server/index.mjs', port: 3000, runtime: 'node' }),
  F('sveltekit', 'SvelteKit', 'fullstack', 'node', 'sveltekit', { pm: 'npm', install: 'npm ci', build: 'npm run build', start: 'node build/index.js', port: 3000, runtime: 'node' }),
  F('remix', 'Remix', 'fullstack', 'node', 'remix', { pm: 'npm', install: 'npm ci', build: 'npm run build', start: 'npm run start', port: 3000, runtime: 'node' }),
  F('astro-ssr', 'Astro (SSR)', 'fullstack', 'node', 'astro', { pm: 'npm', install: 'npm ci', build: 'npm run build', start: 'node ./dist/server/entry.mjs', port: 4321, runtime: 'node' }),
  F('laravel', 'Laravel', 'fullstack', 'php', 'laravel', { pm: 'composer', install: 'composer install --no-dev --prefer-dist --optimize-autoloader --no-interaction', build: 'npm ci && npm run build', start: null, port: null, runtime: 'php-fpm', docroot: 'public', health: '/up', shared: { files: ['.env'], dirs: ['storage/app', 'storage/framework', 'storage/logs'] } }),
  F('symfony', 'Symfony', 'fullstack', 'php', 'symfony', { pm: 'composer', install: 'composer install --no-dev --prefer-dist --optimize-autoloader --no-interaction', build: null, start: null, port: null, runtime: 'php-fpm', docroot: 'public', shared: { files: ['.env.local'], dirs: ['var/log'] } }),
  F('django', 'Django', 'fullstack', 'python', 'django', { pm: 'pip', install: 'python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt', build: '.venv/bin/python manage.py collectstatic --noinput', start: '.venv/bin/gunicorn config.wsgi:application --bind 127.0.0.1:$PORT --workers 2', port: 8000, runtime: 'python', shared: { files: ['.env'], dirs: ['media'] } }),
  // backend
  F('express', 'Express / Node API', 'backend', 'node', 'express', { pm: 'npm', install: 'npm ci --omit=dev', build: null, start: 'node server.js', port: 3000, runtime: 'node', health: '/health' }),
  F('nestjs', 'NestJS', 'backend', 'node', 'nest', { pm: 'npm', install: 'npm ci', build: 'npm run build', start: 'node dist/main.js', port: 3000, runtime: 'node', health: '/health' }),
  F('fastapi', 'FastAPI', 'backend', 'python', 'fastapi', { pm: 'pip', install: 'python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt', build: null, start: '.venv/bin/uvicorn main:app --host 127.0.0.1 --port $PORT --workers 2', port: 8000, runtime: 'python', health: '/docs' }),
  F('flask', 'Flask', 'backend', 'python', 'flask', { pm: 'pip', install: 'python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt', build: null, start: '.venv/bin/gunicorn app:app --bind 127.0.0.1:$PORT --workers 2', port: 8000, runtime: 'python' }),
  F('php', 'PHP (composer)', 'backend', 'php', 'composer', { pm: 'composer', install: 'composer install --no-dev --prefer-dist --optimize-autoloader --no-interaction', build: null, start: null, port: null, runtime: 'php-fpm', docroot: 'public' }),
  F('docker-compose', 'Docker Compose', 'backend', 'docker', 'compose', { pm: null, install: null, build: 'docker compose -f compose.yaml build --pull', start: null, port: 8080, runtime: 'docker' }),
  F('dockerfile', 'Dockerfile', 'backend', 'docker', 'dockerfile', { pm: null, install: null, build: 'docker build --pull -t ${name}:${ts} .', start: null, port: 8080, runtime: 'docker' }),
  // frontend
  F('vite', 'Vite (React / Vue / Svelte)', 'frontend', 'static', 'vite', { pm: 'npm', install: 'npm ci', build: 'npm run build', start: null, port: null, runtime: 'static', outputDir: 'dist' }),
  F('cra', 'Create React App', 'frontend', 'static', 'cra', { pm: 'npm', install: 'npm ci', build: 'npm run build', start: null, port: null, runtime: 'static', outputDir: 'build' }),
  F('angular', 'Angular', 'frontend', 'static', 'angular', { pm: 'npm', install: 'npm ci', build: 'npm run build', start: null, port: null, runtime: 'static', outputDir: 'dist' }),
  F('astro', 'Astro (static)', 'frontend', 'static', 'astro', { pm: 'npm', install: 'npm ci', build: 'npm run build', start: null, port: null, runtime: 'static', outputDir: 'dist' }),
  F('eleventy', 'Eleventy', 'frontend', 'static', 'eleventy', { pm: 'npm', install: 'npm ci', build: 'npm run build', start: null, port: null, runtime: 'static', outputDir: '_site' }),
  // static
  F('html', 'Plain HTML', 'static', 'static', 'plain', { pm: null, install: null, build: null, start: null, port: null, runtime: 'static', outputDir: null }),
];

const GROUPS = [{ id: 'frontend', label: 'Frontend' }, { id: 'backend', label: 'Backend' }, { id: 'fullstack', label: 'Fullstack' }, { id: 'static', label: 'Static' }];

/** Manifest fragment for a catalog entry with optional overrides from the editable form. */
function fragmentFor(id, over = {}) {
  const c = CATALOG.find((x) => x.id === id);
  if (!c) { const e = new Error(`unknown framework "${id}"`); e.status = 400; throw e; }
  const install = over.install ?? c.install, build = over.build ?? c.build, start = over.start ?? c.start;
  const steps = [];
  if (install) steps.push(...String(install).split('&&').map((s) => s.trim()).filter(Boolean));
  if (build) steps.push(...String(build).split('&&').map((s) => s.trim()).filter(Boolean));
  const port = over.port !== undefined && over.port !== '' && over.port !== null ? Number(over.port) : c.port;
  const outputDir = over.outputDir !== undefined ? (over.outputDir || null) : (c.outputDir || null);
  const frag = {
    stack: { type: c.stackType, framework: c.framework, packageManager: c.pm },
    build: { steps, env: c.stackType === 'node' || c.stackType === 'static' ? { NODE_ENV: 'production', CI: 'true' } : c.stackType === 'php' ? { APP_ENV: 'production' } : {}, outputDir },
    runtime: { kind: c.runtime, start: start || null, port: port || null, docroot: over.docroot ?? c.docroot ?? '.' },
    health: { path: over.healthPath || c.health || '/', expectStatus: [200, 399] },
  };
  if (c.shared) frag.shared = c.shared;
  return frag;
}

/** Map a detection result (stack fragment) to a catalog id. */
function catalogIdFor(fragment) {
  if (!fragment?.stack) return null;
  const { type, framework } = fragment.stack;
  const hit = CATALOG.find((c) => c.stackType === type && c.framework === framework && !(c.id === 'astro-ssr' && fragment.runtime?.kind === 'static') && !(c.id === 'astro' && fragment.runtime?.kind === 'node'));
  return hit ? hit.id : (CATALOG.find((c) => c.stackType === type) || {}).id || null;
}

/** Editable summary of a resolved manifest for the form (install/build/start/port/output). */
function formFrom(manifest) {
  const steps = manifest?.build?.steps || [];
  const isInstall = (s) => /^(npm (ci|install)|pnpm install|yarn install|bun install|composer install|python3 -m venv|\.venv\/bin\/pip install|uv sync|\.venv\/bin\/poetry|PIPENV_VENV_IN_PROJECT|\.venv\/bin\/pipenv)/.test(s.trim());
  const install = steps.filter(isInstall).join(' && ');
  const build = steps.filter((s) => !isInstall(s)).join(' && ');
  return { install, build, start: manifest?.runtime?.start || '', port: manifest?.runtime?.port || '', outputDir: manifest?.build?.outputDir || '', docroot: manifest?.runtime?.docroot || '.', healthPath: manifest?.health?.path || '/' };
}

module.exports = { CATALOG, GROUPS, fragmentFor, catalogIdFor, formFrom };
