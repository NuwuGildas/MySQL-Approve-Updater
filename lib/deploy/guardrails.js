'use strict';
/* Manifest guardrails: per-stack safety rules a proposal must satisfy, and
   starter templates that already satisfy them (backup before migrate, shared
   storage and env paths, a start command for services, a health path...). */

const frameworks = require('./frameworks');
const manifestLib = require('./manifest');

const BACKUP_RE = /backup|mysqldump|pg_dump|mongodump|\bdump\b|snapshot/i;
const cmdsOf = (m, hook) => (m.hooks?.[hook] || []).map((h) => (typeof h === 'string' ? h : h.cmd || ''));
const runsBeforeMigrate = (m) => [...cmdsOf(m, 'before_ship'), ...cmdsOf(m, 'after_build'), ...cmdsOf(m, 'before_build')];
const isLaravel = (m) => m.stack?.type === 'php' && m.stack?.framework === 'laravel';
const isService = (m) => ['node', 'python'].includes(m.runtime?.kind);

const RULES = [
  { id: 'backup-before-migrate', applies: (m) => isLaravel(m) && m.migrate !== false,
    test: (m) => runsBeforeMigrate(m).some((c) => BACKUP_RE.test(c)),
    message: 'migrations run on ship but no backup step precedes them',
    fix: 'add a before_ship hook (run: remote) that dumps the database, e.g. ${shared}/bin/backup-db ${ts}, or set "migrate": false' },
  { id: 'laravel-shared-env', applies: isLaravel, test: (m) => (m.shared?.files || []).includes('.env'),
    message: '.env is not a shared file: every release would need its own copy', fix: 'shared.files: [".env"]' },
  { id: 'laravel-shared-storage', applies: isLaravel, test: (m) => (m.shared?.dirs || []).some((d) => /^storage(\/|$)/.test(d)),
    message: 'storage/ is not shared: uploads and logs would vanish on every release', fix: 'shared.dirs: ["storage/app", "storage/framework", "storage/logs"]' },
  { id: 'service-start', applies: isService, test: (m) => !!m.runtime?.start,
    message: 'a node/python service needs a start command', fix: 'runtime.start: e.g. "node server.js" or a gunicorn/uvicorn command' },
  { id: 'service-port', applies: isService, test: (m) => Number(m.runtime?.port) > 0,
    message: 'a node/python service needs a port for the reverse proxy and the health check', fix: 'runtime.port: e.g. 3000' },
  { id: 'service-shared-env', applies: isService, test: (m) => (m.shared?.files || []).some((f) => /^\.env/.test(f)) || Object.keys(m.build?.env || {}).length > 0,
    message: 'no shared env file: production settings would be lost between releases', fix: 'shared.files: [".env"]' },
  { id: 'health-path', applies: () => true, test: (m) => !!(m.health?.path && String(m.health.path).startsWith('/')),
    message: 'health.path is missing: a broken release could not be detected and rolled back', fix: 'health.path: "/" or a dedicated endpoint such as "/up"' },
  { id: 'static-output', applies: (m) => m.stack?.type === 'static' && (m.build?.steps || []).length > 0, test: (m) => !!m.build?.outputDir,
    message: 'a static build has no outputDir: the whole source tree would be shipped', fix: 'build.outputDir: "dist" (or "build")' },
  { id: 'exclude-env', applies: () => true, test: (m) => (m.artifact?.exclude || []).some((g) => /^\.env(\b|\.|\*)/.test(g)),
    message: 'artifact.exclude no longer excludes .env files: local secrets would be uploaded', fix: 'keep ".env" and ".env.*" in artifact.exclude' },
  { id: 'no-dev-deps', applies: (m) => ['php', 'node'].includes(m.stack?.type), test: (m) => !(m.build?.steps || []).some((s) => /composer install(?!.*--no-dev)|npm install(?!.*--omit=dev)(?!.*--production)/.test(s)),
    message: 'dependencies are installed with dev packages', fix: 'composer install --no-dev / npm ci --omit=dev (or a build step followed by npm prune --omit=dev)' },
  { id: 'keep-releases', applies: () => true, test: (m) => m.keepReleases === undefined || m.keepReleases >= 2,
    message: 'keepReleases below 2 leaves nothing to roll back to', fix: 'keepReleases: 3 or more' },
];

/** Full (defaults applied) manifest for the checks; accepts compact input. */
function check(input) {
  const m = manifestLib.resolve(input || {});
  const violations = [];
  for (const r of RULES) {
    let applies = false; try { applies = r.applies(m); } catch {}
    if (!applies) continue;
    let ok = false; try { ok = r.test(m); } catch {}
    if (!ok) violations.push({ rule: r.id, message: r.message, fix: r.fix });
  }
  return { ok: violations.length === 0, violations, rulesChecked: RULES.filter((r) => { try { return r.applies(m); } catch { return false; } }).map((r) => r.id) };
}

const BACKUP_HOOK = { run: 'remote', cmd: 'if [ -x ${shared}/bin/backup-db ]; then ${shared}/bin/backup-db ${ts}; else echo "guardrail: no backup script at ${shared}/bin/backup-db (create it, or set migrate:false)"; exit 1; fi' };

/** Starter manifest for a framework with the guardrail defaults applied. */
function templateFor(frameworkId, over = {}) {
  const frag = frameworks.fragmentFor(frameworkId, over);
  const applied = [];
  frag.name = over.name || '';
  frag.hooks = frag.hooks || {};
  if (isLaravel(frag)) {
    frag.hooks.before_ship = [BACKUP_HOOK]; applied.push('backup-before-migrate');
    frag.shared = { files: ['.env'], dirs: ['storage/app', 'storage/framework', 'storage/logs'] }; applied.push('laravel-shared-env', 'laravel-shared-storage');
    frag.health = { ...frag.health, path: frag.health?.path || '/up' };
  }
  if (isService(frag)) {
    frag.shared = frag.shared || {}; frag.shared.files = [...new Set([...(frag.shared.files || []), '.env'])]; applied.push('service-shared-env');
    if (frag.stack.type === 'python') { frag.shared.dirs = [...new Set([...(frag.shared.dirs || []), 'media'])]; }
  }
  if (frag.stack?.type === 'static' && !frag.build.outputDir && frag.build.steps.length) { frag.build.outputDir = 'dist'; applied.push('static-output'); }
  frag.keepReleases = 5; applied.push('keep-releases', 'health-path', 'exclude-env');
  const manifest = manifestLib.compact(manifestLib.validate(frag));
  const result = check(manifest);
  const required = RULES.filter((r) => result.rulesChecked.includes(r.id)).map((r) => ({ rule: r.id, satisfied: !result.violations.some((v) => v.rule === r.id), requirement: r.message, how: r.fix }));
  return { framework: frameworkId, manifest, applied: [...new Set(applied)], required, ok: result.ok, violations: result.violations };
}

module.exports = { RULES, check, templateFor, BACKUP_HOOK };
