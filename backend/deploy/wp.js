'use strict';
/* Bootstrapping a WordPress deployment.
 *
 * WordPress is not something you build from a repository: core is 2,000-odd files nobody commits,
 * and what a team actually keeps in git is wp-content - a theme, some plugins, maybe a composer.json.
 * So a release is assembled rather than compiled: a pinned, checksum-verified copy of core from
 * wordpress.org underneath, the repository's own files on top, and a wp-config.php generated from
 * the vault. Anything the repository provides wins, wp-config.php included, so "customise it" never
 * means "fight the scaffold".
 *
 * Core is fetched HERE, during the build, and shipped inside the artifact. That costs a ~35 MB
 * upload per release and buys the one thing that matters: it works the same on a VPS, on shared
 * hosting reachable only over FTP, and on this machine - none of which need a shell, wp-cli, or
 * outbound network on the server.
 *
 * Nothing in this file touches a database. The generated wp-config.php points at one; the famous
 * five-minute install still runs in the browser, once.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const tar = require('tar');

const VERSION_API = 'https://api.wordpress.org/core/version-check/1.7/';
const DOWNLOAD_BASE = 'https://wordpress.org';
const VERSION_RE = /^\d+(\.\d+){1,2}$/;
const DOWNLOAD_TIMEOUT_MS = 10 * 60000;

class WpError extends Error { constructor(m) { super(m); this.name = 'WpError'; } }

/* ---------------------------------------------------------------- version */

/**
 * Resolve "latest" against wordpress.org; a pinned version is taken as given.
 * @param {string} version "latest" or e.g. "6.8.3"
 * @returns {Promise<string>}
 */
async function resolveVersion(version, { fetchImpl = fetch, signal } = {}) {
  const want = String(version || 'latest').trim();
  if (want && want !== 'latest') {
    if (!VERSION_RE.test(want)) throw new WpError(`"${want}" is not a WordPress version (expected 6.8 or 6.8.3, or "latest")`);
    return want;
  }
  const res = await fetchImpl(`${VERSION_API}?version=0`, { signal });
  if (!res.ok) throw new WpError(`wordpress.org version check failed: HTTP ${res.status}`);
  const body = await res.json();
  const current = body?.offers?.find((o) => o.current)?.current;
  if (!current || !VERSION_RE.test(current)) throw new WpError('wordpress.org did not report a current version; pin one with stack.wordpress.version');
  return current;
}

const tarballUrl = (version) => `${DOWNLOAD_BASE}/wordpress-${version}.tar.gz`;

/* --------------------------------------------------------------- download */

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

/**
 * The core tarball for `version`, cached under `cacheDir` and verified against the .sha1 that
 * wordpress.org publishes beside it. A cached file is re-verified before it is trusted, so a
 * truncated or tampered cache entry is replaced rather than shipped.
 * @returns {Promise<{file: string, version: string, bytes: number, cached: boolean, sha1: string}>}
 */
