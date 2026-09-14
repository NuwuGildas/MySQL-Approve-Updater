'use strict';
/* Two things that only go wrong at small widths, and that a unit test cannot see because both
   are settled by the stylesheet:

   1. the assistant is an ACTION SHEET on a phone - full width, pinned to the bottom edge,
      dismissed by tapping outside it - and still a draggable floating window on a laptop;
   2. the terminal session bar is ONE row, with clear / new / end behind a single "more" trigger.

   Run: node checks/workspace/mobile-shell.js */

const { startSandbox } = require('./sandbox');
const { launch, openApp, recorder, shot, until, sleep } = require('./browser');

const PORT = Number(process.env.PORT || 3118);
const PHONE = { width: 430, height: 860 };
const DESK = { width: 1280, height: 860 };

/* Runs in the page. Children of the session bar whose vertical centres are within 10px are one
   visual row; the screen-reader-only label is positioned off-screen and is not a row. */
const barRows = () => {
  const kids = [...document.getElementById('wsIdent').children]
    .filter((e) => e.getClientRects().length && !e.classList.contains('sr-only'));
  const centres = kids.map((e) => { const b = e.getBoundingClientRect(); return b.top + b.height / 2; }).sort((a, b) => a - b);
  let rows = 0, last = -Infinity;
  for (const c of centres) { if (c - last > 10) { rows++; last = c; } }
  return rows;
};

