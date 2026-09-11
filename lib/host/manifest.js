'use strict';
/* Validation for the two documents the host trusts least: a package's own
   module.json, and a marketplace catalog. Both are checked before anything is
   downloaded, extracted, imported or executed. Every failure names the field. */

const semver = require('./semver');
const { HOST_SDK_VERSION, PACKAGE_FORMAT, CATALOG_VERSION, isKnownCapability, isSharedDependency } = require('./sdk');

const ID_RE = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
const ENTRY_RE = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
const PACKAGE_NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const fail = (message) => { throw Object.assign(new Error(message), { status: 400, code: 'invalid_manifest' }); };

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** A relative POSIX path that cannot climb out of the package. */
function entryPath(value, field) {
  const s = str(value);
  if (!s) return null;
  if (!ENTRY_RE.test(s) || s.split('/').some((p) => p === '.' || p === '..')) fail(`${field} must be a relative path inside the package`);
  return s;
}

/**
 * Validate a module manifest (module.json). Returns a normalised copy; the
 * original object is never trusted again after this point.
 */
function validateManifest(raw, { hostSdkVersion = HOST_SDK_VERSION } = {}) {
  if (!isObject(raw)) fail('module.json must be a JSON object');
  if (raw.packageFormat !== PACKAGE_FORMAT) fail(`packageFormat must be ${PACKAGE_FORMAT} (found ${JSON.stringify(raw.packageFormat)})`);
  const id = str(raw.id);
  if (!ID_RE.test(id)) fail('id must be lowercase letters, digits and hyphens (3-40 characters)');
  const name = str(raw.name);
  if (!name || name.length > 80) fail('name is required (max 80 characters)');
  const description = str(raw.description);
  if (!description || description.length > 400) fail('description is required (max 400 characters)');
  if (!semver.valid(raw.version)) fail('version must be a semantic version such as 1.0.0');
  const hostSdk = str(raw.hostSdk);
  if (!semver.validRange(hostSdk)) fail('hostSdk must be a version range such as ^1.0.0');

  const frontend = entryPath(raw.frontend, 'frontend');
  const backend = entryPath(raw.backend, 'backend');
  if (!frontend && !backend) fail('a module must declare a frontend entry, a backend entry, or both');

  const dependencies = {};
  if (raw.dependencies !== undefined) {
    if (!isObject(raw.dependencies)) fail('dependencies must be an object of moduleId → version range');
    for (const [depId, range] of Object.entries(raw.dependencies)) {
      if (!ID_RE.test(depId)) fail(`dependencies: "${depId}" is not a valid module id`);
      if (depId === id) fail('a module cannot depend on itself');
      if (!semver.validRange(range)) fail(`dependencies.${depId} is not a version range`);
      dependencies[depId] = str(range) || '*';
    }
  }

  const sharedDependencies = [];
  if (raw.sharedDependencies !== undefined) {
    if (!Array.isArray(raw.sharedDependencies)) fail('sharedDependencies must be an array');
    for (const name of raw.sharedDependencies) {
      const s = str(name);
      if (!isSharedDependency(s)) fail(`sharedDependencies: this host does not share "${s}"`);
      if (!sharedDependencies.includes(s)) sharedDependencies.push(s);
    }
  }

  const bundledDependencies = [];
  if (raw.bundledDependencies !== undefined) {
    if (!Array.isArray(raw.bundledDependencies)) fail('bundledDependencies must be an array');
    for (const name of raw.bundledDependencies) {
      const s = str(name);
      if (!PACKAGE_NAME_RE.test(s)) fail(`bundledDependencies: "${s}" is not an npm package name`);
      if (!bundledDependencies.includes(s)) bundledDependencies.push(s);
    }
  }

  const capabilities = [];
  if (raw.capabilities !== undefined) {
    if (!Array.isArray(raw.capabilities)) fail('capabilities must be an array');
    for (const capability of raw.capabilities) {
      const c = str(capability);
      if (!isKnownCapability(c)) fail(`capabilities: this host does not grant "${c}"`);
      if (!capabilities.includes(c)) capabilities.push(c);
    }
  }

  const compatible = semver.satisfies(hostSdkVersion, hostSdk);
  return {
    packageFormat: PACKAGE_FORMAT, id, name, description,
    version: str(raw.version), hostSdk: hostSdk || '*',
    publisher: str(raw.publisher) || 'Unknown publisher',
    frontend, backend, dependencies, capabilities, sharedDependencies, bundledDependencies,
    styles: Array.isArray(raw.styles) ? raw.styles.map((s, i) => entryPath(s, `styles[${i}]`)).filter(Boolean) : [],
    pages: Array.isArray(raw.pages) ? raw.pages.map((p) => str(p)).filter(Boolean) : [],
    compatible,
  };
}

