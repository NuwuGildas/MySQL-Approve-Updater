'use strict';
/* The assistant works on the page you are on.
 *
 * Handed every tool in the workspace it wanders: the same turn that reads a schema and proposes a
 * rule is also offered SSH, deployments and project management, none of which the question was
 * about. (It is also how a turn runs out of tool steps.) So the tool list follows the page, and the
 * prompt says which page that is and what it is for.
 *
 * Read from the prompt the model was handed, because that is the only thing that distinguishes a
 * tool it chose not to use from one it was never given.
 *
 * Run: node checks/workspace/assistant-page-scope.js
 */

const { startSandbox } = require('./sandbox');
const { launch, openApp, recorder, shot, until, sleep } = require('./browser');

const PORT = Number(process.env.PORT || 3124);

const toolsIn = (prompt) => {
  const block = /Available tools:\n([\s\S]*?)\nAfter a tool result/.exec(prompt || '');
  return block ? block[1].split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2).split(':')[0].trim()) : [];
};

/* Wait for the page to actually BE the one asked for. Waiting for "a page id exists" is no wait at
   all - there is always one - and the question then goes out from wherever the browser still was. */
async function goTo(page, route, id) {
  await page.evaluate((r) => { location.hash = r; }, route);
  const there = await until(page, (want) => typeof currentPageId !== 'undefined' && currentPageId === want, id, 20000);
  if (!there) throw new Error(`never reached ${route} (page is ${await page.evaluate(() => (typeof currentPageId === 'undefined' ? '?' : currentPageId))})`);
  await sleep(600);
}

async function askOn(page, s, route, id, text) {
  await goTo(page, route, id);
  s.script([{ reply: 'Noted.' }]);
  const before = s.prompts().length;
  await page.evaluate((t) => { document.getElementById('agentInput').value = t; agentSend(); }, text);
  await until(page, () => !document.body.classList.contains('agent-busy'), null, 30000);
  for (let i = 0; i < 60 && s.prompts().length === before; i++) await sleep(100);
  return s.lastPrompt();
}

async function main() {
  const s = await startSandbox({ port: PORT, servers: 1 });
  const browser = await launch();
  const r = recorder('assistant-page-scope');
  let page;
  try {
    page = await openApp(browser, s.base);
    await page.evaluate(() => { location.hash = '#/home'; });
    await sleep(600);
    await page.evaluate(() => document.getElementById('btnAiAgent').click());
    await until(page, () => !document.getElementById('agentChatWrap')?.hidden, null, 20000);

    /* ---- the page the user actually asked about ---- */
    const updates = await askOn(page, s, '#/database/updates', 'mysql', 'what rules do I have?');
    const onUpdates = toolsIn(updates);
    console.log(`  MySQL Update Tool (${onUpdates.length}): ${onUpdates.join(', ')}`);
    for (const name of ['list_rules', 'propose_rule', 'list_tables', 'get_table', 'run_sql', 'get_state']) {
      r.ok('updates', `it has ${name}`, onUpdates.includes(name), onUpdates.join(', '));
    }
    for (const name of ['ssh_exec', 'ssh_status', 'deploy_list_targets', 'propose_deploy_action', 'propose_project_change', 'list_servers']) {
      r.ok('updates', `it is NOT offered ${name}`, !onUpdates.includes(name), onUpdates.join(', '));
    }
    r.ok('updates', 'and the prompt says what the page is for',
      /MySQL Update Tool: rule-based batch updates/.test(updates), updates.split('\n')[0].slice(0, 120));
    r.ok('updates', 'and what to do about a question this page does not own',
      /say which page it is on/.test(updates));
    await shot(page, 'ps-updates');

    /* ---- somewhere else entirely ---- */
    const servers = toolsIn(await askOn(page, s, '#/servers', 'servers', 'which servers do I have?'));
    console.log(`  Servers (${servers.length}): ${servers.join(', ')}`);
    r.ok('servers', 'Servers has the server tools', servers.includes('list_servers') && servers.some((t) => t.startsWith('ssh_')), servers.join(', '));
    for (const name of ['propose_rule', 'list_rules', 'run_sql']) {
      r.ok('servers', `and not the database tool ${name}`, !servers.includes(name), servers.join(', '));
    }

    const deployments = toolsIn(await askOn(page, s, '#/deployments', 'deploy', 'what can I deploy?'));
    console.log(`  Deployments (${deployments.length}): ${deployments.join(', ')}`);
    r.ok('deployments', 'Deployments has the deploy tools', deployments.some((t) => t.startsWith('deploy_')), deployments.join(', '));
    r.ok('deployments', 'and not the rule tools', !deployments.includes('propose_rule'), deployments.join(', '));

    const projects = toolsIn(await askOn(page, s, '#/projects', 'projects', 'what projects are there?'));
    r.ok('projects', 'Projects has the project tools', projects.includes('propose_project_change'), projects.join(', '));
    r.ok('projects', 'and not the deploy ones', !projects.some((t) => t.startsWith('deploy_')), projects.join(', '));

    /* ---- Home is the workspace: everything, as before ---- */
    const home = toolsIn(await askOn(page, s, '#/home', 'home', 'what can you do?'));
    console.log(`  Home (${home.length}): ${home.join(', ')}`);
    r.ok('home', 'Home is the whole workspace, so nothing is withheld',
      home.includes('propose_rule') && home.includes('list_servers') && home.some((t) => t.startsWith('deploy_')), `${home.length} tools`);
    r.ok('home', 'and it is more than any single page', home.length > onUpdates.length && home.length > servers.length,
      `home ${home.length}, updates ${onUpdates.length}, servers ${servers.length}`);

    /* ---- the user can see the scope they are in ---- */
    await goTo(page, '#/database/updates', 'mysql');
    const chip = await page.evaluate(() => document.getElementById('agentScopeText').textContent.trim());
    r.ok('ui', 'the chip says which page the assistant is working on', /MySQL Update Tool/.test(chip), chip);
    await shot(page, 'ps-chip');

    r.ok('errors', 'no page errors were raised during the run', page.__errors.length === 0, page.__errors.slice(0, 3).join(' | '));
  } catch (e) {
    r.ok('run', 'the check completed', false, (e && e.stack) || String(e));
  } finally {
    if (page) { try { await shot(page, 'ps-final'); } catch {} }
    await browser.close().catch(() => {});
    await s.stop().catch(() => {});
  }
  process.exit(r.report() ? 0 : 1);
}

main();
