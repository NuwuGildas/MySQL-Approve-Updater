'use strict';
/* The Terminals view as a first-class page, and the way back to a running shell:
   the sidebar entry exists only while a session is LIVE, counts them, survives leaving the view
   and reloading the browser, reopens the most recently used one, and notices sessions this
   browser never opened. Run: node checks/workspace/terminals.js */

const { startSandbox } = require('./sandbox');
const { launch, openApp, recorder, shot, until, sleep } = require('./browser');

const PORT = Number(process.env.PORT || 3136);

const installHelpers = () => {
  window.srvCard = (name) => document.querySelector(`#serversList .srv-name[title="${name}"]`)?.closest('.srv-card') || null;
  window.navEntry = () => document.querySelector('#appNav [data-nav="terminals"]');
  window.navState = () => {
    const el = navEntry();
    return el ? { present: true, hidden: el.hidden, text: el.textContent.replace(/\s+/g, ' ').trim(), visible: !!el.offsetParent } : { present: false };
  };
  window.openTerminalFromCard = (name) => {
    const c = srvCard(name), t = c && c.querySelector('[data-act="terminal-menu"]');
    if (!t) return false;
    const m = c.querySelector('.term-dd-menu');
    if (m.hidden) { t.click(); return false; }
    m.querySelector('[data-act="terminal"]').click();
    return true;
  };
};

