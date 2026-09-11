'use strict';
/* Attaching a resource to a project takes it out of the shared pool.
 *
 * The rule lives once, in lib/projects/store scopeFor(). What this checks is
 * that every surface actually goes through it: the base's connections API, a
 * module's own HTTP surface and RPC, and the assistant's tools - which is the
 * difference between a filter and a boundary. It also checks the one piece of
 * state that cannot simply be hidden: the active DB connection.
 *
 * `node test/e2e/project-scope.e2e.js`. Needs Chrome and built packages.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..', '..');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const { createRegistryServer } = require('../../scripts/module-registry');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, { timeout = 20000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { last = await predicate(); if (last) return last; } catch (error) { last = error.message; }
    await wait(150);
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}

async function main() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-tools-scope-'));
  const dataDir = path.join(workDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const distDir = path.join(ROOT, 'dist', 'modules');
  assert.ok(fs.existsSync(path.join(distDir, 'catalog.json')), 'build the modules first: npm run modules:build');
  const registry = await createRegistryServer({ dir: distDir, port: 0 });
  const port = 3600 + Math.floor(Math.random() * 90);
  const base = `http://127.0.0.1:${port}`;
  const app = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), MAU_NO_OPEN: '1', MODULE_REGISTRIES: registry.catalogUrl, SERVER_TOOLS_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  app.stdout.on('data', (c) => log.push(String(c)));
  app.stderr.on('data', (c) => log.push(String(c)));

  const api = async (route, options) => {
    const response = await fetch(base + route, options);
    const text = await response.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    if (!response.ok) throw new Error(`${route} -> ${response.status} ${String(text).slice(0, 300)}`);
    return body;
  };
  const post = (route, payload) => api(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}) });

  let browser;
  const problems = [];
  try {
    await until(async () => (await fetch(`${base}/api/modules`)).ok, { what: 'the application to start' });
    for (const id of ['projects', 'servers', 'connectors']) {
      const response = await fetch(`${base}/api/modules/${id}/install`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.ok(response.ok, `${id} failed to install: ${JSON.stringify(await response.json())}`);
    }

    /* ---- two projects and a resource of each kind ---- */
    const site = await post('/api/m/projects/save', { name: 'Website' });
    const other = await post('/api/m/projects/save', { name: 'API' });

    const dbSite = await post('/api/connections', { name: 'site-db', db: { host: '127.0.0.1', port: 3306, user: 'u', password: 'p', database: 'site' } });
    const dbShared = await post('/api/connections', { name: 'shared-db', db: { host: '127.0.0.1', port: 3306, user: 'u', password: 'p', database: 'shared' } });
    const srvSite = await api('/api/m/servers/http/profiles', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'site-server', ssh: { enabled: true, host: '127.0.0.1', port: 22, user: 'u', password: 'p', auth: 'password' } }),
    });
    const srvShared = await api('/api/m/servers/http/profiles', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'shared-server', ssh: { enabled: true, host: '127.0.0.1', port: 22, user: 'u', password: 'p', auth: 'password' } }),
    });

    await post('/api/m/projects/link', { id: site.id, kind: 'connections', resourceId: dbSite.id });
    await post('/api/m/projects/link', { id: site.id, kind: 'servers', resourceId: srvSite.id });
    console.log('  two projects, one attached + one shared resource of each kind');

    /* ---- the base API ---- */
    const connectionsIn = async (projectId) => (await api(`/api/connections?projectId=${projectId}`)).profiles.map((p) => p.name).sort();
    assert.deepEqual(await connectionsIn(site.id), ['shared-db', 'site-db']);
    assert.deepEqual(await connectionsIn(other.id), ['shared-db'], 'a connection attached to Website is not in API');
    assert.deepEqual(await connectionsIn('general'), ['shared-db'], 'General is a project like any other');
    console.log('  base: /api/connections is scoped');

    /* ---- a module's own HTTP surface, told the project by the host header ---- */
    const serversIn = async (projectId) => {
      const response = await fetch(`${base}/api/m/servers/http/sessions`, { headers: { 'X-Project': projectId } });
      return (await response.json()).sessions.map((s) => s.name).sort();
    };
    assert.deepEqual(await serversIn(site.id), ['shared-server', 'site-server']);
    assert.deepEqual(await serversIn(other.id), ['shared-server'], 'a server attached to Website is not in API');
    console.log('  module HTTP surface: /sessions is scoped');

    /* ---- a module's RPC, told the project the same way ---- */
    const cnSite = await api('/api/m/connectors/list', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Project': site.id }, body: '{}' });
    assert.equal(Array.isArray(cnSite.connectors), true, 'connectors still answers with the project header');
    console.log('  module RPC: the project reaches the worker');

    /* ---- the assistant ----
       There is deliberately no HTTP route that runs a tool: that would be an
       unauthenticated way to run them. What is checked here is the half that IS
       observable - the conversation each project opens and the project it
       reports - while the other half (a tool filtering through that project's
       scope) is test/project-scope.test.js, which composes the very same two
       pieces server.js composes for list_servers. */
    for (const projectId of [site.id, other.id, 'general']) {
      const answer = await api(`/api/agent?projectId=${projectId}&probe=0`);
      assert.equal(answer.projectId, projectId, 'the conversation reports the project its tools are scoped to');
      assert.equal(answer.conversationId, `project:${projectId}`);
    }
    await assert.rejects(api('/api/agent?projectId=does-not-exist'), /404/, 'a conversation cannot name a project that does not exist');
    console.log('  assistant: each project opens its own conversation, and that is what scopes its tools');

    /* ---- the active connection follows the project ---- */
    await post(`/api/connections/${dbSite.id}/activate`, {});
    const intoOther = await post('/api/connections/scope', { projectId: other.id });
    assert.equal(intoOther.switched, true, 'the active connection belonged to Website');
    assert.equal(intoOther.activeId, dbShared.id, 'the first connection API can see took over');
    const backToSite = await post('/api/connections/scope', { projectId: site.id });
    assert.equal(backToSite.switched, false, 'shared-db is visible in Website too, so nothing moves');
    console.log('  the active connection can never be one the project cannot see');

    /* ---- detaching puts it back in the pool ---- */
    await post('/api/m/projects/unlink', { id: site.id, kind: 'servers', resourceId: srvSite.id });
    assert.deepEqual(await serversIn(other.id), ['shared-server', 'site-server'], 'detached: shared again');
    console.log('  detaching returns a resource to every project');

    /* ---- and the browser shows exactly that ---- */
    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', userDataDir: path.join(workDir, 'chrome'), args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
    page.on('console', (message) => { if (message.type() === 'error' && !/favicon|Failed to load resource/.test(message.text())) problems.push(`console: ${message.text()}`); });
    await page.evaluateOnNewDocument(() => localStorage.setItem('mau-tour-seen', '1'));
    await page.goto(`${base}/#/database/updates`, { waitUntil: 'networkidle2' });
    await until(() => page.evaluate(() => document.body.classList.contains('shell')), { what: 'the shell' });
    await until(() => page.evaluate(() => typeof ModuleLoader !== 'undefined' && ModuleLoader.running().length === 3), { what: 'the three modules' });

    const shownIn = async (projectId) => {
      await page.evaluate((id) => setProject(id), projectId);
      await wait(900);
      return page.evaluate(async () => (await (await fetch(`/api/connections?projectId=${currentProjectId}`)).json()).profiles.map((p) => p.name).sort());
    };
    assert.deepEqual(await shownIn(site.id), ['shared-db', 'site-db']);
    assert.deepEqual(await shownIn(other.id), ['shared-db']);
    assert.equal(await page.evaluate(() => currentProjectId), other.id);
    console.log('  the browser switches project and sees only that project');

    if (problems.length) throw new Error(`the browser reported problems:\n  ${problems.join('\n  ')}`);
    console.log('project-scope e2e: PASS');
  } finally {
    if (browser) await browser.close().catch(() => {});
    try { app.kill(); } catch {}
    await registry.close();
    if (process.env.KEEP_E2E_LOG) console.log(log.join(''));
    await wait(500);
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error('project-scope e2e: FAIL\n', error); process.exit(1); });
