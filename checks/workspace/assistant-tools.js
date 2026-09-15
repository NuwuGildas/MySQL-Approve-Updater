'use strict';
/* What the assistant is actually OFFERED, in each kind of conversation.
 *
 * A check that only reads the answer cannot tell a tool the assistant chose not to use from one it
 * was never given, so this reads the prompt the model was handed - the scripted CLI records every
 * one - and asserts the tool list in it.
 *
 * The workspace conversation gets the host's own tools (rules, the database, the audit trail) plus
 * whatever the installed modules contribute. A terminal session gets only what a module contributed
 * for it: someone's shell is not the place to edit update rules.
 *
 * Run: node checks/workspace/assistant-tools.js
 */

const { startSandbox } = require('./sandbox');
const { launch, openApp, recorder, shot, until, sleep } = require('./browser');
const { installPageHelpers } = require('./page-helpers');

const PORT = Number(process.env.PORT || 3120);

/** The tool names listed in a system prompt. */
const toolsIn = (prompt) => {
  const block = /Available tools:\n([\s\S]*?)\nAfter a tool result/.exec(prompt || '');
  return block ? block[1].split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2).split(':')[0].trim()) : [];
};

/** Send one message in whatever conversation is open and wait for the turn to finish. */
async function ask(page, s, text, reply = 'Noted.') {
  s.script([{ reply }]);
  const before = s.prompts().length;
  await page.evaluate((t) => { document.getElementById('agentInput').value = t; agentSend(); }, text);
  await until(page, () => !document.body.classList.contains('agent-busy'), null, 30000);
  for (let i = 0; i < 60 && s.prompts().length === before; i++) await sleep(100);
  return s.lastPrompt();
}

async function main() {
  const s = await startSandbox({ port: PORT, servers: 1 });
  const browser = await launch();
  const r = recorder('assistant-tools');
  let page;
  try {
    page = await openApp(browser, s.base);
    await page.evaluate(installPageHelpers);

    /* ---- the workspace conversation ---- */
    await page.evaluate(() => { location.hash = '#/home'; });
    await sleep(600);
    await page.evaluate(() => document.getElementById('btnAiAgent').click());
    await until(page, () => !document.getElementById('agentChatWrap')?.hidden, null, 20000);

    const workspace = toolsIn(await ask(page, s, 'what rules do I have?'));
    console.log(`  workspace tools (${workspace.length}): ${workspace.join(', ')}`);
    r.ok('workspace', 'the assistant is given any tools at all', workspace.length > 0, `${workspace.length} tool(s)`);
    /* The one the user asked for: it exists in server.js and has since the beginning, but the tool
       list was filtered to module-contributed tools in EVERY conversation, and no host tool carries
       a module - so the assistant was never told it could touch a rule. */
    for (const name of ['list_rules', 'propose_rule']) {
      r.ok('workspace', `it can work with rules (${name})`, workspace.includes(name));
    }
    for (const name of ['list_tables', 'run_sql', 'get_table', 'get_audit_tail', 'list_servers']) {
      r.ok('workspace', `the workspace tool ${name} is offered`, workspace.includes(name));
    }
    for (const name of ['list_projects', 'project_for_resource', 'propose_project_change']) {
      r.ok('workspace', `the Projects module contributes ${name}`, workspace.includes(name));
    }
    r.ok('workspace', 'and it is told it is the workspace, not one session',
      /assistant for a Server Tools workspace/.test(s.lastPrompt()), s.lastPrompt().split('\n')[0]);
    await shot(page, 'at-workspace');

    /* ---- a terminal session conversation ---- */
    await page.evaluate(() => { location.hash = '#/servers'; });
    await until(page, () => !!document.querySelector('#serversList .srv-card'), null, 25000);
    await until(page, () => { const b = document.querySelector('#serversList [data-act="connect"]'); if (!b) return false; b.click(); return true; }, null, 20000);
    await until(page, () => !!document.querySelector('#serversList [data-act="terminal-menu"]'), null, 45000);
    await until(page, () => termMenuAction('Fixture 1', 'terminal-ai'), null, 25000);
    await until(page, () => document.body.classList.contains('ws-page') && !!document.querySelector('.ssh-console'), null, 30000);
    await until(page, () => typeof agentSessionId === 'function' && !!agentSessionId(), null, 30000);
    await sleep(1500);

    const session = toolsIn(await ask(page, s, 'what is on this box?'));
    console.log(`  session tools (${session.length}): ${session.join(', ')}`);
    r.ok('session', 'a session gets the module tools that work in it', session.some((t) => t.startsWith('ssh_')));
    for (const name of ['propose_rule', 'run_sql', 'list_tables']) {
      r.ok('session', `the workspace tool ${name} is NOT offered in a shell`, !session.includes(name));
    }
    r.ok('session', 'and it is told it is one session', /assistant for ONE Server Tools session/.test(s.lastPrompt()));
    await shot(page, 'at-session');

    r.ok('errors', 'no page errors were raised during the run', page.__errors.length === 0, page.__errors.slice(0, 3).join(' | '));
  } catch (e) {
    r.ok('run', 'the check completed', false, (e && e.stack) || String(e));
  } finally {
    if (page) { try { await shot(page, 'at-final'); } catch {} }
    await browser.close().catch(() => {});
    await s.stop().catch(() => {});
  }
  process.exit(r.report() ? 0 : 1);
}

main();
