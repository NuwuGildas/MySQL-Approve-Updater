'use strict';
/* The assistant inside a shared terminal, against the real split: the host owns
   the conversation store, this module owns the terminal and the approvals.
   These are the guarantees the original suite asserted, restated for the
   contract the module actually has now.

   No real SSH: the shell is a fake that records what it was asked to run. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTestHost } = require('./host-fixture');

function setup(t, { aiAssist = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-servers-agent-'));
  const live = new Map();
  const ran = [];
  let counter = 0;
  const profiles = {
    p1: { id: 'p1', name: 'STAGING', ssh: { enabled: true, host: 'staging.local', user: 'dev', port: 22 } },
    p2: { id: 'p2', name: 'PRODUCTION', ssh: { enabled: true, host: 'production.local', user: 'deploy', port: 22 } },
  };
  const terminals = {
    sessions: live,
    async open(profileId, { sessionId } = {}) {
      if (sessionId) {
        const existing = live.get(sessionId);
        if (!existing || existing.status !== 'open') throw Object.assign(new Error('Terminal is closed'), { status: 409 });
        if (existing.profileId !== profileId) throw Object.assign(new Error('The terminal session belongs to another server.'), { status: 409 });
        return { ...existing };
      }
      const session = { sessionId: `session-${++counter}`, profileId, status: 'open', control: 'user', revision: 0, output: 'shell ready\n', cursor: 12, busy: false };
      live.set(session.sessionId, session);
      return { ...session };
    },
    snapshot(id, { cursor = 0 } = {}) {
      if (!live.has(id)) throw Object.assign(new Error('Terminal not found'), { status: 404 });
      const session = live.get(id);
      return { ...session, output: session.output.slice(cursor) };
    },
    get: (id) => live.get(id),
    async sendCommand(id, cmd, { expectedRevision }) {
      const session = live.get(id);
      assert.equal(session.control, 'assistant');
      assert.equal(session.revision, expectedRevision);
      session.revision++;
      ran.push({ id, cmd });
      await new Promise((resolve) => setImmediate(resolve));
      return { stdout: `result for ${session.profileId}: ${cmd}\n`, stderr: '', code: 0, revision: session.revision };
    },
    async setControl(id, control) { const session = live.get(id); session.control = control; session.revision++; },
    close(id) { const session = live.get(id); session.status = 'closed'; session.revision++; },
  };
  const settings = { aiAssist: { sshRead: true, sshWrite: true, sshDestructive: true, sshMemory: true, ...aiAssist } };
  const fixture = createTestHost({ dataDir: dir, terminals, settings, profiles });
  t.after(async () => { await fixture.flush(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { ...fixture, terminals, live, ran, settings, profiles, dir };
}

const meta = (sessionId) => ({ sessionId });

test('opening a terminal creates no ambient AI context, and every command needs a handover first', async (t) => {
  const ctx = setup(t);
  const session = await ctx.agent.attach('p1', { projectId: 'project-a' });

  // With no session named, the tools refuse outright.
  await assert.rejects(ctx.agent.tools.ssh_exec.run({ cmd: 'ls' }, {}), /terminal session/);

  assert.equal(ctx.agent.tools.ssh_exec.enabled(session.sessionId), true);
  const view = await ctx.agent.tools.ssh_terminal_read.run({ cursor: 0 }, meta(session.sessionId));
  assert.match(view.output, /shell ready/);
  await assert.rejects(ctx.agent.tools.ssh_exec.run({ cmd: 'df -h' }, meta(session.sessionId)), /Hand terminal control/);

  await ctx.terminals.setControl(session.sessionId, 'assistant');
  for (const cmd of ['ls -la', 'df -h', 'rm -rf /tmp/x']) {
    const proposal = await ctx.agent.tools.ssh_exec.run({ cmd }, meta(session.sessionId));
    assert.equal(proposal.status, 'pending_user_approval', cmd);
  }
  assert.equal(ctx.ran.length, 0, 'proposing runs nothing');
});

test('approval runs the command exactly once and writes the result into that conversation', async (t) => {
  const ctx = setup(t);
  const session = await ctx.agent.attach('p1');
  await ctx.terminals.setControl(session.sessionId, 'assistant');
  await ctx.agent.tools.ssh_exec.run({ cmd: 'df -h' }, meta(session.sessionId));
  const proposal = ctx.proposals[0];

  const result = await ctx.agent.approve(proposal);
  assert.equal(result.cmd, 'df -h');
  assert.deepEqual(ctx.ran.map((r) => r.cmd), ['df -h']);
  assert.match(ctx.history(session.sessionId).at(-1).text, /Ran on "STAGING"/);

  // The seal is spent: the same card cannot run again.
  await assert.rejects(ctx.agent.approve(proposal), /no longer pending|changed/);
  assert.deepEqual(ctx.ran.map((r) => r.cmd), ['df -h']);
});

test('an approval is sealed to its session, its revision and its classification', async (t) => {
  const ctx = setup(t);
  const a = await ctx.agent.attach('p1');
  const b = await ctx.agent.attach('p2');
  await ctx.terminals.setControl(a.sessionId, 'assistant');
  await ctx.terminals.setControl(b.sessionId, 'assistant');
  await ctx.agent.tools.ssh_exec.run({ cmd: 'df -h' }, meta(a.sessionId));
  const proposal = ctx.proposals.at(-1);

  // Belongs to another server's session.
  await assert.rejects(ctx.agent.approve({ ...proposal, profileId: 'p2' }), /another terminal session/);
  // The command changed after it was proposed.
  await assert.rejects(ctx.agent.approve({ ...proposal, cmd: 'rm -rf /' }), /no longer pending|changed/);
  // The terminal moved on.
  await ctx.terminals.setControl(a.sessionId, 'assistant');
  await assert.rejects(ctx.agent.approve(proposal), /terminal changed|no longer pending/i);
  assert.equal(ctx.ran.length, 0);
});

test('permissions gate what may even be proposed', async (t) => {
  const ctx = setup(t, { aiAssist: { sshWrite: false, sshDestructive: false, sshSudo: false } });
  const session = await ctx.agent.attach('p1');
  await ctx.terminals.setControl(session.sessionId, 'assistant');
  const refusal = (input) => ctx.agent.tools.ssh_exec.run(input, meta(session.sessionId));

  assert.match((await refusal({ cmd: 'touch /tmp/x' })).reason, /Write commands are disabled/);
  assert.match((await refusal({ cmd: 'rm -rf /tmp/x' })).reason, /Destructive commands are disabled/);
  assert.match((await refusal({ cmd: 'sudo ls' })).reason, /Allow sudo/);
  assert.equal((await refusal({ cmd: 'df -h' })).status, 'pending_user_approval', 'read stays allowed');
});

test('two sessions on one server keep separate conversations and separate memory', async (t) => {
  const ctx = setup(t);
  const a = await ctx.agent.attach('p1');
  const b = await ctx.agent.attach('p1');
  ctx.push(a.sessionId, { role: 'user', text: 'private-a' });
  ctx.push(b.sessionId, { role: 'user', text: 'private-b' });
  await ctx.agent.tools.ssh_remember.run({ text: 'memory-a' }, meta(a.sessionId));

  assert.equal(ctx.history(a.sessionId).some((m) => m.text === 'private-b'), false);
  assert.equal(ctx.history(b.sessionId).some((m) => m.text === 'private-a'), false);
  const recalled = await ctx.agent.tools.ssh_recall.run({}, meta(a.sessionId));
  assert.equal(recalled.notes.some((n) => n.text === 'memory-a'), true);
  const other = await ctx.agent.tools.ssh_recall.run({}, meta(b.sessionId));
  assert.equal(other.notes.length, 0);

  const listed = await ctx.conversations.listForProfile('p1');
  assert.equal(listed.length, 2);
  assert.equal(JSON.stringify(listed).includes('private'), false, 'the list never carries conversation text');
  await assert.rejects(ctx.agent.attach('p2', { sessionId: a.sessionId }), /another server/);
});

test('the conversation outlives the terminal, and outlives this module', async (t) => {
  const ctx = setup(t);
  const session = await ctx.agent.attach('p1');
  ctx.push(session.sessionId, { role: 'user', text: 'still here' });
  ctx.terminals.close(session.sessionId);
  await ctx.agent.publish();

  // Closed: no tools, but the transcript is still readable.
  assert.equal(ctx.agent.tools.ssh_exec.enabled(session.sessionId), false);
  assert.equal(ctx.history(session.sessionId).at(-1).text, 'still here');

  // With no module publishing a view at all - the module removed - the store is
  // still readable and simply refuses to be worked in.
  ctx.conversations.setSessionView(null);
  assert.equal(ctx.conversations.history(session.sessionId).at(-1).text, 'still here');
  assert.throws(() => ctx.conversations.requireSession(session.sessionId), /not installed/);
});

test('the read-file helper produces one capped, quoted, absolute-path approval', async (t) => {
  const ctx = setup(t);
  const session = await ctx.agent.attach('p1');
  await ctx.terminals.setControl(session.sessionId, 'assistant');
  for (const filename of ['/etc/x"; rm /tmp/x', '/etc/$(touch x)', '../etc/hosts']) {
    await assert.rejects(ctx.agent.tools.ssh_read_file.run({ path: filename }, meta(session.sessionId)), /plain absolute path/);
  }
  const proposed = await ctx.agent.tools.ssh_read_file.run({ path: '/etc/hosts', lines: 900 }, meta(session.sessionId));
  assert.equal(proposed.status, 'pending_user_approval');
  assert.equal(ctx.proposals.at(-1).cmd, "head -n 400 -- '/etc/hosts' | tail -n 400");
});
