'use strict';
/* Whole-app smoke: the deploy module, projects, the palette, the servers page and settings live in
   the same files as the assistant and the terminal workspace, so walk every route, open the command
   palette and the assistant, and assert nothing threw and no page took over another.
   Run: node checks/workspace/smoke.js */

const { startSandbox } = require('./sandbox');
const { launch, openApp, recorder, shot, until, sleep } = require('./browser');

const ROUTES = [
  ['#/home', 'home'], ['#/database/updates', 'mysql'], ['#/database/sql', 'sql'],
  ['#/database/schema', 'schema'], ['#/deployments', 'deploy'], ['#/servers', 'servers'], ['#/terminals', 'terminals'],
  ['#/connectors', 'connectors'], ['#/projects', 'projects'], ['#/history', 'history'],
  ['#/settings/appearance', 'settings'], ['#/connections', 'connections'],
];

async function main() {
  const s = await startSandbox({ port: Number(process.env.PORT || 3126), servers: 1 });
  const browser = await launch();
  const r = recorder('smoke');
  let page;
  try {
    page = await openApp(browser, s.base);
    for (const [hash, id] of ROUTES) {
      await page.evaluate((h) => navigate(h), hash);
      await sleep(700);
      const st = await page.evaluate(() => ({
        page: [...document.body.classList].find((c) => c.startsWith('page-')),
        title: document.title,
        overflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      }));
      r.ok('route', `${hash} shows the ${id} page without sideways overflow`, st.page === 'page-' + id && st.overflow, JSON.stringify(st));
    }
    // the palette and the assistant still open from anywhere
    await page.evaluate(() => navigate('#/home'));
    await sleep(500);
    await page.keyboard.down('Control'); await page.keyboard.press('KeyK'); await page.keyboard.up('Control');
    await sleep(500);
    r.ok('palette', 'the command palette opens', await page.evaluate(() => !!document.querySelector('#cmdk:not([hidden]), .cmdk-wrap:not([hidden]), dialog#cmdkModal[open]')
      || !!document.querySelector('[id^="cmdk"]:not([hidden])')));
    await page.keyboard.press('Escape');
    await sleep(300);
    await page.evaluate(() => openAgent());
    r.ok('assistant', 'the assistant opens on the project conversation from Home',
      await until(page, () => !document.getElementById('agentChatWrap').hidden && !document.getElementById('agentInput').disabled, null, 15000));
    await shot(page, 'smoke-home-assistant');
    r.ok('smoke', 'no page errors were raised', page.__errors.length === 0, page.__errors.slice(0, 4).join(' | '));
    // /api/events/scope now accepts a "project:<id>" conversation id as well as a terminal one, so a
    // project-scoped stream no longer 404s and nothing needs excusing here.
    const missing = page.__missing || [];
    r.ok('smoke', 'no unexpected 404s', missing.length === 0, missing.slice(0, 4).join(' | '));
  } catch (e) {
    r.ok('run', 'the check completed', false, (e && e.stack) || String(e));
  } finally {
    if (page) { try { await shot(page, 'smoke-final'); } catch {} }
    await browser.close();
    await s.stop();
  }
  process.exit(r.report() ? 0 : 1);
}

main();
