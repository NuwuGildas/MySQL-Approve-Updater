'use strict';
/* Deploy manifest (ship.json): schema, defaults, validation, merging and
   interpolation. The manifest describes HOW to build and run an app; the
   target describes WHERE. Secrets may only appear as ${vault:NAME} refs in
   env maps: never inside a command string. */

const { REF_RE } = require('./vault');

class ManifestError extends Error {
  constructor(errors) { super(`invalid manifest: ${errors.join('; ')}`); this.name = 'ManifestError'; this.status = 400; this.errors = errors; }
}

const HOOK_NAMES = ['before_build', 'after_build', 'before_ship', 'after_ship', 'before_activate', 'after_activate', 'on_failure', 'on_success'];
const STACK_TYPES = ['php', 'node', 'static', 'docker', 'python'];
const RUNTIME_KINDS = ['php-fpm', 'node', 'static', 'docker', 'python'];
const PMS = ['composer', 'npm', 'pnpm', 'yarn', 'bun', 'pip', 'poetry', 'uv', 'pipenv', null];
const TOP_KEYS = ['version', 'name', 'root', 'stack', 'build', 'artifact', 'shared', 'hooks', 'runtime', 'health', 'keepReleases', 'migrate'];

function defaults() {
  return {
    version: 1, name: '', root: '.',
    stack: { type: null, framework: null, packageManager: null, php: null, node: null, python: null },
    build: { steps: [], env: {}, outputDir: null },
    artifact: { include: ['**'], exclude: ['.git/**', '.github/**', 'node_modules/**', 'tests/**', 'test/**', '.env', '.env.*', '**/*.map', 'ship.json'], extra: [] },
    shared: { files: [], dirs: [] },
    hooks: Object.fromEntries(HOOK_NAMES.map((h) => [h, []])),
    runtime: { kind: 'static', start: null, port: null, docroot: '.' },
    health: { path: '/', expectStatus: [200, 399], timeoutSec: 60, intervalSec: 3 },
    keepReleases: 5,
    migrate: true,
  };
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function normHook(h) {
  if (typeof h === 'string') return { run: 'auto', cmd: h.trim() };
  if (isObj(h) && typeof h.cmd === 'string') return { run: ['local', 'remote', 'auto'].includes(h.run) ? h.run : 'auto', cmd: h.cmd.trim() };
  return null;
}

/** Deep-merge two manifest fragments (arrays replace, objects merge, null/undefined skipped). */
function merge(base, over) {
  if (!isObj(over)) return base;
  const out = Array.isArray(base) ? [...base] : { ...(base || {}) };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    if (isObj(v) && isObj(out[k])) out[k] = merge(out[k], v);
    else out[k] = v;
  }
  return out;
}

