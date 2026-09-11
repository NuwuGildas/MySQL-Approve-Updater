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
const { Server: SshServer, utils: sshUtils } = require('ssh2');

const ROOT = path.join(__dirname, '..', '..');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const { createRegistryServer } = require('../../scripts/module-registry');

const MODULES = ['history', 'projects', 'connectors', 'servers', 'deployments'];
const DRAWERS = { history: 'auditDrawer', projects: 'projectsDrawer', connectors: 'connectorsDrawer', servers: 'serversDrawer', deployments: 'deployDrawer' };
const BUTTONS = { history: 'btnAuditRefresh', projects: 'btnPjRefresh', connectors: 'btnCnRefresh', servers: 'btnServersRefresh', deployments: 'btnDpNew' };
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

/**
 * Click and wait for what the click should cause; if it did not, click again.
 *
 * These are real pointer events against a UI that re-renders on its own - the
 * palette refetches its sources, a module view repaints - so a click can land on
 * a node in the middle of being replaced and do nothing at all. Retrying is what
 * a person does, and it keeps the assertion about the OUTCOME rather than about
 * the timing. The last attempt uses the full timeout so a genuine failure still
 * reports as one.
 */
async function clickUntil(page, click, condition, { attempts = 3, what = 'the click to take effect' } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (typeof click === 'function') await click(); else await page.click(click);
    if (attempt === attempts) break;
    try { return await until(condition, { timeout: 4000, what }); } catch { /* the UI moved under it; go again */ }
  }
  return until(condition, { what });
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

    await page.evaluateOnNewDocument(() => localStorage.setItem('mau-tour-seen', '1'));
    await page.goto(`${base}/#/database/updates`, { waitUntil: 'networkidle2' });
    await until(() => page.evaluate(() => document.body.classList.contains('shell')), { what: 'the shell' });
    const checkStandaloneAssistant = async () => {
      /* Chrome throttles rendering in a background tab, and puppeteer decides
         whether an element needs scrolling into view with an IntersectionObserver
         - which never fires there, so a click waits for ever. The second tab this
         suite opens later is enough to cause it. */
      await page.bringToFront();
      assert.equal(await page.$('#sshDrawer'), null, 'Servers module is absent');
      /* Wide enough for the dock preference, which only applies from 1440px. The
         rest of the suite keeps the viewport it had. */
      const viewport = page.viewport();
      await page.click('#btnAiAgent');
      await until(() => page.evaluate(() => document.getElementById('agentDrawer').classList.contains('open')
        && !document.getElementById('agentStatus').textContent.includes('Loading')), { what: 'assistant to load without the Servers module' });
      assert.equal(await page.evaluate(() => document.body.classList.contains('ssh-shared-workspace')), false);

      /* "Dock beside the workspace" is a base control, in the assistant's own
         options menu. Its stylesheet used to live in the Servers module, so the
         button did nothing at all without it. */
      await page.setViewport({ width: 1600, height: 1000 });
      await page.click('#btnAgentMenu');
      await page.click('#btnAgentDock');
      await wait(400);
      const docked = await page.evaluate(() => {
        const px = (v) => Math.round(parseFloat(v) || 0);
        return { right: px(getComputedStyle(document.getElementById('agentDrawer')).right), main: px(getComputedStyle(document.querySelector('main')).marginRight) };
      });
      assert.deepEqual(docked, { right: 0, main: 400 }, 'the assistant pins to the edge and the page makes room, with no module installed');
      await page.click('#btnAgentMenu');
      await page.click('#btnAgentDock');
      await page.click('#btnAgentClose');
      await page.setViewport(viewport);
    };
    await checkStandaloneAssistant();

    /* Managing projects is a module; having one is not. With nothing able to
       create a project there is nothing to switch between, so the header
       switcher stays hidden and everything is the default project's. */
    assert.deepEqual(await page.evaluate(() => ({
      // What is on SCREEN, not just the attribute: an author `display` rule
      // beats the UA's [hidden], so .hidden alone can change nothing.
      shown: document.getElementById('projSwitch').getClientRects().length > 0,
      active: document.getElementById('projTriggerName').textContent,
      manager: !!HostSDK.core.projectManager,
    })), { shown: false, active: 'General', manager: false });
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

    /* Projects is installed now, so the switcher it manages is there. */
    assert.deepEqual(await page.evaluate(() => ({
      // What is on SCREEN, not just the attribute: an author `display` rule
      // beats the UA's [hidden], so .hidden alone can change nothing.
      shown: document.getElementById('projSwitch').getClientRects().length > 0,
      manager: !!HostSDK.core.projectManager,
    })), { shown: true, manager: true }, 'the Projects module reveals the header switcher');

    /* Connect asks the real host for credentials over the worker bridge.
       An unknown profile must reach validation, without attempting SSH. */
    const missingServer = await fetch(`${base}/api/m/servers/http/sessions/missing-profile/connect`, { method: 'POST' });
    const missingServerBody = await missingServer.json();
    assert.equal(missingServer.status, 400, JSON.stringify(missingServerBody));
    assert.equal(missingServerBody.error, 'That profile has no SSH configured');

    const navigation = await page.evaluate(async () => {
      const { scope } = await ModuleLoader.activate({ id: 'connectors' });
      scope.navigate('#/connectors');
      return scope.route();
    });
    assert.equal(navigation, '/connectors');

    // Scoped module results must retain their source, including in recents.
    // Use the real deployment action, recording its requested route locally.
    await page.evaluate(async () => {
      const source = HostSDK.searchSources.get('targets');
      const { scope } = await ModuleLoader.activate({ id: 'deployments' });
      const originalFetch = source.fetch, originalNavigate = scope.navigate;
      source.fetch = async () => [{ id: 'palette-target', name: 'Palette deployment', type: 'local' }];
      scope.navigate = (route) => { window.__paletteRoute = route; };
      window.__restorePalette = () => { source.fetch = originalFetch; scope.navigate = originalNavigate; cmdk.cache.delete('targets'); };
      cmdk.cache.delete('targets');
      localStorage.removeItem(CMDK_RECENTS_KEY);
    });
    try {
      for (const mode of ['keyboard', 'mouse', 'recent']) {
        await page.evaluate(() => { window.__paletteRoute = null; });
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyK');
        await page.keyboard.up('Control');
        if (mode !== 'recent') await page.type('#cmdkInput', 'deployments:');
        /* The palette fetches its sources, so the list can still be re-rendered
           after the row first appears. Wait for it to settle, or a click lands
           on a row that is being replaced and dispatches nothing. */
        await until(async () => {
          const seen = await page.evaluate(() => {
            const rows = [...document.querySelectorAll('#cmdkList .cmdk-row')];
            return rows.some((el) => el.textContent.includes('Palette deployment')) ? rows.length : 0;
          });
          if (!seen) return false;
          await wait(120);
          const again = await page.evaluate(() => {
            const rows = [...document.querySelectorAll('#cmdkList .cmdk-row')];
            return rows.some((el) => el.textContent.includes('Palette deployment')) ? rows.length : 0;
          });
          return seen === again && again;
        }, { what: 'deployment search result to settle' });

        if (mode === 'mouse') {
          // Click the row that IS the deployment, not whichever row is first:
          // once this has been chosen before, a "recent" entry joins the list.
          const row = await page.evaluateHandle(() => [...document.querySelectorAll('#cmdkList .cmdk-row')].find((el) => el.textContent.includes('Palette deployment')));
          const element = row.asElement();
          assert.ok(element, 'the deployment row is still in the document');
          await element.click();
          await element.dispose();
        } else await page.keyboard.press('Enter');
        await until(() => page.evaluate(() => window.__paletteRoute === '#/deployments/targets/palette-target'), { what: mode + ' selection to dispatch the deployment route' });
        assert.equal(await page.$eval('#cmdkModal', (el) => el.open), false);
      }
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyK');
      await page.keyboard.up('Control');
      await page.waitForSelector('#cmdkModal[open]');
      // The backdrop is what swallows an outside click, and the modal puts it
      // there as it opens. Clicking before it is laid out hits nothing.
      await until(() => page.evaluate(() => {
        const backdrop = document.getElementById('stBackdrop');
        return !!backdrop && !backdrop.hidden && backdrop.getBoundingClientRect().width > 0;
      }), { what: 'the modal backdrop to cover the page' });
      await clickUntil(page, () => page.mouse.click(5, 5), () => page.$eval('#cmdkModal', (el) => !el.open), { what: 'outside click to close search' });
      await until(() => page.$eval('#stBackdrop', (el) => el.hidden), { what: 'search backdrop to clear' });
    } finally { await page.evaluate(() => { window.__restorePalette(); localStorage.removeItem(CMDK_RECENTS_KEY); }); }

    // Edit a fixture connector through real pointer and keyboard events. Keep
    // provider verification local by stubbing only the connector RPC responses.
    await page.evaluate(async () => {
      const { scope } = await ModuleLoader.activate({ id: 'connectors' });
      const originalGet = scope.get, originalRpc = scope.rpc;
      const fixture = { id: 'editor-test', name: 'Editor test', kind: 'github', baseUrl: 'https://api.github.com', status: 'unverified' };
      scope.get = async (method, params) => {
        const data = await originalGet(method, params);
        return method === 'list' ? { ...data, connectors: [fixture] } : data;
      };
      scope.rpc = async (method, params, options) => {
        if (method !== 'save') return originalRpc(method, params, options);
        window.__connectorSaved = params;
        return { ...fixture, ...params, status: 'ok', account: { login: 'test' } };
      };
      window.__restoreConnectorRpc = () => { scope.get = originalGet; scope.rpc = originalRpc; };
      await HostSDK.apis.get('connectors').reload();
    });
    try {
      await page.click('#connectorsList [data-act="edit"]');
      await until(() => page.$eval('#cnModal', (el) => el.open), { what: 'connector editor' });
      assert.equal(await page.$eval('#cnName', (el) => !!el.closest('[inert]')), false, 'editor input has no inert ancestor');
      assert.equal(await page.$eval('#connectorsDrawer', (el) => el.inert), true, 'background module view stays blocked');
      await page.click('#cnName');
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Control');
      await page.type('#cnName', 'Edited connector');
      await clickUntil(page, '#btnCnSave', () => page.$eval('#cnModal', (el) => !el.open), { what: 'editor to save and close' });
      assert.equal(await page.evaluate(() => window.__connectorSaved.name), 'Edited connector');
      await page.click('#connectorsList [data-act="edit"]');
      await clickUntil(page, '#btnCnCancel', () => page.$eval('#cnModal', (el) => !el.open), { what: 'editor cancel' });
      await page.click('#connectorsList [data-act="edit"]');
      await page.keyboard.press('Escape');
      await until(() => page.$eval('#cnModal', (el) => !el.open), { what: 'editor Escape' });
      assert.equal(await page.$eval('#connectorsDrawer', (el) => el.inert), false, 'background interaction is restored');
    } finally { await page.evaluate(() => window.__restoreConnectorRpc()); }

    const loadingFailure = await page.evaluate(async () => {
      const { scope } = await ModuleLoader.activate({ id: 'servers' });
      const original = scope.http;
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      scope.http = async (path, options) => {
        if (path.startsWith('/agent/sessions')) { await gate; return { sessions: [] }; }
        if (path === '/agent/attach') throw new Error('Test connection unavailable');
        return original(path, options);
      };
      try {
        const api = HostSDK.apis.get('servers');
        const first = api.openTerminal('loading-test');
        const second = api.openTerminal('loading-test');
        const immediate = !!document.querySelector('.ssh-opening-notice[role="status"] progress');
        release();
        await first;
        return { immediate, deduplicated: first === second, cleared: !document.querySelector('.ssh-opening-notice') };
      } finally { scope.http = original; }
    });
    assert.deepEqual(loadingFailure, { immediate: true, deduplicated: true, cleared: true });

    // Exercise serialized JSON from the browser against a disposable SSH peer.
    // Missing Content-Type used to discard profileId and report a missing server.
    const sshClients = new Set();
    const sshPeer = new SshServer({ hostKeys: [sshUtils.generateKeyPairSync('rsa', { bits: 2048 }).private] }, (client) => {
      sshClients.add(client);
      client.on('error', () => {});
      client.on('authentication', (ctx) => ctx.method === 'password' && ctx.username === 'test' && ctx.password === 'test' ? ctx.accept() : ctx.reject(['password']));
      client.on('ready', () => client.on('session', (accept) => {
        const session = accept();
        session.on('pty', (acceptPty) => acceptPty());
        session.on('shell', (acceptShell) => acceptShell().write('Test terminal ready\r\n'));
      }));
    });
    await new Promise((resolve) => sshPeer.listen(0, '127.0.0.1', resolve));
    try {
      const result = await page.evaluate(async (port) => {
        const { scope } = await ModuleLoader.activate({ id: 'servers' });
        {
          const profile = await scope.http('/profiles', { method: 'POST', body: JSON.stringify({
            name: 'Terminal regression', ssh: { enabled: true, host: '127.0.0.1', port, user: 'test', password: 'test', auth: 'password' },
          }) });
          const messages = [];
          const originalToast = window.toast;
          window.toast = (message, state) => { messages.push(message); originalToast(message, state); };
          let attached;
          scope.navigate('#/servers');
          try { attached = await HostSDK.apis.get('servers').openTerminal(profile.id); }
          finally { window.toast = originalToast; }
          if (!attached) throw new Error(messages.join('; ') || 'Terminal did not open');
          if (scope.shell.page() !== 'terminals' || !document.body.classList.contains('page-terminals')) throw new Error('Terminal did not become the active page');
          if (document.getElementById('serversDrawer').classList.contains('open')) throw new Error('Servers view stayed open behind the terminal');
          if (!document.querySelector('#appNav [data-nav="terminals"][aria-current="page"]')) throw new Error('Terminal navigation entry is not selected');
          if (document.querySelector('.ssh-opening-notice')) throw new Error('Terminal loading indicator did not clear');
          const control = await scope.http(`/terminal/${attached.sessionId}/control`, { method: 'POST', body: JSON.stringify({ control: 'user' }) });
          await scope.http(`/terminal/${attached.sessionId}`, { method: 'DELETE' });
          await scope.http(`/profiles/${profile.id}`, { method: 'DELETE' });
          return { attached: attached.attached, status: attached.terminal?.status, control: control.control };
        }
      }, sshPeer.address().port);
      assert.deepEqual(result, { attached: true, status: 'open', control: 'user' });
      console.log('  opened a real SSH terminal and selected user control through the browser SDK');
    } finally {
      for (const client of sshClients) client.end();
      await new Promise((resolve) => sshPeer.close(resolve));
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
      // Real pointer and keyboard input must reach views loaded after shell startup.
      // element.click() would bypass inert and conceal this regression.
      const drawer = '#' + DRAWERS[id];
      const button = '#' + BUTTONS[id];
      assert.equal(await page.$eval(drawer, (el) => el.inert), false, id + ': open view is inert');
      await page.$eval(button, (el) => {
        window.__moduleClicks = 0;
        el.addEventListener('click', (event) => {
          if (event.isTrusted) window.__moduleClicks++;
          event.stopImmediatePropagation();
        }, { capture: true });
      });
      await page.click(button);
      await page.focus(button);
      await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(() => window.__moduleClicks), 2, id + ': pointer and keyboard clicks reach the button');
      await page.evaluate(() => navigate('#/home'));
      await until(() => page.$eval(drawer, (el) => el.inert), { what: id + ' to become inert when closed' });
      await page.evaluate((r) => navigate(r), route);
      await until(() => page.$eval(drawer, (el) => !el.inert), { what: id + ' to become interactive again' });
      console.log(`  opened and interacted with ${route}`);
    }

    // Opening a terminal deliberately switches the assistant conversation.
    // Start a fresh draft in that conversation for the removal checks below.
    await page.evaluate(() => { document.getElementById('agentInput').value = 'draft'; });

    /* ---- assistant tools and search sources arrived with their modules ---- */
    const searchSources = await page.evaluate(() => HostSDK.searchSources.keys());
    for (const key of ['history', 'projects', 'connectors', 'servers', 'targets', 'repos', 'runs', 'secrets']) {
      assert.ok(searchSources.includes(key), `search source "${key}" is missing`);
    }
    const settingsSections = await page.evaluate(() => HostSDK.settingsSections.keys());
    assert.deepEqual(settingsSections.sort(), ['deploy', 'ssh'], 'both module settings sections registered');

    await page.evaluate(async () => { navigate('#/settings/ssh'); await renderSettings(); });
    const visibleSettings = () => page.evaluate(() => [...document.querySelectorAll('#settingsModal .settings-section')]
      .filter((el) => getComputedStyle(el).display !== 'none').map((el) => el.dataset.sec));
    assert.deepEqual(await visibleSettings(), ['ssh'], 'a module settings route selects only that section');
    for (const section of ['appearance', 'ai', 'deploy', 'sql', 'ssh']) {
      await page.click(`#settingsNav [data-sec="${section}"]`);
      await page.evaluate(() => renderSettings());
      assert.deepEqual(await visibleSettings(), [section], 'only the selected settings section remains visible after rendering');
    }
    const settingsMounts = await page.evaluate(() => {
      const mounts = [...document.querySelectorAll('#settingsModal [data-mount]')];
      return { count: mounts.length, unique: new Set(mounts.map((el) => el.dataset.module + ':' + el.dataset.mount)).size };
    });
    assert.equal(settingsMounts.count, settingsMounts.unique, 'repeated settings renders reuse their moved containers');
    await page.evaluate(() => navigate('#/home'));

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
      // The switcher belongs to whoever manages projects, so it leaves with it.
      if (id === 'projects') {
        assert.deepEqual(await page.evaluate(() => ({
          // What is on SCREEN, not just the attribute: an author `display` rule
      // beats the UA's [hidden], so .hidden alone can change nothing.
      shown: document.getElementById('projSwitch').getClientRects().length > 0,
          active: document.getElementById('projTriggerName').textContent,
          manager: !!HostSDK.core.projectManager,
        })), { shown: false, active: 'General', manager: false }, 'the switcher is withdrawn with the Projects module, in the same session');
      }
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
    await checkStandaloneAssistant();

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
