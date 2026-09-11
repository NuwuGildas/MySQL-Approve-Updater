'use strict';
/* The process an optional backend module runs in.
 *
 * It is started by the host with an IPC channel and does nothing until it is
 * told which module to load, so the entry point itself carries no module code.
 * A worker is an isolation and lifecycle boundary - one module can crash, hang
 * or be shut down without touching the host or another module - and NOT a
 * security sandbox: it runs with this application's own privileges, which is
 * why only packages signed by a trusted publisher are ever installed.
 *
 * A module may answer in two ways:
 *   methods  - named RPC calls dispatched over IPC
 *   http     - a Node request listener (an Express app is one) served on a
 *              loopback port the host proxies to, so a module can keep real
 *              routers and real WebSocket endpoints without the host growing
 *              routes it cannot remove.
 */

const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { Module } = require('node:module');

const send = (message) => { try { process.send?.(message); } catch { /* channel already gone */ } };
const errorPayload = (error) => ({ message: error?.message || String(error), code: error?.code || null, status: error?.status || null, stack: error?.stack || null });

let instance = null;
let server = null;
const pendingHostCalls = new Map();
let hostCallSeq = 0;

/** Calls back into the host. Capability checks happen on the host side. */
function hostCall(method, params) {
  return new Promise((resolve, reject) => {
    const id = `h${++hostCallSeq}`;
    pendingHostCalls.set(id, { resolve, reject });
    send({ k: 'host-call', id, method, params });
  });
}

function makeHostApi(info) {
  return {
    id: info.id,
    version: info.version,
    hostSdkVersion: info.hostSdkVersion,
    dataDir: info.dataDir,          // module-owned user data; survives removal
    appDataDir: info.appDataDir,    // the application's data directory, for files a user already had
    codeDir: info.dir,
    capabilities: info.capabilities.slice(),
    can: (capability) => info.capabilities.includes(capability),
    /* A proposal carries its own label. The module describes a card with a
       function (proposalKinds[kind].label), and a function cannot cross to the
       host - so it is applied HERE, as the card is raised, and travels with it
       as plain text. Without this the host has no label at all and deciding the
       card fails with "handler.label is not a function". */
    call: (method, params) => {
      if (method !== 'assistant.propose' || !params || typeof params !== 'object' || params.label) return hostCall(method, params);
      const describe = instance?.proposalKinds?.[params.kind]?.label;
      if (typeof describe !== 'function') return hostCall(method, params);
      let label = null;
      try { label = describe(params); } catch { label = null; }
      return hostCall(method, label ? { ...params, label: String(label) } : params);
    },
    log: (level, message) => send({ k: 'log', level, message: String(message) }),
    emit: (name, payload) => send({ k: 'event', name, payload }),
    audit: (entry) => hostCall('audit.record', entry),
    settings: () => hostCall('settings.get', {}),
    /** Resolve a dependency the package ships with, from inside the package. */
    require: (request) => require(Module.createRequire(path.join(info.dir, 'noop.js')).resolve(request)),
    /** A library the HOST shares (declared in the manifest's sharedDependencies).
        It resolves from the host's own installation, which is what makes it work
        inside the packaged executable's snapshot. */
    shared: (request) => {
      if (!(info.sharedDependencies || []).includes(request)) throw new Error(`${info.id} did not declare "${request}" in sharedDependencies`);
      return require(request);
    },
  };
}

