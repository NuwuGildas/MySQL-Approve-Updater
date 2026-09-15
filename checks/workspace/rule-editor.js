'use strict';
/* Opening a hand-written draft rule in the editor.
 *
 * rules.json is a plain file people edit, and a rule written by hand - or pasted out of the chat -
 * holds "id,page_url" where the application expects ["id","page_url"]. A string has no .join, so
 * the editor threw "((intermediate value) || []).join is not a function" and the rule could not be
 * opened at all. Both halves are checked: what the server hands over, and what the editor does with
 * the raw shape if it ever meets one.
 * Run: node checks/workspace/rule-editor.js */
const fs=require('fs'); const path=require('path');
const { startSandbox } = require('./sandbox');
const { launch, openApp, shot, until, sleep } = require('./browser');

const HAND_WRITTEN = {
  name: 'Canonicalise casino hub links → /casino/',
  table: 'x2950_site', pkColumn: 'id', draft: true, limit: 500,
  where: "CONCAT_WS(' ', maintext, cta) REGEXP '/(online-)?casinos?/'",
  displayColumns: 'id,page_url,maintext,site_main_2,bottom_text,cta',
  transforms: [{ column: 'maintext', type: 'findReplace', params: { find: '/casinos/', replace: '/casino/', regex: true } }],
};

(async () => {
  const s = await startSandbox({
    port: Number(process.env.PORT || 3122), servers: 0,
    beforeStart: (dir) => fs.writeFileSync(path.join(dir, 'rules.json'), JSON.stringify([HAND_WRITTEN], null, 2)),
  });
  const browser = await launch();
  let page, bad = 0;
  const say = (ok, m, d='') => { if (!ok) bad++; console.log((ok?'PASS ':'FAIL ')+m+(d?' — '+d:'')); };
  try {
    page = await openApp(browser, s.base);
    await page.evaluate(() => { location.hash = '#/database/updates'; });
    await until(page, () => !!document.querySelector('#rulesList .rule-card, #rulesList button, #rulesList *'), null, 20000);
    await sleep(1200);

    const served = await (await fetch(s.base + '/api/rules')).json();
    const rule = (served.rules || served)[0];
    say(Array.isArray(rule.displayColumns), 'the server hands the editor a list, not a string', JSON.stringify(rule.displayColumns));
    say(!!rule.id, 'and the rule has an id to be saved against', rule.id);

    // open it the way the user does
    await page.evaluate((r) => { window.__testRule = r; }, rule);
    const res = await page.evaluate(() => {
      try { fillForm(window.__testRule); return { ok: true, display: document.getElementById('rDisplay').value, name: document.getElementById('rName').value }; }
      catch (e) { return { ok: false, error: e.message }; }
    });
    say(res.ok, 'the editor opens it without throwing', res.error || '');
    say(res.display === 'id, page_url, maintext, site_main_2, bottom_text, cta', 'with the columns filled in', res.display);

    // and the old shape straight from the file, unnormalised, must not throw either
    const raw = await page.evaluate((r) => {
      try { fillForm(r); return { ok: true, display: document.getElementById('rDisplay').value }; }
      catch (e) { return { ok: false, error: e.message }; }
    }, HAND_WRITTEN);
    say(raw.ok, 'and so does the raw string shape, straight from the file', raw.error || '');
    say(raw.display === 'id,page_url,maintext,site_main_2,bottom_text,cta', 'the field still shows the columns', raw.display);

    await shot(page, 'rule-draft-editor');
    say(page.__errors.length === 0, 'no page errors', page.__errors.slice(0,2).join(' | '));
  } catch (e) { say(false, 'the check completed', (e && e.stack) || String(e)); }
  finally { await browser.close().catch(()=>{}); await s.stop().catch(()=>{}); }
  console.log(bad ? `\n${bad} failure(s)` : '\nall good');
  process.exit(bad ? 1 : 0);
})();
