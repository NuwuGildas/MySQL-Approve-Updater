'use strict';
/* Installing a module.
 *
 * The order is fixed and every step can fail without leaving anything behind:
 *   plan (dependencies, cycles, compatibility)
 *     → download to staging (bounded, cancellable)
 *       → verify digest and publisher signature
 *         → inspect and extract the archive (no links, no traversal)
 *           → read and re-validate module.json against the catalog entry
 *             → publish: move code into place, then record installation state
 *
 * Nothing in a package is executed during installation. There are no lifecycle
 * scripts and no npm install: a package ships with the runtime dependencies it
 * needs, already built. */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const semver = require('./semver');
const { validateManifest } = require('./manifest');
const { downloadTo } = require('./download');
const archive = require('./archive');

const fail = (status, message, code) => { throw Object.assign(new Error(message), { status, code }); };

function createInstaller({ registry, catalogClient, verifier, hostSdkVersion, log = () => {} }) {
  /**
   * Work out everything that has to be installed, in the order it must happen.
   * Detects cycles in the requested graph and refuses versions this host cannot run.
   */
  async function plan(id, { version = '*', catalog = null, includeInstalled = false } = {}) {
    const source = catalog || (await catalogClient.load());
    const steps = [];
    const chosen = new Map();
    const visiting = new Set();

    function visit(moduleId, range, trail) {
      if (visiting.has(moduleId)) fail(409, `Circular module dependency: ${[...trail, moduleId].join(' → ')}`, 'dependency_cycle');
      const already = chosen.get(moduleId);
      if (already) {
        if (!semver.satisfies(already.version.version, range)) {
          fail(409, `${moduleId} is needed at ${range} and at another incompatible version in the same install.`, 'dependency_conflict');
        }
        return;
      }
      const installedVersion = registry.installedVersion(moduleId);
      if (!includeInstalled && registry.has(moduleId) && semver.satisfies(installedVersion, range)) return;

      const found = catalogClient.pick(source, moduleId, range);
      if (!found) {
        const listed = catalogClient.entry(source, moduleId);
        if (!listed) fail(404, `The module registry does not offer "${moduleId}".`, 'module_not_found');
        fail(409, `No version of ${listed.name} matches ${range} and host SDK ${hostSdkVersion}.`, 'incompatible_module');
      }
      visiting.add(moduleId);
      for (const [depId, depRange] of Object.entries(found.version.dependencies)) visit(depId, depRange, [...trail, moduleId]);
      visiting.delete(moduleId);
      chosen.set(moduleId, found);
      steps.push({
        id: moduleId, name: found.module.name, description: found.module.description,
        publisher: found.module.publisher, version: found.version.version,
        capabilities: found.version.capabilities, source: found.version.source,
        package: found.version.package, upgradeFrom: installedVersion,
      });
    }

    visit(id, version, []);
    return steps;
  }

  /** Download → verify → extract one package into a fresh staging directory. */
  async function stage(step, { signal, onProgress = () => {} } = {}) {
    const token = crypto.randomUUID();
    const dir = path.join(registry.layout.staging, `${step.id}-${token}`);
    const archivePath = path.join(registry.layout.cache, `${step.id}-${step.version}-${token}.tgz`);
    fs.mkdirSync(registry.layout.cache, { recursive: true });
    try {
      onProgress({ phase: 'download', received: 0, total: step.package.size });
      await downloadTo(step.package.url, archivePath, {
        expectedBytes: step.package.size, signal,
        onProgress: ({ received, total }) => onProgress({ phase: 'download', received, total }),
      });
      onProgress({ phase: 'verify' });
      const proof = await verifier.verifyPackage(archivePath, step.package, { moduleId: step.id, version: step.version });
      if (signal?.aborted) fail(499, 'Installation cancelled', 'cancelled');
      onProgress({ phase: 'extract' });
      const contents = await archive.extract(archivePath, dir);

      // The manifest inside the package must agree with the catalog entry that
      // was verified; otherwise a signed archive could describe a different module.
      let raw;
      try { raw = JSON.parse(await fsp.readFile(path.join(dir, 'module.json'), 'utf8')); }
      catch (error) { fail(400, `Package does not contain a readable module.json: ${error.message}`, 'invalid_package'); }
      const manifest = validateManifest(raw, { hostSdkVersion });
      if (manifest.id !== step.id) fail(400, `Package declares module "${manifest.id}" but the catalog offered "${step.id}".`, 'package_mismatch');
      if (manifest.version !== step.version) fail(400, `Package is version ${manifest.version} but the catalog offered ${step.version}.`, 'package_mismatch');
      if (!manifest.compatible) fail(409, `${manifest.name} ${manifest.version} needs host SDK ${manifest.hostSdk}; this host is ${hostSdkVersion}.`, 'incompatible_module');
      for (const entry of [manifest.frontend, manifest.backend, ...manifest.styles].filter(Boolean)) {
        if (!contents.files.includes(entry)) fail(400, `Package is missing its declared entry point ${entry}.`, 'invalid_package');
      }
      return { dir, manifest, proof, contents, cleanup: () => cleanup(dir, archivePath) };
    } catch (error) {
      await cleanup(dir, archivePath);
      throw error;
    }
  }

  async function cleanup(...targets) {
    for (const target of targets) await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
  }

  /**
   * Move the staged directory into place. A rename is atomic and is what we want,
   * but on Windows another process (an indexer, a virus scanner) can still hold a
   * handle on a file that was written a moment ago, which surfaces as EPERM. Retry
   * briefly, then fall back to a copy - which is not atomic, but the state
   * document is only written afterwards, so a half-copy is never "installed".
   */
  async function moveDirectory(from, to) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try { return await fsp.rename(from, to); }
      catch (error) {
        const retryable = ['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(error.code);
        if (error.code === 'EXDEV') break;
        if (!retryable || attempt === 4) { if (!retryable) throw error; break; }
        await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
      }
    }
    await fsp.rm(to, { recursive: true, force: true }).catch(() => {});
    await fsp.cp(from, to, { recursive: true });
    await fsp.rm(from, { recursive: true, force: true }).catch(() => {});
  }

  /**
   * Move staged code to its final versioned directory and record the install.
   * `activate` runs before the state document is written, so a module that fails
   * to start is never reported as installed.
   */
  async function publish(staged, step, { activate }) {
    const target = registry.codeDirFor(step.id, step.version);
    const previous = registry.get(step.id);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.rm(target, { recursive: true, force: true });
    await moveDirectory(staged.dir, target);
    const entry = {
      id: step.id, version: step.version, manifest: staged.manifest,
      installedAt: new Date().toISOString(),
      activationId: crypto.randomUUID(),   // changes on every install so caches cannot survive one
      digest: staged.proof.digest,
      publisher: staged.proof.publisher, signed: staged.proof.signed,
      source: step.source, packageUrl: step.package.url,
    };
    try {
      if (activate) await activate({ ...entry, dir: target });
    } catch (error) {
      // Roll the code directory back to whatever was there before.
      await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
      if (previous && previous.version !== step.version) log('warn', `modules: ${step.id} ${step.version} failed to activate; ${previous.version} is still installed`);
      throw error;
    }
    return registry.record(step.id, entry);
  }

  /** The whole flow for one module and everything it needs, newest dependency first. */
  async function install(id, { version = '*', signal, onProgress = () => {}, activate, catalog = null } = {}) {
    const steps = await plan(id, { version, catalog });
    if (!steps.length) return { installed: [], steps: [] };
    const done = [];
    for (const step of steps) {
      onProgress({ moduleId: step.id, version: step.version, phase: 'start', steps: steps.map((s) => s.id) });
      const staged = await stage(step, { signal, onProgress: (p) => onProgress({ moduleId: step.id, version: step.version, ...p }) });
      try {
        onProgress({ moduleId: step.id, version: step.version, phase: 'activate' });
        done.push(await publish(staged, step, { activate }));
      } finally { await staged.cleanup(); }
      onProgress({ moduleId: step.id, version: step.version, phase: 'installed' });
    }
    return { installed: done, steps };
  }

  return { plan, stage, publish, install };
}

module.exports = { createInstaller };
