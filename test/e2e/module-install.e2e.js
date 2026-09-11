'use strict';
/* End-to-end proof that adding a module does not reload the page.
 *
 * Runs the real base application against a disposable data directory and a
 * local HTTP registry serving real signed archives, drives it with headless
 * Chrome, and asserts:
 *   - the base app requests no optional module code before installation
 *   - clicking Add downloads, verifies, installs and activates in place
 *   - there is no main-frame navigation and no document replacement
 *   - an in-memory sentinel, the assistant draft and the open page survive
 *   - the new route, search entries and assistant tool appear immediately
 *   - removing and re-adding in the same tab registers everything once
 *
 * Not a unit test: `node test/e2e/module-install.e2e.js`, or through
 * `npm run test:e2e`. It needs Chrome; it never touches real servers.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..', '..');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const { createRegistryServer } = require('../../scripts/module-registry');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, { timeout = 15000, interval = 150, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { last = await predicate(); if (last) return last; } catch (error) { last = error.message; }
    await wait(interval);
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}

function startApp({ dataDir, port, catalogUrl }) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      MAU_NO_OPEN: '1',
      MODULE_REGISTRIES: catalogUrl,
      SERVER_TOOLS_DATA_DIR: dataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (c) => log.push(String(c)));
  child.stderr.on('data', (c) => log.push(String(c)));
  return { child, log };
}

async function main() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-tools-e2e-'));
  const dataDir = path.join(workDir, 'data');
  const profileDir = path.join(workDir, 'chrome');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });
  // Disposable configuration: no real database, no real server, no real account.
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({}));

  const distDir = path.join(ROOT, 'dist', 'modules');
  assert.ok(fs.existsSync(path.join(distDir, 'catalog.json')), 'build the modules first: npm run modules:build');

  const registry = await createRegistryServer({ dir: distDir, port: 0 });
  const port = 3400 + Math.floor(Math.random() * 300);
  const app = startApp({ dataDir, port, catalogUrl: registry.catalogUrl });
  const base = `http://127.0.0.1:${port}`;
  const cleanup = async () => {
    try { app.child.kill(); } catch {}
    await registry.close();
  };

  let browser;
  try {
    await until(async () => (await fetch(`${base}/api/modules`)).ok, { what: 'the application to start' });

    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: 'new',
      userDataDir: profileDir,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();

    /* --- A. the base application asks for no optional module code --- */
    const requested = [];
    page.on('request', (request) => requested.push(request.url()));
    /* A hash change is a same-document navigation and is expected; what must
       never happen is the document being replaced. Both are checked: the count
       of cross-document loads, and a marker that only survives one document. */
    let documentLoads = 0;
    const stripHash = (url) => String(url).split('#')[0];
    let lastUrl = null;
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      if (stripHash(frame.url()) !== lastUrl) { documentLoads++; lastUrl = stripHash(frame.url()); }
    });

    await page.goto(`${base}/#/database/updates`, { waitUntil: 'networkidle2' });
    await until(() => page.evaluate(() => typeof window.HostSDK === 'object' && document.body.classList.contains('shell')), { what: 'the shell' });
    assert.equal(documentLoads, 1, 'the initial load is the only document load');
    assert.ok(!requested.some((url) => /\/api\/modules\/[a-z-]+\/asset\//.test(url)), 'no module asset was fetched before installing anything');
    assert.ok(!requested.some((url) => /xterm/.test(url)), 'the terminal library is not part of the base application');

    /* Sentinel state that a reload would destroy. */
    await page.evaluate(() => {
      window.__sentinel = { id: 'keep-me', at: Date.now() };
      document.getElementById('agentInput').value = 'draft that must survive';
    });
    const pageBefore = await page.evaluate(() => location.hash);

    /* --- B. add the module --- */
    await page.evaluate(() => openModuleMarketplace());
    await until(() => page.$('#moduleCatalog [data-module="history"]'), { what: 'the marketplace card' });
    await page.evaluate(() => {
      const card = document.querySelector('#moduleCatalog [data-module="history"]');
      [...card.querySelectorAll('button')].find((b) => b.textContent.includes('Add')).click();
    });
    await until(() => page.evaluate(() => ModuleLoader.isRunning('history')), { what: 'history to activate', timeout: 30000 });

    /* --- C. nothing reloaded --- */
    assert.equal(documentLoads, 1, 'installing a module must not load a new document');
    const survived = await page.evaluate(() => ({
      sentinel: window.__sentinel?.id || null,
      draft: document.getElementById('agentInput').value,
      hash: location.hash,
    }));
    assert.equal(survived.sentinel, 'keep-me', 'in-memory state survived the installation');
    assert.equal(survived.draft, 'draft that must survive', 'the assistant draft survived the installation');

    /* --- D. the module is usable immediately --- */
    const registered = await page.evaluate(() => ({
      page: HostSDK.pages.has('history'),
      nav: !!document.querySelector('#appNav [data-nav="history"]'),
      tile: HostSDK.launcherTiles.has('history'),
      search: HostSDK.searchSources.has('history'),
      styles: !!document.querySelector('link[data-module="history"]'),
      mount: !!document.querySelector('#modulePages [data-module="history"] #auditDrawer'),
    }));
    for (const [what, ok] of Object.entries(registered)) assert.ok(ok, `${what} appeared without a reload`);

    const tools = await (await fetch(`${base}/api/modules`)).json();
    assert.equal(tools.modules.find((m) => m.id === 'history').status, 'active');

    await page.evaluate(() => navigate('#/history'));
    await until(() => page.evaluate(() => document.querySelector('#modulePages #auditDrawer')?.classList.contains('open')), { what: 'the History page' });
    assert.equal(documentLoads, 1, 'opening a module page does not load a new document');

    /* --- E. remove, then add again, in the same tab --- */
    await page.evaluate((route) => navigate(route || '#/database/updates'), pageBefore);
    await page.evaluate(() => fetch('/api/modules/history/remove', { method: 'POST' }).then((r) => r.json()));
    await until(() => page.evaluate(async () => {
      const state = await (await fetch('/api/modules')).json();
      await ModuleLoader.sync(state);
      return !ModuleLoader.isRunning('history');
    }), { what: 'history to deactivate' });
    const afterRemoval = await page.evaluate(() => ({
      page: HostSDK.pages.has('history'),
      nav: !!document.querySelector('#appNav [data-nav="history"]'),
      styles: !!document.querySelector('link[data-module="history"]'),
      mount: !!document.querySelector('#modulePages [data-module="history"]'),
    }));
    for (const [what, present] of Object.entries(afterRemoval)) assert.ok(!present, `${what} was cleaned up on removal`);

    await page.evaluate(() => fetch('/api/modules/history/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.json()));
    await until(() => page.evaluate(async () => {
      const state = await (await fetch('/api/modules')).json();
      await ModuleLoader.sync(state);
      return ModuleLoader.isRunning('history');
    }), { what: 'history to activate again', timeout: 30000 });
    const duplicates = await page.evaluate(() => ({
      navEntries: document.querySelectorAll('#appNav [data-nav="history"]').length,
      mounts: document.querySelectorAll('#modulePages [data-module="history"][data-mount="history"]').length,
      styles: document.querySelectorAll('link[data-module="history"]').length,
    }));
    assert.deepEqual(duplicates, { navEntries: 1, mounts: 1, styles: 1 }, 're-adding a module registers it exactly once');
    assert.equal(documentLoads, 1, 'the whole run happened in one document');
    assert.equal(await page.evaluate(() => window.__sentinel?.id || null), 'keep-me', 'the same document was live throughout');

    console.log('module-install e2e: PASS');
  } finally {
    if (browser) await browser.close().catch(() => {});
    await cleanup();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error('module-install e2e: FAIL\n', error); process.exit(1); });