async function fetchCore(version, cacheDir, { fetchImpl = fetch, onLine = () => {}, signal } = {}) {
  await fsp.mkdir(cacheDir, { recursive: true });
  const file = path.join(cacheDir, `wordpress-${version}.tar.gz`);
  const url = tarballUrl(version);

  const expected = await fetchSha1(url, { fetchImpl, signal });
  if (!expected) onLine(`WARN wordpress.org published no checksum for ${version}: the download cannot be verified`);

  if (fs.existsSync(file)) {
    const have = sha1(await fsp.readFile(file));
    if (!expected || have === expected) {
      onLine(`WordPress ${version} from the cache (${have.slice(0, 12)}…)`);
      return { file, version, bytes: (await fsp.stat(file)).size, cached: true, sha1: have };
    }
    onLine(`WARN cached WordPress ${version} does not match its checksum: downloading again`);
    await fsp.rm(file, { force: true });
  }

  onLine(`downloading ${url}`);
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  const timer = setTimeout(() => ac.abort(), DOWNLOAD_TIMEOUT_MS);
  let body;
  try {
    const res = await fetchImpl(url, { signal: ac.signal });
    if (!res.ok) throw new WpError(`could not download WordPress ${version}: HTTP ${res.status} from ${url}`);
    body = Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  const got = sha1(body);
  if (expected && got !== expected) throw new WpError(`the WordPress ${version} download does not match the checksum wordpress.org published (expected ${expected}, got ${got}); nothing was written`);
  // written through a temp name: a cancelled or failed write must not leave a half file in the cache
  const tmp = `${file}.${process.pid}.part`;
  await fsp.writeFile(tmp, body);
  await fsp.rename(tmp, file);
  onLine(`WordPress ${version} downloaded (${body.length} bytes, sha1 ${got.slice(0, 12)}…)${expected ? ', checksum verified' : ''}`);
  return { file, version, bytes: body.length, cached: false, sha1: got };
}

/** The checksum wordpress.org publishes beside a tarball, or null when it serves none. */
async function fetchSha1(url, { fetchImpl = fetch, signal } = {}) {
  try {
    const res = await fetchImpl(`${url}.sha1`, { signal });
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    return /^[0-9a-f]{40}$/i.test(text) ? text.toLowerCase() : null;
  } catch { return null; }
}

/** Extract core into `dest`, dropping the "wordpress/" prefix every release tarball carries. */
async function extractCore(file, dest) {
  await fsp.mkdir(dest, { recursive: true });
  await tar.x({ file, cwd: dest, strip: 1, filter: (p) => p === 'wordpress' || p.startsWith('wordpress/') });
  if (!fs.existsSync(path.join(dest, 'wp-settings.php'))) throw new WpError('the WordPress archive did not contain wp-settings.php');
}

/* ------------------------------------------------------------------ salts */

/* WordPress's own generator uses printable ASCII. Quote and backslash are left out so the values
   need no escaping inside the single-quoted PHP strings they end up in. */
const SALT_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()-_=+[]{}<>~;:,.?/|';
const SALT_KEYS = ['AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY', 'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT'];

function randomSalt(len = 64) {
  const bytes = crypto.randomBytes(len * 2);
  let out = '';
  for (let i = 0; out.length < len; i++) out += SALT_CHARS[bytes[i % bytes.length] % SALT_CHARS.length];
  return out;
}

const newSalts = () => Object.fromEntries(SALT_KEYS.map((k) => [k, randomSalt()]));

/**
 * The salts for this deployment, generated once and then kept.
 *
 * Regenerating them on every ship would sign every logged-in user out on every deploy, so they live
 * in the vault under a name derived from the target and are read back from there afterwards.
 * @param {{has: Function, get: Function, set: Function}} vault
 * @param {string} secretName UPPER_SNAKE vault entry
 * @returns {{salts: Record<string,string>, created: boolean}}
 */
function saltsFor(vault, secretName) {
  if (vault.has(secretName)) {
    const stored = parseEnvBlock(vault.get(secretName));
    const complete = SALT_KEYS.every((k) => typeof stored[k] === 'string' && stored[k].length >= 32);
    if (complete) return { salts: Object.fromEntries(SALT_KEYS.map((k) => [k, stored[k]])), created: false };
  }
  const salts = newSalts();
  vault.set(secretName, SALT_KEYS.map((k) => `${k}=${salts[k]}`).join('\n'));
  return { salts, created: true };
}

/** A vault entry name for this target's salts: WP_SALTS_<TARGET>. */
function saltSecretName(targetName) {
  const slug = String(targetName || 'site').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50) || 'SITE';
  return `WP_SALTS_${/^[A-Z]/.test(slug) ? slug : 'S' + slug}`;
}

/* ----------------------------------------------------------- wp-config.php */

