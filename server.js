'use strict';
/*
 * MySQL batch updater with mandatory human approval.
 *
 * Safety model (read this before changing anything):
 *  - The ONLY code path that issues a write statement to the database is
 *    executeApprovedChange(), and it is reachable ONLY from
 *    POST /api/session/decision with action === 'approve'.
 *  - Previews are SELECT-only and computed in memory.
 *  - Table / column names are validated against information_schema before
 *    being interpolated (and are backtick-quoted on top of that).
 *  - Every VALUE travels as a bound parameter (mysql2 execute/query with ?).
 *  - The rule's WHERE clause is free-form trusted operator input; it is only
 *    ever used inside a SELECT, wrapped in parentheses, with a server-enforced
 *    LIMIT and multipleStatements disabled.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const net = require('net');
const path = require('path');
const crypto = require('crypto');

// When packaged as a standalone exe (pkg), __dirname points into the read-only
// snapshot: static assets load from there, but everything the app WRITES (and
// .env) lives next to the executable instead.
const IS_PACKAGED = typeof process.pkg !== 'undefined';
const ROOT = __dirname;
const DATA_DIR = IS_PACKAGED ? path.dirname(process.execPath) : __dirname;
require('dotenv').config({ path: path.join(DATA_DIR, '.env') });

const express = require('express');
const mysql = require('mysql2/promise');
const sqlLiteral = require('mysql2').escape; // value → safe SQL literal (backup scripts only)
const { Client: SSHClient } = require('ssh2');

const RULES_FILE = path.join(DATA_DIR, 'rules.json');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.log');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
const PORT = Number(process.env.PORT || 3000);
const MAX_PREVIEW_ROWS = Math.max(1, Number(process.env.MAX_PREVIEW_ROWS || 500));

/* ------------------------------------------------------------------ */
/* Database connectivity (lazy — nothing touches the DB at startup)    */
/* ------------------------------------------------------------------ */

// ---- connection profiles (multiple named DB+SSH configs, one active) ----
// .env acts as the seed: on first run it is migrated into connections.json.
// SSH_TUNNEL=false disables the tunnel even when SSH_* settings are present.
const CONNECTIONS_FILE = path.join(DATA_DIR, 'connections.json');
const sshTunnelDisabled = /^(0|false|no|off)$/i.test((process.env.SSH_TUNNEL || '').trim());

const envProfile = {
  id: 'env',
  name: '.env settings',
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || '',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || '',
  },
  ssh: {
    enabled: !!process.env.SSH_HOST && !sshTunnelDisabled,
    host: process.env.SSH_HOST || '',
    port: Number(process.env.SSH_PORT || 22),
    user: process.env.SSH_USER || '',
    password: process.env.SSH_PASSWORD || '',
    privateKeyPath: process.env.SSH_PRIVATE_KEY_PATH || '',
    passphrase: process.env.SSH_PASSPHRASE || '',
  },
};

let connStore = { activeId: null, profiles: [] };
try {
  connStore = JSON.parse(fs.readFileSync(CONNECTIONS_FILE, 'utf8'));
  if (!Array.isArray(connStore.profiles)) connStore.profiles = [];
} catch {
  // first run: seed from .env when it holds a usable DB config
  if (envProfile.db.database && envProfile.db.user) {
    const seeded = { ...envProfile, id: crypto.randomUUID() };
    connStore = { activeId: seeded.id, profiles: [seeded] };
    try {
      fs.writeFileSync(CONNECTIONS_FILE, JSON.stringify(connStore, null, 2), 'utf8');
      console.log('Migrated .env connection settings into connections.json');
    } catch (e) { console.error('Could not write connections.json:', e.message); }
  }
}

async function saveConnections() {
  const tmp = CONNECTIONS_FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(connStore, null, 2), 'utf8');
  await fsp.rename(tmp, CONNECTIONS_FILE);
}

function activeProfile() {
  return connStore.profiles.find((p) => p.id === connStore.activeId)
    || connStore.profiles[0]
    || envProfile;
}
function currentDb() { return activeProfile().db; }
function currentSsh() {
  const s = activeProfile().ssh;
  return s && s.enabled && s.host ? s : null;
}

let poolPromise = null; // Promise<{pool, close()}> — lazy singleton

function resetPool(reason) {
  if (poolPromise) {
    logEvent('warn', `Database connection reset (${reason}); will reconnect on next use`);
    poolPromise.then((h) => h.close()).catch(() => {});
    poolPromise = null;
  }
}

/**
 * When SSH is configured, open one SSH connection and a local TCP server on
 * 127.0.0.1:<ephemeral>. Each incoming socket (one per pooled MySQL
 * connection) is forwarded through the SSH connection to DB_HOST:DB_PORT as
 * seen from the SSH server. The mysql2 pool then targets the local server.
 */
function openSshTunnel(sshCfg, dbCfg, onDown = () => {}) {
  return new Promise((resolve, reject) => {
    const ssh = new SSHClient();
    const connectOpts = {
      host: sshCfg.host,
      port: sshCfg.port,
      username: sshCfg.user,
      readyTimeout: 20000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 4,
    };
    if (sshCfg.privateKeyPath) {
      try {
        connectOpts.privateKey = fs.readFileSync(sshCfg.privateKeyPath);
        if (sshCfg.passphrase) connectOpts.passphrase = sshCfg.passphrase;
      } catch (e) {
        return reject(new Error(`Cannot read SSH private key: ${e.message}`));
      }
    } else if (sshCfg.password) {
      connectOpts.password = sshCfg.password;
      // Some servers only accept keyboard-interactive instead of plain
      // password auth — answer its prompts with the same password.
      connectOpts.tryKeyboard = true;
      ssh.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
        finish(prompts.map(() => sshCfg.password));
      });
    } else {
      return reject(new Error('SSH tunnel enabled but neither an SSH password nor a private key is configured'));
    }

    let settled = false;
    ssh.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(new Error(`SSH connection failed: ${err.message}`));
      } else {
        onDown(`SSH error: ${err.message}`);
      }
    });
    ssh.on('close', () => {
      if (settled) onDown('SSH connection closed');
    });

    ssh.on('ready', () => {
      const server = net.createServer((socket) => {
        ssh.forwardOut(socket.localAddress || '127.0.0.1', socket.localPort || 0, dbCfg.host, dbCfg.port, (err, stream) => {
          if (err) {
            logEvent('error', `SSH forward failed: ${err.message}`);
            socket.destroy();
            return;
          }
          socket.pipe(stream).pipe(socket);
          stream.on('error', () => socket.destroy());
          socket.on('error', () => stream.destroy());
        });
      });
      server.on('error', (err) => {
        if (!settled) { settled = true; reject(err); }
      });
      server.listen(0, '127.0.0.1', () => {
        settled = true;
        logEvent('info', `SSH tunnel up: 127.0.0.1:${server.address().port} → ${sshCfg.host} → ${dbCfg.host}:${dbCfg.port}`);
        resolve({
          localPort: server.address().port,
          close: () => { try { server.close(); } catch {} try { ssh.end(); } catch {} },
        });
      });
    });

    ssh.connect(connectOpts);
  });
}

function getPool() {
  if (!poolPromise) {
    const dbCfg = currentDb();
    const sshCfg = currentSsh();
    poolPromise = (async () => {
      let host = dbCfg.host;
      let port = dbCfg.port;
      let tunnel = null;
      if (sshCfg) {
        tunnel = await openSshTunnel(sshCfg, dbCfg, (reason) => resetPool(reason));
        host = '127.0.0.1';
        port = tunnel.localPort;
      }
      const pool = mysql.createPool({
        host,
        port,
        user: dbCfg.user,
        password: dbCfg.password,
        database: dbCfg.database,
        waitForConnections: true,
        connectionLimit: 4,
        dateStrings: true, // stable string round-trips for stale detection
        multipleStatements: false,
      });
      return {
        pool,
        close: async () => {
          try { await pool.end(); } catch {}
          if (tunnel) tunnel.close();
        },
      };
    })();
    poolPromise.catch(() => { poolPromise = null; });
  }
  return poolPromise.then((h) => h.pool);
}

