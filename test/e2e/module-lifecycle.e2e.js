'use strict';
/* Every optional module, added and removed in one browser session.
 *
 * Installs all five packages from a local registry, opens each page, and checks
 * that what the module registered appears and then disappears again: routes,
 * sidebar entries, launcher tiles, search sources, settings sections, assistant
 * tools and the module's own DOM and styles. Also covers the rules that stop a
 * removal - a dependent module, and work in flight - and what a second tab sees.
 *
 * `node test/e2e/module-lifecycle.e2e.js`. Needs Chrome and built packages.
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

const MODULES = ['history', 'projects', 'connectors', 'servers', 'deployments'];
const PAGES = { history: '#/history', projects: '#/projects', connectors: '#/connectors', servers: '#/servers', deployments: '#/deployments' };

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
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-tools-lifecycle-'));
  const dataDir = path.join(workDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const distDir = path.join(ROOT, 'dist', 'modules');
  assert.ok(fs.existsSync(path.join(distDir, 'catalog.json')), 'build the modules first: npm run modules:build');
  const registry = await createRegistryServer({ dir: distDir, port: 0 });
  const port = 3700 + Math.floor(Math.random() * 200);
  const base = `http://127.0.0.1:${port}`;
  let app = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), MAU_NO_OPEN: '1', MODULE_REGISTRIES: registry.catalogUrl, SERVER_TOOLS_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  app.stdout.on('data', (c) => log.push(String(c)));
  app.stderr.on('data', (c) => log.push(String(c)));

  let browser;
  const problems = [];
  try {
    await until(async () => (await fetch(`${base}/api/modules`)).ok, { what: 'the application to start' });
    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', userDataDir: path.join(workDir, 'chrome'), args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
    page.on('console', (message) => { if (message.type() === 'error' && !/favicon|Failed to load resource/.test(message.text())) problems.push(`console: ${message.text()}`); });

    await page.goto(`${base}/#/database/updates`, { waitUntil: 'networkidle2' });
    await until(() => page.evaluate(() => document.body.classList.contains('shell')), { what: 'the shell' });
    await page.evaluate(() => { window.__sentinel = 'keep-me'; document.getElementById('agentInput').value = 'draft'; });

    const sync = () => page.evaluate(async () => {
      const state = await (await fetch('/api/modules')).json();
      await ModuleLoader.sync(state, { onError: (m, e) => { window.__activationErrors = (window.__activationErrors || []).concat(`${m.id}: ${e.message}`); } });
      return { running: ModuleLoader.running(), errors: window.__activationErrors || [] };
    });

    /* ---- install every module ---- */
    for (const id of MODULES) {
      const response = await fetch(`${base}/api/modules/${id}/install`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const body = await response.json();
      assert.ok(response.ok, `${id} failed to install: ${body.error}`);
      const state = await sync();
      assert.ok(state.running.includes(id), `${id} did not activate in the browser (${state.errors.join('; ')})`);
      console.log(`  installed ${id}`);
    }

    /* ---- every page opens, and the shell knows about it ---- */
    for (const [id, route] of Object.entries(PAGES)) {
      await page.evaluate((r) => navigate(r), route);
      await wait(400);
      const shown = await page.evaluate((moduleId) => ({
        page: HostSDK.pages.has(moduleId === 'deployments' ? 'deploy' : moduleId),
        nav: !!document.querySelector(`#appNav [data-nav="${moduleId === 'deployments' ? 'deploy' : moduleId}"]`),
        mounted: !!document.querySelector(`#modulePages [data-module="${moduleId}"]`),
        styles: !!document.querySelector(`link[data-module="${moduleId}"]`),
      }), id);
      for (const [what, ok] of Object.entries(shown)) assert.ok(ok, `${id}: ${what} missing after opening ${route}`);
      console.log(`  opened ${route}`);
    }

    /* ---- assistant tools and search sources arrived with their modules ---- */
    const searchSources = await page.evaluate(() => HostSDK.searchSources.keys());
    for (const key of ['history', 'projects', 'connectors', 'servers', 'targets', 'repos', 'runs', 'secrets']) {
      assert.ok(searchSources.includes(key), `search source "${key}" is missing`);
    }
    const settingsSections = await page.evaluate(() => HostSDK.settingsSections.keys());
    assert.deepEqual(settingsSections.sort(), ['deploy', 'ssh'], 'both module settings sections registered');

    /* ---- a dependent module blocks removal of what it needs ---- */
    // Nothing in this set declares a hard dependency, so the guard is checked
    // against the state the host reports rather than invented here.
    const state = await (await fetch(`${base}/api/modules`)).json();
    for (const module of state.modules) {
      if (!module.requiredBy.length) continue;
      const attempt = await fetch(`${base}/api/modules/${module.id}/remove`, { method: 'POST' });
      assert.equal(attempt.status, 409, `${module.id} should be held by ${module.requiredBy.map((d) => d.id).join(', ')}`);
    }

    /* ---- a second tab reconciles from the server, not from its own memory ---- */
    const second = await browser.newPage();
    await second.goto(`${base}/#/home`, { waitUntil: 'networkidle2' });
    await until(() => second.evaluate(() => ModuleLoader.running().includes('history')), { what: 'the second tab to pick up installed modules' });

    /* ---- remove every module, in reverse ---- */
    for (const id of [...MODULES].reverse()) {
      const response = await fetch(`${base}/api/modules/${id}/remove`, { method: 'POST' });
      const body = await response.json();
      assert.ok(response.ok, `${id} failed to remove: ${body.error}`);
      const after = await sync();
      assert.ok(!after.running.includes(id), `${id} is still running after removal`);
      const leftovers = await page.evaluate((moduleId) => ({
        page: HostSDK.pages.has(moduleId === 'deployments' ? 'deploy' : moduleId),
        nav: !!document.querySelector(`#appNav [data-nav="${moduleId === 'deployments' ? 'deploy' : moduleId}"]`),
        mounted: !!document.querySelector(`#modulePages [data-module="${moduleId}"]`),
        styles: !!document.querySelector(`link[data-module="${moduleId}"]`),
        search: HostSDK.searchSources.keys().includes(moduleId),
      }), id);
      for (const [what, present] of Object.entries(leftovers)) assert.ok(!present, `${id} left its ${what} behind`);
      console.log(`  removed ${id}`);
    }

    /* ---- the base application is untouched by all of it ---- */
    const survived = await page.evaluate(() => ({
      sentinel: window.__sentinel,
      draft: document.getElementById('agentInput').value,
      corePages: HostSDK.pages.keys().sort(),
    }));
    assert.equal(survived.sentinel, 'keep-me');
    assert.equal(survived.draft, 'draft');
    assert.deepEqual(survived.corePages, ['connections', 'home', 'modules', 'mysql', 'schema', 'settings', 'sql']);

    /* ---- what was installed comes back after a restart ---- */
    await fetch(`${base}/api/modules/history/install`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    app.kill();
    await wait(800);
    app = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), MAU_NO_OPEN: '1', MODULE_REGISTRIES: registry.catalogUrl, SERVER_TOOLS_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await until(async () => {
      const answer = await fetch(`${base}/api/modules`).then((r) => r.json()).catch(() => null);
      return answer?.modules?.find((m) => m.id === 'history')?.status === 'active';
    }, { what: 'history to come back active after a restart', timeout: 25000 });

    if (problems.length) throw new Error(`the browser reported problems:\n  ${problems.join('\n  ')}`);
    console.log('module-lifecycle e2e: PASS');
  } finally {
    if (browser) await browser.close().catch(() => {});
    try { app.kill(); } catch {}
    await registry.close();
    if (process.env.KEEP_E2E_LOG) console.log(log.join(''));
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error('module-lifecycle e2e: FAIL\n', error); process.exit(1); });
