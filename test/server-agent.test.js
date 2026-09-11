'use strict';
/* The agent on the server, seen from the assistant.
 *
 * The point of it is speed: it reads the box itself instead of asking a human to
 * approve every `ls`. The point of the guardrail is that speed stops at the
 * first CHANGE - so what these tests hold is the seam between the two. Nothing
 * the remote agent says runs; everything it wants run becomes an approval card
 * under the same rules as a command the local model proposed. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestHost } = require('./host-fixture');

/** The same fake terminal the other suites use, trimmed to what this needs. */
function setup(t, { aiAssist = {}, agentAnswer = null, agentError = null } = {}) {
  const live = new Map();
  const ran = [];
  let counter = 0;
  const profiles = { p1: { id: 'p1', name: 'STAGING', ssh: { enabled: true, host: 'staging.local', user: 'dev', port: 22 } } };
  const terminals = {
    sessions: live,
    async open(profileId, { sessionId } = {}) {
      if (sessionId) return { ...live.get(sessionId) };
      const session = { sessionId: `session-${++counter}`, profileId, status: 'open', control: 'user', revision: 0, output: '', cursor: 0, busy: false };
      live.set(session.sessionId, session);
      return { ...session };
    },
    snapshot: (id, { cursor = 0 } = {}) => ({ ...live.get(id), output: String(live.get(id).output).slice(cursor) }),
    get: (id) => live.get(id),
    async sendCommand(id, cmd) { ran.push(cmd); return { stdout: '', stderr: '', code: 0, revision: live.get(id).revision }; },
    async setControl(id, control) { const s = live.get(id); s.control = control; s.revision++; },
    close(id) { const s = live.get(id); s.status = 'closed'; s.revision++; },
  };

  const asked = [];
  const remoteAgents = {
    detect: async () => ({ claude: { id: 'claude', installed: true, version: '1' }, codex: { id: 'codex', installed: false } }),
    install: async () => ({ ok: true }),
    run: async (profileId, options) => {
      asked.push({ profileId, ...options });
      if (agentError) throw agentError;
      return agentAnswer;
    },
  };

  const settings = { aiAssist: { sshRead: true, sshWrite: true, sshDestructive: false, sshMemory: true, ...aiAssist } };
  const fixture = createTestHost({ terminals, settings, profiles, remoteAgents });
  t.after(async () => { await fixture.flush(); });
  return { ...fixture, terminals, live, ran, asked, settings };
}

const answer = (commands, extra = {}) => ({
  agent: 'claude', label: 'Claude Code',
  reply: 'The disk is full because /var/log/nginx holds 40G.',
  summary: 'rotate the nginx logs',
  commands, timedOut: false, truncated: false, stderr: null, ...extra,
});

test('what the server agent found is reported, and what it wants changed becomes approval cards', async (t) => {
  const ctx = setup(t, { agentAnswer: answer([{ cmd: 'logrotate -f /etc/logrotate.d/nginx', why: 'reclaim 40G' }]) });
  const session = await ctx.agent.attach('p1');
  await ctx.terminals.setControl(session.sessionId, 'assistant');   // a card needs the terminal

  const out = await ctx.agent.tools.ssh_server_agent.run({ task: 'why is / full?' }, { sessionId: session.sessionId });

  assert.equal(out.agent, 'claude');
  assert.match(out.findings, /40G/);
  assert.equal(out.summary, 'rotate the nginx logs');
  assert.deepEqual(ctx.asked.map((a) => [a.profileId, a.task, a.serverName]), [['p1', 'why is / full?', 'STAGING']]);

  /* The card is real: pending, classified, in this session. */
  assert.equal(ctx.proposals.length, 1);
  const card = ctx.proposals[0];
  assert.equal(card.kind, 'ssh-command');
  assert.equal(card.sessionId, session.sessionId);
  assert.equal(card.cmd, 'logrotate -f /etc/logrotate.d/nginx');
  assert.match(card.why, /Claude Code: reclaim 40G/);
  assert.equal(card.status, 'pending');
  assert.equal(out.proposed[0].status, 'pending_user_approval');
  assert.match(out.note, /Nothing has run/);

  /* And nothing ran. That is the whole guarantee. */
  assert.deepEqual(ctx.ran, []);
});

test('the server agent cannot get a command past the rules the local model obeys', async (t) => {
  /* Destructive commands are off in Settings, so a destructive proposal is
     refused here exactly as it would be from the local model - the remote agent
     is not a way around the user's own permissions. */
  const ctx = setup(t, {
    aiAssist: { sshDestructive: false },
    agentAnswer: answer([
      { cmd: 'rm -rf /var/log/nginx', why: 'free space' },
      { cmd: 'df -h', why: 'confirm' },
    ]),
  });
  const session = await ctx.agent.attach('p1');
  await ctx.terminals.setControl(session.sessionId, 'assistant');
  const out = await ctx.agent.tools.ssh_server_agent.run({ task: 'clear space' }, { sessionId: session.sessionId });

  const refused = out.proposed.find((p) => p.cmd.startsWith('rm -rf'));
  assert.equal(refused.refused, true);
  assert.match(refused.reason, /Destructive commands are disabled/);

  const allowed = out.proposed.find((p) => p.cmd === 'df -h');
  assert.equal(allowed.status, 'pending_user_approval');
  assert.equal(ctx.proposals.length, 1, 'only the permitted command became a card');
  assert.deepEqual(ctx.ran, []);
});

