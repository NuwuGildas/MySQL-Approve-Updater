'use strict';
/* Session UI checks (points A1–A7 of the brief, plus the project/session dual scope), driven
   against a real Server Tools instance: two fixture SSH servers, two sessions on one of them, and
   a scripted stand-in for the CLI so every turn is exact. Nothing here touches the user's data.
   Run: node checks/workspace/session-ui.js */

const { startSandbox } = require('./sandbox');
const { launch, openApp, recorder, shot, until, sleep } = require('./browser');

const PORT = Number(process.env.PORT || 3106);

/* Helpers installed in the page, so later evaluate() bodies can call them by name. */
const installHelpers = () => {
  window.chatText = () => document.getElementById('agentMessages').innerText;
  window.boundSession = () => (typeof agentSessionId === 'function' ? agentSessionId() : null);
  window.cardStates = () => [...document.querySelectorAll('.agent-proposal')].map((el) => ({
    state: el.dataset.state, id: el.dataset.proposal,
    badge: (el.querySelector('.ap-state') || {}).innerText || '',
    text: el.innerText.replace(/\s+/g, ' ').trim().slice(0, 180),
  }));
  window.pendingCard = () => document.querySelector('.agent-proposal[data-state="pending"]');
  // no decision may overlap another: the server holds ONE operation per conversation
  window.settled = () => !document.querySelector('.agent-working') && !document.body.classList.contains('agent-busy');
  window.card = (state) => [...document.querySelectorAll('.agent-proposal')].some((el) => el.dataset.state === state);
  // a connected card is titled with the REMOTE hostname, so find it by the profile name kept in
  // .srv-name[title]; the list is rebuilt on every SSE nudge, so clicking is a retry
  window.srvCard = (name) => document.querySelector(`#serversList .srv-name[title="${name}"]`)?.closest('.srv-card') || null;
  window.clickCard = (name, sel) => {
    const b = srvCard(name)?.querySelector(sel);
    if (!b) return false;
    b.click();
    return true;
  };
};

