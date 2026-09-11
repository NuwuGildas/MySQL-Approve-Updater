'use strict';
/* A host for this module alone: the vault it borrows, the audit trail it writes
   to, and a data directory that is thrown away afterwards. No real provider is
   contacted - `fetch` is replaced for the duration of each test. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Build a provider response the way `fetch` returns one. */
const reply = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
  json: async () => body,
});

/** Replace global fetch for one test, restoring it however the test ends. */
function stubFetch(t, handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), headers: options.headers || {} });
    return handler(String(url), options);
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

function createTestHost(t, { vault = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-connectors-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const audits = [];
  const events = [];
  const logs = [];
  const host = {
    id: 'connectors',
    version: '1.0.0',
    appDataDir: dir,
    dataDir: dir,
    log: (level, message) => logs.push({ level, message }),
    emit: (event, payload) => events.push({ event, payload }),
    audit: async (entry) => { audits.push(entry); },
    async call(method, params = {}) {
      switch (method) {
        /* The vault is the host's. This module may name a secret and read one
           back; it never sees where or how it is stored. */
        case 'vault.set': vault[params.name] = String(params.value); return { ok: true };
        case 'vault.get':
          if (!(params.name in vault)) throw Object.assign(new Error(`no secret named ${params.name}`), { status: 404 });
          return vault[params.name];
        case 'vault.has': return Object.hasOwn(vault, params.name);
        case 'vault.names': return Object.keys(vault).sort();
        case 'vault.remove': delete vault[params.name]; return { ok: true };
        default: throw new Error(`the module made an undeclared host call: ${method}`);
      }
    },
  };
  return { host, dir, vault, audits, events, logs, file: path.join(dir, 'connectors.json') };
}

module.exports = { createTestHost, stubFetch, reply };