/* ------------------------------------------------------------------ */
/* Schema validation                                                   */
/* ------------------------------------------------------------------ */

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** Backtick-quote an identifier that has ALREADY been schema-validated. */
function quoteIdent(name) {
  return '`' + String(name).replace(/`/g, '``') + '`';
}

/** Fetch the live column list for a table; throws 400 if the table is unknown. */
async function getTableColumns(table) {
  const pool = await getPool();
  const [rows] = await pool.execute(
    `SELECT COLUMN_NAME AS name, COLUMN_KEY AS columnKey, DATA_TYPE AS dataType
       FROM information_schema.columns
      WHERE table_schema = ? AND table_name = ?
      ORDER BY ORDINAL_POSITION`,
    [currentDb().database, table]
  );
  if (rows.length === 0) {
    throw httpError(400, `Table "${table}" does not exist in database "${currentDb().database}"`);
  }
  return rows;
}

function assertColumn(columns, table, name, role) {
  if (!columns.some((c) => c.name === name)) {
    throw httpError(400, `${role} "${name}" is not a column of table "${table}"`);
  }
}

/* ------------------------------------------------------------------ */
/* Transforms — add new types by adding an entry here                  */
/* ------------------------------------------------------------------ */

const TRANSFORMS = {
  findReplace: {
    label: 'Find / replace',
    validate(p) {
      if (typeof p.find !== 'string' || p.find === '') throw httpError(400, 'findReplace: "find" is required');
      if (typeof p.replace !== 'string') throw httpError(400, 'findReplace: "replace" is required (may be empty)');
      if (p.regex) {
        const flags = p.flags == null || p.flags === '' ? 'g' : String(p.flags);
        if (!/^[gimsuy]*$/.test(flags)) throw httpError(400, `findReplace: invalid regex flags "${flags}"`);
        try { new RegExp(p.find, flags); } catch (e) { throw httpError(400, `findReplace: invalid regex: ${e.message}`); }
      }
    },
    apply(value, p) {
      if (p.regex) {
        const flags = p.flags == null || p.flags === '' ? 'g' : String(p.flags);
        return value.replace(new RegExp(p.find, flags), p.replace);
      }
      return value.split(p.find).join(p.replace);
    },
  },
  trim: {
    label: 'Trim whitespace',
    validate() {},
    apply(value) { return value.trim(); },
  },
  changeCase: {
    label: 'Change case',
    validate(p) {
      if (!['upper', 'lower', 'title'].includes(p.mode)) throw httpError(400, 'changeCase: mode must be upper, lower or title');
    },
    apply(value, p) {
      if (p.mode === 'upper') return value.toUpperCase();
      if (p.mode === 'lower') return value.toLowerCase();
      return value.toLowerCase().replace(/(^|[\s\-_'([{"])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
    },
  },
  prefix: {
    label: 'Add prefix',
    validate(p) { if (typeof p.text !== 'string' || p.text === '') throw httpError(400, 'prefix: "text" is required'); },
    apply(value, p) { return p.text + value; },
  },
  suffix: {
    label: 'Add suffix',
    validate(p) { if (typeof p.text !== 'string' || p.text === '') throw httpError(400, 'suffix: "text" is required'); },
    apply(value, p) { return value + p.text; },
  },
  setValue: {
    label: 'Set fixed value',
    validate(p) {
      if (!p.setNull && typeof p.value !== 'string') throw httpError(400, 'setValue: "value" is required (or setNull)');
    },
    apply(_value, p) { return p.setNull ? null : p.value; },
    acceptsNull: true, // runs even when the current value is NULL
  },
};

function validateTransforms(transforms) {
  if (!Array.isArray(transforms) || transforms.length === 0) {
    throw httpError(400, 'Rule needs at least one transform');
  }
  for (const t of transforms) {
    if (!t || typeof t.column !== 'string' || !t.column) throw httpError(400, 'Each transform needs a "column"');
    const impl = TRANSFORMS[t.type];
    if (!impl) throw httpError(400, `Unknown transform type "${t.type}"`);
    impl.validate(t.params || {});
  }
}

/** Apply a string function to every `s:N:"..."` token of a PHP-serialized
 * value, rewriting each N with the new content's BYTE length. Byte-exact for
 * everything outside strings; navigates by the declared lengths, so embedded
 * quotes/HTML in the content cannot desync it. Tokens that do not line up
 * (corrupt or not actually serialized) are left untouched. */
function transformSerializedStrings(value, fn) {
  const buf = Buffer.from(value, 'utf8');
  const parts = [];
  let last = 0, i = 0;
  while (i < buf.length - 3) {
    if (buf[i] === 0x73 /* s */ && buf[i + 1] === 0x3a /* : */) {
      let j = i + 2, n = 0, digits = 0;
      while (j < buf.length && buf[j] >= 0x30 && buf[j] <= 0x39) { n = n * 10 + (buf[j] - 0x30); j++; digits++; }
      const start = j + 2;
      const end = start + n;
      if (digits > 0 && buf[j] === 0x3a && buf[j + 1] === 0x22 /* :" */ &&
          end < buf.length && buf[end] === 0x22 && buf[end + 1] === 0x3b /* "; */) {
        const content = buf.slice(start, end).toString('utf8');
        const replaced = String(fn(content));
        const rbuf = Buffer.from(replaced, 'utf8');
        parts.push(buf.slice(last, i), Buffer.from(`s:${rbuf.length}:"`), rbuf, Buffer.from('";'));
        i = end + 2;
        last = i;
        continue;
      }
    }
    i++;
  }
  parts.push(buf.slice(last));
  return Buffer.concat(parts).toString('utf8');
}

/** Apply one rule's transforms to a row → { column: newValue } (may be identical to old). */
function applyTransforms(row, transforms) {
  const out = {};
  for (const t of transforms) {
    const impl = TRANSFORMS[t.type];
    const current = t.column in out ? out[t.column] : row[t.column];
    if (current === null || current === undefined) {
      out[t.column] = impl.acceptsNull ? impl.apply(null, t.params || {}) : current ?? null;
    } else if (t.phpSerialized) {
      out[t.column] = transformSerializedStrings(String(current), (s) => impl.apply(s, t.params || {}));
    } else {
      out[t.column] = impl.apply(String(current), t.params || {});
    }
  }
  return out;
}

function valuesEqual(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  return String(a) === String(b);
}

/* ------------------------------------------------------------------ */
/* Rules persistence                                                   */
/* ------------------------------------------------------------------ */

let rules = [];
try {
  rules = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
  if (!Array.isArray(rules)) rules = [];
} catch { rules = []; }

async function saveRules() {
  const tmp = RULES_FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(rules, null, 2), 'utf8');
  await fsp.rename(tmp, RULES_FILE);
}

function sanitizeRuleInput(body) {
  const name = String(body.name || '').trim();
  const table = String(body.table || '').trim();
  const pkColumn = String(body.pkColumn || '').trim();
  const where = String(body.where || '').trim();
  const displayColumns = String(body.displayColumns || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  let limit = Number(body.limit);
  if (!Number.isInteger(limit) || limit < 1) limit = MAX_PREVIEW_ROWS;
  limit = Math.min(limit, MAX_PREVIEW_ROWS);
  if (!name) throw httpError(400, 'Rule name is required');
  if (!table) throw httpError(400, 'Target table is required');
  if (!pkColumn) throw httpError(400, 'Primary-key column is required');
  validateTransforms(body.transforms);
  return { name, table, pkColumn, where, limit, displayColumns, transforms: body.transforms, draft: !!body.draft };
}

/* ------------------------------------------------------------------ */
/* Session state (in memory — pending changes do not survive restart)  */
/* ------------------------------------------------------------------ */

let session = null;
let approvalChain = Promise.resolve(); // serializes approvals

function sessionCounts(s) {
  const counts = { matched: s.changes.length, pending: 0, approved: 0, rejected: 0, skipped: 0, failed: 0, stale: 0 };
  for (const c of s.changes) counts[c.status] = (counts[c.status] || 0) + 1;
  return counts;
}

function sessionSnapshot() {
  if (!session) return null;
  return {
    id: session.id,
    ruleId: session.ruleId,
    ruleName: session.ruleName,
    table: session.table,
    pkColumn: session.pkColumn,
    status: session.status,
    startedAt: session.startedAt,
    backupFile: session.backupFile || null,
    backupDownloaded: !!session.backupDownloaded,
    counts: sessionCounts(session),
    changes: session.changes,
  };
}

/* ------------------------------------------------------------------ */
/* SSE + activity log + audit                                          */
/* ------------------------------------------------------------------ */

const sseClients = new Set();
const recentLog = [];

function sseBroadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(payload);
}

function logEvent(level, msg) {
  const entry = { time: new Date().toISOString(), level, msg };
  recentLog.push(entry);
  if (recentLog.length > 300) recentLog.shift();
  sseBroadcast('log', entry);
  console.log(`[${entry.time}] ${level.toUpperCase()} ${msg}`);
}

function broadcastSession() { sseBroadcast('session', sessionSnapshot()); }
function broadcastChange(change) {
  sseBroadcast('change', { change, counts: session ? sessionCounts(session) : null, sessionStatus: session?.status });
}

let auditChain = Promise.resolve();
function audit(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  auditChain = auditChain.then(() => fsp.appendFile(AUDIT_FILE, line, 'utf8')).catch((e) => {
    console.error('AUDIT WRITE FAILED:', e.message);
  });
  return auditChain;
}

/* ------------------------------------------------------------------ */
/* Backup — snapshot of preview-time values, as a restore script       */
/* ------------------------------------------------------------------ */

function buildBackup(s, format) {
  const safeTable = s.table.replace(/[^A-Za-z0-9_-]/g, '_');
  const stamp = s.startedAt.replace(/[:.]/g, '-');
  if (format === 'json') {
    return {
      filename: `backup-${safeTable}-${stamp}.json`,
      mime: 'application/json',
      content: JSON.stringify({
        rule: s.ruleName, table: s.table, pkColumn: s.pkColumn, capturedAt: s.startedAt,
        rows: s.changes.map((c) => ({
          pk: c.pk,
          before: Object.fromEntries(c.cols.map((col) => [col.column, col.before])),
        })),
      }, null, 2),
    };
  }
  const lines = [
    '-- Restore script generated by mysql-approve-updater',
    `-- Rule: ${String(s.ruleName).replace(/[\r\n]+/g, ' ')} | Table: ${s.table} | Captured at preview: ${s.startedAt}`,
    `-- Restores the preview-time values of the ${s.changes.length} row(s) this rule proposed to change.`,
    '-- Review before running. Each statement targets exactly one row by primary key.',
    '',
  ];
  for (const c of s.changes) {
    const sets = c.cols.map((col) => `${quoteIdent(col.column)} = ${sqlLiteral(col.before)}`).join(', ');
    lines.push(`UPDATE ${quoteIdent(s.table)} SET ${sets} WHERE ${quoteIdent(s.pkColumn)} = ${sqlLiteral(c.pk)} LIMIT 1;`);
  }
  return { filename: `backup-${safeTable}-${stamp}.sql`, mime: 'application/sql', content: lines.join('\n') + '\n' };
}

/* ------------------------------------------------------------------ */
/* Preview (SELECT only)                                               */
/* ------------------------------------------------------------------ */

/** Validate a rule against the live schema and build its queries.
 *  Shared by preview and the SQL export so they can never drift apart. */
async function buildRuleQuery(rule) {
  const columns = await getTableColumns(rule.table);
  assertColumn(columns, rule.table, rule.pkColumn, 'Primary-key column');
  for (const t of rule.transforms) assertColumn(columns, rule.table, t.column, 'Transform column');
  for (const d of rule.displayColumns) assertColumn(columns, rule.table, d, 'Display column');

  const where = rule.where || '1=1';
  if (where.includes(';')) throw httpError(400, 'WHERE condition must not contain ";"');

  const limit = Math.min(Math.max(1, rule.limit || MAX_PREVIEW_ROWS), MAX_PREVIEW_ROWS);
  const selectCols = [...new Set([rule.pkColumn, ...rule.displayColumns, ...rule.transforms.map((t) => t.column)])];
  const sql = `SELECT ${selectCols.map(quoteIdent).join(', ')} FROM ${quoteIdent(rule.table)} WHERE (${where}) LIMIT ${limit}`;

  const changeCols = [...new Set(rule.transforms.map((t) => t.column))];
  const updateTemplate =
    `UPDATE ${quoteIdent(rule.table)} SET ${changeCols.map((c) => `${quoteIdent(c)} = <new value>`).join(', ')} ` +
    `WHERE ${quoteIdent(rule.pkColumn)} = <pk> AND ${changeCols.map((c) => `${quoteIdent(c)} <=> <preview value>`).join(' AND ')} LIMIT 1`;

  return { sql, updateTemplate, limit };
}

async function runPreview(rule) {
  const progress = (stage, text) => sseBroadcast('preview', { stage, text });
  progress('validate', 'Validating rule against the live schema…');
  const { sql, limit } = await buildRuleQuery(rule);

  const pool = await getPool();
  logEvent('info', `Preview: ${sql}`);
  progress('fetch', `Fetching matching rows${currentSsh() ? ' (via SSH tunnel)' : ''}…`);
  const [rows] = await pool.query(sql); // WHERE is trusted operator input; values elsewhere are parameterized
  progress('fetched', `Found ${rows.length} matching row(s)${rows.length >= limit ? ` (capped at ${limit})` : ''}.`);

  progress('compute', `Applying ${rule.transforms.length} transform(s) and computing the before/after diff…`);
  const changes = [];
  const nRows = rows.length;
  let scanned = 0;
  for (const row of rows) {
    const after = applyTransforms(row, rule.transforms);
    const cols = [];
    for (const [column, newValue] of Object.entries(after)) {
      if (!valuesEqual(row[column], newValue)) {
        cols.push({ column, before: row[column] ?? null, after: newValue ?? null });
      }
    }
    scanned++;
    // periodic progress on big result sets (diffing large text can be slow)
    if (nRows > 50 && scanned % 50 === 0) progress('computing', `Computed ${scanned}/${nRows} rows, ${changes.length} would change so far…`);
    if (cols.length === 0) continue;
    const display = {};
    for (const d of rule.displayColumns) display[d] = row[d] ?? null;
    changes.push({
      id: crypto.randomUUID(),
      pk: row[rule.pkColumn],
      display,
      cols,
      status: 'pending',
      note: null,
    });
  }
  progress('done', `${changes.length} row(s) would change. Rendering…`);

  session = {
    id: crypto.randomUUID(),
    ruleId: rule.id,
    ruleName: rule.name,
    table: rule.table,
    pkColumn: rule.pkColumn,
    status: 'running',
    startedAt: new Date().toISOString(),
    changes,
  };

  audit({
    action: 'preview',
    rule: rule.name,
    table: rule.table,
    matchedRows: rows.length,
    proposedChanges: changes.length,
    limit,
  });
  logEvent('info', `Preview "${rule.name}": ${rows.length} rows matched, ${changes.length} proposed changes (nothing written)`);

  // Auto-save a restore script of the captured values before any approval can happen
  if (changes.length) {
    try {
      await fsp.mkdir(BACKUPS_DIR, { recursive: true });
      const b = buildBackup(session, 'sql');
      await fsp.writeFile(path.join(BACKUPS_DIR, b.filename), b.content, 'utf8');
      session.backupFile = `backups/${b.filename}`;
      logEvent('info', `Backup saved: ${session.backupFile}`);
    } catch (e) {
      logEvent('error', `Backup save failed: ${e.message}`);
    }
  }
  broadcastSession();
  return sessionSnapshot();
}

/* ------------------------------------------------------------------ */
/* Approval — THE ONLY WRITE PATH                                      */
/* ------------------------------------------------------------------ */

async function executeApprovedChange(change) {
  const pool = await getPool();
  const table = quoteIdent(session.table);
  const pkCol = quoteIdent(session.pkColumn);

  // Single-row UPDATE, conditioned on the values captured at preview time so
  // a concurrently-modified row can never be overwritten blindly.
  const setSql = change.cols.map((c) => `${quoteIdent(c.column)} = ?`).join(', ');
  const guardSql = change.cols.map((c) => `${quoteIdent(c.column)} <=> ?`).join(' AND ');
  const sql = `UPDATE ${table} SET ${setSql} WHERE ${pkCol} = ? AND ${guardSql} LIMIT 1`;
  const params = [
    ...change.cols.map((c) => c.after),
    change.pk,
    ...change.cols.map((c) => c.before),
  ];

  const [result] = await pool.execute(sql, params);

  const readCols = [...new Set([session.pkColumn, ...change.cols.map((c) => c.column)])];
  const [reread] = await pool.execute(
    `SELECT ${readCols.map(quoteIdent).join(', ')} FROM ${table} WHERE ${pkCol} = ? LIMIT 1`,
    [change.pk]
  );
  const currentRow = reread[0] || null;

  if (result.affectedRows === 1) {
    const verified = currentRow && change.cols.every((c) => valuesEqual(currentRow[c.column], c.after));
    change.status = 'approved';
    change.note = verified ? 'written & verified' : 'written (re-read differs — row changed again after update)';
    return { sqlResult: { affectedRows: result.affectedRows, changedRows: result.changedRows ?? result.affectedRows }, verified };
  }

  // affectedRows === 0 → either the row is gone or its values no longer match the preview
  if (!currentRow) {
    change.status = 'failed';
    change.note = 'row no longer exists';
    return { sqlResult: { affectedRows: 0 }, verified: false };
  }
  change.status = 'stale';
  change.note = 'value changed in DB since preview — not updated';
  change.currentValues = {};
  for (const c of change.cols) change.currentValues[c.column] = currentRow[c.column] ?? null;
  return { sqlResult: { affectedRows: 0 }, verified: false };
}

async function decideChange(changeId, action) {
  if (!session) throw httpError(409, 'No active session');
  if (session.status === 'aborted' || session.status === 'done') throw httpError(409, `Session is ${session.status}`);
  if (session.status === 'paused' && action === 'approve') throw httpError(409, 'Session is paused — resume before approving');
  const change = session.changes.find((c) => c.id === changeId);
  if (!change) throw httpError(404, 'Change not found');
  if (change.status !== 'pending') throw httpError(409, `Change is already ${change.status}`);

  const base = {
    rule: session.ruleName,
    table: session.table,
    pk: change.pk,
    columns: change.cols.map((c) => ({ column: c.column, oldValue: c.before, newValue: c.after, manualEdit: !!c.manualEdit })),
  };

  if (action === 'reject' || action === 'skip') {
    change.status = action === 'reject' ? 'rejected' : 'skipped';
    change.note = 'no write performed';
    audit({ action, ...base, sqlResult: null });
    logEvent('info', `${action === 'reject' ? 'Rejected' : 'Skipped'} pk=${change.pk} — nothing written`);
  } else if (action === 'approve') {
    let outcome;
    try {
      outcome = await executeApprovedChange(change);
    } catch (e) {
      change.status = 'failed';
      change.note = `UPDATE failed: ${e.message}`;
      audit({ action: 'approve', ...base, sqlResult: { error: e.message } });
      logEvent('error', `Approve pk=${change.pk} FAILED: ${e.message}`);
      broadcastChange(change);
      maybeFinishSession();
      return change;
    }
    audit({ action: change.status === 'approved' ? 'approve' : `approve-${change.status}`, ...base, sqlResult: outcome.sqlResult });
    logEvent(
      change.status === 'approved' ? 'info' : 'warn',
      change.status === 'approved'
        ? `Approved pk=${change.pk}: 1 row updated (${change.note})`
        : `Approve pk=${change.pk} → ${change.status}: ${change.note}`
    );
  } else {
    throw httpError(400, `Unknown action "${action}"`);
  }

  broadcastChange(change);
  maybeFinishSession();
  return change;
}

function maybeFinishSession() {
  if (session && session.status === 'running' && sessionCounts(session).pending === 0) {
    session.status = 'done';
    logEvent('info', `Session for rule "${session.ruleName}" complete`);
    broadcastSession();
  }
}

/* ------------------------------------------------------------------ */
/* HTTP API                                                            */
/* ------------------------------------------------------------------ */

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.use('/vendor/introjs', express.static(path.join(ROOT, 'node_modules', 'intro.js', 'minified')));
app.use('/vendor/tabulator', express.static(path.join(ROOT, 'node_modules', 'tabulator-tables', 'dist')));
app.use('/vendor/codemirror', express.static(path.join(ROOT, 'node_modules', 'codemirror')));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get('/api/state', (req, res) => {
  res.json({
    session: sessionSnapshot(),
    recentLog,
    config: { database: currentDb().database, sshTunnel: !!currentSsh(), profile: activeProfile().name, maxPreviewRows: MAX_PREVIEW_ROWS },
    transformTypes: Object.fromEntries(Object.entries(TRANSFORMS).map(([k, v]) => [k, v.label])),
  });
});

app.get('/api/schema', wrap(async (req, res) => {
  const pool = await getPool();
  const [rows] = await pool.execute(
    `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName, COLUMN_KEY AS columnKey
       FROM information_schema.columns
      WHERE table_schema = ?
      ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [currentDb().database]
  );
  const tables = {};
  for (const r of rows) {
    (tables[r.tableName] ||= []).push({ name: r.columnName, isPk: r.columnKey === 'PRI' });
  }
  res.json({ database: currentDb().database, tables });
}));

/* ---- read-only SQL console ----
   Writes are deliberately refused here: the ONLY write path in this tool is
   executeApprovedChange(). Use a rule + approval for changes.               */
const SQL_CONSOLE_MAX_ROWS = 200;

function validateConsoleSql(raw) {
  let sql = String(raw || '').trim();
  if (!sql) throw httpError(400, 'Empty query');
  sql = sql.replace(/;\s*$/, '');
  if (sql.includes(';')) throw httpError(400, 'Only a single statement is allowed');
  const kw = (sql.match(/^[\s(]*([a-zA-Z]+)/) || [])[1]?.toUpperCase();
  if (!['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH'].includes(kw)) {
    throw httpError(400, `This console is read-only (SELECT / SHOW / DESCRIBE / EXPLAIN): "${kw || '?'}" is not allowed. Writes go through rules and per-row approval.`);
  }
  return { sql, kw };
}

app.post('/api/sql', wrap(async (req, res) => {
  const { sql, kw } = validateConsoleSql(req.body?.sql);
  const page = Math.max(0, Math.min(100000, Number(req.body?.page) || 0));
  const cap = SQL_CONSOLE_MAX_ROWS;
  const pool = await getPool();
  const started = Date.now();
  let rows, fields, hasMore;
  if (kw === 'SELECT' || kw === 'WITH') {
    // wrap to enforce the page window inside MySQL; fall back to the raw query
    // when the wrapper is not applicable (e.g. locking clauses)
    try {
      [rows, fields] = await pool.query({
        sql: `SELECT * FROM (${sql}) AS _console_q LIMIT ${cap + 1} OFFSET ${page * cap}`,
        timeout: 30000,
      });
      hasMore = rows.length > cap;
      rows = rows.slice(0, cap);
    } catch {
      [rows, fields] = await pool.query({ sql, timeout: 30000 });
      hasMore = rows.length > (page + 1) * cap;
      rows = rows.slice(page * cap, page * cap + cap);
    }
  } else {
    [rows, fields] = await pool.query({ sql, timeout: 30000 });
    hasMore = rows.length > (page + 1) * cap;
    rows = rows.slice(page * cap, page * cap + cap);
  }
  const ms = Date.now() - started;
  const out = rows.map((r) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Buffer.isBuffer(v) ? '0x' + v.toString('hex').slice(0, 400) : v]))
  );
  logEvent('info', `Console query (page ${page + 1}, ${ms}ms, ${out.length}${hasMore ? '+' : ''} rows): ${sql.slice(0, 160)}`);
  res.json({ columns: (fields || []).map((f) => f.name), rows: out, rowCount: out.length, page, hasMore, ms });
}));

/* ---- full-result export: streams ALL rows (no page cap), read-only ---- */
app.post('/api/sql/export', wrap(async (req, res) => {
  const { sql } = validateConsoleSql(req.body?.sql);
  const format = ['updates', 'inserts', 'csv', 'json'].includes(req.body?.format) ? req.body.format : 'json';
  const table = String(req.body?.table || 'my_table');
  const pkWanted = String(req.body?.pk || '');

  const qid = (n) => '`' + String(n).replace(/`/g, '``') + '`';
  const sval = (v) => {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return String(v);
    if (Buffer.isBuffer(v)) v = '0x' + v.toString('hex');
    return "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\0/g, '\\0') + "'";
  };
  const csvq = (v) => {
    if (v === null || v === undefined) return '';
    const s = Buffer.isBuffer(v) ? '0x' + v.toString('hex') : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };

  const ext = format === 'csv' ? 'csv' : format === 'json' ? 'json' : 'sql';
  res.setHeader('Content-Disposition', `attachment; filename="export-${format}.${ext}"`);
  res.type({ sql: 'application/sql', csv: 'text/csv', json: 'application/json' }[ext]);
  const write = (s) => new Promise((r) => (res.write(s) ? r() : res.once('drain', r)));

  const pool = await getPool();
  const conn = await pool.getConnection();
  let columns = null, pk = null, setCols = null, count = 0;
  const started = Date.now();
  try {
    const stream = conn.connection.query({ sql, timeout: 300000 }).stream();
    for await (const row of stream) {
      if (!columns) {
        columns = Object.keys(row);
        pk = pkWanted && columns.includes(pkWanted) ? pkWanted : (columns.find((c) => c.toLowerCase() === 'id') || columns[0]);
        setCols = columns.filter((c) => c !== pk);
        if (format === 'updates' || format === 'inserts') {
          await write(`-- ${format === 'updates' ? 'UPDATE' : 'INSERT'} statements generated from the SQL console (full result)\n` +
            `-- Source query: ${sql.replace(/\s+/g, ' ').slice(0, 160)}\n-- Review before running.\n\n`);
        } else if (format === 'csv') {
          await write(columns.map(csvq).join(',') + '\r\n');
        } else {
          await write('[\n');
        }
      }
      if (format === 'updates') {
        await write(setCols.length
          ? `UPDATE ${qid(table)} SET ${setCols.map((c) => `${qid(c)} = ${sval(row[c])}`).join(', ')} WHERE ${qid(pk)} = ${sval(row[pk])} LIMIT 1;\n`
          : '-- row skipped: result only contains the key column\n');
      } else if (format === 'inserts') {
        await write(`INSERT INTO ${qid(table)} (${columns.map(qid).join(', ')}) VALUES (${columns.map((c) => sval(row[c])).join(', ')});\n`);
      } else if (format === 'csv') {
        await write(columns.map((c) => csvq(row[c])).join(',') + '\r\n');
      } else {
        await write((count ? ',\n' : '') + JSON.stringify(
          Object.fromEntries(columns.map((c) => [c, Buffer.isBuffer(row[c]) ? '0x' + row[c].toString('hex') : row[c]]))
        ));
      }
      count++;
    }
    if (!columns) { // empty result
      if (format === 'csv') await write('');
      else if (format === 'json') await write('[]');
      else await write('-- 0 rows\n');
    } else if (format === 'json') {
      await write('\n]\n');
    }
    logEvent('info', `Console export ${format}: ${count} rows in ${Date.now() - started}ms — ${sql.slice(0, 120)}`);
    res.end();
  } finally {
    conn.release();
  }
}));

/* ---- schema graph: tables, columns, and relations for the visual map ---- */
app.get('/api/schema/graph', wrap(async (req, res) => {
  const pool = await getPool();
  const db = currentDb().database;
  const q = String(req.query.q || '').trim();
  const maxTables = Math.min(Math.max(1, Number(req.query.limit) || 120), 400);

  const [allRows] = await pool.execute(
    `SELECT TABLE_NAME AS t, TABLE_ROWS AS r FROM information_schema.tables WHERE table_schema = ? ORDER BY TABLE_NAME`,
    [db]
  );
  const approxRows = new Map(allRows.map((x) => [x.t, x.r]));
  const allNames = allRows.map((r) => r.t);
  const allSet = new Set(allNames);
  const matchedAll = q ? allNames.filter((n) => n.toLowerCase().includes(q.toLowerCase())) : allNames;
  const totalTables = matchedAll.length;
  const matched = matchedAll.slice(0, maxTables);
  const matchedSet = new Set(matched);

  // With a filter active, pull in relation partners of the matches too —
  // via declared FKs (both directions) and *_id naming inference.
  let chosen = [...matched];
  if (q && matched.length) {
    const neighbors = new Set();
    const ph = matched.map(() => '?').join(',');
    const [fkN] = await pool.execute(
      `SELECT TABLE_NAME AS t, REFERENCED_TABLE_NAME AS rt
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL
          AND (TABLE_NAME IN (${ph}) OR REFERENCED_TABLE_NAME IN (${ph}))`,
      [db, ...matched, ...matched]
    );
    for (const r of fkN) { neighbors.add(r.t); neighbors.add(r.rt); }
    // outgoing inferred: matched tables' <x>_id columns → table x / xs / xes
    const [idCols] = await pool.execute(
      `SELECT COLUMN_NAME AS c FROM information_schema.columns
        WHERE table_schema = ? AND TABLE_NAME IN (${ph}) AND COLUMN_NAME LIKE '%\\_id'`,
      [db, ...matched]
    );
    for (const r of idCols) {
      const base = r.c.replace(/_id$/i, '').toLowerCase();
      for (const cand of [base, base + 's', base + 'es']) if (allSet.has(cand)) neighbors.add(cand);
    }
    // incoming inferred: any table holding a <matched-singular>_id column
    const candCols = [...new Set(matched.flatMap((m) => {
      const b = m.toLowerCase();
      return [...new Set([b, b.replace(/es$/, ''), b.replace(/s$/, '')])].map((s) => s + '_id');
    }))];
    if (candCols.length) {
      const ph2 = candCols.map(() => '?').join(',');
      const [incoming] = await pool.execute(
        `SELECT DISTINCT TABLE_NAME AS t FROM information_schema.columns
          WHERE table_schema = ? AND COLUMN_NAME IN (${ph2})`,
        [db, ...candCols]
      );
      incoming.forEach((r) => neighbors.add(r.t));
    }
    for (const m of matched) neighbors.delete(m);
    chosen = [...matched, ...[...neighbors].slice(0, Math.max(0, 400 - matched.length))];
  }
  if (chosen.length === 0) return res.json({ database: db, totalTables, tables: [], relations: [] });

  const ph = chosen.map(() => '?').join(',');
  const [cols] = await pool.execute(
    `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName, COLUMN_KEY AS columnKey, COLUMN_TYPE AS columnType
       FROM information_schema.columns
      WHERE table_schema = ? AND TABLE_NAME IN (${ph})
      ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [db, ...chosen]
  );
  const [fks] = await pool.execute(
    `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName,
            REFERENCED_TABLE_NAME AS refTable, REFERENCED_COLUMN_NAME AS refColumn
       FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL
        AND TABLE_NAME IN (${ph}) AND REFERENCED_TABLE_NAME IN (${ph})`,
    [db, ...chosen, ...chosen]
  );

  const tableMap = new Map();
  for (const c of cols) {
    if (!tableMap.has(c.tableName)) tableMap.set(c.tableName, { name: c.tableName, columns: [] });
    tableMap.get(c.tableName).columns.push({ name: c.columnName, type: c.columnType, isPk: c.columnKey === 'PRI' });
  }

  const relations = fks.map((f) => ({
    from: f.tableName, fromColumn: f.columnName, to: f.refTable, toColumn: f.refColumn, inferred: false,
  }));
  const declared = new Set(relations.map((r) => `${r.from}.${r.fromColumn}`));

  // No FK constraint? Infer from Laravel-style naming: <thing>_id → table <thing> / <thing>s
  for (const t of tableMap.values()) {
    for (const col of t.columns) {
      const m = /^(.+)_id$/i.exec(col.name);
      if (!m || declared.has(`${t.name}.${col.name}`)) continue;
      const base = m[1].toLowerCase();
      const target = [base, base + 's', base + 'es'].find((n) => tableMap.has(n) && n !== t.name);
      if (target) {
        const pk = tableMap.get(target).columns.find((c) => c.isPk);
        relations.push({ from: t.name, fromColumn: col.name, to: target, toColumn: pk?.name || 'id', inferred: true });
      }
    }
  }

  const tables = [...tableMap.values()].map((t) => ({
    ...t,
    related: q ? !matchedSet.has(t.name) : false,
    approxRows: approxRows.get(t.name) ?? null, // information_schema estimate (null for views)
  }));
  res.json({ database: db, totalTables, tables, relations });
}));

/* ---- exact row count (on demand — COUNT(*) can be slow on huge tables) ---- */
app.get('/api/schema/table/:name/count', wrap(async (req, res) => {
  const table = req.params.name;
  await getTableColumns(table); // schema-validates the name (400 if unknown)
  const pool = await getPool();
  const [rows] = await pool.query(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`);
  res.json({ table, rows: rows[0].n });
}));

/* ---- table DDL: read-only SHOW CREATE TABLE ---- */
app.get('/api/schema/table/:name/ddl', wrap(async (req, res) => {
  const table = req.params.name;
  await getTableColumns(table); // validates the name against the live schema (400 if unknown)
  const pool = await getPool();
  const [rows] = await pool.query(`SHOW CREATE TABLE ${quoteIdent(table)}`);
  const ddl = rows[0]?.['Create Table'] || rows[0]?.['Create View'] || '';
  res.json({ table, ddl });
}));

/* ---- rules CRUD ---- */
app.get('/api/rules', (req, res) => res.json(rules));

app.post('/api/rules', wrap(async (req, res) => {
  const rule = { id: crypto.randomUUID(), ...sanitizeRuleInput(req.body) };
  rules.push(rule);
  await saveRules();
  logEvent('info', `Rule created: "${rule.name}"`);
  res.status(201).json(rule);
}));

app.put('/api/rules/:id', wrap(async (req, res) => {
  const idx = rules.findIndex((r) => r.id === req.params.id);
  if (idx === -1) throw httpError(404, 'Rule not found');
  rules[idx] = { id: rules[idx].id, ...sanitizeRuleInput(req.body) };
  await saveRules();
  logEvent('info', `Rule updated: "${rules[idx].name}"`);
  res.json(rules[idx]);
}));

app.delete('/api/rules/:id', wrap(async (req, res) => {
  const idx = rules.findIndex((r) => r.id === req.params.id);
  if (idx === -1) throw httpError(404, 'Rule not found');
  const [removed] = rules.splice(idx, 1);
  await saveRules();
  logEvent('info', `Rule deleted: "${removed.name}"`);
  res.json({ ok: true });
}));

/* ---- connection profiles ---- */
// Secrets never leave the server: reads are masked, and a blank password on
// save keeps the stored one.
function maskProfile(p) {
  return {
    id: p.id,
    name: p.name,
    db: { host: p.db.host, port: p.db.port, user: p.db.user, database: p.db.database, passwordSet: !!p.db.password },
    ssh: {
      enabled: !!(p.ssh && p.ssh.enabled),
      host: p.ssh?.host || '', port: p.ssh?.port || 22, user: p.ssh?.user || '',
      privateKeyPath: p.ssh?.privateKeyPath || '',
      passwordSet: !!p.ssh?.password, passphraseSet: !!p.ssh?.passphrase,
    },
  };
}

function sanitizeProfile(body, existing) {
  const name = String(body.name || '').trim();
  if (!name) throw httpError(400, 'Connection name is required');
  const db = body.db || {};
  const database = String(db.database || '').trim();
  const user = String(db.user || '').trim();
  if (!database) throw httpError(400, 'Database name is required');
  if (!user) throw httpError(400, 'Database user is required');
  const sshIn = body.ssh || {};
  const num = (v, dflt) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : dflt);
  const profile = {
    id: existing?.id || crypto.randomUUID(),
    name,
    db: {
      host: String(db.host || '127.0.0.1').trim() || '127.0.0.1',
      port: num(db.port, 3306),
      user,
      password: db.password ? String(db.password) : (existing?.db.password || ''),
      database,
    },
    ssh: {
      enabled: !!sshIn.enabled,
      host: String(sshIn.host || '').trim(),
      port: num(sshIn.port, 22),
      user: String(sshIn.user || '').trim(),
      password: sshIn.password ? String(sshIn.password) : (existing?.ssh?.password || ''),
      privateKeyPath: String(sshIn.privateKeyPath || '').trim(),
      passphrase: sshIn.passphrase ? String(sshIn.passphrase) : (existing?.ssh?.passphrase || ''),
    },
  };
  if (profile.ssh.enabled && !profile.ssh.host) throw httpError(400, 'SSH tunnel is enabled but the SSH host is empty');
  return profile;
}

function assertNoPendingSession(what) {
  if (session && session.status !== 'done' && session.status !== 'aborted' && sessionCounts(session).pending > 0) {
    throw httpError(409, `A session with pending changes is active — abort it before ${what}`);
  }
}

app.get('/api/connections', (req, res) => {
  res.json({ activeId: activeProfile().id, profiles: connStore.profiles.map(maskProfile) });
});

app.post('/api/connections', wrap(async (req, res) => {
  const p = sanitizeProfile(req.body, null);
  connStore.profiles.push(p);
  if (!connStore.activeId) connStore.activeId = p.id;
  await saveConnections();
  logEvent('info', `Connection saved: "${p.name}"`);
  res.status(201).json(maskProfile(p));
}));

app.put('/api/connections/:id', wrap(async (req, res) => {
  const idx = connStore.profiles.findIndex((p) => p.id === req.params.id);
  if (idx === -1) throw httpError(404, 'Connection not found');
  const isActive = activeProfile().id === req.params.id;
  if (isActive) assertNoPendingSession('editing the active connection');
  connStore.profiles[idx] = sanitizeProfile(req.body, connStore.profiles[idx]);
  await saveConnections();
  if (isActive) {
    resetPool('active connection edited');
    session = null;
    broadcastSession();
  }
  logEvent('info', `Connection updated: "${connStore.profiles[idx].name}"`);
  res.json(maskProfile(connStore.profiles[idx]));
}));

app.delete('/api/connections/:id', wrap(async (req, res) => {
  const idx = connStore.profiles.findIndex((p) => p.id === req.params.id);
  if (idx === -1) throw httpError(404, 'Connection not found');
  if (activeProfile().id === req.params.id) throw httpError(400, 'Cannot delete the active connection — activate another one first');
  const [removed] = connStore.profiles.splice(idx, 1);
  await saveConnections();
  logEvent('info', `Connection deleted: "${removed.name}"`);
  res.json({ ok: true });
}));

app.post('/api/connections/:id/activate', wrap(async (req, res) => {
  const p = connStore.profiles.find((x) => x.id === req.params.id);
  if (!p) throw httpError(404, 'Connection not found');
  assertNoPendingSession('switching connections');
  connStore.activeId = p.id;
  await saveConnections();
  resetPool('connection profile switched');
  session = null; // sessions belong to the database they were previewed on
  logEvent('info', `Active connection: "${p.name}" (${p.db.database} @ ${p.db.host})`);
  broadcastSession();
  res.json({ ok: true, active: maskProfile(p) });
}));

app.post('/api/connections/:id/test', wrap(async (req, res) => {
  const p = connStore.profiles.find((x) => x.id === req.params.id);
  if (!p) throw httpError(404, 'Connection not found');
  const sshCfg = p.ssh && p.ssh.enabled && p.ssh.host ? p.ssh : null;
  let tunnel = null, conn = null;
  try {
    let host = p.db.host, port = p.db.port;
    if (sshCfg) {
      tunnel = await openSshTunnel(sshCfg, p.db); // no onDown: a test tunnel must never reset the live pool
      host = '127.0.0.1';
      port = tunnel.localPort;
    }
    conn = await mysql.createConnection({
      host, port, user: p.db.user, password: p.db.password, database: p.db.database, connectTimeout: 10000,
    });
    await conn.query('SELECT 1');
    logEvent('info', `Connection test OK: "${p.name}"`);
    res.json({ ok: true });
  } catch (e) {
    logEvent('warn', `Connection test failed for "${p.name}": ${e.message}`);
    throw httpError(400, `Test failed: ${e.message}`);
  } finally {
    if (conn) await conn.end().catch(() => {});
    if (tunnel) tunnel.close();
  }
}));

/* ---- SQL export: the exact queries a rule generates ---- */
app.get('/api/rules/:id/sql', wrap(async (req, res) => {
  const rule = rules.find((r) => r.id === req.params.id);
  if (!rule) throw httpError(404, 'Rule not found');
  const { sql, updateTemplate, limit } = await buildRuleQuery(rule);
  const text = [
    '-- Generated by mysql-approve-updater',
    `-- Rule: ${String(rule.name).replace(/[\r\n]+/g, ' ')} | Database: ${currentDb().database} | Exported: ${new Date().toISOString()}`,
    '',
    `-- Preview query (read-only; exactly what "Run preview" executes, server-capped LIMIT ${limit}):`,
    sql + ';',
    '',
    '-- Per-row update executed on each Approve. All values are bound parameters;',
    '-- the <=> conditions pin the row to its preview-time values (stale guard):',
    `-- ${updateTemplate};`,
    '',
  ].join('\n');
  const safeName = rule.name.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60) || 'rule';
  res.setHeader('Content-Disposition', `attachment; filename="rule-${safeName}.sql"`);
  res.type('application/sql').send(text);
}));

/* ---- preview ---- */
app.post('/api/rules/:id/preview', wrap(async (req, res) => {
  const rule = rules.find((r) => r.id === req.params.id);
  if (!rule) throw httpError(404, 'Rule not found');
  if (rule.draft) throw httpError(400, 'This rule is a draft — open it and use "Save rule" to publish it first');
  if (session && session.status !== 'done' && session.status !== 'aborted' && sessionCounts(session).pending > 0) {
    throw httpError(409, 'A session with pending changes is active — abort it or finish it first');
  }
  res.json(await runPreview(rule));
}));

/* ---- PHP-serialized helpers for the manual editor: decode to JSON for
        editing, encode back on save (byte lengths correct by construction) ---- */
const phpSer = require('php-serialize');
app.post('/api/php', wrap(async (req, res) => {
  const { mode, value } = req.body || {};
  if (mode === 'decode') {
    let data;
    try { data = phpSer.unserialize(String(value ?? '')); }
    catch (e) { throw httpError(400, `Value is not decodable serialized PHP: ${e.message}`); }
    res.json({ json: JSON.stringify(data, null, 2) });
  } else if (mode === 'encode') {
    let data;
    try { data = JSON.parse(String(value ?? '')); }
    catch (e) { throw httpError(400, `Invalid JSON: ${e.message}`); }
    res.json({ serialized: phpSer.serialize(data) });
  } else {
    throw httpError(400, 'mode must be "decode" or "encode"');
  }
}));

/* ---- manual edit of a proposed value (in-memory only — nothing is written
        until the change is approved through the normal guarded path) ---- */
app.post('/api/session/edit', wrap(async (req, res) => {
  const { changeId, column, newValue } = req.body || {};
  if (!session) throw httpError(409, 'No active session');
  if (session.status === 'aborted' || session.status === 'done') throw httpError(409, `Session is ${session.status}`);
  const change = session.changes.find((c) => c.id === changeId);
  if (!change) throw httpError(404, 'Change not found');
  if (change.status !== 'pending') throw httpError(409, `Change is already ${change.status}`);
  const col = change.cols.find((c) => c.column === column);
  if (!col) throw httpError(400, `Column "${column}" is not part of this change`);
  if (newValue !== null && typeof newValue !== 'string') throw httpError(400, 'newValue must be a string or null');
  if (valuesEqual(col.before, newValue)) throw httpError(400, 'Edited value equals the current DB value — use Skip instead');
  const previousProposed = col.after;
  col.after = newValue;
  col.manualEdit = true;
  audit({
    action: 'edit',
    rule: session.ruleName,
    table: session.table,
    pk: change.pk,
    column,
    oldValue: col.before,
    ruleProposed: previousProposed,
    manualProposed: newValue,
  });
  logEvent('info', `Manual edit on pk=${change.pk}, column ${column} (pending only — nothing written)`);
  broadcastChange(change);
  res.json(change);
}));

/* ---- decisions (serialized so approvals never interleave) ---- */
app.post('/api/session/decision', wrap(async (req, res) => {
  const { changeId, action } = req.body || {};
  const run = approvalChain.then(() => decideChange(changeId, action));
  approvalChain = run.catch(() => {});
  res.json(await run);
}));

/* ---- backup download (preview-time values of the current session) ---- */
app.get('/api/session/backup', (req, res) => {
  if (!session) throw httpError(404, 'No session — run a preview first');
  const b = buildBackup(session, req.query.format === 'json' ? 'json' : 'sql');
  res.setHeader('Content-Disposition', `attachment; filename="${b.filename}"`);
  res.type(b.mime).send(b.content);
  if (!session.backupDownloaded) {
    session.backupDownloaded = true;
    logEvent('info', 'Backup downloaded by operator');
    broadcastSession();
  }
});

/* ---- batch decision over selected rows (same per-row guarantees) ---- */
app.post('/api/session/batch', wrap(async (req, res) => {
  const { changeIds, action } = req.body || {};
  if (!Array.isArray(changeIds) || changeIds.length === 0) throw httpError(400, 'changeIds must be a non-empty array');
  if (!['approve', 'reject', 'skip'].includes(action)) throw httpError(400, `Unknown action "${action}"`);
  const run = approvalChain.then(async () => {
    const summary = { requested: changeIds.length, results: {}, stopped: null };
    logEvent('info', `Batch ${action}: ${changeIds.length} row(s) selected`);
    for (const id of changeIds) {
      try {
        const c = await decideChange(id, action);
        summary.results[c.status] = (summary.results[c.status] || 0) + 1;
      } catch (e) {
        // Session-level refusal (paused / aborted / gone) stops the batch;
        // per-change problems (already decided, not found) are counted and skipped.
        if (e.status === 409 && /paused|aborted|done|No active/i.test(e.message)) {
          summary.stopped = e.message;
          logEvent('warn', `Batch ${action} stopped: ${e.message}`);
          break;
        }
        summary.results.unavailable = (summary.results.unavailable || 0) + 1;
      }
    }
    return summary;
  });
  approvalChain = run.catch(() => {});
  res.json(await run);
}));

/* ---- session control ---- */
app.post('/api/session/pause', (req, res) => {
  if (!session || session.status !== 'running') throw httpError(409, 'No running session');
  session.status = 'paused';
  logEvent('info', 'Session paused');
  broadcastSession();
  res.json(sessionSnapshot());
});

app.post('/api/session/resume', (req, res) => {
  if (!session || session.status !== 'paused') throw httpError(409, 'No paused session');
  session.status = 'running';
  logEvent('info', 'Session resumed');
  broadcastSession();
  maybeFinishSession();
  res.json(sessionSnapshot());
});

app.post('/api/session/abort', wrap(async (req, res) => {
  if (!session || session.status === 'aborted') throw httpError(409, 'No session to abort');
  let discarded = 0;
  for (const c of session.changes) {
    if (c.status === 'pending') {
      c.status = 'skipped';
      c.note = 'discarded by abort';
      discarded++;
    }
  }
  session.status = 'aborted';
  audit({ action: 'abort', rule: session.ruleName, table: session.table, discardedPending: discarded });
  logEvent('warn', `Session aborted — ${discarded} pending change(s) discarded, nothing written`);
  broadcastSession();
  res.json(sessionSnapshot());
}));

/* ---- AI review of one pending change (single LLM call, result via SSE) ---- */
// windows around BOTH the first and last difference, so the reviewer can see
// every edge of the change (not just where it starts) to judge collateral damage
function reviewExcerpt(before, after, span = 900) {
  const a = String(before ?? ''), b = String(after ?? '');
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let sa = a.length, sb = b.length;
  while (sa > p && sb > p && a[sa - 1] === b[sb - 1]) { sa--; sb--; }
  const win = (s, from, to) => (from > 0 ? '…' : '') + s.slice(Math.max(0, from - 120), to + 120) + (to + 120 < s.length ? '…' : '');
  const near = (s, end) => `START-OF-CHANGE: ${win(s, p, p + span)}` + (end - p > span * 2 ? `\nEND-OF-CHANGE: ${win(s, Math.max(p, end - span), end)}` : '');
  return { before: near(a, sa), after: near(b, sb), beforeLen: a.length, afterLen: b.length, identical: p === a.length && p === b.length };
}

/* deterministic guard: does the proposed value equal EXACTLY what the rule's
   transforms produce from the before value? If yes, nothing beyond the rule
   happened. If no, it was manually edited or something is off. */
function ruleMatchCheck(rule, change) {
  if (!rule) return null;
  const results = [];
  for (const col of change.cols) {
    const row = { [col.column]: col.before };
    let expected;
    try { expected = applyTransforms(row, rule.transforms.filter((t) => t.column === col.column))[col.column]; }
    catch (e) { results.push({ column: col.column, ok: false, error: e.message }); continue; }
    results.push({ column: col.column, ok: valuesEqual(expected, col.after), manualEdit: !!col.manualEdit });
  }
  return results;
}

app.post('/api/session/review/:changeId', wrap(async (req, res) => {
  if (!agentConfig?.provider) throw httpError(400, 'No AI agent connected');
  if (!session) throw httpError(409, 'No active session');
  const change = session.changes.find((c) => c.id === req.params.changeId);
  if (!change) throw httpError(404, 'Change not found');
  if (change.aiReview?.status === 'pending') throw httpError(409, 'A review of this change is already running');
  change.aiReview = { status: 'pending' };
  broadcastChange(change);
  res.json({ ok: true }); // the verdict arrives over SSE when ready

  (async () => {
    try {
      const rule = rules.find((r) => r.id === session.ruleId);
      const matchCheck = ruleMatchCheck(rule, change);
      const ruleTargets = [...new Set((rule?.transforms || []).map((t) => t.column))];
      const changed = change.cols.map((c) => c.column);
      const cols = change.cols.map((c) => {
        const ex = reviewExcerpt(c.before, c.after);
        return `Column "${c.column}" (before ${ex.beforeLen} chars, after ${ex.afterLen} chars${c.manualEdit ? ', MANUALLY EDITED by the user after the rule ran' : ''}):\n[BEFORE]\n${ex.before}\n[AFTER]\n${ex.after}`;
      }).join('\n\n');
      const prompt = `You are reviewing ONE proposed row change in "MySQL Approve Updater" before a human approves it. Be a careful safety reviewer: the goal is to confirm the change does EXACTLY what the rule intends and destroys nothing else.

RULE (the intended modification): "${session.ruleName}"
  table: ${session.table}, row: ${session.pkColumn}=${change.pk}
  WHERE (which rows it targets): ${rule?.where || '(all)'}
  columns the rule is allowed to modify: ${JSON.stringify(ruleTargets)}
  transforms (in order): ${JSON.stringify(rule?.transforms || [])}

DETERMINISTIC CHECK (already computed by the server): for each changed column, does the proposed AFTER exactly equal the rule's own output re-computed from BEFORE?
  ${JSON.stringify(matchCheck)}
  - ok:true  => the AFTER is precisely the rule's transform output; no extra/hidden edits were introduced beyond the rule.
  - ok:false with manualEdit:true => a human hand-edited the value; scrutinize whether that manual result is safe and on-intent.
  - ok:false with manualEdit:false => ANOMALY: the value diverges from the rule for no known reason — treat with suspicion.

Columns actually changed: ${JSON.stringify(changed)} (these must be a subset of the rule's allowed columns above; flag "bad" if any other column were affected).

${cols}

Judge, in order of importance:
1. Confinement: is the change limited to the rule's intent, only on allowed columns, only matching what the rule describes? Nothing unrelated altered or deleted.
2. Structural safety: no broken HTML tags/attribute quotes, no corrupted PHP-serialized s:N byte lengths, no truncation, no unintended/duplicate replacements (e.g. a pattern that also matched inside URLs or other attributes it shouldn't).
3. Intent: does AFTER actually achieve what the rule name/transforms describe?
BEFORE/AFTER show windows at the start and end of the changed region (long unchanged middles are elided with …).

Reply with ONLY one line of JSON, nothing else: {"verdict":"ok"|"warn"|"bad","summary":"<max 2 short, specific sentences>"}`;
      const out = (await agentRun(prompt)).trim().replace(/^```(json)?\s*|\s*```$/g, '');
      let parsed = null;
      try { parsed = JSON.parse((out.match(/\{[\s\S]*\}/) || [out])[0]); } catch {}
      if (!parsed || !['ok', 'warn', 'bad'].includes(parsed.verdict)) parsed = { verdict: 'warn', summary: out.slice(0, 300) };
      change.aiReview = { status: 'done', verdict: parsed.verdict, summary: String(parsed.summary || '').slice(0, 500), at: new Date().toISOString() };
      logEvent('info', `AI review pk=${change.pk}: ${parsed.verdict} — ${change.aiReview.summary.slice(0, 120)}`);
    } catch (e) {
      change.aiReview = { status: 'error', summary: e.message };
      logEvent('error', `AI review failed for pk=${change.pk}: ${e.message}`);
    }
    broadcastChange(change);
  })();
}));

/* ---- clear: drop the whole session and reset the queue (nothing written) ---- */
app.post('/api/session/clear', wrap(async (req, res) => {
  if (!session) throw httpError(409, 'No session to clear');
  const pending = sessionCounts(session).pending;
  audit({ action: 'clear', rule: session.ruleName, table: session.table, discardedPending: pending });
  logEvent('warn', `Session cleared: ${pending} pending change(s) discarded, nothing written`);
  session = null;
  broadcastSession();
  res.json({ ok: true });
}));

/* ================= AI agent (local CLI providers, read-only tools) ================= */
const { spawn } = require('child_process');
const AGENT_FILE = path.join(DATA_DIR, 'agent.json');
let agentConfig = null;
try { agentConfig = JSON.parse(fs.readFileSync(AGENT_FILE, 'utf8')); } catch {}
const agentChat = []; // in-memory conversation: { role: 'user'|'assistant', text }

const AGENT_PROVIDERS = {
  claude: { label: 'Claude Code (CLI)', short: 'Claude Code', cmd: 'claude', kind: 'cli' },
  codex: { label: 'Codex CLI', short: 'Codex', cmd: 'codex', kind: 'cli' },
  'claude-api': { label: 'Claude (API key or sign-in token)', short: 'Claude', kind: 'api' },
};

/* direct Messages API call — used for API keys (sk-ant-api…) and OAuth tokens
   from browser sign-in flows like `claude setup-token` (sk-ant-oat…) */
async function claudeApiCall(apiKey, model, prompt, maxTokens = 1500) {
  const isOAuth = apiKey.startsWith('sk-ant-oat');
  const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (isOAuth) {
    headers.authorization = 'Bearer ' + apiKey;
    headers['anthropic-beta'] = 'oauth-2025-04-20';
  } else {
    headers['x-api-key'] = apiKey;
  }
  const body = { model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] };
  // OAuth tokens from the Claude sign-in flow are scoped to Claude Code and are
  // rejected unless the request identifies as such via this exact system prompt.
  if (isOAuth) body.system = "You are Claude Code, Anthropic's official CLI for Claude.";
  let res, j;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(body) });
    j = await res.json().catch(() => ({}));
  } catch (e) {
    throw new Error(`network error reaching api.anthropic.com: ${e.message}`);
  }
  if (!res.ok) {
    const msg = j?.error?.message || j?.error?.type || j?.error || (typeof j === 'string' ? j : '') || `HTTP ${res.status}`;
    throw new Error(`${res.status} ${msg}`);
  }
  return (j.content || []).map((c) => c.text || '').join('').trim();
}

function runCli(cmd, args, input, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: true, cwd: DATA_DIR, windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} reject(new Error('Agent CLI timed out')); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`agent CLI exited ${code}: ${(err || out).slice(0, 400)}`));
    });
    if (input != null) child.stdin.write(input);
    child.stdin.end();
  });
}

async function probeProvider(key) {
  if (AGENT_PROVIDERS[key].kind === 'api') return true; // nothing to probe until a key is given
  try { await runCli(AGENT_PROVIDERS[key].cmd, ['--version'], null, 20000); return true; } catch { return false; }
}

async function agentRun(prompt) {
  const model = agentConfig.model || null; // null = provider/CLI default
  if (agentConfig.provider === 'claude-api') {
    try {
      return await claudeApiCall(agentConfig.apiKey, model || 'claude-sonnet-4-5', prompt);
    } catch (e) {
      // expired sign-in token: refresh once and retry
      if (/401|authentication|expired/i.test(e.message) && (await refreshClaudeToken())) {
        return claudeApiCall(agentConfig.apiKey, model || 'claude-sonnet-4-5', prompt);
      }
      throw e;
    }
  }
  if (agentConfig.provider === 'codex') {
    const lastFile = path.join(DATA_DIR, '.agent-last.txt');
    try { await fsp.unlink(lastFile); } catch {}
    const args = ['exec', '--skip-git-repo-check'];
    if (model) args.push('-m', model);
    args.push('--output-last-message', `"${lastFile}"`, '-');
    await runCli('codex', args, prompt);
    const txt = (await fsp.readFile(lastFile, 'utf8')).trim();
    fsp.unlink(lastFile).catch(() => {});
    return txt;
  }
  const args = ['-p'];
  if (model) args.push('--model', model);
  return runCli('claude', args, prompt); // print mode: prompt on stdin, answer on stdout
}

/* read-only tools, executed by THIS server against the active connection */
const AGENT_TOOLS = {
  get_state: {
    desc: 'Current app state: connection info (no secrets) and active approval-session summary.',
    run: async () => ({
      config: { database: currentDb().database, sshTunnel: !!currentSsh(), profile: activeProfile().name },
      session: session ? { ...sessionSnapshot(), changes: `${session.changes.length} changes (use get_audit_tail or ask the user for details)` } : null,
    }),
  },
  list_rules: { desc: 'All saved rules and drafts (their full definitions).', run: async () => rules },
  list_tables: {
    desc: 'Tables of the connected database (max 200). Input: {"like":"optional name filter"}',
    run: async (inp) => {
      const pool = await getPool();
      const [rows] = await pool.execute(
        `SELECT TABLE_NAME AS tableName, TABLE_ROWS AS approxRows FROM information_schema.tables
          WHERE table_schema = ? AND TABLE_NAME LIKE ? ORDER BY TABLE_NAME LIMIT 200`,
        [currentDb().database, `%${String(inp?.like || '')}%`]
      );
      return rows;
    },
  },
  get_table: { desc: 'Column list of one table. Input: {"table":"name"}', run: async (inp) => getTableColumns(String(inp?.table || '')) },
  run_sql: {
    desc: 'Run a READ-ONLY query (SELECT/SHOW/EXPLAIN/DESCRIBE, single statement) on the connected database. Input: {"sql":"..."}. Result capped at 50 rows.',
    run: async (inp) => {
      const { sql, kw } = validateConsoleSql(String(inp?.sql || ''));
      const pool = await getPool();
      let rows;
      if (kw === 'SELECT' || kw === 'WITH') {
        try { [rows] = await pool.query({ sql: `SELECT * FROM (${sql}) AS _a LIMIT 51`, timeout: 30000 }); }
        catch { [rows] = await pool.query({ sql, timeout: 30000 }); }
      } else {
        [rows] = await pool.query({ sql, timeout: 30000 });
      }
      return { rows: rows.slice(0, 50), truncated: rows.length > 50 };
    },
  },
  get_audit_tail: {
    desc: 'Last N audit-log entries (decisions, previews, edits). Input: {"n":20}',
    run: async (inp) => {
      try {
        const lines = (await fsp.readFile(AUDIT_FILE, 'utf8')).trim().split('\n');
        return lines.slice(-Math.min(50, Number(inp?.n) || 20)).map((l) => { try { return JSON.parse(l); } catch { return l; } });
      } catch { return []; }
    },
  },
  propose_rule: {
    desc: 'Propose creating or updating a RULE (requires explicit user approval in the UI before it is saved; nothing happens without it). ' +
      'Input: {"action":"create"|"update","ruleId":"<existing rule id, update only>","rule":{"name","table","pkColumn","where","limit",' +
      '"displayColumns":"comma,separated","transforms":[{"column","type","params","phpSerialized"}],"draft":bool}}. ' +
      'Transform types: findReplace(params: find, replace, regex, flags), trim, changeCase(params: mode=upper|lower|title), prefix(params: text), suffix(params: text), setValue(params: value or setNull).',
    run: async (inp) => {
      const action = inp?.action === 'update' ? 'update' : 'create';
      let existing = null;
      if (action === 'update') {
        existing = rules.find((r) => r.id === String(inp?.ruleId || ''));
        if (!existing) throw new Error('ruleId not found — use list_rules to get valid ids');
      }
      const clean = sanitizeRuleInput(inp?.rule || {}); // same validation as the UI editor
      const prop = {
        id: crypto.randomUUID(), action, ruleId: existing?.id || null, targetName: existing?.name || null,
        rule: clean, status: 'pending', ts: new Date().toISOString(),
      };
      agentProposals.push(prop);
      while (agentProposals.length > 30) agentProposals.shift();
      logEvent('info', `AI agent proposed rule ${action}: "${clean.name}" (awaiting user approval)`);
      return { proposalId: prop.id, status: 'pending_user_approval', note: 'Submitted. The user must approve it in the chat UI; do not assume it exists yet.' };
    },
  },
};
const agentProposals = []; // rule change proposals awaiting explicit user decision

function agentSystemPrompt() {
  const toolLines = Object.entries(AGENT_TOOLS).map(([k, v]) => `- ${k}: ${v.desc}`).join('\n');
  return `You are the embedded AI assistant of "MySQL Approve Updater", a tool that runs rule-based MySQL updates where every row change needs explicit human approval.
STRICT SCOPE: only this tool and the currently connected database "${currentDb().database}". Politely refuse anything outside that scope (general coding help, other systems, the wider filesystem, etc).
DATABASE access is strictly READ-ONLY: you can never write to the database. Row changes only happen through rules whose previewed changes the USER approves.
You MAY create or update RULES via the propose_rule tool — but every proposal requires the user's explicit approval in the UI before it is saved; never claim a rule exists until a system note confirms approval.
To gather information, reply with ONLY one JSON object on a single line, nothing else: {"tool":"<name>","input":{...}}
Available tools:
${toolLines}
After a tool result you may call another tool (max 6 total) or give your final answer as plain text (never JSON). Keep answers concise and concrete.`;
}

function parseAgentToolCall(s) {
  const tryParse = (str) => {
    try { const j = JSON.parse(str); if (j && typeof j.tool === 'string' && AGENT_TOOLS[j.tool]) return j; } catch {}
    return null;
  };
  const line = s.trim().replace(/^```(json)?\s*|\s*```$/g, '');
  return tryParse(line) || (line.startsWith('{') ? null : tryParse((line.match(/\{[\s\S]*\}/) || [])[0] || ''));
}

app.get('/api/agent', wrap(async (req, res) => {
  const probe = req.query.probe === '1';
  const providers = {};
  for (const [k, v] of Object.entries(AGENT_PROVIDERS)) {
    providers[k] = { label: v.label, cmd: v.cmd, kind: v.kind, available: probe ? await probeProvider(k) : undefined };
  }
  res.json({
    connected: !!agentConfig?.provider, provider: agentConfig?.provider || null,
    model: agentConfig?.model || null, // the stored key/token is never sent to the browser
    providers, chat: agentChat, proposals: agentProposals.filter((p) => p.status === 'pending'),
  });
}));

/* user decision on an agent rule proposal */
app.post('/api/agent/proposal/:id', wrap(async (req, res) => {
  const prop = agentProposals.find((p) => p.id === req.params.id);
  if (!prop) throw httpError(404, 'Proposal not found');
  if (prop.status !== 'pending') throw httpError(409, `Proposal already ${prop.status}`);
  const decision = req.body?.decision === 'approve' ? 'approved' : 'rejected';
  if (decision === 'approved') {
    if (prop.action === 'update') {
      const idx = rules.findIndex((r) => r.id === prop.ruleId);
      if (idx === -1) throw httpError(409, 'The target rule no longer exists');
      rules[idx] = { id: prop.ruleId, ...prop.rule };
    } else {
      rules.push({ id: crypto.randomUUID(), ...prop.rule });
    }
    await saveRules();
  }
  prop.status = decision;
  agentChat.push({
    role: 'note', kind: 'decision', decision, proposalAction: prop.action, ruleName: prop.rule.name,
    text: `User ${decision} the agent's rule-${prop.action} proposal "${prop.rule.name}".`,
  });
  audit({ action: `agent-rule-${decision}`, rule: prop.rule.name, table: prop.rule.table, proposalAction: prop.action });
  logEvent(decision === 'approved' ? 'info' : 'warn', `AI agent rule proposal ${decision}: "${prop.rule.name}"`);
  res.json({ ok: true, status: decision });
}));

app.post('/api/agent/connect', wrap(async (req, res) => {
  const provider = String(req.body?.provider || '');
  const p = AGENT_PROVIDERS[provider];
  if (!p) throw httpError(400, 'Unknown provider');
  if (p.kind === 'api') {
    const apiKey = String(req.body?.apiKey || '').trim();
    const model = String(req.body?.model || '').trim() || 'claude-sonnet-4-5';
    if (!apiKey) throw httpError(400, 'Paste an API key (console.anthropic.com) or a sign-in token (run: claude setup-token)');
    try { await claudeApiCall(apiKey, model, 'Reply with the single word: ok', 8); }
    catch (e) { throw httpError(400, `Key/token validation failed: ${e.message}`); }
    agentConfig = { provider, model, apiKey, connectedAt: new Date().toISOString() };
  } else {
    if (!(await probeProvider(provider))) {
      throw httpError(400, `${p.label} not found: "${p.cmd} --version" failed on this machine`);
    }
    agentConfig = { provider, connectedAt: new Date().toISOString() };
  }
  await fsp.writeFile(AGENT_FILE, JSON.stringify(agentConfig, null, 2), 'utf8'); // persists across restarts
  logEvent('info', `AI agent connected: ${p.label}${agentConfig.model ? ` (${agentConfig.model})` : ''}`);
  res.json({ ok: true, provider });
}));

/* Claude browser sign-in (OAuth + PKCE, same public flow as `claude setup-token`) */
const CLAUDE_OAUTH = {
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authorizeUrl: 'https://claude.ai/oauth/authorize',
  tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
  redirectUri: 'https://console.anthropic.com/oauth/code/callback',
  scopes: 'org:create_api_key user:profile user:inference',
};
let oauthPending = null; // { verifier, ts }

app.post('/api/agent/oauth/start', wrap(async (req, res) => {
  // reuse a fresh pending attempt: clicking the button twice must NOT invalidate
  // the code from an already-opened authorization tab (PKCE binds code↔verifier)
  if (!oauthPending || Date.now() - oauthPending.ts > 10 * 60 * 1000) {
    oauthPending = { verifier: crypto.randomBytes(32).toString('base64url'), ts: Date.now() };
  }
  const verifier = oauthPending.verifier;
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const u = new URL(CLAUDE_OAUTH.authorizeUrl);
  u.searchParams.set('code', 'true');
  u.searchParams.set('client_id', CLAUDE_OAUTH.clientId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', CLAUDE_OAUTH.redirectUri);
  u.searchParams.set('scope', CLAUDE_OAUTH.scopes);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', verifier);
  res.json({ url: u.toString() });
}));

app.post('/api/agent/oauth/finish', wrap(async (req, res) => {
  let raw = String(req.body?.code || '').replace(/\s+/g, '');
  if (raw.includes('code=')) { try { raw = new URL(raw).searchParams.get('code') || raw; } catch {} } // tolerate a pasted URL
  if (!raw) throw httpError(400, 'Paste the authorization code shown after approving access');
  const [code, statePart] = raw.split('#');
  // We set state = code_verifier when building the authorize URL, so a full
  // "code#state" paste is SELF-CONTAINED: the exchange works even if the
  // server restarted or a newer sign-in attempt replaced the in-memory one.
  const verifier = statePart && /^[A-Za-z0-9_-]{20,}$/.test(statePart) ? statePart : oauthPending?.verifier;
  if (!verifier) {
    throw httpError(400, 'Missing sign-in state: paste the FULL code including everything after "#" (or click "Sign in with Claude" and complete the fresh tab)');
  }
  const r = await fetch(CLAUDE_OAUTH.tokenUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code', code, state: statePart || verifier,
      client_id: CLAUDE_OAUTH.clientId, redirect_uri: CLAUDE_OAUTH.redirectUri, code_verifier: verifier,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    logEvent('warn', `Claude sign-in exchange failed: HTTP ${r.status} ${JSON.stringify(j).slice(0, 250)} ` +
      `(code ${code.length} chars [${code.slice(0, 6)}…], state ${(statePart || '').length} chars, ` +
      `${statePart && oauthPending && statePart === oauthPending.verifier ? 'from the CURRENT sign-in attempt' : 'from an OLDER sign-in attempt/tab'})`);
    throw httpError(400, `Authorization failed: ${j.error_description || j.error || 'HTTP ' + r.status}. ` +
      `Each code works once — click "Sign in with Claude" for a fresh tab, approve, then paste the FULL code (both parts around "#").`);
  }
  const model = String(req.body?.model || '').trim() || 'claude-sonnet-4-5';
  try { await claudeApiCall(j.access_token, model, 'Reply with the single word: ok', 16); }
  catch (e) {
    logEvent('warn', `Claude sign-in token validation failed: ${e.message}`);
    throw httpError(400, `Signed in, but the token failed validation: ${e.message}`);
  }
  agentConfig = {
    provider: 'claude-api', model, apiKey: j.access_token,
    refreshToken: j.refresh_token || null, connectedAt: new Date().toISOString(),
  };
  oauthPending = null;
  await fsp.writeFile(AGENT_FILE, JSON.stringify(agentConfig, null, 2), 'utf8');
  logEvent('info', 'AI agent connected via Claude browser sign-in');
  res.json({ ok: true, provider: 'claude-api' });
}));

async function refreshClaudeToken() {
  if (!agentConfig?.refreshToken) return false;
  const r = await fetch(CLAUDE_OAUTH.tokenUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: agentConfig.refreshToken, client_id: CLAUDE_OAUTH.clientId }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) return false;
  agentConfig.apiKey = j.access_token;
  if (j.refresh_token) agentConfig.refreshToken = j.refresh_token;
  await fsp.writeFile(AGENT_FILE, JSON.stringify(agentConfig, null, 2), 'utf8');
  logEvent('info', 'Claude sign-in token refreshed');
  return true;
}

app.post('/api/agent/disconnect', wrap(async (req, res) => {
  agentConfig = null;
  agentChat.length = 0;
  try { await fsp.unlink(AGENT_FILE); } catch {}
  logEvent('info', 'AI agent disconnected');
  res.json({ ok: true });
}));

app.post('/api/agent/reset', (req, res) => { agentChat.length = 0; res.json({ ok: true }); });

/* switch the model live (all providers; empty string = provider default) */
app.post('/api/agent/model', wrap(async (req, res) => {
  if (!agentConfig?.provider) throw httpError(400, 'No AI agent connected');
  const model = String(req.body?.model || '').trim();
  agentConfig.model = model || null;
  await fsp.writeFile(AGENT_FILE, JSON.stringify(agentConfig, null, 2), 'utf8');
  logEvent('info', `AI agent model set to: ${model || '(provider default)'}`);
  res.json({ ok: true, model: agentConfig.model });
}));

/* push an AI review of a pending change into the conversation as context */
app.post('/api/agent/context-review', wrap(async (req, res) => {
  if (!agentConfig?.provider) throw httpError(400, 'No AI agent connected');
  if (!session) throw httpError(409, 'No active session');
  const change = session.changes.find((c) => c.id === String(req.body?.changeId || ''));
  if (!change?.aiReview || change.aiReview.status !== 'done') throw httpError(400, 'No completed review on that change');
  const cols = change.cols.map((c) => c.column).join(', ');
  agentChat.push({
    role: 'note', kind: 'review',
    verdict: change.aiReview.verdict, summary: change.aiReview.summary,
    rule: session.ruleName, pk: change.pk, table: session.table, columns: cols,
    text: `The user shared a prior AI review of a pending change (rule "${session.ruleName}", table ${session.table}, ${session.pkColumn}=${change.pk}, column(s) ${cols}). Verdict: ${change.aiReview.verdict}. Summary: ${change.aiReview.summary}`,
  });
  while (agentChat.length > 20) agentChat.shift();
  logEvent('info', `AI review of pk=${change.pk} sent to chat as context`);
  res.json({ ok: true });
}));

/* attach one rule to the conversation as context */
app.post('/api/agent/context', wrap(async (req, res) => {
  if (!agentConfig?.provider) throw httpError(400, 'No AI agent connected');
  const rule = rules.find((r) => r.id === String(req.body?.ruleId || ''));
  if (!rule) throw httpError(404, 'Rule not found');
  agentChat.push({
    role: 'note', kind: 'context', rule,
    text: `The user attached rule "${rule.name}" (id ${rule.id}) as context for the conversation: ${JSON.stringify(rule)}`,
  });
  while (agentChat.length > 20) agentChat.shift();
  logEvent('info', `AI chat context: rule "${rule.name}" attached`);
  res.json({ ok: true, name: rule.name });
}));

app.post('/api/agent/chat', wrap(async (req, res) => {
  if (!agentConfig?.provider) throw httpError(400, 'No AI agent connected');
  const message = String(req.body?.message || '').trim();
  if (!message) throw httpError(400, 'Empty message');
  agentChat.push({ role: 'user', text: message });
  while (agentChat.length > 20) agentChat.shift();
  const actions = [];
  const propBefore = agentProposals.length;
  let transcriptExtra = '';
  let reply = null;
  for (let step = 0; step < 6; step++) {
    const who = AGENT_PROVIDERS[agentConfig.provider].short + (agentConfig.model ? ` (${agentConfig.model})` : '');
    sseBroadcast('agent', { type: 'step', step: step + 1, msg: `thinking with ${who}` });
    const prompt = agentSystemPrompt() + '\n\n--- Conversation ---\n' +
      agentChat.map((m) => `${m.role === 'user' ? 'User' : m.role === 'note' ? 'System note' : 'Assistant'}: ${m.text}`).join('\n\n') +
      transcriptExtra + '\n\nAssistant:';
    const outRaw = (await agentRun(prompt)).trim();
    const call = parseAgentToolCall(outRaw);
    if (!call) { sseBroadcast('agent', { type: 'final' }); reply = outRaw; break; }
    sseBroadcast('agent', { type: 'tool', tool: call.tool, input: JSON.stringify(call.input || {}).slice(0, 140) });
    const t0 = Date.now();
    let result, ok = true;
    try { result = await AGENT_TOOLS[call.tool].run(call.input || {}); }
    catch (e) { ok = false; result = { error: e.message }; }
    let resultStr = JSON.stringify(result);
    if (resultStr.length > 12000) resultStr = resultStr.slice(0, 12000) + ' …(truncated)';
    actions.push({ tool: call.tool, input: call.input || {}, ok, ms: Date.now() - t0 });
    sseBroadcast('agent', { type: 'tool-done', tool: call.tool, ok, ms: Date.now() - t0 });
    logEvent('info', `AI agent action: ${call.tool} ${JSON.stringify(call.input || {}).slice(0, 120)} (${Date.now() - t0}ms${ok ? '' : ', FAILED'})`);
    transcriptExtra += `\n\nAssistant: ${outRaw}\n\nTool result for ${call.tool}: ${resultStr}`;
  }
  if (reply == null) reply = 'I hit the tool-step limit before finishing. Ask again more specifically.';
  agentChat.push({ role: 'assistant', text: reply });
  res.json({ reply, actions, proposals: agentProposals.slice(propBefore).filter((p) => p.status === 'pending') });
}));

/* ---- audit viewer: parsed tail, newest first ---- */
app.get('/api/audit', wrap(async (req, res) => {
  const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 500));
  let entries = [];
  try {
    const lines = (await fsp.readFile(AUDIT_FILE, 'utf8')).split('\n').filter((l) => l.trim());
    entries = lines.slice(-limit).map((l, i) => { try { const o = JSON.parse(l); o._n = i; return o; } catch { return { _raw: l }; } }).reverse();
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const actions = [...new Set(entries.map((e) => e.action).filter(Boolean))].sort();
  res.json({ entries, actions, total: entries.length });
}));

/* ---- audit download ---- */
app.get('/api/audit.log', (req, res) => {
  if (!fs.existsSync(AUDIT_FILE)) return res.status(404).type('text/plain').send('No audit entries yet');
  res.setHeader('Content-Disposition', 'attachment; filename="audit.log"');
  res.type('application/x-ndjson');
  fs.createReadStream(AUDIT_FILE).pipe(res);
});

/* ---- SSE ---- */
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: session\ndata: ${JSON.stringify(sessionSnapshot())}\n\n`);
  sseClients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
});

/* ---- errors ---- */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Internal error' });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`mysql-approve-updater listening on http://localhost:${PORT} (localhost only)`);
  const db = currentDb(), ssh = currentSsh();
  console.log(`Connection profile: "${activeProfile().name}" — ${db.database} @ ${db.host}:${db.port}${ssh ? ` via SSH tunnel ${ssh.host}` : ' (direct)'}`);
  console.log('No database connection is opened until you load the schema or run a preview.');
  if (IS_PACKAGED && process.platform === 'win32' && !process.env.MAU_NO_OPEN) {
    // double-click convenience: open the UI in the default browser
    require('child_process').exec(`start http://localhost:${PORT}`, () => {});
  }
});