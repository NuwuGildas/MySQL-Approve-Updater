'use strict';
/* The module host: what the base application mounts once, and the only place
 * that knows an optional module can exist.
 *
 * Everything an installed module reaches the network through is here, so a
 * removed module leaves no Express route, no worker, no assistant tool and no
 * socket behind. There is one dispatcher (`/api/m/:id/:method`) rather than a
 * growing pile of routes that cannot be unregistered. */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');

const { HOST_SDK_VERSION, CAPABILITIES, describeCapability } = require('./sdk');
const { createRegistry } = require('./registry');
const { createCatalogClient } = require('./catalog');
const { createVerifier } = require('./verify');
const { createInstaller } = require('./installer');
const { createSupervisor } = require('./supervisor');
const { createServices } = require('./services');
const semver = require('./semver');

const fail = (status, message, code) => Object.assign(new Error(message), { status, code });
const MIME = {
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.html': 'text/html; charset=utf-8',
};

function createModuleHost({
  dataDir, rootDir, isPackaged = false, registries = [], requireSignature = true,
  providers = {}, log = () => {}, broadcast = () => {},
}) {
  const registry = createRegistry(dataDir, { hostSdkVersion: HOST_SDK_VERSION });
  const catalogClient = createCatalogClient({ registries, hostSdkVersion: HOST_SDK_VERSION, log });
  const verifier = createVerifier({
    trustFiles: [path.join(rootDir, 'config', 'trusted-publishers.json'), path.join(dataDir, 'trusted-publishers.json')],
    requireSignature,
  });
  const installer = createInstaller({ registry, catalogClient, verifier, hostSdkVersion: HOST_SDK_VERSION, log });
  const services = createServices({ ...providers, log, events: { broadcast: (name, payload, moduleId) => broadcast('module', { module: moduleId, name, payload }) } });
  const supervisor = createSupervisor({ isPackaged, services, log });

  const jobs = new Map();          // installation jobs, for progress and cancellation
  const activation = new Map();    // id → { status, error, startedAt }
  const assistantBridges = new Map();
  let announce = () => {};

  /* ---------------- assistant + proposal bridging ---------------- */
  /* A module's tools live in the host's tool table only while its worker is
     ready, and are removed the moment it stops. Nothing is left registered. */
  function bindAssistant(id, worker) {
    const tools = providers.assistant?.tools;
    const kinds = providers.assistant?.proposalKinds;
    const added = { tools: [], kinds: [] };
    for (const tool of worker.state.assistantTools) {
      if (!tools) break;
      if (tools[tool.name]) { log('warn', `modules: ${id} tried to replace the existing assistant tool ${tool.name}`); continue; }
      tools[tool.name] = {
        description: tool.description, parameters: tool.parameters, label: tool.label, module: id,
        enabled: () => supervisor.get(id)?.state.status === 'ready',
        run: (params, meta) => supervisor.get(id)?.tool(tool.name, params, meta) ?? Promise.reject(fail(503, 'This module is not running.', 'worker_gone')),
      };
      added.tools.push(tool.name);
    }
    for (const kind of worker.state.proposalKinds) {
      if (!kinds) break;
      if (kinds[kind]) { log('warn', `modules: ${id} tried to replace the existing proposal kind ${kind}`); continue; }
      kinds[kind] = {
        module: id,
        /* How the decision reads in the transcript, the log and the audit
           trail. The module's own label() ran in its worker when the card was
           raised (see worker-entry) and travelled with it; this is the fallback
           for a module that describes no label, and it must never throw - a
           missing description is not a reason to fail a decision. */
        label: (payload) => String(payload?.label || `${kind} proposal${payload?.targetName ? ` for "${payload.targetName}"` : ''}`),
        approve: async (payload, meta) => {
          const worker = supervisor.get(id);
          if (!worker) throw fail(503, 'This module is not running.', 'worker_gone');
          const result = await worker.proposal(kind, 'approve', payload, meta);
          // The card the user is looking at lives here, not in the worker: give it
          // what the command actually produced.
          if (result && typeof result === 'object') payload.result = result;
          return result;
        },
        reject: (payload, meta) => supervisor.get(id)?.proposal(kind, 'reject', payload, meta).catch(() => null),
      };
      added.kinds.push(kind);
    }
    assistantBridges.set(id, added);
  }
  function unbindAssistant(id) {
    const added = assistantBridges.get(id);
    if (!added) return;
    for (const name of added.tools) delete providers.assistant?.tools?.[name];
    for (const kind of added.kinds) delete providers.assistant?.proposalKinds?.[kind];
    assistantBridges.delete(id);
  }

  /* ---------------- lifecycle ---------------- */
  async function activate(record) {
    if (!record.manifest?.backend) { activation.set(record.id, { status: 'ready', backend: false }); return null; }
    activation.set(record.id, { status: 'starting', startedAt: Date.now() });
    const workerInfo = {
      id: record.id, version: record.version, dir: record.dir, entry: record.manifest.backend,
      dataDir: registry.dataDirFor(record.id), appDataDir: dataDir, capabilities: record.manifest.capabilities,
      sharedDependencies: record.manifest.sharedDependencies || [],
      hostSdkVersion: HOST_SDK_VERSION,
    };
    try {
      const worker = await supervisor.start({ ...record, workerInfo }, {
        onEvent: (name, payload) => broadcast('module', { module: record.id, name, payload }),
        onExit: ({ id, expected }) => {
          unbindAssistant(id);
          if (!expected) {
            activation.set(id, { status: 'crashed', error: `${record.manifest.name} stopped unexpectedly.` });
            log('warn', `modules: ${id} crashed; other modules and the host are unaffected`);
            announce();
          }
        },
      });
      bindAssistant(record.id, worker);
      activation.set(record.id, { status: 'ready', backend: true, pid: worker.child.pid });
      return worker;
    } catch (error) {
      activation.set(record.id, { status: 'failed', error: error.message });
      await supervisor.stop(record.id, 'activation failed').catch(() => {});
      throw error;
    }
  }

  async function deactivate(id, reason = 'removed') {
    unbindAssistant(id);
    await supervisor.stop(id, reason);
    activation.delete(id);
  }

  /** Bring back everything that was installed before the application restarted. */
  async function restore() {
    await registry.sweepStaging();
    for (const record of registry.list()) {
      if (record.broken) { activation.set(record.id, { status: 'failed', error: record.broken }); log('warn', `modules: ${record.id} is installed but unusable — ${record.broken}`); continue; }
      try { await activate(record); log('info', `modules: ${record.id} ${record.version} active`); }
      catch (error) { log('warn', `modules: ${record.id} failed to start — ${error.message}`); }
    }
    announce();
  }

  /* ---------------- state the browser sees ---------------- */
  async function snapshot({ refreshCatalog = false } = {}) {
    const catalog = await catalogClient.load({ force: refreshCatalog }).catch(() => ({ modules: [], failures: [] }));
    const installedById = new Map(registry.list().map((m) => [m.id, m]));
    const seen = new Set();
    const view = [];

    for (const entry of catalog.modules) {
      seen.add(entry.id);
      const installed = installedById.get(entry.id);
      const latest = entry.versions.filter((v) => v.compatible).sort((a, b) => semver.compare(a.version, b.version)).pop() || null;
      view.push(describe(entry, installed, latest));
    }
    for (const installed of installedById.values()) {
      if (seen.has(installed.id)) continue;
      view.push(describe(null, installed, null));   // installed but no longer offered
    }
    return {
      version: 2, hostSdk: HOST_SDK_VERSION,
      registries: catalogClient.sources.map((s) => ({ name: s.name, url: s.url })),
      registryFailures: catalog.failures || [],
      publishers: verifier.publishers(),
      capabilities: CAPABILITIES,
      jobs: [...jobs.values()].map(publicJob),
      modules: view.sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  function describe(entry, installed, latest) {
    const manifest = installed?.manifest || null;
    const state = activation.get(installed?.id) || null;
    const job = [...jobs.values()].find((j) => j.moduleId === (entry?.id || installed?.id) && j.status === 'running');
    const id = entry?.id || installed.id;
    const capabilities = (manifest?.capabilities || latest?.capabilities || []).map((c) => ({ id: c, label: describeCapability(c) }));
    const dependencies = manifest ? manifest.dependencies : (latest?.dependencies || {});
    return {
      id,
      name: entry?.name || manifest?.name || id,
      description: entry?.description || manifest?.description || '',
      publisher: installed?.publisher?.name || entry?.publisher || manifest?.publisher || 'Unknown publisher',
      installed: !!installed,
      installedVersion: installed?.version || null,
      availableVersion: latest?.version || null,
      updateAvailable: !!(installed && latest && semver.compare(latest.version, installed.version) > 0),
      hostSdk: latest?.hostSdk || manifest?.hostSdk || null,
      compatible: latest ? true : !!manifest?.compatible,
      dependencies: Object.entries(dependencies).map(([depId, range]) => ({ id: depId, range, installed: registry.has(depId) })),
      requiredBy: registry.dependents(id).map((m) => ({ id: m.id, name: m.manifest?.name || m.id })),
      capabilities,
      status: job ? 'installing' : installed ? (state?.status === 'ready' ? 'active' : state?.status || 'inactive') : (entry ? 'available' : 'unavailable'),
      error: state?.status && state.status !== 'ready' ? state.error || installed?.broken || null : installed?.broken || null,
      hasFrontend: !!manifest?.frontend,
      hasBackend: !!manifest?.backend,
      // The browser imports this exact URL. It changes on every install, so a new
      // copy of the module is evaluated instead of the one the engine cached.
      entryUrl: installed && manifest?.frontend ? `/api/modules/${id}/asset/${installed.activationId}/${manifest.frontend}` : null,
      styleUrls: installed && manifest?.styles?.length ? manifest.styles.map((s) => `/api/modules/${id}/asset/${installed.activationId}/${s}`) : [],
      signed: installed ? !!installed.signed : null,
      source: installed?.source || latest?.source || null,
      installedAt: installed?.installedAt || null,
      pages: manifest?.pages || [],
    };
  }

  const publicJob = (job) => ({ id: job.id, moduleId: job.moduleId, kind: job.kind, status: job.status, phase: job.phase, received: job.received, total: job.total, steps: job.steps, error: job.error, startedAt: job.startedAt });

  /* ---------------- install / remove / update ---------------- */
  async function isBusy(id) {
    const worker = supervisor.get(id);
    if (!worker) return false;
    return !!(await worker.busy());
  }

  function startJob(kind, moduleId, run) {
    const job = { id: crypto.randomUUID(), kind, moduleId, status: 'running', phase: 'plan', received: 0, total: null, steps: [], error: null, startedAt: Date.now(), controller: new AbortController() };
    jobs.set(job.id, job);
    announce();
    job.promise = run(job).then(
      (value) => { job.status = 'done'; job.phase = 'done'; job.result = value; announce(); scheduleForget(job); return value; },
      (error) => { job.status = 'failed'; job.error = error.message; job.code = error.code || null; announce(); scheduleForget(job); throw error; },
    );
    return job;
  }
  const scheduleForget = (job) => setTimeout(() => jobs.delete(job.id), 60_000).unref?.();

  function install(id, { version = '*' } = {}) {
    // One installation at a time: the registry lock serialises concurrent requests
    // from different tabs so two installs cannot interleave their state writes.
    return startJob('install', id, (job) => registry.withLock('install', async () => {
      if (registry.has(id) && version === '*') throw fail(409, 'That module is already installed.', 'already_installed');
      const result = await installer.install(id, {
        version, signal: job.controller.signal,
        onProgress: (progress) => {
          job.phase = progress.phase || job.phase;
          job.moduleId = progress.moduleId || job.moduleId;
          if (progress.steps) job.steps = progress.steps;
          if (progress.received !== undefined) { job.received = progress.received; job.total = progress.total; }
          announce();
        },
        activate: async (record) => { await activate({ ...record, manifest: record.manifest }); },
      });
      announce();
      return result.installed.map((r) => r.id);
    }));
  }

  function remove(id) {
    return startJob('remove', id, () => registry.withLock('install', async () => {
      const record = registry.get(id);
      if (!record) throw fail(404, 'That module is not installed.', 'not_installed');
      const dependents = registry.dependents(id);
      if (dependents.length) throw fail(409, `Remove ${dependents.map((d) => d.manifest?.name || d.id).join(', ')} first — ${record.manifest?.name || id} is required by ${dependents.length === 1 ? 'it' : 'them'}.`, 'has_dependents');
      if (await isBusy(id)) throw fail(409, `${record.manifest?.name || id} has work in progress. Finish or stop it before removing the module.`, 'module_busy');
      await deactivate(id, 'removed');
      await registry.forget(id);
      announce();
      return id;
    }));
  }

  function update(id, { version = '*' } = {}) {
    return startJob('update', id, (job) => registry.withLock('install', async () => {
      const record = registry.get(id);
      if (!record) throw fail(404, 'That module is not installed.', 'not_installed');
      if (await isBusy(id)) throw fail(409, `${record.manifest?.name || id} has work in progress; it will not be updated while that is running.`, 'module_busy');
      const steps = await installer.plan(id, { version, includeInstalled: true });
      const target = steps.find((s) => s.id === id);
      if (!target || semver.compare(target.version, record.version) <= 0) throw fail(409, 'There is no newer version to install.', 'no_update');
      // Staging happens first; the running worker is only stopped once the new
      // version is on disk and verified.
      const staged = await installer.stage(target, { signal: job.controller.signal, onProgress: (p) => { job.phase = p.phase; job.received = p.received ?? job.received; job.total = p.total ?? job.total; announce(); } });
      job.phase = 'activate'; announce();
      await deactivate(id, 'updating');
      try {
        await installer.publish(staged, target, { activate: async (record2) => { await activate(record2); } });
      } catch (error) {
        // Put the version that was working back.
        await activate(registry.get(id)).catch(() => {});
        throw error;
      } finally { await staged.cleanup(); }
      announce();
      return target.version;
    }));
  }

  /* ---------------- proxy to a module's own HTTP surface ----------------
     A backend module may answer with a Node request listener (an Express app).
     It listens on a loopback port with a per-activation token, and the host
     forwards `/api/m/<id>/http/...` to it. That keeps the host's routing table
     fixed: removing a module removes the only route that could reach it. */
  function workerTarget(id) {
    const worker = supervisor.get(id);
    if (!worker || worker.state.status !== 'ready') return null;
    return worker.state.httpPort ? { port: worker.state.httpPort, token: worker.state.httpToken } : null;
  }

  function proxyRequest(id, req, res) {
    const target = workerTarget(id);
    const record = registry.get(id);
    if (!target) { res.statusCode = 503; return res.end(JSON.stringify({ error: `${record?.manifest?.name || id} is not running.`, code: 'module_inactive' })); }
    const headers = { ...req.headers, 'x-module-token': target.token, host: `127.0.0.1:${target.port}` };
    delete headers['content-length'];
    const upstream = http.request({ host: '127.0.0.1', port: target.port, method: req.method, path: req.url, headers }, (answer) => {
      res.writeHead(answer.statusCode || 502, answer.headers);
      answer.pipe(res);
    });
    upstream.on('error', (error) => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: `${record?.manifest?.name || id}: ${error.message}`, code: 'module_unreachable' })); });
    // express.json() has already consumed the body for API routes, so replay it.
    if (req.body !== undefined && req.readableEnded) { upstream.end(Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body))); }
    else req.pipe(upstream);
  }

  /** WebSocket upgrades a module owns are relayed at the socket level. */
  function proxyUpgrade(id, req, socket, head, rest) {
    const target = workerTarget(id);
    if (!target) { socket.destroy(); return; }
    const upstream = http.request({
      host: '127.0.0.1', port: target.port, path: rest, method: 'GET',
      headers: { ...req.headers, 'x-module-token': target.token, host: `127.0.0.1:${target.port}` },
    });
    upstream.on('upgrade', (answer, upstreamSocket, upstreamHead) => {
      socket.write(`HTTP/1.1 101 ${answer.statusMessage || 'Switching Protocols'}\r\n` +
        Object.entries(answer.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
      if (upstreamHead?.length) socket.write(upstreamHead);
      if (head?.length) upstreamSocket.write(head);
      socket.pipe(upstreamSocket).pipe(socket);
      const drop = () => { try { socket.destroy(); } catch {} try { upstreamSocket.destroy(); } catch {} };
      socket.on('error', drop); upstreamSocket.on('error', drop);
    });
    upstream.on('response', () => socket.destroy());
    upstream.on('error', () => socket.destroy());
    upstream.end();
  }

  /* ---------------- HTTP surface ---------------- */
  function mount(app, { wrap = (fn) => fn } = {}) {
    const router = express.Router();

    router.get('/', wrap(async (req, res) => res.json(await snapshot({ refreshCatalog: req.query.refresh === '1' }))));
    router.get('/jobs/:id', (req, res) => {
      const job = jobs.get(req.params.id);
      if (!job) return res.status(404).json({ error: 'No such installation job' });
      res.json(publicJob(job));
    });
    router.post('/jobs/:id/cancel', (req, res) => {
      const job = jobs.get(req.params.id);
      if (!job || job.status !== 'running') return res.status(404).json({ error: 'No such installation job' });
      job.controller.abort();
      res.json({ ok: true });
    });

    router.post('/:id/install', wrap(async (req, res) => {
      const job = install(req.params.id, { version: req.body?.version || '*' });
      // The caller waits for BOTH backend activation and a recorded install; a
      // module is never reported as added before it is actually running.
      try { await job.promise; } catch (error) { return res.status(error.status || 500).json({ error: error.message, code: error.code || null, jobId: job.id }); }
      res.json({ ok: true, jobId: job.id, installed: job.result, state: await snapshot() });
    }));
    router.post('/:id/remove', wrap(async (req, res) => {
      const job = remove(req.params.id);
      try { await job.promise; } catch (error) { return res.status(error.status || 500).json({ error: error.message, code: error.code || null }); }
      res.json({ ok: true, state: await snapshot() });
    }));
    router.post('/:id/update', wrap(async (req, res) => {
      const job = update(req.params.id, { version: req.body?.version || '*' });
      try { await job.promise; } catch (error) { return res.status(error.status || 500).json({ error: error.message, code: error.code || null, jobId: job.id }); }
      res.json({ ok: true, jobId: job.id, version: job.result, state: await snapshot() });
    }));
    router.post('/:id/retry', wrap(async (req, res) => {
      const record = registry.get(req.params.id);
      if (!record) return res.status(404).json({ error: 'That module is not installed.' });
      await deactivate(req.params.id, 'retry').catch(() => {});
      try { await activate(record); } catch (error) { return res.status(500).json({ error: error.message }); }
      announce();
      res.json({ ok: true, state: await snapshot() });
    }));

    /* Frontend assets. Only files inside an installed module's own directory, and
       only through the activation id that install produced. */
    router.get('/:id/asset/:activation/*', wrap(async (req, res) => {
      const record = registry.get(req.params.id);
      if (!record || record.broken) return res.status(404).type('text/plain').send('Module not installed');
      if (record.activationId !== req.params.activation) return res.status(409).type('text/plain').send('This module was reinstalled; reload its entry point.');
      const relative = req.params[0];
      const target = path.resolve(record.dir, relative);
      const root = path.resolve(record.dir);
      if (target !== root && !target.startsWith(root + path.sep)) return res.status(400).type('text/plain').send('Bad asset path');
      const allowed = [record.manifest.frontend, ...record.manifest.styles].filter(Boolean);
      // The declared entry points, plus whatever they import from the frontend folder.
      const rel = path.relative(root, target).split(path.sep).join('/');
      if (!allowed.includes(rel) && !rel.startsWith('frontend/')) return res.status(403).type('text/plain').send('Not a published module asset');
      let body;
      try { body = await fsp.readFile(target); } catch { return res.status(404).type('text/plain').send('Not found'); }
      res.type(MIME[path.extname(target).toLowerCase()] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.send(body);
    }));

    app.use('/api/modules', router);

    /* A module's own HTTP surface, reached through the host and nothing else. */
    app.use('/api/m/:id/http', (req, res) => proxyRequest(req.params.id, req, res));

    /* The single RPC dispatcher every module frontend talks to. */
    app.all('/api/m/:id/:method', wrap(async (req, res) => {
      const { id, method } = req.params;
      const record = registry.get(id);
      if (!record || record.broken) throw fail(404, 'That module is not installed.', 'not_installed');
      const worker = supervisor.get(id);
      if (!worker || worker.state.status !== 'ready') throw fail(503, `${record.manifest?.name || id} is not running.`, 'module_inactive');
      if (!worker.state.methods.includes(method)) throw fail(404, `${record.manifest?.name || id} has no "${method}" method.`, 'unknown_method');
      const params = req.method === 'GET' || req.method === 'DELETE' ? { ...req.query } : { ...req.query, ...(req.body || {}) };
      // Which project the caller is working in, kept out of params so it cannot
      // collide with a module's own fields. Module HTTP surfaces read the header.
      const value = await worker.call(method, params, { method: req.method, projectId: req.get('x-project') || null });
      if (value && value.__raw) {
        res.status(value.status || 200);
        if (value.headers) for (const [k, v] of Object.entries(value.headers)) res.setHeader(k, v);
        return res.type(value.type || 'text/plain').send(value.body);
      }
      res.json(value === null || value === undefined ? { ok: true } : value);
    }));

    return router;
  }

  return {
    HOST_SDK_VERSION, registry, catalogClient, installer, supervisor, verifier, services,
    mount, restore, snapshot, install, remove, update, activate, deactivate, proxyUpgrade, workerTarget,
    isBusy, has: (id) => registry.has(id) && activation.get(id)?.status === 'ready',
    setAnnounce: (fn) => { announce = () => { snapshot().then((s) => fn(s)).catch(() => {}); }; },
    async shutdown() { await supervisor.stopAll('application shutdown'); },
    jobs,
  };
}

module.exports = { createModuleHost, HOST_SDK_VERSION };