/** Parse a KEY=value block (the shape every .env-style vault entry in this module uses). */
function parseEnvBlock(text) {
  const out = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

const phpStr = (v) => `'${String(v ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const phpBool = (v) => (v ? 'true' : 'false');
const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase());

/**
 * Settings for wp-config.php, read from a vault entry using the names the official WordPress
 * container image uses - so an existing WORDPRESS_DB_* block can be pasted in unchanged.
 */
function readSettings(block) {
  const e = parseEnvBlock(block);
  return {
    dbName: e.WORDPRESS_DB_NAME || '',
    dbUser: e.WORDPRESS_DB_USER || '',
    dbPassword: e.WORDPRESS_DB_PASSWORD || '',
    dbHost: e.WORDPRESS_DB_HOST || 'localhost',
    dbCharset: e.WORDPRESS_DB_CHARSET || 'utf8mb4',
    dbCollate: e.WORDPRESS_DB_COLLATE || '',
    tablePrefix: e.WORDPRESS_TABLE_PREFIX || 'wp_',
    debug: truthy(e.WORDPRESS_DEBUG),
    allowFileMods: truthy(e.WORDPRESS_ALLOW_FILE_MODS),
    siteUrl: e.WORDPRESS_SITE_URL || '',
    extra: e.WORDPRESS_CONFIG_EXTRA || '',
  };
}

/** Which required settings are missing, so the caller can say so instead of writing a broken file. */
const missingSettings = (s) => ['dbName', 'dbUser'].filter((k) => !s[k]);

/**
 * Render wp-config.php.
 *
 * DISALLOW_FILE_EDIT is on: the built-in theme and plugin editors write into the release directory,
 * which the next deploy replaces, so edits made there look saved and then vanish. Installing plugins
 * from wp-admin has the same problem, which is why DISALLOW_FILE_MODS defaults on too and is opt-out
 * through WORDPRESS_ALLOW_FILE_MODS.
 */
function renderConfig(settings, salts, { generator = 'Server Tools' } = {}) {
  const s = settings;
  const lines = [
    '<?php',
    `/* Generated by ${generator} on every deploy. Edits here do not survive the next one.`,
    ' *',
    ' * To change it: commit your own wp-config.php to the repository and it is used instead of this',
    ' * file, or add PHP to WORDPRESS_CONFIG_EXTRA in the vault entry this deployment reads. */',
    '',
    `define( 'DB_NAME', ${phpStr(s.dbName)} );`,
    `define( 'DB_USER', ${phpStr(s.dbUser)} );`,
    `define( 'DB_PASSWORD', ${phpStr(s.dbPassword)} );`,
    `define( 'DB_HOST', ${phpStr(s.dbHost)} );`,
    `define( 'DB_CHARSET', ${phpStr(s.dbCharset)} );`,
    `define( 'DB_COLLATE', ${phpStr(s.dbCollate)} );`,
    '',
    ...SALT_KEYS.map((k) => `define( ${phpStr(k)}, ${phpStr(salts[k])} );`),
    '',
    `$table_prefix = ${phpStr(s.tablePrefix)};`,
    '',
    `define( 'WP_DEBUG', ${phpBool(s.debug)} );`,
    `define( 'WP_DEBUG_DISPLAY', ${phpBool(false)} );`,
    `define( 'WP_ENVIRONMENT_TYPE', ${phpStr(s.debug ? 'development' : 'production')} );`,
    "define( 'DISALLOW_FILE_EDIT', true );",
    `define( 'DISALLOW_FILE_MODS', ${phpBool(!s.allowFileMods)} );`,
  ];
  if (s.siteUrl) {
    lines.push('', `define( 'WP_HOME', ${phpStr(s.siteUrl)} );`, `define( 'WP_SITEURL', ${phpStr(s.siteUrl)} );`);
  }
  if (s.extra.trim()) lines.push('', '/* WORDPRESS_CONFIG_EXTRA */', s.extra.trim());
  lines.push(
    '',
    "if ( ! defined( 'ABSPATH' ) ) { define( 'ABSPATH', __DIR__ . '/' ); }",
    "require_once ABSPATH . 'wp-settings.php';",
    '',
  );
  return lines.join('\n');
}

/* --------------------------------------------------------------- scaffold */