/** Validate + normalize a full manifest. Throws ManifestError. */
function validate(input) {
  const errors = [];
  if (!isObj(input)) throw new ManifestError(['manifest must be an object']);
  for (const k of Object.keys(input)) if (!TOP_KEYS.includes(k)) errors.push(`unknown key "${k}"`);
  const m = merge(defaults(), input);
  if (m.version !== 1) errors.push('version must be 1');
  if (typeof m.name !== 'string') errors.push('name must be a string');
  if (typeof m.root !== 'string' || m.root.includes('..') || m.root.startsWith('/')) errors.push('root must be a relative path without ".."');
  if (m.stack.type != null && !STACK_TYPES.includes(m.stack.type)) errors.push(`stack.type must be one of ${STACK_TYPES.join(', ')}`);
  if (!PMS.includes(m.stack.packageManager ?? null)) errors.push('stack.packageManager is not recognized');
  if (!Array.isArray(m.build.steps) || m.build.steps.some((s) => typeof s !== 'string' || !s.trim())) errors.push('build.steps must be an array of non-empty strings');
  if (!isObj(m.build.env) || Object.entries(m.build.env).some(([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== 'string')) errors.push('build.env must map ENV_NAME → string');
  if (m.build.outputDir != null && (typeof m.build.outputDir !== 'string' || m.build.outputDir.includes('..') || m.build.outputDir.startsWith('/'))) errors.push('build.outputDir must be a relative path');
  for (const key of ['include', 'exclude']) if (!Array.isArray(m.artifact[key]) || m.artifact[key].some((s) => typeof s !== 'string')) errors.push(`artifact.${key} must be an array of glob strings`);
  if (!Array.isArray(m.artifact.extra) || m.artifact.extra.some((e) => !isObj(e) || typeof e.from !== 'string' || typeof e.to !== 'string' || e.to.includes('..'))) errors.push('artifact.extra must be [{from,to}]');
  for (const key of ['files', 'dirs']) if (!Array.isArray(m.shared[key]) || m.shared[key].some((s) => typeof s !== 'string' || s.includes('..') || s.startsWith('/'))) errors.push(`shared.${key} must be relative paths`);
  if (!isObj(m.hooks)) errors.push('hooks must be an object');
  else {
    for (const k of Object.keys(m.hooks)) if (!HOOK_NAMES.includes(k)) errors.push(`unknown hook "${k}"`);
    for (const h of HOOK_NAMES) {
      const list = m.hooks[h] ?? [];
      if (!Array.isArray(list)) { errors.push(`hooks.${h} must be an array`); continue; }
      const norm = list.map(normHook);
      if (norm.some((x) => !x || !x.cmd)) errors.push(`hooks.${h} entries must be "cmd" strings or {run, cmd}`);
      m.hooks[h] = norm.filter(Boolean);
    }
  }
  if (!RUNTIME_KINDS.includes(m.runtime.kind)) errors.push(`runtime.kind must be one of ${RUNTIME_KINDS.join(', ')}`);
  if (m.runtime.port != null && !(Number.isInteger(m.runtime.port) && m.runtime.port > 0 && m.runtime.port < 65536)) errors.push('runtime.port must be a port number');
  if (m.runtime.start != null && typeof m.runtime.start !== 'string') errors.push('runtime.start must be a string');
  if (typeof m.runtime.docroot !== 'string' || m.runtime.docroot.includes('..') || m.runtime.docroot.startsWith('/')) errors.push('runtime.docroot must be a relative path');
  if (typeof m.health.path !== 'string' || !m.health.path.startsWith('/')) errors.push('health.path must start with /');
  if (!Array.isArray(m.health.expectStatus) || m.health.expectStatus.length !== 2 || m.health.expectStatus.some((n) => !Number.isInteger(n))) errors.push('health.expectStatus must be [min, max]');
  if (!(Number.isInteger(m.health.timeoutSec) && m.health.timeoutSec >= 1 && m.health.timeoutSec <= 900)) errors.push('health.timeoutSec must be 1-900');
  if (!(Number.isInteger(m.health.intervalSec) && m.health.intervalSec >= 1 && m.health.intervalSec <= 60)) errors.push('health.intervalSec must be 1-60');
  if (!(Number.isInteger(m.keepReleases) && m.keepReleases >= 2 && m.keepReleases <= 50)) errors.push('keepReleases must be 2-50');
  if (typeof m.migrate !== 'boolean') errors.push('migrate must be a boolean');
  // secrets policy: ${vault:} may appear only in build.env values
  const scanCmd = (label, s) => { if (typeof s === 'string' && REF_RE.test(s)) errors.push(`${label} must not contain \${vault:...} (secrets are only allowed in build.env)`); REF_RE.lastIndex = 0; };
  m.build.steps.forEach((s, i) => scanCmd(`build.steps[${i}]`, s));
  for (const h of HOOK_NAMES) (m.hooks[h] || []).forEach((x, i) => scanCmd(`hooks.${h}[${i}]`, x.cmd));
  scanCmd('runtime.start', m.runtime.start);
  if (errors.length) throw new ManifestError(errors);
  return m;
}

/** Resolve a manifest chain: stack defaults ← ship.json ← app-side manifest ← target overrides. */
function resolve(...fragments) {
  let m = {};
  for (const f of fragments) if (isObj(f)) m = merge(m, f);
  return validate(m);
}

/**
 * Interpolate ${var} placeholders in strings. `vars` covers release/current/... ;
 * `${vault:NAME}` is resolved via resolveSecret only where allowed (build.env).
 */
function interpolate(m, vars, resolveSecret) {
  const sub = (s, allowVault) => String(s).replace(/\$\{(vault:)?([A-Za-z0-9_]+)\}/g, (all, isVault, name) => {
    if (isVault) { if (!allowVault) throw new ManifestError([`\${vault:${name}} is not allowed here`]); return resolveSecret(name); }
    return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : all;
  });
  const out = JSON.parse(JSON.stringify(m));
  out.build.steps = out.build.steps.map((s) => sub(s, false));
  out.build.env = Object.fromEntries(Object.entries(out.build.env).map(([k, v]) => [k, sub(v, true)]));
  for (const h of HOOK_NAMES) out.hooks[h] = out.hooks[h].map((x) => ({ ...x, cmd: sub(x.cmd, false) }));
  if (out.runtime.start) out.runtime.start = sub(out.runtime.start, false);
  return out;
}

/** Strip defaults so the saved/downloaded ship.json stays small. */
function compact(m) {
  const d = defaults();
  const out = {};
  for (const k of TOP_KEYS) {
    if (m[k] === undefined) continue;
    if (JSON.stringify(m[k]) === JSON.stringify(d[k])) continue;
    if (isObj(m[k]) && isObj(d[k])) {
      const sub = {};
      for (const [kk, vv] of Object.entries(m[k])) if (JSON.stringify(vv) !== JSON.stringify(d[k][kk])) sub[kk] = vv;
      if (Object.keys(sub).length) out[k] = sub;
    } else out[k] = m[k];
  }
  return { version: 1, ...out };
}

module.exports = { defaults, merge, validate, resolve, interpolate, compact, ManifestError, HOOK_NAMES, STACK_TYPES, RUNTIME_KINDS };