async function main() {
  const s = await startSandbox({ port: PORT, servers: 2 });
  const browser = await launch();
  const r = recorder('session-ui');
  let page;
  try {
    page = await openApp(browser, s.base);
    await page.evaluate(installHelpers);

    // WebSocket creation is not an HTTP "request": watch it on the protocol instead
    const cdp = await page.target().createCDPSession();
    await cdp.send('Network.enable');
    const sockets = [];
    cdp.on('Network.webSocketCreated', (e) => sockets.push(e.url));

    /* ---- A7: the live stream is subscribed WITH a name, so it can be re-scoped later ---- */
    const scopePosts = [];
    page.on('request', (req) => { if (req.url().includes('/api/events/scope')) scopePosts.push(req.postData() || ''); });
    const esUrl = await page.evaluate(() => sseUrl());
    r.ok('A7', 'the browser subscribes to a NAMED event stream', /[?&]stream=st-/.test(esUrl), esUrl);

    /* ---- A0: with NO server session the window is the project conversation and is usable ---- */
    await page.evaluate(() => openAgent());
    const project = await until(page, () => !document.getElementById('agentChatWrap').hidden, null, 15000);
    const projectMode = await page.evaluate(() => ({
      bound: boundSession(), disabled: document.getElementById('agentInput').disabled,
      chip: document.getElementById('agentSsh').hidden,
      empty: chatText().replace(/\s+/g, ' ').slice(0, 90),
      scope: document.getElementById('agentScopeText').textContent,
    }));
    r.ok('A0', 'with no session the assistant opens the PROJECT conversation and can be typed in',
      project && projectMode.bound === null && !projectMode.disabled && projectMode.chip, JSON.stringify(projectMode));
    s.script([{ reply: 'PROJECT-SCOPED-ANSWER for the active project.' }]);
    await page.evaluate(() => { document.getElementById('agentInput').value = 'hello with no server'; agentSend(); });
    r.ok('A0', 'a message with no session reaches the project conversation',
      await until(page, () => chatText().includes('PROJECT-SCOPED-ANSWER'), null, 25000),
      (await page.evaluate(() => chatText())).replace(/\s+/g, ' ').slice(-90));
    await shot(page, 'a0-project-conversation');

    /* ---- open a terminal on Fixture 1 through the real server card ---- */
    await until(page, () => document.querySelectorAll('#serversList .srv-card').length >= 2, null, 20000);
    await until(page, () => clickCard('Fixture 1', '[data-act="connect"]'), null, 20000);
    await until(page, () => !!srvCard('Fixture 1')?.querySelector('[data-act="terminal-menu"]'), null, 45000);
    // the cards are rebuilt on every SSE nudge, so open the menu and read it in ONE evaluate
    const menuShape = await page.evaluate(() => {
      const c = srvCard('Fixture 1');
      const t = c && c.querySelector('[data-act="terminal-menu"]');
      if (!t) return null;
      t.click();
      const m = c.querySelector('.term-dd-menu');
      return { hidden: m.hidden, items: [...m.querySelectorAll('button')].map((b) => b.dataset.act), focused: document.activeElement?.dataset?.act || null };
    });
    r.ok('A8', 'the Terminal menu leads with its two actions and focuses Terminal',
      !!menuShape && !menuShape.hidden && menuShape.items[0] === 'terminal' && menuShape.items[1] === 'terminal-ai' && menuShape.focused === 'terminal',
      JSON.stringify(menuShape));
    await until(page, () => {
      const c = srvCard('Fixture 1');
      const t = c && c.querySelector('[data-act="terminal-menu"]');
      if (!t) return false;
      const m = c.querySelector('.term-dd-menu');
      if (m.hidden) { t.click(); return false; }
      m.querySelector('[data-act="terminal"]').click();
      return true;
    }, null, 20000);
    const openedA = await until(page, () => !!boundSession() && document.querySelectorAll('.ssh-console').length === 1, null, 30000);
    r.ok('A1', 'opening a server terminal binds the chat to that session', openedA);
    const sessionA = await page.evaluate(() => boundSession());
    r.ok('A7', 'binding a session re-scopes the live stream', scopePosts.some((p) => p.includes(sessionA)),
      `${scopePosts.length} scope call(s)`);

    /* ---- A3: "New session" is a new shell AND a new conversation ---- */
    await page.evaluate(() => document.getElementById('btnWsNewSession').click());
    const openedB = await until(page, (a) => boundSession() && boundSession() !== a, sessionA, 30000);
    const sessionB = await page.evaluate(() => boundSession());
    r.ok('A3', 'starting another terminal creates a separate session', openedB && sessionA !== sessionB,
      `${String(sessionA).slice(0, 8)} → ${String(sessionB).slice(0, 8)}`);

    /* ---- A1/A6: a slow reply for session A must never paint in session B ---- */
    await page.evaluate((id) => switchAgentSession({ sessionId: id, profileId: 'srv-1', name: 'Fixture 1' }), sessionA);
    await until(page, (a) => boundSession() === a && !document.getElementById('agentChatWrap').hidden, sessionA, 15000);
    s.script([{ reply: 'LATE-REPLY-FOR-SESSION-A that must never appear in B.', delayMs: 4000 }]);
    await page.evaluate(() => { document.getElementById('agentInput').value = 'slow one please'; agentSend(); });
    await sleep(600);
    await page.evaluate((id) => switchAgentSession({ sessionId: id, profileId: 'srv-1', name: 'Fixture 1' }), sessionB);
    await sleep(7000);
    const bText = await page.evaluate(() => chatText());
    r.ok('A1', 'a reply for another session never lands in this one', !bText.includes('LATE-REPLY-FOR-SESSION-A'),
      bText.replace(/\s+/g, ' ').slice(0, 80));
    r.ok('A1', 'the composer targets the session on screen', (await page.evaluate(() => boundSession())) === sessionB);

    /* ---- A2: coming back resumes THAT session's saved conversation ---- */
    await page.evaluate((id) => switchAgentSession({ sessionId: id, profileId: 'srv-1', name: 'Fixture 1' }), sessionA);
    r.ok('A2', 'opening a session resumes its saved conversation',
      await until(page, () => chatText().includes('LATE-REPLY-FOR-SESSION-A'), null, 15000));

    /* ---- A2: a slow history load for A must not paint after the user moved to B ---- */
    let raceArmed = true;
    await page.setRequestInterception(true);
    page.on('request', async (req) => {
      try {
        if (raceArmed && req.url().includes('/api/agent?') && req.url().includes(sessionA)) await sleep(2500);
        await req.continue();
      } catch {}
    });
    await page.evaluate((id) => switchAgentSession({ sessionId: id, profileId: 'srv-1', name: 'Fixture 1' }), sessionB);
    await sleep(120);
    page.evaluate((id) => switchAgentSession({ sessionId: id, profileId: 'srv-1', name: 'Fixture 1' }), sessionA).catch(() => {});
    await sleep(250);
    await page.evaluate((id) => switchAgentSession({ sessionId: id, profileId: 'srv-1', name: 'Fixture 1' }), sessionB);
    await sleep(5000);
    const afterRace = await page.evaluate(() => ({ id: boundSession(), text: chatText() }));
    r.ok('A2', 'a slow load for the session the user left is discarded',
      afterRace.id === sessionB && !afterRace.text.includes('LATE-REPLY-FOR-SESSION-A'),
      afterRace.text.replace(/\s+/g, ' ').slice(0, 70));
    raceArmed = false;
    await page.setRequestInterception(false);

    /* ---- A5: Stop updates the view at once and discards the late reply ---- */
    s.script([{ reply: 'CANCELLED-REPLY that must be discarded.', delayMs: 4000 }]);
    await page.evaluate(() => { document.getElementById('agentInput').value = 'take your time'; agentSend(); });
    await until(page, () => !!document.querySelector('.agent-working'), null, 10000);
    await page.evaluate(() => agentCancel());
    const stoppedNow = await page.evaluate(() => ({
      note: chatText().includes('Reply stopped by the user'),
      spinner: !!document.querySelector('.agent-working'),
      busy: document.body.classList.contains('agent-busy'),
    }));
    r.ok('A5', 'Stop updates the view immediately', stoppedNow.note && !stoppedNow.spinner && !stoppedNow.busy, JSON.stringify(stoppedNow));
    await sleep(7000);
    r.ok('A5', 'the late reply for a cancelled turn is discarded', !(await page.evaluate(() => chatText())).includes('CANCELLED-REPLY'));

    /* ---- A4: approval cards. Align the visible console with the conversation first. ---- */
    await page.evaluate((id) => openSsh('srv-1', { ai: true, sessionId: id }), sessionB);
    await until(page, (b) => boundSession() === b && workspaceConsole() && workspaceConsole().sessionId === b, sessionB, 25000);
    await page.evaluate(() => document.getElementById('btnWsControl').click()); // hand the shell to the assistant
    r.ok('A4', 'the assistant can be given control from the terminal pane',
      await until(page, () => document.getElementById('wsOwner').dataset.owner === 'assistant', null, 15000));

    s.script([
      { reply: '{"tool":"ssh_exec","input":{"cmd":"echo card-check","why":"prove the card","timeoutSec":10}}' },
      { reply: 'One command is waiting for your approval.' },
    ]);
    await page.evaluate(() => { document.getElementById('agentInput').value = 'propose echo'; agentSend(); });
    const gotCard = await until(page, () => !!pendingCard(), null, 30000);
    r.ok('A4', 'a proposal renders as a pending approval card', gotCard, JSON.stringify(await page.evaluate(() => cardStates())));
    const three = await page.evaluate(() => {
      const el = pendingCard();
      return el ? { approve: !!el.querySelector('[data-dec="approve"]'), reject: !!el.querySelector('[data-dec="reject"]'), alt: !!el.querySelector('[data-alternative]') } : {};
    });
    r.ok('A4', 'the card offers Accept, Reject and Alternative', three.approve && three.reject && three.alt, JSON.stringify(three));

    // a double click must not execute twice: both clicks in the same tick
    s.script([{ reply: 'It printed card-check and exited 0.' }]);
    const beforeExec = await page.evaluate(() => document.querySelectorAll('.agent-msg.ai').length);
    await page.evaluate(() => { const b = pendingCard().querySelector('[data-dec="approve"]'); b.click(); b.click(); });
    r.ok('A4', 'the card shows "running" while the command is in the shell', await until(page, () => card('running'), null, 5000));
    const settled = await until(page, () => card('done') || card('failed'), null, 30000);
    const finalCard = (await page.evaluate(() => cardStates())).find((c) => ['done', 'failed'].includes(c.state));
    r.ok('A4', 'the card settles on "done" with the exit code',
      settled && finalCard && finalCard.state === 'done' && /done/.test(finalCard.badge) && /exit code 0/.test(finalCard.badge),
      finalCard ? `state=${finalCard.state} badge="${finalCard.badge.replace(/s+/g, ' ')}"` : 'none');
    await sleep(2500);
    const aiCount = await page.evaluate(() => document.querySelectorAll('.agent-msg.ai').length);
    r.ok('A4', 'a double click cannot execute the command twice', aiCount - beforeExec <= 1, `${beforeExec} → ${aiCount} assistant replies`);
    await shot(page, 'a4-card-done');

    await until(page, () => settled(), null, 30000); // one operation per conversation at a time
    // Reject
    s.script([{ reply: '{"tool":"ssh_exec","input":{"cmd":"echo reject-me","why":"to be rejected","timeoutSec":10}}' }, { reply: 'Waiting for you.' }]);
    await page.evaluate(() => { document.getElementById('agentInput').value = 'propose one to reject'; agentSend(); });
    await until(page, () => !!pendingCard(), null, 30000);
    s.script([{ reply: 'Understood, I will not run it.' }]);
    await page.evaluate(() => pendingCard().querySelector('[data-dec="reject"]').click());
    r.ok('A4', 'Reject marks the card rejected and nothing runs', await until(page, () => card('rejected'), null, 30000));

    await until(page, () => settled(), null, 30000);
    // Alternative (free text)
    s.script([{ reply: '{"tool":"ssh_exec","input":{"cmd":"echo alt-me","why":"to be replaced","timeoutSec":10}}' }, { reply: 'Waiting again.' }]);
    await page.evaluate(() => { document.getElementById('agentInput').value = 'propose one to replace'; agentSend(); });
    await until(page, () => !!pendingCard(), null, 30000);
    s.script([{ reply: 'Right, I will check the config first instead.' }]);
    await page.evaluate(() => {
      const el = pendingCard();
      el.querySelector('[data-alternative]').click();
      el.querySelector('.agent-alternative textarea').value = 'check the config first';
      el.querySelector('.agent-alternative').requestSubmit();
    });
    const superseded = await until(page, () => card('superseded'), null, 30000);
    await until(page, () => settled(), null, 30000); // the card supersedes at once; the turn follows
    const altText = await page.evaluate(() => chatText());
    r.ok('A4', 'Alternative supersedes the card and sends the free-text instruction',
      superseded && altText.includes('check the config first'),
      `superseded=${superseded} states=${JSON.stringify(await page.evaluate(() => cardStates().map((c) => c.state)))} tail="${altText.replace(/s+/g, ' ').slice(-120)}"`);

    await until(page, () => settled(), null, 30000);
    // Stale: taking control back bumps the terminal revision the card is sealed to
    s.script([{ reply: '{"tool":"ssh_exec","input":{"cmd":"echo stale-me","why":"to go stale","timeoutSec":10}}' }, { reply: 'Waiting.' }]);
    await page.evaluate(() => { document.getElementById('agentInput').value = 'propose one to go stale'; agentSend(); });
    await until(page, () => !!pendingCard(), null, 30000);
    await page.evaluate(() => document.getElementById('btnWsControlChat').click());
    const wentStale = await until(page, () => card('stale'), null, 20000);
    const staleCard = (await page.evaluate(() => cardStates())).find((c) => c.state === 'stale');
    r.ok('A4', 'a moved-on terminal revision marks its pending card stale', wentStale, staleCard ? staleCard.text.slice(0, 100) : 'no stale card');
    r.ok('A4', 'a card that is not pending has no live controls',
      await page.evaluate(() => [...document.querySelectorAll('.agent-proposal:not([data-state="pending"]) button')].every((b) => b.disabled)));
    await shot(page, 'a4-card-states');

    /* ---- A3: an ended session is a read-only archive with no socket ---- */
    const endedId = await page.evaluate(() => boundSession());
    const socketsBefore = sockets.length;
    await page.evaluate(() => fetch('/api/ssh/terminal/' + encodeURIComponent(agentSessionId()), { method: 'DELETE' }));
    await sleep(1200);
    await page.evaluate((id) => viewEndedSession({ sessionId: id, profileId: 'srv-1', name: 'Fixture 1' }), endedId);
    await until(page, () => document.getElementById('agentInput').disabled, null, 15000);
    await sleep(1500);
    const ended = await page.evaluate(() => ({
      input: document.getElementById('agentInput').disabled,
      send: document.getElementById('btnAgentSend').disabled,
      why: document.getElementById('agentInput').placeholder,
      kbd: document.querySelector('#agentChatWrap .ag-kbd').textContent,
      history: chatText().length,
      control: document.getElementById('btnWsControl').disabled,
      owner: document.getElementById('wsOwner').dataset.owner,
    }));
    r.ok('A3', 'an ended session disables the composer and explains why',
      ended.input && ended.send && /read-only/i.test(ended.why) && /read-only/i.test(ended.kbd), ended.kbd.slice(0, 90));
    r.ok('A3', 'an ended session still shows its saved conversation', ended.history > 60, `${ended.history} chars`);
    r.ok('A3', 'command controls are disabled with the session', ended.control && ended.owner === 'ended', JSON.stringify({ control: ended.control, owner: ended.owner }));
    r.ok('A3', 'reading an ended session opens no terminal socket', sockets.length === socketsBefore,
      `${sockets.length - socketsBefore} socket(s) opened`);
    await shot(page, 'a3-ended-session');

    // a fresh session on the same server starts empty and writable again
    await page.evaluate(() => openSsh('srv-1', { ai: true, newSession: true }));
    const fresh = await until(page, (old) => boundSession() && boundSession() !== old && !document.getElementById('agentInput').disabled, endedId, 30000);
    r.ok('A3', 'starting another terminal gives a new session with its own history',
      fresh && !(await page.evaluate(() => chatText())).includes('card-check'));

    /* ---- A0: leaving the server session returns to the project conversation ---- */
    await page.evaluate(() => sshAgentDetach());
    const backToProject = await until(page, () => boundSession() === null && !document.getElementById('agentInput').disabled, null, 20000);
    r.ok('A0', 'leaving a server session returns to the project conversation',
      backToProject && (await page.evaluate(() => chatText())).includes('PROJECT-SCOPED-ANSWER'),
      (await page.evaluate(() => chatText())).replace(/\s+/g, ' ').slice(0, 80));

    r.ok('A6', 'no page errors were raised during the run', page.__errors.length === 0, page.__errors.slice(0, 3).join(' | '));
  } catch (e) {
    r.ok('run', 'the check completed', false, (e && e.stack) || String(e));
  } finally {
    if (page) { try { await shot(page, 'a-final'); } catch {} }
    await browser.close();
    await s.stop();
  }
  process.exit(r.report() ? 0 : 1);
}

main();
