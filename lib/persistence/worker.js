'use strict';
// Owns the database socket on a separate event loop. Legacy sync callers can
// wait for a COMMITTED write without blocking the socket that acknowledges it.
const { parentPort, workerData } = require('node:worker_threads');
const mysql = require('mysql2/promise');
const { createMysqlStore, lockName } = require('./mysql');
let connection;
let store;
const revisions = new Map();
const ready = (async () => {
  const { connectionLimit, ...options } = workerData.options;
  if (options.ssl?.ca) options.ssl.ca = Buffer.from(options.ssl.ca);
  connection = await mysql.createConnection({ ...options, connectTimeout: 10000 });
  connection.on('error', () => {}); // subsequent commands report connection loss
  const lock = lockName(options.database, workerData.role);
  const [[row]] = await connection.execute('SELECT GET_LOCK(?, 0) AS acquired', [lock]);
  if (Number(row.acquired) !== 1) throw Object.assign(new Error('Another storage writer is already running for this role'), { code: 'storage_locked' });
  store = createMysqlStore(connection);
  await connection.query('SELECT document_key FROM st_documents LIMIT 0');
  const [documents] = await connection.query("SELECT document_key, body FROM st_documents WHERE document_key LIKE '%.json'");
  for (const document of documents) {
    try { JSON.parse(Buffer.from(document.body).toString('utf8')); }
    catch { throw Object.assign(new Error('Invalid persisted JSON'), { code: 'storage_invalid_json' }); }
  }
})();
ready.catch(() => {});

async function read(key) {
  const record = await store.get(key);
  revisions.set(key, record?.revision || 0);
  return record;
}
async function write(key, body) {
  if (!revisions.has(key)) await read(key);
  revisions.set(key, await store.put(key, Buffer.from(body), revisions.get(key)));
}
const missing = () => Object.assign(new Error('Stored document does not exist'), { code: 'ENOENT' });
async function dispatch(op, args) {
  await ready;
  const [key, value] = args;
  switch (op) {
    case 'ready': return true;
    case 'read': { const record = await read(key); if (!record) throw missing(); return record.body; }
    case 'exists': return !!(await read(key));
    case 'write': await write(key, value); return;
    case 'append': {
      // Appends are atomic and never read/rewrite the whole accumulated log.
      await connection.execute('INSERT INTO st_documents (document_key, body) VALUES (?, ?) ON DUPLICATE KEY UPDATE body = CONCAT(body, ?), revision = revision + 1', [key, Buffer.from(value), Buffer.from(value)]);
      revisions.delete(key);
      return;
    }
    case 'remove': {
      const record = await read(key);
      if (!record) throw missing();
      const [result] = await connection.execute('DELETE FROM st_documents WHERE document_key = ? AND revision = ?', [key, record.revision]);
      if (result.affectedRows !== 1) throw Object.assign(new Error('Concurrent document change'), { code: 'storage_conflict' });
      revisions.delete(key); return;
    }
    case 'copy':
    case 'rename': {
      const before = new Map(revisions);
      await connection.beginTransaction();
      try {
        const record = await read(key);
        if (!record) throw missing();
        await write(value, record.body);
        if (op === 'rename') {
          const [result] = await connection.execute('DELETE FROM st_documents WHERE document_key = ? AND revision = ?', [key, record.revision]);
          if (result.affectedRows !== 1) throw Object.assign(new Error('Concurrent document change'), { code: 'storage_conflict' });
          revisions.delete(key);
        }
        await connection.commit();
      } catch (error) {
        revisions.clear(); for (const [k, v] of before) revisions.set(k, v);
        await connection.rollback(); throw error;
      }
      return;
    }
    case 'close': await connection.end(); return;
    default: throw new Error('Unknown persistence operation');
  }
}
let chain = Promise.resolve();
parentPort.on('message', ({ op, args, port, signal }) => {
  const run = chain.then(() => dispatch(op, args));
  chain = run.catch(() => {});
  run.then((value) => port.postMessage({ value }), (error) => port.postMessage({ error: {
    code: error.code || 'storage_error', status: 503,
    // mysql errors and JSON payloads can contain credentials; do not forward them.
    message: error.code === 'ENOENT' ? 'Stored document does not exist' : `Application storage failed (${error.code || 'storage_error'}). Restart after resolving the database issue.`,
  } })).finally(() => {
    if (signal) { const state = new Int32Array(signal); Atomics.store(state, 0, 1); Atomics.notify(state, 0); }
    port.close();
  });
});
