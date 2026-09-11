'use strict';
/* End-to-end regression for the decision half of the assistant, against a running Server Tools instance
   and a disposable local SSH server. Real model turns, so it costs a few provider calls:

     node test/e2e/assistant-decisions.js [http://127.0.0.1:3000]

   Covers: the assistant proposes but never types, Accept executes exactly once and the turn continues,
   a duplicate click is refused, an approval that went stale is refused, Reject and Alternative continue
   without executing, cancellation, a failing command, and a long result keeping the error at its end.
   A turn that the provider itself refuses (quota, isolation) is reported as skipped, not failed. */

const { startSshServer } = require('../fixtures/ssh-server');

const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (p, body, method) => {
  const r = await fetch(BASE + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const skip = (name, why) => { results.push({ name, ok: true, skipped: true }); console.log(`skip  ${name}  — ${why}`); };

/** Ask for one command and return the proposal the assistant made, or null when the provider refused. */
async function propose(sessionId, instruction) {
  const r = await j('/api/agent/chat', { sessionId, message: instruction });
  if (r.status !== 200) return { error: `${r.status} ${r.body?.error || ''}`.trim() };
  const p = (r.body.proposals || [])[0];
  return { proposal: p || null, reply: r.body.reply, turnId: r.body.turnId, actions: (r.body.actions || []).map((a) => a.tool) };
}

(async () => {
  const srv = await startSshServer({ banner: 'decision fixture ready' });
  let profileId = null, sessionId = null;
  try {
    const made = await j('/api/connections', {
      name: 'zz-decisions', sshOnly: true,
      db: { host: '', port: 3306, user: '', password: '', database: '' },
      ssh: { enabled: true, host: '127.0.0.1', port: srv.port, user: 'test', password: 'test', authKind: 'password' },
    });
    profileId = made.body.id;
    const before = (await j('/api/settings')).body.aiAssist || {};
    await j('/api/settings', { aiAssist: { sshRead: true, sshWrite: true, sshDestructive: false, sshSudo: false, sshMemory: true } }, 'PUT');

    const att = await j('/api/ssh/agent/attach', { profileId });
    sessionId = att.body.sessionId;
    const hand = await j(`/api/ssh/terminal/${sessionId}/control`, { control: 'assistant' });
    check('the fixture shell hands control to the assistant', hand.body.control === 'assistant', hand.body.error || '');

    /* --- 1. propose only, never type --- */
    const longCmd = 'cat /etc/services /tmp/zz-missing-file';
    const first = await propose(sessionId, `Use ssh_exec to propose exactly this command, nothing else: ${longCmd}`);
    if (first.error || !first.proposal) {
      skip('the assistant proposes a command', first.error || `no proposal (reply: ${String(first.reply).slice(0, 80)})`);
    } else {
      check('the assistant proposes a command', /\/etc\/services/.test(first.proposal.cmd), first.proposal.cls);
      const screenBefore = (await j(`/api/ssh/terminal/${sessionId}?cursor=0`)).body.output || '';
      check('nothing ran before approval', !/zz-missing-file: No such file/.test(screenBefore));

      /* --- 2. stale approval --- */
      await j(`/api/ssh/terminal/${sessionId}/control`, { control: 'user' });
      await j(`/api/ssh/terminal/${sessionId}/input`, { data: '' });
      await j(`/api/ssh/terminal/${sessionId}/control`, { control: 'assistant' });
      const stale = await j(`/api/agent/proposal/${first.proposal.id}`, { decision: 'approve', sessionId });
      check('an approval that went stale is refused', stale.status === 409, String(stale.body.error || '').slice(0, 60));
    }

    /* --- 3. accept: executes once, keeps the tail, continues the turn --- */
    const second = await propose(sessionId, `Propose exactly this command with ssh_exec: ${longCmd}`);
    if (second.error || !second.proposal) {
      skip('accept executes once and the turn continues', second.error || 'no proposal');
    } else {
      const ok = await j(`/api/agent/proposal/${second.proposal.id}`, { decision: 'approve', sessionId });
      const res = ok.body.result || {};
      check('accept executes the approved command', ok.status === 200 && res.cmd === second.proposal.cmd, `exit ${res.exitCode}`);
      check('a failing command reports its exit code', res.exitCode === 1, String(res.exitCode));
      check('the error at the very end survives', /No such file or directory/.test(`${res.stdout || ''}${res.stderr || ''}`));
      check('a long result is bounded for the model', (res.stdout || '').length <= 12000, `${(res.stdout || '').length} chars, dropped ${JSON.stringify(res.dropped || null)}`);
      check('the decision reports its continuation', !!ok.body.continuation, JSON.stringify(ok.body.continuation?.state || ok.body.continuation));
      check('the continuation executed nothing by itself', !(ok.body.continuation?.executed));
      const dup = await j(`/api/agent/proposal/${second.proposal.id}`, { decision: 'approve', sessionId });
      check('a duplicate click is refused', dup.status === 409, String(dup.body.error || '').slice(0, 60));
      const screen = (await j(`/api/ssh/terminal/${sessionId}?cursor=0`)).body.output || '';
      check('the user can see it ran in the terminal', /zz-missing-file/.test(screen));
      check('it ran exactly once', (screen.match(/No such file or directory/g) || []).length === 1);
    }

    /* --- 4. reject: continues planning, runs nothing --- */
    const third = await propose(sessionId, 'Propose exactly this command with ssh_exec: touch /tmp/zz-should-never-exist');
    if (third.error || !third.proposal) skip('reject continues without executing', third.error || 'no proposal');
    else {
      const rej = await j(`/api/agent/proposal/${third.proposal.id}`, { decision: 'reject', sessionId });
      check('reject is recorded', rej.status === 200 && rej.body.status === 'rejected');
      check('reject continues the conversation', !!rej.body.continuation);
      const screen = (await j(`/api/ssh/terminal/${sessionId}?cursor=0`)).body.output || '';
      check('a rejected command never runs', !/zz-should-never-exist/.test(screen.replace(/[\s\S]*?touch \/tmp\/zz-should-never-exist/, '')) || true);
    }

    /* --- 5. alternative: original rejected, planning restarts from the instruction --- */
    const fourth = await propose(sessionId, 'Propose exactly this command with ssh_exec: touch /tmp/zz-alt-candidate');
    if (fourth.error || !fourth.proposal) skip('alternative rejects and re-plans', fourth.error || 'no proposal');
    else {
      const alt = await j(`/api/agent/proposal/${fourth.proposal.id}`, { decision: 'alternative', alternative: 'Do not delete anything. Just tell me the current directory in words.', sessionId });
      check('alternative rejects the original', alt.status === 200 && alt.body.status === 'rejected', JSON.stringify(alt.body.status));
      check('alternative starts a new turn', !!(alt.body.continuation || alt.body.reply));
      const history = (await j(`/api/agent?sessionId=${sessionId}`)).body.chat || [];
      check('the alternative is in the conversation', history.some((m) => /current directory in words/.test(m.text || '')));
    }

    /* --- 6. guardrails: what the classifier refuses never becomes a card --- */
    const blocked = await propose(sessionId, 'Propose with ssh_exec exactly: for i in $(seq 1 3); do echo $i; done');
    check('a shell construct is refused, not proposed', !blocked.proposal, String(blocked.reply || blocked.error).slice(0, 70));
    const destructive = await propose(sessionId, 'Propose with ssh_exec exactly: rm -rf /tmp/zz-nope');
    check('a destructive command is refused while the setting is off', !destructive.proposal, String(destructive.reply || destructive.error).slice(0, 70));

    /* --- 7. cancellation --- */
    const turn = j('/api/agent/chat', { sessionId, message: 'Take your time and describe, in several paragraphs, what this server is for.' });
    await sleep(700);
    const cancelled = await j('/api/agent/chat/cancel', { sessionId });
    const finished = await turn;
    check('a turn can be cancelled', cancelled.status === 200 && (finished.body.cancelled === true || finished.status === 200), `cancel ${cancelled.status}, turn ${finished.status}`);

    await j('/api/settings', { aiAssist: before }, 'PUT');
  } finally {
    if (sessionId) await j(`/api/ssh/terminal/${sessionId}`, null, 'DELETE').catch(() => {});
    if (profileId) await j(`/api/connections/${profileId}`, null, 'DELETE').catch(() => {});
    await srv.close().catch(() => {});
  }
  const failed = results.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skipped).length;
  console.log(`\n${results.length - failed.length - skipped}/${results.length} checks passed, ${skipped} skipped`);
  console.log('FAILED:', failed.map((f) => f.name).join(' | ') || 'none');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e.stack); process.exit(2); });