async function main() {
  const s = await startSandbox({ port: PORT, servers: 1 });
  const browser = await launch();
  const r = recorder('mobile-shell');
  let page;
  try {
    page = await openApp(browser, s.base);

    /* ---- 1. the assistant as an action sheet ---- */
    await page.setViewport(PHONE);
    await sleep(600);
    await page.evaluate(() => document.getElementById('btnAiAgent').click());
    await until(page, () => document.getElementById('agentDrawer').classList.contains('open'), null, 10000);
    await sleep(600);
    const sheet = await page.evaluate(() => {
      const el = document.getElementById('agentDrawer');
      const b = el.getBoundingClientRect(), cs = getComputedStyle(el);
      return {
        left: b.left, right: b.right, bottom: b.bottom, height: b.height,
        vw: innerWidth, vh: innerHeight, resize: cs.resize, inline: el.getAttribute('style') || '',
        scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
      };
    });
    r.ok('sheet', 'the assistant spans the full width of the phone',
      Math.abs(sheet.left) < 1 && Math.abs(sheet.right - sheet.vw) < 1, JSON.stringify(sheet));
    r.ok('sheet', 'it rises from the bottom edge', Math.abs(sheet.bottom - sheet.vh) < 1, `bottom=${Math.round(sheet.bottom)} vh=${sheet.vh}`);
    r.ok('sheet', 'it is a tall panel, not a shrunken window',
      sheet.height > sheet.vh * 0.6 && sheet.height <= sheet.vh * 0.9, `${Math.round(sheet.height)}px of ${sheet.vh}`);
    r.ok('sheet', 'no saved window geometry is pinned onto it', sheet.inline === '', sheet.inline);
    r.ok('sheet', 'no resize grip on a sheet', sheet.resize === 'none', sheet.resize);
    r.ok('sheet', 'the page does not scroll sideways', sheet.scrollW <= sheet.clientW + 1, `${sheet.scrollW} > ${sheet.clientW}`);
    await shot(page, 'm-agent-sheet');

    await page.mouse.click(Math.round(PHONE.width / 2), 60); // the scrim above the sheet
    await sleep(400);
    r.ok('sheet', 'tapping outside dismisses it',
      !(await page.evaluate(() => document.getElementById('agentDrawer').classList.contains('open'))));

    await page.setViewport(DESK);
    await sleep(400);
    await page.evaluate(() => document.getElementById('btnAiAgent').click());
    await sleep(600);
    const win = await page.evaluate(() => {
      const el = document.getElementById('agentDrawer'), b = el.getBoundingClientRect();
      return { w: b.width, left: b.left, vw: innerWidth, resize: getComputedStyle(el).resize };
    });
    r.ok('sheet', 'back on a laptop it is a floating window again',
      win.w < win.vw * 0.6 && win.left > 40 && win.resize !== 'none', JSON.stringify(win));
    await page.evaluate(() => document.getElementById('btnAgentClose').click());

    /* ---- 2. the terminal session bar ---- */
    if (!s.modules.includes('servers')) {
      r.ok('bar', 'the Servers module was installed into the sandbox', false, `installed: ${s.modules.join(', ') || 'none'}`);
    } else {
      await page.evaluate(() => { location.hash = '#/servers'; });
      await until(page, () => !!document.querySelector('#serversList .srv-card'), null, 25000);
      await until(page, () => { const b = document.querySelector('#serversList [data-act="connect"]'); if (!b) return false; b.click(); return true; }, null, 20000);
      await until(page, () => !!document.querySelector('#serversList [data-act="terminal-menu"]'), null, 40000);
      await until(page, () => {
        const card = document.querySelector('#serversList .srv-card');
        const trigger = card && card.querySelector('[data-act="terminal-menu"]');
        if (!trigger) return false;
        const menu = card.querySelector('.term-dd-menu');
        if (menu.hidden) { trigger.click(); return false; }
        menu.querySelector('[data-act="terminal"]').click();
        return true;
      }, null, 20000);
      await until(page, () => document.body.classList.contains('ws-page') && !!document.querySelector('.ssh-console'), null, 30000);
      await until(page, () => !document.getElementById('wsIdent').hidden, null, 20000);
      await sleep(1200);

      const bar = await page.evaluate((src) => {
        eval(src); // eslint-disable-line no-eval -- the helper is defined in this file, not fetched
        return { rows: barRows(), menuHidden: document.getElementById('wsMoreMenu').hidden };
      }, 'var barRows = ' + barRows.toString());
      r.ok('bar', 'the session bar is a single row on a laptop', bar.rows === 1, `${bar.rows} row(s)`);
      r.ok('bar', 'the actions menu starts closed', bar.menuHidden);
      await shot(page, 'm-session-bar');

      await page.evaluate(() => document.getElementById('btnWsMore').click());
      await sleep(300);
      const open = await page.evaluate(() => {
        const m = document.getElementById('wsMoreMenu'), b = m.getBoundingClientRect();
        return { hidden: m.hidden, items: [...m.querySelectorAll('button')].map((x) => x.textContent.trim()), inView: b.left >= 0 && b.right <= innerWidth + 1 };
      });
      r.ok('bar', 'clear / new / end are behind the one trigger',
        !open.hidden && open.items.length === 3, open.items.join(' | '));
      r.ok('bar', 'the menu opens inside the viewport', open.inView);
      await shot(page, 'm-session-bar-menu');

      await page.evaluate(() => document.body.click());
      await sleep(250);
      r.ok('bar', 'a click outside closes the menu', await page.evaluate(() => document.getElementById('wsMoreMenu').hidden));

      await page.setViewport(PHONE);
      await sleep(800);
      const phone = await page.evaluate((src) => {
        eval(src); // eslint-disable-line no-eval
        return { rows: barRows(), scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth };
      }, 'var barRows = ' + barRows.toString());
      r.ok('bar', 'it wraps to at most two rows on a phone', phone.rows <= 2, `${phone.rows} row(s)`);
      r.ok('bar', 'and still does not scroll sideways', phone.scrollW <= phone.clientW + 1, `${phone.scrollW} > ${phone.clientW}`);
      await shot(page, 'm-session-bar-phone');
    }

    r.ok('errors', 'no page errors were raised during the run', page.__errors.length === 0, page.__errors.slice(0, 3).join(' | '));
  } catch (e) {
    r.ok('run', 'the check completed', false, (e && e.stack) || String(e));
  } finally {
    if (page) { try { await shot(page, 'm-final'); } catch {} }
    await browser.close().catch(() => {});
    await s.stop().catch(() => {});
  }
  process.exit(r.report() ? 0 : 1);
}

main();
