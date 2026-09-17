'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { connectionOptions, createMysqlStore } = require('../../lib/persistence/mysql');

test('live MySQL HTTP saves survive restart with no application JSON files', { skip: process.env.APP_DB_TEST !== '1', timeout: 60000 }, async () => {
  const pool = require('mysql2/promise').createPool(connectionOptions());
  const store = createMysqlStore(pool);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mysql-http-'));
  let child;
  let owns = false;
  const keys = ['settings.json', 'projects.json', 'browser-state.json', 'audit.log', 'module-data/state.json'];
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const done = once(child, 'exit');
    child.kill(); await done; child = null;
  }
  async function start() {
    // Port zero avoids races with an existing installation.
    child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '../..'), env: {
      ...process.env, APP_STORAGE: 'mysql', SERVER_TOOLS_DATA_DIR: root, PORT: '0', MAU_NO_OPEN: '1',
      DB_NAME: '', DB_USER: '', MODULE_REGISTRIES: '',
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server did not start')), 20000);
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${output}`)); });
      child.stdout.on('data', (b) => {
        output += b;
        const match = /listening on http:\/\/localhost:(\d+)/.exec(output);
        if (match && Number(match[1])) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
      });
      child.stderr.on('data', (b) => { output += b; });
    });
  }
  try {
    await store.initialize();
    for (const key of keys) assert.equal(await store.get(key), null, 'HTTP integration test requires an empty disposable application DB');
    owns = true;
    let base = await start();
    let response = await fetch(base + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxPreviewRows: 731 }) });
    assert.equal(response.status, 200);
    response = await fetch(base + '/api/browser-state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ changes: { 'st-theme': 'light' } }) });
    assert.equal(response.status, 200);
    assert.equal((await store.readJson('settings.json')).value.maxPreviewRows, 731);
    await assert.rejects(fs.access(path.join(root, 'settings.json')), { code: 'ENOENT' });
    await stop();
    base = await start();
    assert.equal((await (await fetch(base + '/api/settings')).json()).maxPreviewRows, 731);
    assert.equal((await (await fetch(base + '/api/browser-state')).json()).values['st-theme'], 'light');
  } finally {
    await stop();
    if (owns) for (const key of keys) await pool.execute('DELETE FROM st_documents WHERE document_key = ?', [key]);
    await pool.end(); await fs.rm(root, { recursive: true, force: true });
  }
});