test('it needs a live session, read permission, and an agent that is actually there', async (t) => {
  const ctx = setup(t, { agentAnswer: answer([]) });
  const session = await ctx.agent.attach('p1');

  /* No session named: the tool refuses before reaching the server. */
  await assert.rejects(ctx.agent.tools.ssh_server_agent.run({ task: 'x' }, {}), /terminal session/);

  /* Reading disabled in Settings turns it off entirely. */
  ctx.settings.aiAssist.sshRead = false;
  const off = await ctx.agent.tools.ssh_server_agent.run({ task: 'x' }, { sessionId: session.sessionId });
  assert.equal(off.refused, true);
  assert.match(off.reason, /disabled/);
  ctx.settings.aiAssist.sshRead = true;

  /* A server with no agent installed says so, and says what to do about it. */
  const bare = setup(t, { agentError: Object.assign(new Error('No coding agent is installed on "STAGING". Install Claude Code or Codex from the server\'s card first.'), { status: 409 }) });
  const other = await bare.agent.attach('p1');
  await assert.rejects(
    bare.agent.tools.ssh_server_agent.run({ task: 'x' }, { sessionId: other.sessionId }),
    (error) => error.status === 409 && /Install Claude Code or Codex/.test(error.message),
  );
});

test('a run that found nothing, timed out or was cut short still answers honestly', async (t) => {
  const ctx = setup(t, { agentAnswer: answer([], { timedOut: true, truncated: true, stderr: 'not logged in' }) });
  const session = await ctx.agent.attach('p1');
  const out = await ctx.agent.tools.ssh_server_agent.run({ task: 'look' }, { sessionId: session.sessionId });

  assert.deepEqual(out.proposed, []);
  assert.match(out.note, /proposed no changes/);
  assert.equal(out.timedOut, true);
  assert.equal(out.truncated, true);
  assert.equal(out.stderr, 'not logged in');
  assert.equal(ctx.proposals.length, 0);
});

test('the session is told which agent ran, for the audit trail', async (t) => {
  const ctx = setup(t, { agentAnswer: answer([{ cmd: 'df -h', why: 'check' }]) });
  const session = await ctx.agent.attach('p1');
  await ctx.terminals.setControl(session.sessionId, 'assistant');
  await ctx.agent.tools.ssh_server_agent.run({ task: 'disk?', agent: 'claude' }, { sessionId: session.sessionId });

  const entry = ctx.audits.find((a) => a.action === 'ai-ssh-server-agent');
  assert.equal(entry.agent, 'claude');
  assert.equal(entry.proposed, 1);
  assert.equal(entry.sessionId, session.sessionId);
  assert.equal(JSON.stringify(ctx.audits).includes('disk?'), false, 'the audit trail records no message text');
});

test('investigating needs no terminal handover; turning findings into cards does', async (t) => {
  /* Reading the server never touches the shared terminal, so the user keeps
     control while the agent looks around. A card is sealed to the terminal's
     control and revision, so it cannot be raised until control is handed over -
     and the findings are still worth having in the meantime. */
  const ctx = setup(t, { agentAnswer: answer([{ cmd: 'systemctl restart nginx', why: 'pick up the new config' }]) });
  const session = await ctx.agent.attach('p1');
  assert.equal(ctx.live.get(session.sessionId).control, 'user');

  const out = await ctx.agent.tools.ssh_server_agent.run({ task: 'is nginx healthy?' }, { sessionId: session.sessionId });
  assert.match(out.findings, /40G/, 'the investigation ran');
  assert.equal(out.proposed[0].suggested, true);
  assert.match(out.proposed[0].reason, /Hand terminal control/);
  assert.match(out.note, /hand terminal control/i);
  assert.equal(ctx.proposals.length, 0, 'nothing is approvable while the terminal is the user\'s');
  assert.deepEqual(ctx.ran, []);

  /* Hand over, ask again, and the same command becomes a real card. */
  await ctx.terminals.setControl(session.sessionId, 'assistant');
  const again = await ctx.agent.tools.ssh_server_agent.run({ task: 'is nginx healthy?' }, { sessionId: session.sessionId });
  assert.equal(again.proposed[0].status, 'pending_user_approval');
  assert.equal(ctx.proposals.length, 1);
  assert.deepEqual(ctx.ran, [], 'still nothing has run');
});
