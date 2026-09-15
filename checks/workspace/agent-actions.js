'use strict';
/* The assistant's "N actions taken" panel, with the two shapes that broke it: a long SQL query
   and a whole proposed rule. Every action used to be one flex row holding the input as a single
   JSON string, so a long argument wrapped to a dozen lines - and the tool NAME, sharing that
   shrinking row, broke a character at a time and read vertically.
   Run: node checks/workspace/agent-actions.js */
const { startSandbox } = require('./sandbox');
const { launch, openApp, shot, until, sleep } = require('./browser');

const LONG_SQL = "SELECT COUNT(*) AS rows_total, SUM(b LIKE '%online-casino%') AS v_online_casino, SUM(b LIKE '%/casinos%') AS v_casinos, SUM(b LIKE '%/casino/%') AS v_casino_slash FROM (SELECT CONCAT_WS(' ', maintext, site_main_2, site_main_3, site_main_4, bottom_text, cta) AS b FROM x2950_site) t";

(async () => {
  const s = await startSandbox({ port: Number(process.env.PORT || 3121), servers: 0 });
  const browser = await launch();
  let page, bad = 0;
  const say = (ok, m, d = '') => { if (!ok) bad++; console.log((ok ? 'PASS ' : 'FAIL ') + m + (d ? ' — ' + d : '')); };
  try {
    page = await openApp(browser, s.base);
    await page.evaluate(() => { location.hash = '#/home'; });
    await sleep(500);
    await page.evaluate(() => document.getElementById('btnAiAgent').click());
    await until(page, () => !document.getElementById('agentChatWrap')?.hidden, null, 20000);

    // paint a reply with the action shapes from the report
    await page.evaluate((sql) => {
      appendAgentMsg('ai', 'Here is what I found.', [
        { tool: 'get_table', input: { table: 'x2950_site' }, ok: true, ms: 8412 },
        { tool: 'run_sql', input: { sql }, ok: true, ms: 3154 },
        { tool: 'propose_rule', input: { action: 'create', rule: { name: 'x2950_site body: casino slug variants', table: 'x2950_site', pkColumn: 'id', where: "CONCAT_WS(' ', maintext, cta) REGEXP '/(online-)?casinos?/'", limit: 500, transforms: [{ column: 'maintext', type: 'findReplace', params: { find: '/casinos/', replace: '/casino/', regex: true } }] } }, ok: true, ms: 1 },
        { tool: 'run_sql', input: { sql: 'SELECT 1' }, ok: false, ms: 12 },
      ]);
    }, LONG_SQL);
    await until(page, () => !!document.querySelector('.agent-actions'), null, 8000);
    await page.evaluate(() => { document.querySelector('.agent-actions').open = true; });
    await sleep(300);

    const rows = await page.evaluate(() => [...document.querySelectorAll('.agent-action')].map((el) => {
      const tool = el.querySelector('.aa-tool'), peek = el.querySelector('.aa-peek');
      const r = el.getBoundingClientRect(), t = tool.getBoundingClientRect();
      const line = parseFloat(getComputedStyle(el).lineHeight) || 16;
      return {
        tool: tool.textContent, toolW: t.width, toolH: t.height, rowH: r.height, line,
        expandable: el.tagName === 'DETAILS',
        peekOneLine: peek.getBoundingClientRect().height <= line * 1.6,
        peekClipped: peek.scrollWidth > peek.clientWidth + 1,
      };
    }));
    console.log(JSON.stringify(rows, null, 1));
    for (const r of rows) {
      say(r.toolH <= r.line * 1.6, `the tool name "${r.tool.trim()}" stays on one line`, `${Math.round(r.toolH)}px vs line ${Math.round(r.line)}px`);
      say(r.peekOneLine, `the argument peek for ${r.tool.trim()} is one line`);
      say(r.rowH <= r.line * 2.2, `the closed row for ${r.tool.trim()} is one line`, `${Math.round(r.rowH)}px`);
    }
    say(rows.filter((r) => r.expandable).length === 2, 'only the long arguments get an expander', `${rows.filter((r) => r.expandable).length} of ${rows.length}`);

    const overflow = await page.evaluate(() => {
      const m = document.getElementById('agentMessages');
      return { sw: m.scrollWidth, cw: m.clientWidth };
    });
    say(overflow.sw <= overflow.cw + 1, 'the chat does not scroll sideways', JSON.stringify(overflow));
    await shot(page, 'aa-closed');

    // opened: the fields are readable and wrap
    await page.evaluate(() => { document.querySelectorAll('details.agent-action').forEach((d) => { d.open = true; }); });
    await sleep(300);
    const opened = await page.evaluate(() => {
      const f = document.querySelector('.aa-field pre');
      const m = document.getElementById('agentMessages');
      return { fields: document.querySelectorAll('.aa-field').length, wraps: f ? getComputedStyle(f).whiteSpace : null, preW: f ? Math.round(f.getBoundingClientRect().width) : 0, chatW: Math.round(m.clientWidth), sw: m.scrollWidth, cw: m.clientWidth };
    });
    say(opened.fields > 0 && opened.wraps === 'pre-wrap', 'an opened action shows its fields, wrapped', JSON.stringify(opened));
    say(opened.sw <= opened.cw + 1, 'and opening one still does not scroll the chat sideways', JSON.stringify(opened));
    say(opened.preW > opened.chatW * 0.7, 'the value gets the width of the window, not a column of it', JSON.stringify(opened));
    await shot(page, 'aa-open');
    say(page.__errors.length === 0, 'no page errors', page.__errors.slice(0, 2).join(' | '));
  } catch (e) {
    say(false, 'the check completed', (e && e.stack) || String(e));
  } finally {
    await browser.close().catch(() => {});
    await s.stop().catch(() => {});
  }
  console.log(bad ? `\n${bad} failure(s)` : '\nall good');
  process.exit(bad ? 1 : 0);
})();