/**
 * Assemble the part of the release that does not come from the repository: core, wp-config.php and
 * an uploads directory for the shared-storage link to adopt.
 *
 * @param {object} o
 * @param {object} o.wp            manifest.stack.wordpress
 * @param {string} o.baseDir       where to assemble (emptied first)
 * @param {string} o.cacheDir      where core tarballs are kept between builds
 * @param {string} o.targetName    names the vault entry holding this deployment's salts
 * @param {boolean} o.hasOwnConfig the repository ships a wp-config.php, so none is generated
 * @param {object} o.vault
 * @returns {Promise<{version: string|null, configWritten: boolean, saltsCreated: boolean, notes: string[]}>}
 */
async function scaffold({ wp, baseDir, cacheDir, targetName, hasOwnConfig, vault, fetchImpl = fetch, onLine = () => {}, warn = () => {}, signal }) {
  await fsp.rm(baseDir, { recursive: true, force: true });
  await fsp.mkdir(baseDir, { recursive: true });
  const notes = [];
  let version = null;

  if (wp.core === 'download') {
    version = await resolveVersion(wp.version, { fetchImpl, signal });
    if (String(wp.version || 'latest') === 'latest') warn(`WordPress version is "latest", resolved to ${version} for this release: pin stack.wordpress.version so a redeploy ships the same core`);
    const core = await fetchCore(version, cacheDir, { fetchImpl, onLine: (l) => (l.startsWith('WARN ') ? warn(l.slice(5)) : onLine(l)), signal });
    await extractCore(core.file, baseDir);
    notes.push(`WordPress ${version} core`);
  } else {
    onLine('core comes from the repository (wp-settings.php is committed): nothing downloaded');
    notes.push('core from the repository');
  }

  // The shared-storage link seeds itself from whatever the release has here, so give it a directory.
  await fsp.mkdir(path.join(baseDir, 'wp-content', 'uploads'), { recursive: true });

  let configWritten = false, saltsCreated = false;
  if (hasOwnConfig) {
    onLine('wp-config.php is in the repository: using yours, generating none');
    notes.push('wp-config.php from the repository');
  } else if (!wp.configFromVault) {
    warn('no wp-config.php: set stack.wordpress.configFromVault to a vault entry holding WORDPRESS_DB_NAME / WORDPRESS_DB_USER / WORDPRESS_DB_PASSWORD, or commit your own wp-config.php. WordPress will ask for the database in the browser, and the file it writes will be lost on the next deploy.');
  } else {
    if (!vault.has(wp.configFromVault)) throw new WpError(`vault entry "${wp.configFromVault}" does not exist: add it in Deployments → Secrets with WORDPRESS_DB_NAME, WORDPRESS_DB_USER and WORDPRESS_DB_PASSWORD`);
    const settings = readSettings(vault.get(wp.configFromVault));
    const missing = missingSettings(settings);
    if (missing.length) throw new WpError(`vault entry "${wp.configFromVault}" is missing ${missing.map((k) => (k === 'dbName' ? 'WORDPRESS_DB_NAME' : 'WORDPRESS_DB_USER')).join(' and ')}`);
    if (!settings.dbPassword) warn(`${wp.configFromVault} has no WORDPRESS_DB_PASSWORD: connecting to MySQL without one rarely works outside a local sandbox`);
    const secretName = saltSecretName(targetName);
    const s = saltsFor(vault, secretName);
    saltsCreated = s.created;
    if (s.created) onLine(`generated this deployment's WordPress salts and stored them as ${secretName}`);
    else onLine(`reusing the WordPress salts stored as ${secretName}`);
    await fsp.writeFile(path.join(baseDir, 'wp-config.php'), renderConfig(settings, s.salts), { mode: 0o640 });
    configWritten = true;
    notes.push('generated wp-config.php');
  }

  return { version, configWritten, saltsCreated, notes };
}

module.exports = {
  WpError, SALT_KEYS,
  resolveVersion, tarballUrl, fetchCore, fetchSha1, extractCore,
  newSalts, saltsFor, saltSecretName,
  parseEnvBlock, readSettings, missingSettings, renderConfig,
  scaffold,
};
