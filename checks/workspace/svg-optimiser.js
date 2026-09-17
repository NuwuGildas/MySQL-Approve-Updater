'use strict';
/* The SVG Optimiser page: files in, smaller files out.
 *
 * The assertion this check exists for is the security one. An SVG is markup, and markup somebody
 * dropped in can carry <script>, an external <image>, or a foreignObject full of HTML. The page
 * shows every file twice, before and after - so if it ever renders that markup INTO the document,
 * opening this page on a file you were sent runs whatever was in it. Both previews must be <img>
 * elements fed from a data: URI, where a browser runs no script and fetches nothing.
 *
 * Run: node checks/workspace/svg-optimiser.js
 */

const fs = require('fs');
const path = require('path');
const { startSandbox } = require('./sandbox');
const { launch, openApp, recorder, shot, until, sleep } = require('./browser');

const PORT = Number(process.env.PORT || 3127);

const ROOMY = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">
  <!-- the slack a drawing tool leaves behind -->
  <title>Check</title>
  <g id="layer1" transform="translate(0,0)">
    <circle cx="60.000000" cy="60.000000" r="48.5000000" fill="#3FB96B" fill-opacity="1.0"/>
  </g>
</svg>`;
/* Everything an SVG can carry that must never run here. Valid XML on purpose: it has to get all
   the way through the optimiser and be DRAWN, because being drawn is the moment that would bite. */
const HOSTILE = `<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50" viewBox="0 0 50 50">
  <script>window.__svgRan = true;</script>
  <image href="http://127.0.0.1:9/never-fetched.png" x="0" y="0" width="10" height="10"/>
  <foreignObject width="50" height="50"><div xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="window.__svgRan = true" /></div></foreignObject>
  <circle cx="25.00000" cy="25" r="20.000000" fill="#e05555" onclick="window.__svgRan = true"/>