/** Serve the module's request listener on loopback, and tell the host where. */
function startHttp(listener, token) {
  return new Promise((resolve, reject) => {
    const wrapped = (req, res) => {
      // Only the host may reach this port; it is loopback-only and token-gated.
      if (req.headers['x-module-token'] !== token) { res.statusCode = 403; return res.end('forbidden'); }
      listener(req, res);
    };
    server = http.createServer(wrapped);
    server.on('upgrade', (req, socket, head) => {
      if (req.headers['x-module-token'] !== token) { socket.destroy(); return; }
      if (typeof listener.handleUpgrade === 'function') listener.handleUpgrade(req, socket, head);
      else socket.destroy();
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

/* A package's own code may `require('ssh2')` directly rather than going through
   host.shared(). Resolve those - and ONLY those, and only from inside the
   package - against the host's installation, which is what makes them work
   inside the packaged executable's snapshot where the package has no
   node_modules of its own. */
function shareDependencies(info) {
  const shared = new Set(info.sharedDependencies || []);
  if (!shared.size) return;
  const root = path.resolve(info.dir);
  const original = Module._resolveFilename;
  Module._resolveFilename = function resolveForModule(request, parent, ...rest) {
    if (shared.has(request) && parent?.filename && path.resolve(parent.filename).startsWith(root)) return require.resolve(request);
    return original.call(this, request, parent, ...rest);
  };
}

async function activate(info) {
  const entry = path.join(info.dir, info.entry);
  shareDependencies(info);
  // Loading the implementation is the first time any package code is executed.
  const implementation = require(entry);
  const activateFn = implementation.activate || implementation.default?.activate;
  if (typeof activateFn !== 'function') throw new Error(`${info.id}: backend entry must export activate(host)`);
  const host = makeHostApi(info);
  const result = (await activateFn(host)) || {};
  const token = crypto.randomUUID();
  const httpPort = result.http ? await startHttp(result.http, token) : null;
  instance = {
    methods: result.methods || {},
    assistantTools: result.assistantTools || {},
    proposalKinds: result.proposalKinds || {},
    busy: typeof result.busy === 'function' ? result.busy : () => false,
    deactivate: typeof result.deactivate === 'function' ? result.deactivate : async () => {},
    host,
  };
  send({
    k: 'ready',
    methods: Object.keys(instance.methods),
    assistantTools: Object.entries(instance.assistantTools).map(([name, tool]) => ({ name, ...describeTool(tool) })),
    proposalKinds: Object.keys(instance.proposalKinds),
    httpPort, httpToken: httpPort ? token : null,
  });
}

const describeTool = (tool) => ({ description: tool.description || '', parameters: tool.parameters || tool.schema || null, label: tool.label || null });

async function shutdown(reason) {
  const current = instance;
  instance = null;
  try { await current?.deactivate(); } catch (error) { send({ k: 'log', level: 'warn', message: `deactivate failed: ${error.message}` }); }
  if (server) await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }).catch?.(() => {});
  send({ k: 'bye', reason });
  // Give the channel a tick to flush before the process ends.
  setTimeout(() => process.exit(0), 20).unref?.();
}

process.on('message', async (message) => {
  if (!message || typeof message !== 'object') return;
  switch (message.k) {
    case 'init':
      try { await activate(message.module); }
      catch (error) { send({ k: 'fatal', error: errorPayload(error) }); setTimeout(() => process.exit(1), 20); }
      return;
    case 'call': {
      const { id, method, params, meta } = message;
      try {
        if (!instance) throw Object.assign(new Error('Module is not active'), { status: 503 });
        const handler = instance.methods[method];
        if (typeof handler !== 'function') throw Object.assign(new Error(`Unknown method ${method}`), { status: 404 });
        send({ k: 'result', id, ok: true, value: await handler(params, meta || {}) });
      } catch (error) { send({ k: 'result', id, ok: false, error: errorPayload(error) }); }
      return;
    }
    case 'tool': {
      const { id, name, params, meta } = message;
      try {
        const tool = instance?.assistantTools?.[name];
        if (!tool) throw Object.assign(new Error(`Unknown tool ${name}`), { status: 404 });
        send({ k: 'result', id, ok: true, value: await tool.run(params, meta || {}) });
      } catch (error) { send({ k: 'result', id, ok: false, error: errorPayload(error) }); }
      return;
    }
    case 'proposal': {
      const { id, kind, action, payload, meta } = message;
      try {
        const handler = instance?.proposalKinds?.[kind];
        const fn = handler && handler[action];
        if (typeof fn !== 'function') throw Object.assign(new Error(`Unknown proposal handler ${kind}.${action}`), { status: 404 });
        send({ k: 'result', id, ok: true, value: await fn(payload, meta || {}) });
      } catch (error) { send({ k: 'result', id, ok: false, error: errorPayload(error) }); }
      return;
    }
    case 'busy': {
      let busy = false;
      try { busy = !!(await instance?.busy()); } catch { busy = false; }
      send({ k: 'result', id: message.id, ok: true, value: busy });
      return;
    }
    case 'host-result': {
      const pending = pendingHostCalls.get(message.id);
      if (!pending) return;
      pendingHostCalls.delete(message.id);
      if (message.ok) pending.resolve(message.value);
      else pending.reject(Object.assign(new Error(message.error?.message || 'Host call failed'), { status: message.error?.status, code: message.error?.code }));
      return;
    }
    case 'shutdown':
      await shutdown(message.reason || 'host requested shutdown');
  }
});

process.on('uncaughtException', (error) => { send({ k: 'fatal', error: errorPayload(error) }); setTimeout(() => process.exit(1), 20); });
process.on('unhandledRejection', (reason) => { send({ k: 'log', level: 'warn', message: `unhandled rejection: ${reason}` }); });
process.on('disconnect', () => process.exit(0));
send({ k: 'hello', pid: process.pid });
