'use strict';
/* One supervised child process per active backend module.
 *
 * Packaging note: when this application runs as the packaged Windows
 * executable there is no `node` on the end user's machine, so the worker is the
 * SAME executable re-entered with the snapshot path of worker-entry.js. In
 * development it is a plain fork. Both give the child an IPC channel, which is
 * the only thing the protocol needs. lib/**\/*.js is listed under `pkg.scripts`
 * in package.json precisely so worker-entry.js exists inside the snapshot. */

const path = require('node:path');
const { fork, spawn } = require('node:child_process');

const WORKER_ENTRY = path.join(__dirname, 'worker-entry.js');
const READY_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 120_000;
const SHUTDOWN_GRACE_MS = 5_000;

const fail = (status, message, code) => Object.assign(new Error(message), { status, code });

function launch({ isPackaged, env }) {
  const options = { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, ...env, MODULE_WORKER: '1' } };
  return isPackaged ? spawn(process.execPath, [WORKER_ENTRY], options) : fork(WORKER_ENTRY, [], options);
}

/**
 * @param services  host-side implementation of the calls a worker makes back
 * @param events    { onEvent, onLog, onExit, onSocket }
 */
function createSupervisor({ isPackaged = false, services, log = () => {} } = {}) {
  const workers = new Map();

  function start(record, { onEvent = () => {}, onExit = () => {} } = {}) {
    const { id } = record;
    if (workers.has(id)) return workers.get(id).ready;

    const child = launch({ isPackaged, env: { MODULE_ID: id } });
    const pending = new Map();
    let seq = 0;
    let settled = false;
    let stopping = false;
    const state = { id, record, child, status: 'starting', methods: [], assistantTools: [], proposalKinds: [], httpPort: null, httpToken: null, error: null, startedAt: Date.now() };

    const readyPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (!settled) { settled = true; state.status = 'failed'; state.error = 'The module did not start in time.'; stop(id, 'startup timeout'); reject(fail(504, `${record.manifest.name} did not start in time.`, 'worker_timeout')); } }, READY_TIMEOUT_MS);
      state.resolveReady = (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
      state.rejectReady = (error) => { if (settled) return; settled = true; clearTimeout(timer); reject(error); };
    });

    child.stdout?.on('data', (chunk) => log('info', `[${id}] ${String(chunk).trimEnd()}`));
    child.stderr?.on('data', (chunk) => log('warn', `[${id}] ${String(chunk).trimEnd()}`));

    child.on('message', async (message) => {
      if (!message || typeof message !== 'object') return;
      switch (message.k) {
        case 'ready':
          state.status = 'ready';
          state.methods = message.methods || [];
          state.assistantTools = message.assistantTools || [];
          state.proposalKinds = message.proposalKinds || [];
          state.httpPort = message.httpPort || null;
          state.httpToken = message.httpToken || null;
          state.resolveReady(state);
          return;
        case 'fatal':
          // The worker is already on its way out; stop offering it as running.
          state.status = 'failed';
          state.error = message.error?.message || 'The module failed to start.';
          stopping = true;
          workers.delete(id);
          state.rejectReady(fail(500, `${record.manifest.name}: ${state.error}`, 'activation_failed'));
          return;
        case 'result': {
          const entry = pending.get(message.id);
          if (!entry) return;
          pending.delete(message.id);
          clearTimeout(entry.timer);
          if (message.ok) entry.resolve(message.value);
          else entry.reject(Object.assign(new Error(message.error?.message || 'Module call failed'), { status: message.error?.status || 500, code: message.error?.code || 'module_error' }));
          return;
        }
        case 'host-call': {
          try { child.send({ k: 'host-result', id: message.id, ok: true, value: await services.call(id, message.method, message.params, record) }); }
          catch (error) { child.send({ k: 'host-result', id: message.id, ok: false, error: { message: error.message, status: error.status, code: error.code } }); }
          return;
        }
        case 'event': onEvent(message.name, message.payload); return;
        case 'log': log(message.level || 'info', `[${id}] ${message.message}`); return;
        case 'bye': stopping = true;
      }
    });

    child.on('exit', (code, signal) => {
      workers.delete(id);
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(fail(503, `${record.manifest.name} stopped while handling this request.`, 'worker_gone')); }
      pending.clear();
      state.status = stopping ? 'stopped' : 'crashed';
      if (!stopping) {
        state.error = `The module process exited unexpectedly (${signal || 'code ' + code}).`;
        log('warn', `modules: ${id} worker exited unexpectedly (${signal || 'code ' + code})`);
      }
      state.rejectReady(fail(500, `${record.manifest.name} stopped before it was ready.`, 'activation_failed'));
      onExit({ id, code, signal, expected: stopping });
    });
    child.on('error', (error) => { state.status = 'failed'; state.error = error.message; state.rejectReady(fail(500, `${record.manifest.name} could not be started: ${error.message}`, 'worker_spawn_failed')); });

    function post(payload, { timeoutMs = CALL_TIMEOUT_MS } = {}) {
      return new Promise((resolve, reject) => {
        if (state.status === 'crashed' || state.status === 'stopped' || !child.connected) return reject(fail(503, `${record.manifest.name} is not running.`, 'worker_gone'));
        const callId = `c${++seq}`;
        const timer = setTimeout(() => { pending.delete(callId); reject(fail(504, `${record.manifest.name} did not answer in time.`, 'module_timeout')); }, timeoutMs);
        pending.set(callId, { resolve, reject, timer });
        child.send({ ...payload, id: callId });
      });
    }

    const worker = {
      state, child, ready: readyPromise,
      call: (method, params, meta) => post({ k: 'call', method, params, meta }),
      tool: (name, params, meta) => post({ k: 'tool', name, params, meta }),
      proposal: (kind, action, payload, meta) => post({ k: 'proposal', kind, action, payload, meta }),
      busy: () => post({ k: 'busy' }, { timeoutMs: 3_000 }).catch(() => false),
      stopping: () => stopping,
      markStopping: () => { stopping = true; },
    };
    workers.set(id, worker);
    child.send({ k: 'init', module: { ...record.workerInfo } });
    return readyPromise.then(() => worker);
  }

  async function stop(id, reason = 'removed') {
    const worker = workers.get(id);
    if (!worker) return false;
    worker.markStopping();
    const exited = new Promise((resolve) => worker.child.once('exit', resolve));
    try { worker.child.send({ k: 'shutdown', reason }); } catch { /* already gone */ }
    const timer = setTimeout(() => { try { worker.child.kill(); } catch {} }, SHUTDOWN_GRACE_MS);
    await exited;
    clearTimeout(timer);
    workers.delete(id);
    return true;
  }

  return {
    start, stop,
    get: (id) => workers.get(id) || null,
    has: (id) => workers.has(id),
    list: () => [...workers.values()].map((w) => ({ ...w.state, record: undefined, child: undefined, resolveReady: undefined, rejectReady: undefined })),
    async stopAll(reason = 'shutdown') { for (const id of [...workers.keys()]) await stop(id, reason); },
    WORKER_ENTRY,
  };
}

module.exports = { createSupervisor, WORKER_ENTRY };