</svg>`;

/** Open the page the way a reader does, and wait until it is actually on screen. */
async function openSvg(page) {
  await until(page, () => !!document.querySelector('[data-nav="svg"]'), null, 25000);
  let up = false;
  for (let i = 0; i < 5 && !up; i++) {
    await page.evaluate(() => document.querySelector('[data-nav="svg"]').click());
    up = await until(page, () => {
      const el = document.getElementById('svgPage');
      return !!el && !el.hidden && el.getClientRects().length > 0;
    }, null, 6000);
  }
  if (!up) throw new Error('the SVG page never came up: ' + await page.evaluate(() => location.hash));
  await sleep(300);
}

/** Add markup through the paste dialog. */
async function paste(page, markup) {
  await page.evaluate(() => document.getElementById('btnSvgPaste').click());
  await until(page, () => document.getElementById('svgPasteModal').open, null, 8000);
  await page.evaluate((m) => { document.getElementById('svgPasteText').value = m; document.getElementById('btnSvgPasteAdd').click(); }, markup);
  await until(page, () => !document.getElementById('svgPasteModal').open, null, 8000);
}

const cards = () => document.querySelectorAll('#svgList .svg-item').length;

async function main() {
  const s = await startSandbox({ port: PORT, servers: 1 });
  const browser = await launch();
  const r = recorder('svg-optimiser');
  let page;
  try {
    page = await openApp(browser, s.base);
    await openSvg(page);

    /* ---- it is there, and says what it is for ---- */
    const empty = await page.evaluate(() => ({
      count: document.getElementById('svgCount').textContent,
      emptyShown: document.getElementById('svgEmpty').getClientRects().length > 0,
      runDisabled: document.getElementById('btnSvgRun').disabled,
      clearShown: document.getElementById('btnSvgClear').getClientRects().length > 0,
      precision: document.getElementById('svgPrecision').value,
      keepViewBox: document.getElementById('svgKeepViewBox').checked,
      keepIds: document.getElementById('svgKeepIds').checked,
    }));
    r.ok('empty', 'the page opens on an invitation, not an empty box', empty.emptyShown && /Nothing added/.test(empty.count), JSON.stringify(empty));
    r.ok('empty', 'and offers nothing to press that would do nothing', empty.runDisabled && !empty.clearShown);
    r.ok('empty', 'the settings arrive from the module, not from the markup',
      empty.precision === '3' && empty.keepViewBox && empty.keepIds, JSON.stringify(empty));
    /* The host mounts a module's markup in a display:contents container, so the page is laid out as
       a child of <body> and has to step around the navigation itself. Without that it starts
       underneath the nav and its left edge is simply cut off - which nothing in the DOM reports. */
    const placed = await page.evaluate(() => {
      const box = document.getElementById('svgPage').getBoundingClientRect();
      const nav = document.getElementById('appNav')?.getBoundingClientRect();
      return {
        left: Math.round(box.left), navRight: Math.round(nav ? nav.right : 0),
        width: Math.round(box.width), viewport: window.innerWidth,
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    r.ok('layout', 'the page sits beside the navigation, not underneath it',
      placed.left >= placed.navRight - 1 && placed.width > 300, JSON.stringify(placed));
    r.ok('layout', 'and nothing spills off the side of the window', placed.overflow <= 2, JSON.stringify(placed));
    await shot(page, 'svg-empty');

    /* ---- a real file, picked the way a user picks one ---- */
    const file = path.join(s.dir, 'check-icon.svg');
    fs.writeFileSync(file, ROOMY);
    const input = await page.$('#svgFiles');
    await input.uploadFile(file);
    await until(page, () => document.querySelectorAll('#svgList .svg-item').length === 1, null, 10000);
    r.ok('add', 'a picked file is added under its own name',
      await page.evaluate(() => document.querySelector('.svg-name').textContent) === 'check-icon.svg');

    await page.evaluate(() => document.getElementById('btnSvgRun').click());
    await until(page, () => !!document.querySelector('#svgList .svg-item.done'), null, 20000);
    const done = await page.evaluate(() => {
      const item = document.querySelector('.svg-item');
      return {
        size: item.querySelector('.svg-size').textContent,
        win: item.querySelector('.svg-win').textContent,
        bar: item.querySelector('.svg-bar > span')?.style.width || '',
        previews: [...item.querySelectorAll('.svg-pane img')].map((i) => i.src.slice(0, 26)),
        panes: [...item.querySelectorAll('.svg-pane h4')].map((h) => h.textContent),
        actions: [...item.querySelectorAll('[data-act]')].map((b) => b.dataset.act),
        markup: item.querySelector('.svg-code pre')?.textContent || '',
        totals: document.getElementById('svgTotals').textContent.replace(/\s+/g, ' ').trim(),
      };
    });
    r.ok('optimise', 'the file comes back smaller, and says by how much', /→/.test(done.size) && /%\s*smaller/.test(done.win), `${done.size} ${done.win}`);
    r.ok('optimise', 'with a bar you can read at a glance', /%$/.test(done.bar), done.bar);
    r.ok('optimise', 'the running total is reported too', /smaller/.test(done.totals), done.totals.slice(0, 90));
    r.ok('optimise', 'both versions are shown side by side', done.panes.join('/') === 'Before/After', done.panes.join('/'));
    r.ok('optimise', 'and the optimised markup is there to read', /<circle/.test(done.markup) && !/<!--/.test(done.markup), done.markup.slice(0, 80));
    r.ok('optimise', 'only then does it offer to copy or download', done.actions.includes('copy') && done.actions.includes('download'), done.actions.join(', '));
    await shot(page, 'svg-optimised');

    /* ---- THE one: untrusted markup is never run ---- */
    await paste(page, HOSTILE);
    await until(page, () => document.querySelectorAll('#svgList .svg-item').length === 2, null, 10000);
    await page.evaluate(() => document.getElementById('btnSvgRun').click());
    await until(page, () => document.querySelectorAll('#svgList .svg-item.done, #svgList .svg-item.flat, #svgList .svg-item.bad').length === 2, null, 20000);
    await sleep(800); // give anything that WOULD run the chance to

    const safety = await page.evaluate(() => {
      const hostile = [...document.querySelectorAll('#svgList .svg-item')].find((el) => /pasted-/.test(el.querySelector('.svg-name').textContent));
      const previews = hostile ? [...hostile.querySelectorAll('.svg-pane img')] : [];
      return {
        ran: !!window.__svgRan,
        state: hostile ? [...hostile.classList].join(' ') : '(no card)',
        liveSvg: document.querySelectorAll('#svgList svg').length,
        liveScript: document.querySelectorAll('#svgList script').length,
        foreign: document.querySelectorAll('#svgList foreignObject').length,
        /* Its OWN previews, not a count over the page: the point is that the hostile file was
           optimised and then drawn, which is the moment a live <svg> would have run. */
        previews: previews.length,
        allData: previews.length > 0 && previews.every((i) => i.src.startsWith('data:image/svg+xml;base64,')),
        shownAsText: !!hostile?.querySelector('.svg-code pre')?.textContent.includes('<script'),
        carries: [...(hostile?.querySelectorAll('.svg-carries') || [])].map((el) => el.textContent),
      };
    });
    r.ok('safety', 'markup from a file never runs', safety.ran === false);
    r.ok('safety', 'because it is never put into the page', safety.liveSvg === 0 && safety.liveScript === 0 && safety.foreign === 0, JSON.stringify(safety));
    r.ok('safety', 'the hostile file was optimised and drawn, which is the moment it would have run',
      /\b(done|flat)\b/.test(safety.state) && safety.previews === 2, `${safety.state} · ${safety.previews} preview(s)`);
    r.ok('safety', 'every preview is an <img> from a data: URI, which executes and fetches nothing',
      safety.allData, JSON.stringify({ previews: safety.previews, allData: safety.allData }));
    r.ok('safety', 'and the markup itself is only ever shown as text', safety.shownAsText);
    /* svgo optimises, it does not sanitise: the script is still in the file that comes back, and
       someone about to inline it has to be told so before they do. */
    r.ok('safety', 'the file is told to still carry its script, since optimising does not remove it',
      safety.carries.some((w) => /<script>.*does not remove/.test(w)), safety.carries.join(' | ').slice(0, 120));
    r.ok('safety', 'and to still reach another server when displayed',
      safety.carries.some((w) => /another server/.test(w)), safety.carries.join(' | ').slice(0, 120));
    r.ok('safety', 'nothing was fetched from the address it asked for',
      !(page.__missing || []).some((u) => /never-fetched/.test(u)), (page.__missing || []).slice(0, 2).join(' | '));
    await shot(page, 'svg-hostile');

    /* ---- a file that cannot be read says so, and takes nothing with it ---- */
    await paste(page, '<svg xmlns="http://www.w3.org/2000/svg"><circle');
    await until(page, () => document.querySelectorAll('#svgList .svg-item').length === 3, null, 10000);
    await page.evaluate(() => document.getElementById('btnSvgRun').click());
    await until(page, () => !!document.querySelector('#svgList .svg-item.bad'), null, 20000);
    const mixed = await page.evaluate(() => ({
      bad: document.querySelector('.svg-item.bad .svg-error')?.textContent || '',
      badActions: [...document.querySelectorAll('.svg-item.bad [data-act]')].map((b) => b.dataset.act),
      stillGood: document.querySelectorAll('#svgList .svg-item.done').length,
    }));
    r.ok('failure', 'a file that could not be read says why, on the file', /could not be read/i.test(mixed.bad), mixed.bad);
    r.ok('failure', 'and is not offered as something to download', !mixed.badActions.includes('download'), mixed.badActions.join(', '));
    r.ok('failure', 'while the files that worked are untouched', mixed.stillGood >= 1, `${mixed.stillGood} still good`);

    /* ---- the settings ---- */
    await page.evaluate(() => { const c = document.getElementById('svgKeepViewBox'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); });
    await sleep(300);
    const warned = await page.evaluate(() => ({
      warn: document.getElementById('svgWarn').textContent,
      shown: document.getElementById('svgWarn').getClientRects().length > 0,
      dimsDisabled: document.getElementById('svgRemoveDimensions').disabled,
    }));
    r.ok('settings', 'turning off the viewBox says what that costs', warned.shown && /stops the image scaling/.test(warned.warn), warned.warn.slice(0, 80));
    r.ok('settings', 'and the setting that then makes no sense is not offered', warned.dimsDisabled);

    await page.evaluate(() => { const p = document.getElementById('svgPrecision'); p.value = '0'; p.dispatchEvent(new Event('change', { bubbles: true })); });
    await sleep(250);
    r.ok('settings', 'a precision that will shift shapes says so too',
      await page.evaluate(() => /decimal places, shapes can visibly shift/.test(document.getElementById('svgWarn').textContent)));
    await shot(page, 'svg-settings');

    /* they survive leaving the page, and Reset puts the module's own defaults back */
    await page.evaluate(() => document.querySelector('[data-nav="home"]').click());
    await sleep(500);
    await openSvg(page);
    const remembered = await page.evaluate(() => ({ p: document.getElementById('svgPrecision').value, v: document.getElementById('svgKeepViewBox').checked }));
    r.ok('settings', 'the settings are still there when you come back', remembered.p === '0' && remembered.v === false, JSON.stringify(remembered));
    await page.evaluate(() => document.getElementById('btnSvgReset').click());
    await sleep(300);
    const reset = await page.evaluate(() => ({ p: document.getElementById('svgPrecision').value, v: document.getElementById('svgKeepViewBox').checked, warn: document.getElementById('svgWarn').getClientRects().length }));
    r.ok('settings', 'and Reset restores what the module considers safe', reset.p === '3' && reset.v === true && reset.warn === 0, JSON.stringify(reset));

    /* ---- clearing ---- */
    await page.evaluate(() => document.getElementById('btnSvgClear').click());
    await until(page, () => document.querySelectorAll('#svgList .svg-item').length === 0, null, 8000);
    r.ok('clear', 'clearing empties the list and brings the invitation back',
      await page.evaluate(() => document.getElementById('svgEmpty').getClientRects().length > 0));

    /* ---- the sample, so the page is usable with nothing to hand ---- */
    await page.evaluate(() => document.getElementById('btnSvgSample').click());
    await until(page, () => document.querySelectorAll('#svgList .svg-item').length === 1, null, 8000);
    await page.evaluate(() => document.getElementById('btnSvgRun').click());
    await until(page, () => !!document.querySelector('#svgList .svg-item.done'), null, 20000);
    r.ok('sample', 'the sample optimises, so the page can be tried with nothing to hand',
      await page.evaluate(() => /smaller/.test(document.querySelector('.svg-win').textContent)));

    /* ---- narrow ---- */
    await page.setViewport({ width: 390, height: 780 });
    await sleep(500);
    const narrow = await page.evaluate(() => {
      const item = document.querySelector('.svg-item');
      return { w: Math.round(item.getBoundingClientRect().width), page: document.documentElement.scrollWidth - window.innerWidth };
    });
    r.ok('narrow', 'nothing spills sideways on a phone', narrow.w > 200 && narrow.page <= 2, JSON.stringify(narrow));
    await shot(page, 'svg-narrow');
    await page.setViewport({ width: 1400, height: 900 });

    r.ok('errors', 'no page errors were raised during the run', page.__errors.length === 0, page.__errors.slice(0, 3).join(' | '));
  } catch (e) {
    r.ok('run', 'the check completed', false, (e && e.stack) || String(e));
  } finally {
    if (page) { try { await shot(page, 'svg-final'); } catch {} }
    await browser.close().catch(() => {});
    await s.stop().catch(() => {});
  }
  process.exit(r.report() ? 0 : 1);
}

main();
