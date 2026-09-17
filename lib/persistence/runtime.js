'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Worker, MessageChannel, receiveMessageOnPort } = require('node:worker_threads');
const { Writable } = require('node:stream');
const { connectionOptions, validateKey } = require('./mysql');
const { managedKey } = require('./paths');

// Explicit adapter: Node's global fs exports are never modified. Code/artifacts
// and machine keys use native IO; only the declared application documents use DB.
function createRuntime({ root, env = process.env, role = 'host', workerFactory } = {}) {
  root = path.resolve(root);
  const mode = env.APP_STORAGE || 'files';
  if (!['files', 'mysql'].includes(mode)) throw new Error('APP_STORAGE must be files or mysql');
  let worker;
  let fault = null;
  const timeout = 15000;
  const pending = new Set();
  function fail(error) {
    if (error.code !== 'ENOENT') fault = Object.assign(new Error(error.message), { code: error.code, status: 503 });
    throw error;
  }
  function healthy() { if (fault) throw fault; }
  function unpack(reply) {
    if (reply.error) return fail(Object.assign(new Error(reply.error.message), reply.error));
    return reply.value;
  }
  function sync(op, args = []) {
    healthy();
    const { port1, port2 } = new MessageChannel();
    const signal = new SharedArrayBuffer(4);
    try {
      worker.postMessage({ op, args, port: port2, signal }, [port2]);
      if (Atomics.wait(new Int32Array(signal), 0, 0, timeout) === 'timed-out') {
        return fail(Object.assign(new Error('Application storage timed out; restart before retrying writes'), { code: 'storage_timeout', status: 503 }));
      }
      const reply = receiveMessageOnPort(port1);
      if (!reply) return fail(Object.assign(new Error('Application storage worker stopped'), { code: 'storage_worker' }));
      return unpack(reply.message);
    } finally { port1.close(); }
  }
  function asyncCall(op, args = []) {
    healthy();
    const work = new Promise((resolve, reject) => {
      const { port1, port2 } = new MessageChannel();
      const finish = (fn, value) => { clearTimeout(timer); port1.close(); fn(value); };
      const timer = setTimeout(() => {
        fault = Object.assign(new Error('Application storage timed out; restart before retrying writes'), { code: 'storage_timeout', status: 503 });
        finish(reject, fault);
      }, timeout);
      port1.once('message', (reply) => {
        try { finish(resolve, unpack(reply)); } catch (e) { finish(reject, e); }
      });
      worker.postMessage({ op, args, port: port2 }, [port2]);
    });
    pending.add(work); work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  }
  if (mode === 'mysql') {
    worker = workerFactory ? workerFactory() : new Worker(path.join(__dirname, 'worker.js'), {
      workerData: { options: connectionOptions(env), role },
    });
    worker.on('error', () => { fault = Object.assign(new Error('Application storage worker failed'), { code: 'storage_worker', status: 503 }); });
    worker.unref();
    try { sync('ready'); } catch (error) { worker.terminate(); throw error; }
  }
  const keyFor = (file) => {
    const key = mode === 'mysql' ? managedKey(root, file) : null;
    // Host and module processes can both persist the vault. Their temporary
    // documents must never share a name, even when legacy code uses '.tmp'.
    return key?.endsWith('.tmp') ? `${key}.${process.pid}.tmp` : key;
  };
  const bytes = (body, options) => Buffer.isBuffer(body) || ArrayBuffer.isView(body)
    ? Buffer.from(body) : Buffer.from(body, typeof options === 'string' ? options : options?.encoding || 'utf8');
  const decode = (body, options) => {
    const buffer = Buffer.from(body);
    const encoding = typeof options === 'string' ? options : options?.encoding;
    return encoding ? buffer.toString(encoding) : buffer;
  };
  const native = { ...fs };
  const promises = { ...fsp };
  for (const [name, op] of [['readFile', 'read'], ['writeFile', 'write'], ['appendFile', 'append'], ['unlink', 'remove']]) {
    for (const synchronous of [false, true]) {
      const method = name + (synchronous ? 'Sync' : '');
      const target = synchronous ? native : promises;
      const real = synchronous ? fs : fsp;
      target[method] = (...args) => {
        const key = keyFor(args[0]);
        if (!key) return real[method](...args);
        validateKey(key);
        const input = [key];
        if (op === 'write' || op === 'append') input.push(bytes(args[1], args[2]));
        if (args[2]?.flag && !['w', 'a'].includes(args[2].flag)) throw new Error('Unsupported database write flag');
        const result = synchronous ? sync(op, input) : asyncCall(op, input);
        return op === 'read' ? (synchronous ? decode(result, args[1]) : result.then((v) => decode(v, args[1]))) : result;
      };
    }
  }
  native.existsSync = (file) => { const key = keyFor(file); return key ? sync('exists', [validateKey(key)]) : fs.existsSync(file); };
  for (const name of ['rename', 'copyFile']) {
    for (const synchronous of [false, true]) {
      const method = name + (synchronous ? 'Sync' : '');
      const target = synchronous ? native : promises;
      target[method] = (from, to, ...rest) => {
        const a = keyFor(from), b = keyFor(to);
        if (!a && !b) return (synchronous ? fs : fsp)[method](from, to, ...rest);
        if (!a || !b) throw new Error('Cannot move application data between storage backends');
        const args = [validateKey(a), validateKey(b)];
        return synchronous ? sync(name === 'rename' ? 'rename' : 'copy', args) : asyncCall(name === 'rename' ? 'rename' : 'copy', args);
      };
    }
  }
  native.createWriteStream = (file, options = {}) => {
    const key = keyFor(file);
    if (!key) return fs.createWriteStream(file, options);
    if (options.flags !== 'a') throw new Error('Database streams currently support append only');
    return new Writable({ write(chunk, encoding, callback) { asyncCall('append', [validateKey(key), Buffer.from(chunk)]).then(() => callback(), callback); } });
  };
  Object.defineProperty(native, 'promises', { value: promises });
  return {
    mode, fs: native, promises, keyFor, assertHealthy: healthy,
    middleware(req, res, next) {
      if (fault) return res.status(503).json({ error: fault.message });
      const json = res.json;
      res.json = function (body) {
        if (fault && this.statusCode < 400) { this.status(503); return json.call(this, { error: fault.message }); }
        return json.call(this, body);
      };
      next();
    },
    get status() { return { mode, healthy: !fault }; },
    async flush() { await Promise.all([...pending]); healthy(); },
    async close() { if (worker) { try { await Promise.allSettled([...pending]); if (!fault) await asyncCall('close'); } finally { await worker.terminate(); } } },
  };
}

let current;
function configure(options) { if (!current) current = createRuntime(options); return current; }
// Proxies defer choosing the backend until after .env has been loaded.
const fileApi = new Proxy({}, { get: (_, key) => (current?.fs || fs)[key] });
const promiseApi = new Proxy({}, { get: (_, key) => (current?.promises || fsp)[key] });
module.exports = { createRuntime, configure, fs: fileApi, promises: promiseApi, current: () => current };