async function main() {
  const s = await startSandbox({ port: PORT, servers: 2 });
  const liveIds = async () => ((await (await fetch(s.base + '/api/ssh/terminal')).json()).terminals || [])
    .filter((t) => t.status === 'open').map((t) => t.sessionId);
  const browser = await launch();
  const r = recorder('terminals');
  let page;
  try {
    page = await openApp(browser, s.base);
    await page.evaluate(installHelpers);

    /* ---- nothing live: no affordance ---- */
    await sleep(1200);
    r.ok('affordance', 'with no live session the sidebar entry is not offered',
      (await page.evaluate(() => navState())).hidden === true, JSON.stringify(await page.evaluate(() => navState())));

    /* ---- open a terminal on Fixture 1 ---- */
    await until(page, () => !!document.querySelector('#serversList .srv-card'), null, 20000);
    await until(page, () => { const b = srvCard('Fixture 1')?.querySelector('[data-act="connect"]'); if (!b) return false; b.click(); return true; }, null, 20000);
    await until(page, () => !!srvCard('Fixture 1')?.querySelector('[data-act="terminal-menu"]'), null, 45000);
    await until(page, () => openTerminalFromCard('Fixture 1'), null, 20000);
    await until(page, () => location.hash.startsWith('#/terminals/'), null, 30000);
    const sid = (await page.evaluate(() => location.hash)).split('/').pop();
    r.ok('view', 'opening a terminal lands on the Terminals view addressed by its session', !!sid && sid.length > 8, sid);
    await until(page, () => navState().hidden === false, null, 15000);
    const withOne = await page.evaluate(() => navState());
    r.ok('affordance', 'a live session reveals the sidebar entry with its count',
      !withOne.hidden && /Terminals\s*1/.test(withOne.text), JSON.stringify(withOne));
    await shot(page, 't-view-open');

    /* ---- leaving the view must not end the session ---- */
    await page.evaluate(() => navigate('#/home'));
    await sleep(1500);
    const alive = await liveIds();
    r.ok('affordance', 'leaving the view keeps the session running', alive.includes(sid), alive.join(','));
    const away = await page.evaluate(() => ({ nav: navState(), viewOpen: document.getElementById('sshDrawer').classList.contains('open') }));
    r.ok('affordance', 'the entry stays while the session is live, with the view closed',
      !away.nav.hidden && away.nav.visible && !away.viewOpen, JSON.stringify(away));
    await shot(page, 't-affordance-home');

    /* ---- and it takes you back to that session ---- */
    await page.evaluate(() => navEntry().click());
    const back = await until(page, (id) => location.hash === '#/terminals/' + id
      && [...consoles.values()].some((c) => c.sessionId === id), sid, 30000);
    r.ok('affordance', 'the entry reopens the most recently used live session', back, await page.evaluate(() => location.hash));

    /* ---- a session this browser never opened still counts ---- */
    const other = await (await fetch(s.base + '/api/ssh/agent/attach', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profileId: 'srv-2' }),
    })).json();
    const sawOther = await until(page, () => /Terminals\s*2/.test(navState().text), null, 20000);
    r.ok('affordance', 'a session opened elsewhere appears in the count', sawOther && !!other.sessionId,
      (await page.evaluate(() => navState())).text);
    const picker = await page.evaluate(() => [...document.querySelectorAll('#wsSessionPick optgroup')].map((g) => g.label));
    r.ok('affordance', 'the view can pick among every live session, grouped by server',
      picker.length === 2, JSON.stringify(picker));
    await shot(page, 't-two-live');

    /* ---- a reload with a live session still offers it ---- */
    await page.evaluate(() => navigate('#/home'));
    await sleep(600);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await until(page, () => typeof window.openSsh === 'function' && !!document.getElementById('wsSplit'), null, 20000);
    await page.evaluate(installHelpers);
    const afterReload = await until(page, () => navState().present && navState().hidden === false, null, 20000);
    r.ok('reload', 'after a browser reload the entry is still offered', afterReload, JSON.stringify(await page.evaluate(() => navState())));
    await page.evaluate(() => navEntry().click());
    const reopened = await until(page, () => location.hash.startsWith('#/terminals/') && consoles.size === 1, null, 30000);
    r.ok('reload', 'and it reopens a live session after the reload', reopened, await page.evaluate(() => location.hash));
    await shot(page, 't-after-reload');

    /* ---- the servers page says which server has a shell to go back to ---- */
    await page.evaluate(() => navigate('#/servers'));
    await until(page, () => !!srvCard('Fixture 1'), null, 20000);
    await sleep(1200);
    const card = await page.evaluate(() => {
      const c = srvCard('Fixture 1');
      return { badge: !!c.querySelector('.srv-live'), text: c.innerText.replace(/\s+/g, ' '), menu: c.querySelector('[data-act="terminal-menu"]').textContent.trim() };
    });
    r.ok('servers', 'a server with a live shell shows it and offers to resume',
      card.badge && /live terminal/i.test(card.text) && /resume/i.test(card.menu), JSON.stringify(card).slice(0, 160));
    await shot(page, 't-server-card-live');
    const menuLabels = await page.evaluate(() => {
      const c = srvCard('Fixture 1');
      c.querySelector('[data-act="terminal-menu"]').click();
      return [...c.querySelectorAll('.term-dd-menu > button')].map((b) => b.textContent.replace(/\s+/g, ' ').trim());
    });
    r.ok('servers', 'the menu offers resume first and a new terminal underneath',
      /resume/i.test(menuLabels[0] || '') && menuLabels.some((l) => /new terminal/i.test(l)), JSON.stringify(menuLabels));

    /* ---- the view and the affordance at every width ---- */
    await page.evaluate(() => navigate('#/terminals'));
    await until(page, () => document.getElementById('sshDrawer').classList.contains('open'), null, 20000);
    await sleep(1200);
    for (const w of [390, 768, 1440, 1900]) {
      await page.setViewport({ width: w, height: 900 });
      await sleep(900);
      // below 768 the sidebar is off-canvas: the entry is reachable through the menu button
      const mobile = w < 768;
      if (mobile) await page.evaluate(() => document.getElementById('btnNav').click());
      await sleep(400);
      const seen = await page.evaluate(() => navState());
      r.ok('affordance', `${w}px: the way back is reachable`, !seen.hidden && seen.visible, JSON.stringify(seen));
      await shot(page, `t-${w}-affordance`);
      if (mobile) { await page.evaluate(() => closeMobileNav()); await sleep(400); }
      await shot(page, `t-${w}-view`);
    }
    await page.setViewport({ width: 1440, height: 950 });
    await sleep(700);

    /* ---- ending a session removes the affordance ---- */
    await page.evaluate(() => navigate('#/terminals'));
    await until(page, () => consoles.size >= 1, null, 30000);
    for (const id of await liveIds()) await fetch(s.base + '/api/ssh/terminal/' + id, { method: 'DELETE' });
    const gone = await until(page, () => navState().hidden === true, null, 25000);
    r.ok('affordance', 'an ended session is not a reason to offer the entry', gone, JSON.stringify(await page.evaluate(() => navState())));

    /* ---- the view with no console still explains itself ---- */
    await page.evaluate(() => { dockedConsoles().forEach((c) => closeConsole(c.id)); showSshDrawer(); });
    await sleep(800);
    const empty = await page.evaluate(() => ({
      shown: !document.getElementById('wsEmpty').hidden,
      text: document.getElementById('wsEmpty').innerText.replace(/\s+/g, ' ').slice(0, 120),
    }));
    r.ok('view', 'with no console open the view explains itself and points at Servers',
      empty.shown && /no terminal is open/i.test(empty.text), JSON.stringify(empty));

    r.ok('view', 'no page errors were raised during the run', page.__errors.length === 0, page.__errors.slice(0, 3).join(' | '));
  } catch (e) {
    r.ok('run', 'the check completed', false, (e && e.stack) || String(e));
  } finally {
    if (page) { try { await shot(page, 't-final'); } catch {} }
    await browser.close();
    await s.stop();
  }
  process.exit(r.report() ? 0 : 1);
}

main();
