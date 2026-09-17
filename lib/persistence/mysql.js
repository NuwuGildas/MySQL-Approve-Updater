'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');

const schema = [
  `CREATE TABLE IF NOT EXISTS st_documents (
    document_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    body LONGBLOB NOT NULL,
    revision INT UNSIGNED NOT NULL DEFAULT 1,
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)
  ) ENGINE=InnoDB`,
];

function validateKey(key) {
  if (typeof key !== 'string' || key.length > 512 || !/^[A-Za-z0-9_.@/-]+$/.test(key) ||
      key.split('/').some((p) => !p || p.endsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error('Invalid document key');
  return key;
}

function connectionOptions(env = process.env) {
  for (const name of ['APP_DB_HOST', 'APP_DB_NAME', 'APP_DB_USER']) {
    if (!env[name]) throw new Error(`${name} is required (application storage uses separate credentials)`);
  }
  const port = Number(env.APP_DB_PORT || 3306);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid APP_DB_PORT');
  return {
    host: env.APP_DB_HOST, port, database: env.APP_DB_NAME, user: env.APP_DB_USER,
    password: env.APP_DB_PASSWORD || '', multipleStatements: false,
    connectionLimit: 5, charset: 'utf8mb4',
    ...(env.APP_DB_SSL_CA ? { ssl: { ca: fs.readFileSync(env.APP_DB_SSL_CA), rejectUnauthorized: true } } : {}),
  };
}

function createMysqlStore(pool) {
  async function get(key) {
    const [rows] = await pool.execute('SELECT body, revision FROM st_documents WHERE document_key = ?', [validateKey(key)]);
    return rows.length ? { body: Buffer.from(rows[0].body), revision: rows[0].revision } : null;
  }
  // Optimistic concurrency: callers must supply the revision they read; 0 creates only.
  async function put(key, body, revision = 0) {
    validateKey(key);
    if (!Number.isInteger(revision) || revision < 0) throw new Error('Invalid revision');
    body = Buffer.from(body);
    try {
      const [result] = revision === 0
        ? await pool.execute('INSERT INTO st_documents (document_key, body) VALUES (?, ?)', [key, body])
        : await pool.execute('UPDATE st_documents SET body = ?, revision = revision + 1 WHERE document_key = ? AND revision = ?', [body, key, revision]);
      if (result.affectedRows !== 1) throw Object.assign(new Error(`Concurrent change: ${key}`), { code: 'storage_conflict' });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') throw Object.assign(new Error(`Document already exists: ${key}`), { code: 'storage_conflict' });
      throw error;
    }
    return revision + 1;
  }
  return {
    get, put,
    async readJson(key) {
      const record = await get(key);
      return record && { value: JSON.parse(record.body.toString('utf8')), revision: record.revision };
    },
    writeJson: (key, value, revision = 0) => {
      const body = JSON.stringify(value);
      if (body === undefined) throw new Error('Value is not JSON serializable');
      return put(key, Buffer.from(body), revision);
    },
    async keys() {
      const [rows] = await pool.query('SELECT document_key FROM st_documents ORDER BY document_key');
      return rows.map((r) => r.document_key);
    },
    async initialize() { for (const sql of schema) await pool.query(sql); },
    async transaction(fn) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const result = await fn(createMysqlStore(connection));
        await connection.commit();
        return result;
      } catch (error) { await connection.rollback(); throw error; }
      finally { connection.release(); }
    },
  };
}

const digest = (body) => crypto.createHash('sha256').update(body).digest('hex');
const lockName = (database, role) => 'st:' + digest(database + ':' + role).slice(0, 60);
module.exports = { createMysqlStore, connectionOptions, validateKey, digest, lockName };