/** Package reference inside a catalog entry: where the bytes are and how to prove them. */
function validatePackageRef(raw, where) {
  if (!isObject(raw)) fail(`${where}.package must be an object`);
  const url = str(raw.url);
  let parsed;
  try { parsed = new URL(url); } catch { fail(`${where}.package.url must be an absolute URL`); }
  if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) fail(`${where}.package.url must be http, https or file`);
  const sha256 = str(raw.sha256).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) fail(`${where}.package.sha256 must be a 64-character hex digest`);
  const size = Number(raw.size);
  if (!Number.isInteger(size) || size <= 0) fail(`${where}.package.size must be the archive size in bytes`);
  const signature = str(raw.signature);
  if (signature && !/^[A-Za-z0-9+/=]+$/.test(signature)) fail(`${where}.package.signature must be base64`);
  const keyId = str(raw.keyId);
  if (keyId && !/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) fail(`${where}.package.keyId is not a key identifier`);
  return { url, sha256, size, signature: signature || null, keyId: keyId || null, algorithm: str(raw.algorithm) || 'ed25519' };
}

function validateVersionEntry(raw, moduleId, { hostSdkVersion = HOST_SDK_VERSION } = {}) {
  const where = `modules.${moduleId}`;
  if (!isObject(raw)) fail(`${where}.versions[] entries must be objects`);
  if (!semver.valid(raw.version)) fail(`${where}: version must be a semantic version`);
  const hostSdk = str(raw.hostSdk) || '*';
  if (!semver.validRange(hostSdk)) fail(`${where} ${raw.version}: hostSdk must be a version range`);
  const dependencies = {};
  if (raw.dependencies !== undefined) {
    if (!isObject(raw.dependencies)) fail(`${where} ${raw.version}: dependencies must be an object`);
    for (const [depId, range] of Object.entries(raw.dependencies)) {
      if (!ID_RE.test(depId)) fail(`${where} ${raw.version}: "${depId}" is not a valid module id`);
      if (!semver.validRange(range)) fail(`${where} ${raw.version}: dependencies.${depId} is not a version range`);
      dependencies[depId] = str(range) || '*';
    }
  }
  const capabilities = Array.isArray(raw.capabilities) ? raw.capabilities.map(str).filter(Boolean) : [];
  for (const capability of capabilities) if (!isKnownCapability(capability)) fail(`${where} ${raw.version}: unknown capability "${capability}"`);
  const source = isObject(raw.source) ? raw.source : {};
  const commit = str(source.commit);
  if (commit && !/^[0-9a-f]{7,40}$/.test(commit)) fail(`${where} ${raw.version}: source.commit must be a git object id`);
  return {
    version: str(raw.version), hostSdk, dependencies, capabilities,
    source: { branch: str(source.branch) || null, commit: commit || null, repository: str(source.repository) || null },
    package: validatePackageRef(raw.package, `${where} ${raw.version}`),
    releasedAt: str(raw.releasedAt) || null,
    compatible: semver.satisfies(hostSdkVersion, hostSdk),
  };
}

/**
 * Validate a marketplace catalog. The publisher key lives in the host's trust
 * store, not in the catalog, so a catalog can name a publisher but cannot
 * introduce one.
 */
function validateCatalog(raw, { hostSdkVersion = HOST_SDK_VERSION } = {}) {
  if (!isObject(raw)) fail('catalog must be a JSON object');
  if (raw.catalogVersion !== CATALOG_VERSION) fail(`catalogVersion must be ${CATALOG_VERSION}`);
  if (!Array.isArray(raw.modules)) fail('catalog.modules must be an array');
  const seen = new Set();
  const modules = raw.modules.map((entry) => {
    if (!isObject(entry)) fail('catalog.modules[] entries must be objects');
    const id = str(entry.id);
    if (!ID_RE.test(id)) fail(`catalog: "${id}" is not a valid module id`);
    if (seen.has(id)) fail(`catalog lists ${id} twice`);
    seen.add(id);
    if (!Array.isArray(entry.versions) || !entry.versions.length) fail(`catalog.modules.${id}.versions must be a non-empty array`);
    const versions = entry.versions.map((v) => validateVersionEntry(v, id, { hostSdkVersion }))
      .sort((a, b) => semver.compare(a.version, b.version));
    return {
      id,
      name: str(entry.name) || id,
      description: str(entry.description),
      publisher: str(entry.publisher) || 'Unknown publisher',
      homepage: str(entry.homepage) || null,
      versions,
    };
  });
  return { catalogVersion: CATALOG_VERSION, name: str(raw.name) || 'Modules', modules };
}

module.exports = { validateManifest, validateCatalog, validateVersionEntry, validatePackageRef, ID_RE };
