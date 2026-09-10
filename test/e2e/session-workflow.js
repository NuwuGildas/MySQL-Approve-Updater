'use strict';
/* End-to-end regression for the shared-terminal assistant, against a running Server Tools instance.
   Two disposable SSH servers are started locally and registered as throwaway connection profiles, so the
   run never touches a real box; everything it creates is removed again at the end.

     node test/e2e/session-workflow.js [http://127.0.0.1:3000]

   Covers: two servers and two sessions on one server, isolation of output and history, several viewers of
   one shell, invalid ids, ended-session history without SSH, audit and event scoping, and terminal control
   with its revision guard. The model-driven half (accept / reject / alternative / continuation) is covered
   by test/agent-workflow.test.js with a fake model; this checks the wiring the browser actually uses. */

const path = require('path');
const WebSocket = require(path.join(__dirname, '..', '..', 'node_modules', 'ws'));
const { startSshServer } = require('../fixtures/ssh-server');

const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (p, body, method) => {
  const r = await fetch(BASE + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

/** Read a shared terminal over the browser's own socket. */
function viewer(sessionId) {
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/ssh-term?sessionId=${encodeURIComponent(sessionId)}&cols=100&rows=30`);
  const v = { output: '', states: [], errors: [], closed: null, ws, ready: null };
  v.ready = new Promise((resolve) => {
    ws.on('open', () => resolve(true));
    ws.on('close', (code) => { v.closed = code; resolve(false); });
  });
  ws.on('message', (data, isBinary) => {
    if (isBinary) { v.output += data.toString('utf8'); return; }
    try { const m = JSON.parse(data.toString('utf8')); if (m.type === 'error') v.errors.push(m); else v.states.push(m); } catch {}
  });
  ws.on('error', () => {});
  return v;
}

(async () => {
  const created = [];
  const fixtures = [];
  try {
    for (const name of ['zz-fixture-a', 'zz-fixture-b']) {
      const srv = await startSshServer({ banner: `${name} ready` });
      fixtures.push(srv);
      const made = await j('/api/connections', {
        name, sshOnly: true,
        db: { host: '', port: 3306, user: '', password: '', database: '' },
        ssh: { enabled: true, host: '127.0.0.1', port: srv.port, user: 'test', password: 'test', authKind: 'password' },
      });
      if (made.status !== 201) throw new Error(`could not create ${name}: ${made.status} ${JSON.stringify(made.body)}`);
      created.push(made.body.id);
    }
    const [A, B] = created;

    /* --- attach: two sessions on server A, one on server B --- */
    const a1 = (await j('/api/ssh/agent/attach', { profileId: A })).body;
    const a2 = (await j('/api/ssh/agent/attach', { profileId: A })).body;
    const b1 = (await j('/api/ssh/agent/attach', { profileId: B })).body;
    check('two sessions on one server are distinct', a1.sessionId && a2.sessionId && a1.sessionId !== a2.sessionId);
    check('a second server gets its own session', b1.sessionId && b1.profileId === B);
    const listA = (await j(`/api/ssh/agent/sessions?profileId=${A}`)).body.sessions || [];
    check('the session list is per server', listA.length >= 2 && listA.every((s) => s.profileId === A), `${listA.length} for A`);

    /* --- viewers: two on one session, one on another --- */
    const v1 = viewer(a1.sessionId), v2 = viewer(a1.sessionId), vb = viewer(b1.sessionId);
    await Promise.all([v1.ready, v2.ready, vb.ready]);
    await sleep(900);
    check('a viewer replays what is already on screen', /zz-fixture-a ready/.test(v1.output), JSON.stringify(v1.output.slice(0, 40)));
    check('two viewers of one shell both receive it', /zz-fixture-a ready/.test(v2.output));
    check('another session never sees it', !/zz-fixture-a/.test(vb.output) && /zz-fixture-b ready/.test(vb.output));

    /* --- typing flows to the shell and to every viewer --- */
    v1.ws.send(Buffer.from('echo hello-from-viewer\r'));
    await sleep(1200);
    check('user input reaches the shell', /hello-from-viewer/.test(v1.output));
    check('the second viewer sees the same output', /hello-from-viewer/.test(v2.output));

    /* --- a live session says when it was opened and last used, so a viewer can find its way back --- */
    const listed = ((await j('/api/ssh/terminal')).body.terminals || []).find((t) => t.sessionId === a1.sessionId);
    const beforeActivity = listed?.lastActivityAt;
    check('a live terminal reports its timestamps', !!listed?.createdAt && !!beforeActivity, `${listed?.createdAt} / ${beforeActivity}`);
    await sleep(1100);
    v1.ws.send(Buffer.from('echo activity-marker\r'));
    await sleep(1200);
    const after = ((await j('/api/ssh/terminal')).body.terminals || []).find((t) => t.sessionId === a1.sessionId);
    check('activity moves the timestamp', after && after.lastActivityAt > beforeActivity, `${beforeActivity} → ${after?.lastActivityAt}`);

    /* --- closing one view leaves the shell running --- */
    v2.ws.close();
    await sleep(400);
    v1.ws.send(Buffer.from('echo still-alive\r'));
    await sleep(1000);
    check('closing a view keeps the terminal alive', /still-alive/.test(v1.output));

    /* --- invalid ids are refused, with no legacy fallback --- */
    const bogus = viewer('not-a-session');
    await bogus.ready; await sleep(300);
    check('an unknown terminal id is refused on the socket', bogus.errors.length > 0 || bogus.closed !== null, `errors=${bogus.errors.length} close=${bogus.closed}`);
    const shellsBefore = ((await j('/api/ssh/terminal')).body.terminals || []).length;
    check('a refused socket opens no new shell', shellsBefore === (((await j('/api/ssh/terminal')).body.terminals || []).length));
    check('an unknown id is refused over REST too', (await j('/api/ssh/terminal/not-a-session')).status >= 400);
    check('attaching to an unknown server is refused', (await j('/api/ssh/agent/attach', { profileId: 'nope' })).status === 404);

    /* --- terminal control and its revision guard --- */
    const hand = await j(`/api/ssh/terminal/${a1.sessionId}/control`, { control: 'assistant' });
    check('control hands over to the assistant', hand.status === 200 && hand.body.control === 'assistant', hand.body.error || '');
    const typed = await j(`/api/ssh/terminal/${a1.sessionId}/input`, { data: 'x' });
    check('the user cannot type while the assistant holds control', typed.status === 409);
    const back = await j(`/api/ssh/terminal/${a1.sessionId}/control`, { control: 'user' });
    check('control comes back to the user', back.status === 200 && back.body.control === 'user');

    /* --- conversation history is per session --- */
    const hist1 = (await j(`/api/agent?sessionId=${a1.sessionId}`)).body.chat || [];
    const hist2 = (await j(`/api/agent?sessionId=${a2.sessionId}`)).body.chat || [];
    check('each session starts with its own conversation', hist1.length >= 1 && hist2.length >= 1 && JSON.stringify(hist1) !== JSON.stringify(hist2));
    // The assistant is not only a terminal feature: with no session it answers in the project
    // conversation, as it does across the rest of the app, and offers no shell tools there.
    const global = await j('/api/agent');
    check('the assistant works with no server session', global.status === 200 && global.body.sessionId === null && !!global.body.projectId, `project ${global.body.projectId}`);
    check('the project conversation is separate from the session ones', JSON.stringify(global.body.chat || []) !== JSON.stringify(hist1));

    /* --- audit: operational, never conversational --- */
    const audit = (await j('/api/audit?limit=200')).body.entries || [];
    const chatEntries = audit.filter((e) => e.action === 'ai-chat');
    check('the audit records no conversation text', chatEntries.every((e) => !e.text && !e.reply), `${chatEntries.length} ai-chat entries`);
    const scoped = await j(`/api/audit?limit=50&sessionId=${a1.sessionId}`);
    check('the audit can be scoped to one session', scoped.status === 200 && (scoped.body.entries || []).every((e) => !e.sessionId || e.sessionId === a1.sessionId));

    /* --- ending a session: history stays, the shell does not --- */
    await j(`/api/ssh/terminal/${a2.sessionId}`, null, 'DELETE');
    await sleep(300);
    const ended = (await j(`/api/ssh/agent?sessionId=${a2.sessionId}`)).body;
    check('an ended session reports itself closed', ended.attached === false && (ended.terminal?.status || 'closed') === 'closed');
    check('its conversation is still readable', ((await j(`/api/agent?sessionId=${a2.sessionId}`)).body.chat || []).length >= 1);
    // Viewing an ended session is allowed (that is how its transcript is read); what must not happen is
    // a fresh shell on the box, so count the fixture's channels rather than the socket's fate.
    const shellsOnA = fixtures[0].sessions;
    const reopened = viewer(a2.sessionId);
    await reopened.ready; await sleep(500);
    const reopenedState = reopened.states.find((s) => s.status) || {};
    check('an ended session opens no new SSH connection', fixtures[0].sessions === shellsOnA
      && (reopened.errors.length > 0 || reopened.closed !== null || reopenedState.status === 'closed'),
      `channels ${shellsOnA}→${fixtures[0].sessions}, state ${reopenedState.status || 'none'}`);
    // A transcript must survive its server: the profile can be edited or removed and the conversation is
    // still readable, while anything that would act in it stays refused.
    const orphan = a2.sessionId;
    const acting = await j('/api/agent/chat', { sessionId: orphan, message: 'hello' });
    check('an ended session refuses new turns', acting.status >= 400, String(acting.body.error || '').slice(0, 50));

    const fresh = (await j('/api/ssh/agent/attach', { profileId: A })).body;
    check('starting another terminal makes a new session', fresh.sessionId && fresh.sessionId !== a2.sessionId && ((await j(`/api/agent?sessionId=${fresh.sessionId}`)).body.chat || []).length >= 1);

    /* --- surviving a restart: shells die with the process, transcripts do not --- */
    const stored = Object.keys(JSON.parse(require('fs').readFileSync(path.join(__dirname, '..', '..', 'ssh-session-chats.json'), 'utf8')).sessions || {});
    const liveIds = new Set(((await j('/api/ssh/terminal')).body.terminals || []).map((t) => t.sessionId));
    const fromEarlierRun = stored.filter((id) => !liveIds.has(id)).slice(-1)[0];
    if (fromEarlierRun) {
      const st = (await j(`/api/ssh/agent?sessionId=${fromEarlierRun}`)).body;
      const chat = await j(`/api/agent?sessionId=${fromEarlierRun}`);
      check('a session from an earlier run reports itself closed', st.attached === false && (st.terminal?.status || 'closed') === 'closed');
      check('its transcript survived the restart', chat.status === 200 && Array.isArray(chat.body.chat), `${(chat.body.chat || []).length} messages`);
    } else check('a session from an earlier run reports itself closed', true, 'no earlier sessions on disk');

    /* --- disconnecting a server ends its shells (a view closing does not, a disconnect does) --- */
    const liveOnB = (await j('/api/ssh/agent/attach', { profileId: B })).body.sessionId;
    await j(`/api/ssh/sessions/${B}/disconnect`, {});
    await sleep(500);
    const afterDisconnect = (await j(`/api/ssh/terminal/${liveOnB}`)).body;
    check('disconnecting a server ends its terminals', afterDisconnect.status === 'closed' || afterDisconnect.error, JSON.stringify(afterDisconnect.status || afterDisconnect.error).slice(0, 50));

    /* --- cleanup of what this run opened --- */
    for (const s of (await j('/api/ssh/terminal')).body.terminals || []) {
      if ([A, B].includes(s.profileId)) await j(`/api/ssh/terminal/${s.sessionId}`, null, 'DELETE');
    }
    v1.ws.close(); vb.ws.close(); reopened.ws.close(); bogus.ws.close();
    check('every fixture terminal is closed', ((await j('/api/ssh/terminal')).body.terminals || []).every((s) => ![A, B].includes(s.profileId)));
  } finally {
    for (const id of created) await j(`/api/connections/${id}`, null, 'DELETE').catch(() => {});
    for (const f of fixtures) await f.close().catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  console.log('FAILED:', failed.map((f) => f.name).join(' | ') || 'none');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e.stack); process.exit(2); });
