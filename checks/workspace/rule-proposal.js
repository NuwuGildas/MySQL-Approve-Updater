'use strict';
/* The assistant proposing a rule, and the user being asked about it.
 *
 * propose_rule raises a card with no session id, because a rule belongs to the workspace and not to
 * one shell. The turn only handed back cards whose session matched its own, so the card never
 * reached the browser: the tool ran, the proposal sat pending on the server, and the user was shown
 * a reply about a rule with nothing to approve, cancel or discuss.
 *
 * Run: node checks/workspace/rule-proposal.js
 */

const { startSandbox } = require('./sandbox');
const { launch, openApp, recorder, shot, until, sleep } = require('./browser');

const PORT = Number(process.env.PORT || 3123);

const DRAFT_RULE = {
  action: 'create',
  rule: {
    name: 'Canonicalise casino hub links → /casino/',
    table: 'x2950_site', pkColumn: 'id', limit: 500, draft: true,
    where: "CONCAT_WS(' ', maintext, cta) REGEXP '/(online-)?casinos?/'",
    displayColumns: 'id,page_url,maintext',
    transforms: [{ column: 'maintext', type: 'findReplace', params: { find: '/casinos/', replace: '/casino/', regex: true } }],
  },
};

async function ask(page, s, text, steps) {
  s.script(steps);
  await page.evaluate((t) => { document.getElementById('agentInput').value = t; agentSend(); }, text);
  await until(page, () => !document.body.classList.contains('agent-busy'), null, 40000);
  await sleep(500);
}

async function main() {
  const s = await startSandbox({ port: PORT, servers: 0 });
  const browser = await launch();
  const r = recorder('rule-proposal');
  let page;
  try {
    page = await openApp(browser, s.base);
    await page.evaluate(() => { location.hash = '#/home'; });
    await sleep(600);
    await page.evaluate(() => document.getElementById('btnAiAgent').click());
    await until(page, () => !document.getElementById('agentChatWrap')?.hidden, null, 20000);

    await ask(page, s, 'write me a rule that canonicalises the casino hub links', [
      { reply: JSON.stringify({ tool: 'propose_rule', input: DRAFT_RULE }) },
      { reply: 'I have proposed the rule as a draft. Approve it and it will appear in your rules list.' },
    ]);

    const card = await page.evaluate(() => {
      const el = document.querySelector('.agent-proposal');
      if (!el) return null;
      return {
        head: el.querySelector('.ap-head')?.innerText.replace(/\s+/g, ' ').trim(),
        meta: el.querySelector('.ap-meta')?.innerText.replace(/\s+/g, ' ').trim(),
        hint: el.querySelector('.hint')?.innerText.replace(/\s+/g, ' ').trim(),
        buttons: [...el.querySelectorAll('.actions button')].map((b) => b.textContent.trim()),
        state: el.dataset.state,
        hasDefinition: !!el.querySelector('details'),
      };
    });
    r.ok('card', 'the proposed rule is put in front of the user', !!card, card ? '' : 'no .agent-proposal was rendered');
    if (card) {
      r.ok('card', 'it names the rule and says it is a draft', /Canonicalise casino hub links/.test(card.head) && /draft/i.test(card.head), card.head);
      r.ok('card', 'it summarises what the rule would do', /x2950_site/.test(card.meta) && /transform/.test(card.meta), card.meta);
      r.ok('card', 'the full definition is there to read', card.hasDefinition);
      /* The three things the user can do with it: take it, drop it, or say what they would rather
         have. "Reply with alternative" is the discussion: it rejects this one and sends the model
         an instruction, in the same turn. */
      r.ok('card', 'it offers: add it', card.buttons.some((b) => /add to drafts/i.test(b)), card.buttons.join(' | '));
      r.ok('card', 'it offers: cancel', card.buttons.some((b) => /^cancel$/i.test(b)), card.buttons.join(' | '));
      r.ok('card', 'it offers: discuss instead of deciding', card.buttons.some((b) => /alternative/i.test(b)), card.buttons.join(' | '));
      r.ok('card', 'and says what approving actually does', /draft/i.test(card.hint || ''), card.hint);
      r.ok('card', 'it is pending, not already spent', card.state === 'pending', card.state);
    }
    await shot(page, 'rule-proposal-card');

    // nothing is saved until the user says so
    const before = await (await fetch(s.base + '/api/rules')).json();
    r.ok('safety', 'nothing is written while the card is pending', before.length === 0, `${before.length} rule(s) already saved`);

    // approve it: the draft appears, with the shape the editor expects
    s.script([{ reply: 'Saved as a draft.' }]);
    await page.evaluate(() => document.querySelector('.agent-proposal .actions .approve').click());
    await until(page, () => document.querySelector('.agent-proposal')?.dataset.state !== 'pending', null, 30000);
    await sleep(800);
    const after = await (await fetch(s.base + '/api/rules')).json();
    r.ok('approve', 'approving adds exactly one rule', after.length === 1, `${after.length} rule(s)`);
    if (after.length) {
      r.ok('approve', 'it is a draft, as proposed', after[0].draft === true);
      r.ok('approve', 'it has an id, so it can be edited and deleted', !!after[0].id, after[0].id);
      r.ok('approve', 'and its columns are a list the editor can open', Array.isArray(after[0].displayColumns), JSON.stringify(after[0].displayColumns));
    }
    await shot(page, 'rule-proposal-approved');

    r.ok('errors', 'no page errors were raised during the run', page.__errors.length === 0, page.__errors.slice(0, 3).join(' | '));
  } catch (e) {
    r.ok('run', 'the check completed', false, (e && e.stack) || String(e));
  } finally {
    if (page) { try { await shot(page, 'rule-proposal-final'); } catch {} }
    await browser.close().catch(() => {});
    await s.stop().catch(() => {});
  }
  process.exit(r.report() ? 0 : 1);
}

main();
