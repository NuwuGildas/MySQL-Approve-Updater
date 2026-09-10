'use strict';
/* Shared-layout checks (points B8–B11 of the brief) plus the two hard geometry rules: the terminal
   workspace never sits under the app header and never under the sidebar, at any width, in either
   dock orientation, and with the chat pane docked beside the terminal.
   Run: node checks/workspace/layout.js */

const { startSandbox } = require('./sandbox');
const { launch, openApp, recorder, shot, until, sleep } = require('./browser');

const PORT = Number(process.env.PORT || 3116);
const WIDTHS = [390, 768, 1440, 1900];

const installHelpers = () => {
  window.srvCard = (name) => document.querySelector(`#serversList .srv-name[title="${name}"]`)?.closest('.srv-card') || null;
  window.geom = () => {
    const px = (v) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(v)) || 0;
    const hdr = document.querySelector('body > header')?.getBoundingClientRect();
    const nav = document.querySelector('.app-nav')?.getBoundingClientRect();
    const drawer = document.getElementById('sshDrawer').getBoundingClientRect();
    const split = document.getElementById('wsSplit').getBoundingClientRect();
    const term = document.querySelector('.ssh-console.active .ssh-console-term')?.getBoundingClientRect() || null;
    // an off-canvas nav (mobile) is translated out of the viewport: it claims no content space
    const navRight = nav && nav.right > 1 && getComputedStyle(document.querySelector('.app-nav')).transform.indexOf('-') === -1 ? nav.right : 0;
    return {
      hdrBottom: hdr ? hdr.bottom : 0, navRight, navW: px('--nav-w'), hdrH: px('--hdr-h'),
      drawer: { top: drawer.top, left: drawer.left, right: drawer.right, width: drawer.width },
      split: { top: split.top, left: split.left, width: split.width },
      term: term ? { left: term.left, width: term.width } : null,
      scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
      termScroll: (() => { const h = document.querySelector('.ssh-console.active .ssh-console-term'); return h ? { sw: h.scrollWidth, cw: h.clientWidth } : null; })(),
    };
  };
  window.paneControls = () => ({
    termBtn: document.querySelectorAll('#wsPaneTerminal .ws-control').length,
    termBadge: document.querySelectorAll('#wsPaneTerminal .ws-owner').length,
    chatBtn: document.querySelectorAll('#wsPaneChat .ws-control').length,
    chatBadge: document.querySelectorAll('#wsPaneChat .ws-owner').length,
    strayCtl: [...document.querySelectorAll('#sshDrawer button')].filter((b) => /give ai control|take control/i.test(b.textContent) && b.offsetParent).length,
    strayOwn: [...document.querySelectorAll('#sshDrawer')].map(() => 0)[0]
      + [...document.querySelectorAll('#sshDrawer [data-control-status]')].filter((e) => e.offsetParent).length,
  });
};

async function main() {
  const s = await startSandbox({ port: PORT, servers: 1 });
  const browser = await launch();
  const r = recorder('layout');
  let page;
  try {
    page = await openApp(browser, s.base);
    await page.evaluate(installHelpers);

    // connect the fixture and open its terminal page
    await until(page, () => !!document.querySelector('#serversList .srv-card'), null, 20000);
    const off = await page.evaluate(() => {
      const c = srvCard('Fixture 1');
      const acts = [...c.querySelectorAll('.srv-actions > *')].filter((e) => e.offsetParent);
      // centre, not top: an icon button is shorter than a text one and would read as a second row
      const rows = new Set(acts.map((e) => { const b = e.getBoundingClientRect(); return Math.round((b.top + b.height / 2) / 6); }));
      return { lines: rows.size, labels: acts.map((e) => e.textContent.replace(/\s+/g, ' ').trim() || e.title || 'icon') };
    });
    r.ok('B-card', 'a disconnected card keeps its actions on one line', off.lines === 1, `${off.lines} line(s): ${off.labels.join(' | ')}`);
    await shot(page, 'b-card-disconnected');
    await until(page, () => { const b = srvCard('Fixture 1')?.querySelector('[data-act="connect"]'); if (!b) return false; b.click(); return true; }, null, 20000);
    await until(page, () => !!srvCard('Fixture 1')?.querySelector('[data-act="terminal-menu"]'), null, 40000);

    /* ---- server card: no session chips on the card, actions on one line ---- */
    const cardShape = await page.evaluate(() => {
      const c = srvCard('Fixture 1');
      const acts = [...c.querySelectorAll('.srv-actions > *')].filter((e) => e.offsetParent);
      const tops = new Set(acts.map((e) => { const b = e.getBoundingClientRect(); return Math.round((b.top + b.height / 2) / 6); }));
      return {
        text: c.innerText.replace(/\s+/g, ' '),
        labels: acts.map((e) => e.textContent.replace(/\s+/g, ' ').trim() || e.title || 'icon'),
        lines: tops.size, width: Math.round(c.getBoundingClientRect().width),
      };
    });
    r.ok('B-card', 'the card carries no session chips', !/ended \(read-only\)|· \d+ msg/.test(cardShape.text), cardShape.text.slice(0, 110));
    r.ok('B-card', 'the action row stays on one line at card width', cardShape.lines === 1,
      `${cardShape.lines} line(s) at ${cardShape.width}px: ${cardShape.labels.join(' | ')}`);
    const wanted = ['AI chat', 'Refresh', 'Terminal', 'Disconnect']; // the actions that must survive
    r.ok('B-card', 'the card keeps every action it had', wanted.every((w) => cardShape.labels.some((l) => l.includes(w))), cardShape.labels.join(' | '));
    await shot(page, 'b-card-connected');

    await until(page, () => {
      const c = srvCard('Fixture 1'), t = c && c.querySelector('[data-act="terminal-menu"]');
      if (!t) return false;
      const m = c.querySelector('.term-dd-menu');
      if (m.hidden) { t.click(); return false; }
      m.querySelector('[data-act="terminal"]').click();
      return true;
    }, null, 20000);
    const up = await until(page, () => document.body.classList.contains('ws-page') && !!document.querySelector('.ssh-console'), null, 30000);
    r.ok('B8', 'the terminal opens as the workspace page', up);
    await sleep(1200);
    const asView = await page.evaluate(() => {
      const d = document.getElementById('sshDrawer'), cs = getComputedStyle(d);
      return {
        route: location.hash, page: [...document.body.classList].find((c) => c.startsWith('page-')),
        position: cs.position, transform: cs.transform,
        asPage: d.classList.contains('as-page'),
        resize: !!document.getElementById('sshResize'),
        floatable: !!document.querySelector('[data-cact="popout"]'),
        close: !!document.getElementById('btnSshClose'),
        dock: !!d.querySelector('.btn-dock'),
      };
    });
    r.ok('view', 'Terminals is a routed view, not a drawer coerced into a page',
      /^#\/terminals\//.test(asView.route) && asView.page === 'page-terminals' && asView.position === 'relative'
      && asView.transform === 'none' && !asView.asPage, JSON.stringify(asView));
    r.ok('view', 'no drawer chrome is left behind (resize, pop-out, dock, close)',
      !asView.resize && !asView.floatable && !asView.close && !asView.dock, JSON.stringify(asView));

    /* ---- B8/B10/B11 + the two hard geometry rules, at four widths ---- */
    for (const w of WIDTHS) {
      await page.setViewport({ width: w, height: 900 });
      await sleep(800);
      const g = await page.evaluate(() => geom());
      const split = await page.evaluate(() => document.body.classList.contains('ws-wide'));
      r.ok('geometry', `${w}px: the workspace starts below the header`, g.drawer.top >= g.hdrBottom - 1 && g.split.top >= g.hdrBottom - 1,
        `drawer.top=${Math.round(g.drawer.top)} split.top=${Math.round(g.split.top)} header.bottom=${Math.round(g.hdrBottom)}`);
      r.ok('geometry', `${w}px: the workspace starts right of the sidebar`, g.drawer.left >= g.navRight - 1,
        `drawer.left=${Math.round(g.drawer.left)} nav.right=${Math.round(g.navRight)}`);
      r.ok('geometry', `${w}px: the page does not scroll sideways`, g.scrollW <= g.clientW + 1, `${g.scrollW} vs ${g.clientW}`);
      if (g.termScroll) r.ok('B11', `${w}px: the terminal does not scroll sideways`, g.termScroll.sw <= g.termScroll.cw + 2, JSON.stringify(g.termScroll));
      r.ok('B8', `${w}px: ${w >= 1100 ? 'both panes are side by side' : 'the panes are Terminal/Chat tabs'}`,
        split === (w >= 1100) && (split ? await page.evaluate(() => !document.getElementById('wsPaneChat').hidden && !document.getElementById('wsPaneTerminal').hidden)
          : await page.evaluate(() => !document.getElementById('wsTabs').hidden)));
      const controls = await page.evaluate(() => paneControls());
      r.ok('B9', `${w}px: exactly one control action and one ownership badge per pane`,
        controls.termBtn === 1 && controls.chatBtn === 1 && controls.termBadge === 1 && controls.chatBadge === 1, JSON.stringify(controls));
      r.ok('B9', `${w}px: no third copy of the control action is on screen`, controls.strayCtl <= (split ? 2 : 1) && controls.strayOwn === 0, JSON.stringify(controls));
      await shot(page, `b-${w}-${split ? 'split' : 'tabs'}`);
    }

    /* ---- B8: the tabs are a real tablist with roving tabindex and arrow keys ---- */
    await page.setViewport({ width: 768, height: 900 });
    await sleep(600);
    const roving = await page.evaluate(() => ({
      role: document.getElementById('wsTabs').getAttribute('role'),
      t: document.getElementById('wsTabTerminal').tabIndex, c: document.getElementById('wsTabChat').tabIndex,
      sel: document.getElementById('wsTabTerminal').getAttribute('aria-selected'),
      panelRole: document.getElementById('wsPaneTerminal').getAttribute('role'),
      labelled: document.getElementById('wsPaneTerminal').getAttribute('aria-labelledby'),
    }));
    r.ok('B8', 'the tab strip is a tablist with a roving tabindex', roving.role === 'tablist' && roving.t === 0 && roving.c === -1
      && roving.sel === 'true' && roving.panelRole === 'tabpanel' && roving.labelled === 'wsTabTerminal', JSON.stringify(roving));
    await page.bringToFront();
    const focused = await page.evaluate(() => { const t = document.getElementById('wsTabTerminal'); t.focus(); return document.activeElement === t; });
    r.ok('B8', 'the Terminal tab takes keyboard focus', focused);
    await page.keyboard.press('ArrowRight');
    await sleep(400);
    const afterRight = await page.evaluate(() => ({ active: document.activeElement.id, chatShown: !document.getElementById('wsPaneChat').hidden, termShown: !document.getElementById('wsPaneTerminal').hidden }));
    r.ok('B8', 'ArrowRight moves to Chat and shows only that panel',
      afterRight.active === 'wsTabChat' && afterRight.chatShown && !afterRight.termShown, JSON.stringify(afterRight));
    await page.keyboard.press('Home');
    await sleep(300);
    const afterHome = await page.evaluate(() => ({ active: document.activeElement.id, termShown: !document.getElementById('wsPaneTerminal').hidden }));
    r.ok('B8', 'Home returns to the Terminal tab', afterHome.active === 'wsTabTerminal' && afterHome.termShown, JSON.stringify(afterHome));
    await page.keyboard.press('End');
    await sleep(300);
    r.ok('B8', 'End moves to the last tab', (await page.evaluate(() => document.activeElement.id)) === 'wsTabChat');
    const focusRing = await page.evaluate(() => {
      const el = document.getElementById('wsTabChat');
      const cs = getComputedStyle(el, ':focus-visible');
      return { outline: cs.outlineStyle, width: cs.outlineWidth };
    });
    r.ok('B8', 'the tabs have a visible focus ring', focusRing.outline !== 'none', JSON.stringify(focusRing));
    // identity must be readable on the chat tab too, with the control reachable
    const chatTabIdent = await page.evaluate(() => ({
      ident: document.getElementById('wsChatIdent').textContent.trim(),
      visible: !!document.getElementById('wsChatIdent').offsetParent,
      control: document.getElementById('btnWsControlChat').textContent.trim(),
    }));
    r.ok('B8', 'the chat tab names the server and session and offers the control',
      /session/i.test(chatTabIdent.ident) && chatTabIdent.visible && /control/i.test(chatTabIdent.control), JSON.stringify(chatTabIdent));
    await shot(page, 'b-768-chat-tab');

    /* ---- B10: ownership is announced in WORDS through one polite live region ---- */
    await page.setViewport({ width: 1440, height: 950 });
    await sleep(700);
    const liveRegions = await page.evaluate(() => [...document.querySelectorAll('#sshDrawer [aria-live], #sshDrawer [role="status"]')].map((e) => e.id || e.className));
    r.ok('B10', 'the workspace has exactly one live region', liveRegions.length === 1 && liveRegions[0] === 'wsOwnerLive', JSON.stringify(liveRegions));
    const ctlState = await page.evaluate(() => {
      const b = document.getElementById('btnWsControl'), c = workspaceConsole();
      b.click();
      return { disabled: b.disabled, label: b.textContent, consoles: consoles.size, status: c && c.session.terminal.status, control: c && c.session.terminal.control };
    });
    r.ok('B10', 'the control button is live on an open session', !ctlState.disabled, JSON.stringify(ctlState));
    // wait for the WORD, not the data attribute: a handover briefly reports the old owner
    await until(page, () => /assistant/i.test(document.querySelector('#wsOwner .ws-owner-text').textContent)
      && /assistant/i.test(document.getElementById('wsOwnerLive').textContent), null, 20000);
    const owned = await page.evaluate(() => ({
      said: document.getElementById('wsOwnerLive').textContent,
      badge: document.querySelector('#wsOwner .ws-owner-text').textContent,
      chatBadge: document.querySelector('#wsChatOwner .ws-owner-text').textContent,
      chatHidden: document.getElementById('wsChatOwner').getAttribute('aria-hidden'),
      readOnly: !!document.querySelector('.ssh-console.active').classList.contains('assistant-driving'),
      stdin: (() => { const c = workspaceConsole(); return c && c.term.options.disableStdin; })(),
    }));
    r.ok('B10', 'ownership is announced in words, once, and shown as text in both panes',
      /assistant has control/i.test(owned.said) && /assistant/i.test(owned.badge) && /assistant/i.test(owned.chatBadge) && owned.chatHidden === 'true',
      JSON.stringify(owned).slice(0, 160));
    r.ok('B10', 'the xterm is read-only while the assistant holds control', owned.stdin === true && owned.readOnly);
    await shot(page, 'b-1440-assistant-control');
    await page.evaluate(() => document.getElementById('btnWsControlChat').click());
    await until(page, () => /you have control/i.test(document.getElementById('wsOwnerLive').textContent)
      && !workspaceConsole().term.options.disableStdin, null, 20000);
    const back = await page.evaluate(() => ({ said: document.getElementById('wsOwnerLive').textContent, stdin: workspaceConsole().term.options.disableStdin }));
    r.ok('B10', 'taking control back is announced and re-enables typing', /you have control/i.test(back.said) && back.stdin === false, JSON.stringify(back));

    /* ---- B11: the xterm refits when its visible box changes ---- */
    await page.setViewport({ width: 1900, height: 950 });
    await sleep(900);
    const before = await page.evaluate(() => { const c = workspaceConsole(); return { cols: c.term.cols, rows: c.term.rows }; });
    await page.setViewport({ width: 760, height: 900 }); // drops to tabs and narrows the terminal box
    await page.evaluate(() => setWorkspaceTab('terminal'));
    await sleep(1000);
    const narrow = await page.evaluate(() => { const c = workspaceConsole(); return { cols: c.term.cols, rows: c.term.rows }; });
    r.ok('B11', 'the xterm refits when the pane changes shape', narrow.cols < before.cols,
      `${before.cols}x${before.rows} → ${narrow.cols}x${narrow.rows}`);
    // switching to the chat tab must not fit a hidden host down to nothing
    await page.evaluate(() => setWorkspaceTab('chat'));
    await sleep(700);
    const hidden = await page.evaluate(() => { const c = workspaceConsole(); return { cols: c.term.cols, rows: c.term.rows }; });
    r.ok('B11', 'a hidden pane is never fitted to a zero box', hidden.cols === narrow.cols && hidden.rows === narrow.rows,
      `${narrow.cols}x${narrow.rows} → ${hidden.cols}x${hidden.rows}`);
    await page.evaluate(() => setWorkspaceTab('terminal'));
    await page.setViewport({ width: 1900, height: 950 });
    await sleep(1000);
    const wideAgain = await page.evaluate(() => { const c = workspaceConsole(); return { cols: c.term.cols, rows: c.term.rows }; });
    r.ok('B11', 'the xterm refits again when the pane is revealed and widened', wideAgain.cols > hidden.cols,
      `${hidden.cols} → ${wideAgain.cols} columns`);

    /* ---- geometry: the same two rules in the horizontal dock and with a collapsed sidebar ---- */
    await page.evaluate(() => document.body.classList.add('drawers-h'));
    await sleep(700);
    for (const w of [768, 1900]) {
      await page.setViewport({ width: w, height: 900 });
      await sleep(600);
      const g = await page.evaluate(() => geom());
      r.ok('geometry', `${w}px horizontal dock: below the header and right of the sidebar`,
        g.drawer.top >= g.hdrBottom - 1 && g.drawer.left >= g.navRight - 1,
        `top=${Math.round(g.drawer.top)}/${Math.round(g.hdrBottom)} left=${Math.round(g.drawer.left)}/${Math.round(g.navRight)}`);
    }
    await page.evaluate(() => document.body.classList.remove('drawers-h'));
    await page.setViewport({ width: 1900, height: 950 });
    await page.evaluate(() => document.body.classList.add('nav-collapsed'));
    await sleep(700);
    const collapsed = await page.evaluate(() => geom());
    r.ok('geometry', '1900px with a collapsed sidebar: still right of the nav',
      collapsed.drawer.left >= collapsed.navRight - 1, `left=${Math.round(collapsed.drawer.left)} nav.right=${Math.round(collapsed.navRight)}`);
    await shot(page, 'b-1900-collapsed-nav');
    await page.evaluate(() => document.body.classList.remove('nav-collapsed'));
    await sleep(500);
    await shot(page, 'b-1900-split');

    r.ok('B12', 'no page errors were raised during the run', page.__errors.length === 0, page.__errors.slice(0, 3).join(' | '));
  } catch (e) {
    r.ok('run', 'the check completed', false, (e && e.stack) || String(e));
  } finally {
    if (page) { try { await shot(page, 'b-final'); } catch {} }
    await browser.close();
    await s.stop();
  }
  process.exit(r.report() ? 0 : 1);
}

main();
