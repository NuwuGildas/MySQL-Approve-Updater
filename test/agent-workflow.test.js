'use strict';
/* The assistant's backend workflow: approval decisions that resume the same turn, one reserved
   operation per session, one completion event per turn, and the scoping that keeps one session's
   words out of another viewer's stream. No real model and no real SSH: the shared shell is a
   fake, the model is a script.

   It exercises the split the module architecture introduced: the CONVERSATION store is the host's
   (lib/shared/session-conversations, which keeps working with no module installed) and the session
   half is a stand-in module defined below. Nothing here requires a real module: the base
   application has to hold up against any of them. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { createSessionConversations } = require('../lib/shared/session-conversations');
const { createAgentWorkflow, agentEventForViewer, auditEntryForViewer, redactAuditEntry } = require('../lib/agent-workflow');

const httpError = (status, message) => Object.assign(new Error(message), { status });

/* ---------- fakes ---------- */

function fakeTerminals(state) {
  const { live, ran } = state;
  let counter = 0;
  return {
    async open(profileId) {
      const s = { sessionId: `session-${++counter}`, profileId, status: 'open', control: 'user', revision: 0, output: 'shell ready\n', cursor: 12, busy: false };
      live.set(s.sessionId, s); return { ...s };
    },
    snapshot(id, { cursor = 0 } = {}) {
      if (!live.has(id)) throw httpError(404, 'Terminal not found');
      const s = live.get(id); return { ...s, output: s.output.slice(cursor) };
    },
    get: (id) => live.get(id),
    subscribe: (id, fn) => { (state.subs[id] ||= []).push(fn); return () => {}; },
    resize() {},
    writeUser(id, data) { state.typed.push({ id, data }); return { ...live.get(id) }; },
    async sendCommand(id, cmd, { expectedRevision }) {
      const s = live.get(id);
      if (s.revision !== expectedRevision) throw httpError(409, 'Terminal moved on');
      if (state.commandFails) throw httpError(500, 'shell write failed');
      s.revision++; ran.push({ id, cmd });
      await new Promise((r) => setImmediate(r));
      return { stdout: `output of ${cmd}\n`, stderr: '', code: 0, revision: s.revision };
    },
    async setControl(id, control) { const s = live.get(id); s.control = control; s.revision++; return { ...s }; },
    close(id) { const s = live.get(id); s.status = 'closed'; s.revision++; return { ...s }; },
    sessions: live,
  };
}

/* A stand-in for a module that owns sessions: exactly the contract the host
   offers one - a tool that PROPOSES, and a proposal kind that runs what the user
   approved. Nothing here is specific to SSH; the Servers module simply happens to
   be the first thing shaped like this, and its own suite tests its own half.

   The base application must hold up against ANY such module, which is why this
   file depends on none of them. */
function createSessionModule({ host, terminals, agent }) {
  const seals = new Map();
  const seal = (p) => JSON.stringify([p.id, p.sessionId, p.cmd, p.revision]);
  const live = (id) => { try { return terminals.snapshot(id); } catch { return null; } };
  let counter = 0;

  const status = async (sessionId) => {
    if (!sessionId) return { attached: false, sessionId: null };
    const stored = await host.call('conversation.status', { sessionId });
    return { ...stored, attached: live(sessionId)?.status === 'open' && !stored.missing };
  };

  /** What the module tells the host about the sessions it owns. */
  const publish = () => {
    const view = {};
    for (const terminal of terminals.sessions.values()) {
      view[terminal.sessionId] = {
        terminal: { sessionId: terminal.sessionId, profileId: terminal.profileId, status: terminal.status, control: terminal.control, revision: terminal.revision },
        unusable: terminal.status !== 'open' ? 'This terminal session has ended. Open a new terminal on that server to continue.' : null,
      };
    }
    return host.call('sessions.publish', { sessions: view });
  };

  async function attach(profileId) {
    const terminal = await terminals.open(profileId);
    await host.call('conversation.create', {
      sessionId: terminal.sessionId,
      fields: { profileId, name: 'STAGING', host: 'staging.local', user: 'dev', port: 22 },
    });
    await host.call('conversation.push', {
      sessionId: terminal.sessionId,
      message: { role: 'note', kind: 'ssh-attach', text: 'Connected to STAGING. Every assistant command needs your approval.' },
    });
    await publish();
    return status(terminal.sessionId);
  }

  async function propose(sessionId, cmd) {
    const terminal = terminals.snapshot(sessionId);
    if (terminal.control !== 'assistant') throw httpError(409, 'Hand terminal control to the assistant before running a command.');
    const proposal = await host.call('assistant.propose', {
      id: `p${++counter}`, kind: 'ssh-command', sessionId, profileId: terminal.profileId,
      serverName: 'STAGING', cmd, cls: 'read', revision: terminal.revision, ts: new Date().toISOString(),
    });
    seals.set(proposal.id, { signature: seal(proposal), started: false });
    return { proposalId: proposal.id, sessionId, status: 'pending_user_approval', class: 'read' };
  }

  /** Every guarantee the host relies on is re-checked here, as a real module does. */
  async function approve(proposal) {
    const guard = seals.get(proposal.id);
    if (!guard || guard.started || guard.signature !== seal(proposal)) throw httpError(409, 'This approval is no longer pending or its command changed.');
    const terminal = terminals.snapshot(proposal.sessionId);
    if (terminal.revision !== proposal.revision) throw httpError(409, 'The terminal changed since this command was proposed. Request a new proposal.');
    guard.started = true;   // synchronous claim: a second simultaneous approval cannot execute
    const outcome = await terminals.sendCommand(proposal.sessionId, proposal.cmd, { expectedRevision: proposal.revision });
    const result = {
      cmd: proposal.cmd, class: proposal.cls, sessionId: proposal.sessionId,
      exitCode: outcome.code, stdout: outcome.stdout, stderr: outcome.stderr, revision: outcome.revision,
    };
    proposal.result = result;
    await host.call('conversation.push', {
      sessionId: proposal.sessionId,
      message: { role: 'note', kind: 'ssh-result', text: `Ran on "STAGING": ${proposal.cmd}\n${result.stdout}` },
    });
    await publish();
    return result;
  }

  agent.kinds['ssh-command'] = { label: (p) => p.cmd, approve };
  agent.tools.ssh_exec = {
    description: 'Propose one command in this session. It does not run until the user approves it.',
    enabled: (sessionId) => live(sessionId)?.status === 'open',
    run: async (input, meta) => {
      if (!meta?.sessionId) throw httpError(400, 'Open a server terminal session and use its assistant first.');
      return propose(meta.sessionId, String(input?.cmd || '').trim());
    },
  };
  return { attach, status, approve, publish };
}

/* A scripted model. Each entry is the raw text of one model step, in order. */
function fakeModel(script) {
  let i = 0;
  const prompts = [];
  return {
    prompts,
    get used() { return i; },
    push: (...more) => script.push(...more),
    connected: () => true,
    label: () => 'FakeModel',
    systemPrompt: () => 'SYSTEM PROMPT',
    parseToolCall: (s) => { try { const j = JSON.parse(s.trim()); return (j && typeof j.tool === 'string') ? j : null; } catch { return null; } },
    async run(prompt, opts = {}) {
      prompts.push(prompt);
      if (i >= script.length) throw new Error(`model script exhausted after ${i} steps`);
      const step = script[i++];
      const out = typeof step === 'function' ? await step(prompt, opts) : step;
      if (opts.onText) opts.onText(out);
      return out;
    },
  };
}

function setup(t, { script = [], settings: extraSettings = {}, connected = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-agent-workflow-'));
  const state = { live: new Map(), ran: [], typed: [], subs: {}, commandFails: false };
  const terminals = fakeTerminals(state);
  const agent = { tools: {}, proposals: [], kinds: {} };
  const audits = [], events = [], logs = [];
  const settings = { aiAssist: { sshRead: true, sshWrite: true, sshDestructive: true, sshSudo: false, sshMemory: false, ...extraSettings } };
  const profiles = { p1: { id: 'p1', name: 'STAGING', ssh: { enabled: true, host: 'staging.local', user: 'dev', port: 22 } } };
  /* The host side: the conversation store, and the services a worker calls back into. */
  const conversations = createSessionConversations({ dataDir: dir, httpError, proposals: () => agent.proposals });
  let published = {};
  conversations.setSessionView({ snapshot: (id) => published[id] || null });
  const hostServices = {
    'connections.get': ({ id }) => profiles[id] || null,
    'conversation.create': ({ sessionId, fields }) => conversations.create(sessionId, fields),
    'conversation.push': ({ sessionId, message }) => conversations.push(sessionId, message),
    'conversation.history': ({ sessionId }) => conversations.history(sessionId),
    'conversation.remember': ({ sessionId, note }) => conversations.remember(sessionId, note),
    'conversation.rememberCommand': ({ sessionId, entry }) => conversations.rememberCommand(sessionId, entry),
    'conversation.digest': ({ sessionId, options }) => conversations.digest(sessionId, options || {}),
    'conversation.status': ({ sessionId }) => conversations.status(sessionId),
    'conversation.listForProfile': ({ profileId }) => conversations.listForProfile(profileId),
    'conversation.has': ({ sessionId }) => conversations.has(sessionId),
    'sessions.publish': ({ sessions }) => { published = sessions; return true; },
    'assistant.propose': (proposal) => { const stored = { ...proposal, status: 'pending' }; agent.proposals.push(stored); return stored; },
    'assistant.proposals': ({ sessionId }) => agent.proposals.filter((p) => !sessionId || p.sessionId === sessionId),
    'assistant.setPromptFragment': () => true,
    'audit.record': (entry) => { audits.push(entry); return true; },
  };
  const fakeHost = {
    id: 'servers',
    call: async (method, params) => {
      if (!hostServices[method]) throw new Error('unknown host service ' + method);
      return hostServices[method](params || {});
    },
    audit: async (entry) => { audits.push(entry); },
    log() {}, emit() {},
  };
  const sshAgent = createSessionModule({ host: fakeHost, terminals, agent });

  /* The workflow only ever sees the host's conversation contract. */
  const api = {
    attach: (profileId, options) => sshAgent.attach(profileId, options),
    status: (id) => sshAgent.status(id),
    history: (id) => conversations.history(id),
    push: (id, message) => conversations.push(id, message),
    withSession: (id, fn) => { conversations.requireSession(id); return fn(); },
    noteTurn: () => {},
    isTerminal: () => true,
    flush: () => conversations.flush(),
  };
  const model = fakeModel(script);
  model.connected = () => connected;
  const workflow = createAgentWorkflow({
    httpError, audit: (e) => audits.push(e), logEvent: (level, msg) => logs.push({ level, msg }),
    emit: (payload) => events.push(payload),
    agent, sessions: api, model,
  });
  t.after(async () => { await api.flush(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { api, agent, workflow, model, terminals, state, audits, events, logs, settings };
}

/* Attach, hand the terminal to the assistant, and let the model propose one command. */
async function proposeOne(ctx, { cmd = 'df -h' } = {}) {
  const attached = await ctx.api.attach('p1');
  const sessionId = attached.sessionId;
  await ctx.terminals.setControl(sessionId, 'assistant');
  ctx.model.push(JSON.stringify({ tool: 'ssh_exec', input: { cmd } }), 'I have proposed a command for you to approve.');
  const first = await ctx.workflow.runTurn(sessionId, { message: `please run ${cmd}` });
  return { sessionId, first };
}

const completions = (events, turnId) => events.filter((e) => e.type === 'done' && (!turnId || e.turnId === turnId));

/* ---------- 2. accept / reject / alternative all resume the same conversation ---------- */

test('accept executes the approved command exactly once and resumes interpretation in the same turn', async (t) => {
  const ctx = setup(t);
  const { sessionId, first } = await proposeOne(ctx);
  assert.equal(first.outcome, 'awaiting-approval');
  assert.equal(first.proposals.length, 1);
  assert.equal(ctx.state.ran.length, 0); // proposing runs nothing

  ctx.model.push('Disk usage is 41%, nothing to do.');
  const before = ctx.events.length;
  const out = await ctx.workflow.decide(sessionId, first.proposals[0].id, { decision: 'approve' });

  assert.equal(out.decision, 'approved');
  assert.equal(out.status, 'approved');
  assert.equal(out.executed, true);
  assert.equal(out.result.cmd, 'df -h');
  assert.equal(out.continuation.state, 'completed');
  assert.equal(out.continuation.reply, 'Disk usage is 41%, nothing to do.');
  assert.equal(out.continuation.outcome, 'final');
  assert.deepEqual(ctx.state.ran.map((r) => r.cmd), ['df -h']); // executed once, and only once

  // the continuation read the result out of the conversation, without the user typing again
  const history = ctx.api.history(sessionId);
  assert.ok(history.some((m) => m.kind === 'ssh-result' && m.text.includes('output of df -h')));
  assert.equal(history.at(-1).text, 'Disk usage is 41%, nothing to do.');
  const guidance = ctx.model.prompts.at(-1);
  assert.match(guidance, /TURN GUIDANCE: the user approved/);

  // decision + continuation are one turn: one completion, one turn id
  const mine = ctx.events.slice(before);
  assert.equal(completions(mine).length, 1);
  assert.equal(completions(mine)[0].turnId, out.turnId);
  assert.ok(mine.every((e) => e.sessionId === sessionId && e.turnId === out.turnId));
});

test('the continuation may propose but never executes a second command by itself', async (t) => {
  const ctx = setup(t);
  const { sessionId, first } = await proposeOne(ctx);
  // the model wants to keep going after the result: that is a new card, not a new execution
  ctx.model.push(JSON.stringify({ tool: 'ssh_exec', input: { cmd: 'ls /var/log' } }), 'I would like to look at the logs next; approve when ready.');
  const out = await ctx.workflow.decide(sessionId, first.proposals[0].id, { decision: 'approve' });
  assert.deepEqual(ctx.state.ran.map((r) => r.cmd), ['df -h']);
  assert.equal(out.continuation.outcome, 'awaiting-approval');
  assert.equal(out.continuation.proposals.length, 1);
  assert.equal(out.continuation.proposals[0].cmd, 'ls /var/log');
  assert.equal(out.continuation.proposals[0].status, 'pending'); // still needs its own approval
});

test('reject resumes planning and executes nothing', async (t) => {
  const ctx = setup(t);
  const { sessionId, first } = await proposeOne(ctx);
  ctx.model.push('Understood, I will not run that. Shall I check the mount points instead?');
  const out = await ctx.workflow.decide(sessionId, first.proposals[0].id, { decision: 'reject' });

  assert.equal(out.decision, 'rejected');
  assert.equal(out.executed, false);
  assert.equal(out.result, null);
  assert.equal(ctx.state.ran.length, 0);
  assert.equal(out.continuation.state, 'completed');
  assert.match(out.continuation.reply, /will not run that/);
  assert.match(ctx.model.prompts.at(-1), /TURN GUIDANCE: the user rejected/);
  assert.equal(first.proposals[0].status, 'rejected');
  assert.equal(completions(ctx.events, out.turnId).length, 1);
});

test('an alternative rejects the original and starts planning from the alternative instruction', async (t) => {
  const ctx = setup(t);
  const { sessionId, first } = await proposeOne(ctx);
  ctx.model.push('Checking inodes instead, as you asked.');
  const out = await ctx.workflow.decide(sessionId, first.proposals[0].id, { decision: 'alternative', alternative: 'check inodes, not disk usage' });

  assert.equal(out.decision, 'rejected');
  assert.equal(out.executed, false);
  assert.equal(ctx.state.ran.length, 0);
  assert.equal(first.proposals[0].status, 'rejected');
  const history = ctx.api.history(sessionId);
  assert.equal(history.at(-2).role, 'user');
  assert.equal(history.at(-2).text, 'check inodes, not disk usage'); // it is conversation input, not shell bytes
  assert.equal(out.continuation.reply, 'Checking inodes instead, as you asked.');
  assert.match(ctx.model.prompts.at(-1), /TURN GUIDANCE: the user rejected your previous proposal/);
  assert.equal(completions(ctx.events, out.turnId).length, 1);
});

test('with no model connected a decision still stands and reports that it could not continue', async (t) => {
  const ctx = setup(t, { connected: false });
  const attached = await ctx.api.attach('p1');
  await ctx.terminals.setControl(attached.sessionId, 'assistant');
  const proposed = await ctx.agent.tools.ssh_exec.run({ cmd: 'uptime' }, { sessionId: attached.sessionId });
  const out = await ctx.workflow.decide(attached.sessionId, proposed.proposalId, { decision: 'alternative', alternative: 'try free -m' });
  assert.equal(out.continuation.state, 'skipped');
  assert.equal(out.continuation.reason, 'no-provider');
  assert.equal(ctx.api.history(attached.sessionId).at(-1).text, 'try free -m'); // waiting for a provider
  assert.equal(completions(ctx.events, out.turnId).length, 1);
});

/* ---------- 3. one reserved operation per session ---------- */

test('two clicks on the same card execute once; a second card cannot interleave with the first', async (t) => {
  const ctx = setup(t);
  const { sessionId, first } = await proposeOne(ctx);
  ctx.model.push('Interpreted.');
  const both = await Promise.allSettled([
    ctx.workflow.decide(sessionId, first.proposals[0].id, { decision: 'approve' }),
    ctx.workflow.decide(sessionId, first.proposals[0].id, { decision: 'approve' }),
  ]);
  assert.equal(both.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(both.find((r) => r.status === 'rejected').reason.status, 409);
  assert.deepEqual(ctx.state.ran.map((r) => r.cmd), ['df -h']);

  // a different card, clicked while the first decision is still interpreting, is refused too
  ctx.model.push(JSON.stringify({ tool: 'ssh_exec', input: { cmd: 'uptime' } }), 'Approve the next one.');
  const second = await ctx.workflow.runTurn(sessionId, { message: 'now check uptime' });
  const slow = ctx.workflow.decide(sessionId, second.proposals[0].id, { decision: 'reject' });
  await assert.rejects(() => ctx.workflow.decide(sessionId, second.proposals[0].id, { decision: 'approve' }), (e) => e.status === 409);
  ctx.model.push('Fine.');
  await slow;
});

test('a chat turn and a decision cannot run at the same time on one session', async (t) => {
  const ctx = setup(t);
  const attached = await ctx.api.attach('p1');
  const sessionId = attached.sessionId;
  let release;
  ctx.model.push(() => new Promise((r) => { release = () => r('done at last'); }));
  const running = ctx.workflow.runTurn(sessionId, { message: 'take your time' });
  await new Promise((r) => setImmediate(r));
  assert.equal(ctx.workflow.busy(sessionId), true);
  await assert.rejects(() => ctx.workflow.runTurn(sessionId, { message: 'me too' }), (e) => e.status === 409);
  release();
  await running;
  assert.equal(ctx.workflow.busy(sessionId), false); // the reservation is always given back
});

/* ---------- 4. approvals that are no longer valid ---------- */

test('an approval whose terminal has moved on is refused and runs nothing', async (t) => {
  const ctx = setup(t);
  const { sessionId, first } = await proposeOne(ctx);
  ctx.state.live.get(sessionId).revision += 1; // the user typed in the shared shell meanwhile
  const before = ctx.events.length;
  await assert.rejects(() => ctx.workflow.decide(sessionId, first.proposals[0].id, { decision: 'approve' }), (e) => e.status === 409);
  assert.equal(ctx.state.ran.length, 0);
  assert.equal(first.proposals[0].status, 'failed');
  const mine = ctx.events.slice(before);
  assert.equal(completions(mine).length, 1);
  assert.equal(completions(mine)[0].outcome, 'failed');
  assert.equal(ctx.workflow.busy(sessionId), false);
  // and the refusal is visible in the conversation, not only in the HTTP error
  assert.match(ctx.api.history(sessionId).at(-1).text, /was not completed/);
});

test('a decided card cannot be decided again', async (t) => {
  const ctx = setup(t);
  const { sessionId, first } = await proposeOne(ctx);
  ctx.model.push('Right.');
  await ctx.workflow.decide(sessionId, first.proposals[0].id, { decision: 'reject' });
  await assert.rejects(() => ctx.workflow.decide(sessionId, first.proposals[0].id, { decision: 'approve' }), (e) => e.status === 409);
  await assert.rejects(() => ctx.workflow.decide(sessionId, 'no-such-proposal', { decision: 'approve' }), (e) => e.status === 404);
  await assert.rejects(() => ctx.workflow.decide(sessionId, first.proposals[0].id, { decision: 'maybe' }), (e) => e.status === 400);
});

/* ---------- 5. exactly one completion, whatever the outcome ---------- */

test('a cancelled turn emits exactly one completion, carrying the cancelled outcome and its turn id', async (t) => {
  const ctx = setup(t);
  const attached = await ctx.api.attach('p1');
  const sessionId = attached.sessionId;
  ctx.model.push(() => {
    ctx.workflow.cancel(sessionId);
    return Promise.reject(Object.assign(new Error('stopped'), { cancelled: true }));
  });
  const out = await ctx.workflow.runTurn(sessionId, { message: 'long job' });
  assert.equal(out.cancelled, true);
  assert.equal(out.outcome, 'cancelled');
  const done = completions(ctx.events);
  assert.equal(done.length, 1);
  assert.equal(done[0].outcome, 'cancelled');
  assert.equal(done[0].turnId, out.turnId);
  assert.equal(ctx.events.find((e) => e.type === 'turn-start').turnId, out.turnId);
  assert.ok(ctx.events.every((e) => e.sessionId === sessionId && e.turnId === out.turnId));
});

test('a failing command emits exactly one completion, and a failing model does too', async (t) => {
  const ctx = setup(t);
  const { sessionId, first } = await proposeOne(ctx);
  ctx.state.commandFails = true;
  let before = ctx.events.length;
  await assert.rejects(() => ctx.workflow.decide(sessionId, first.proposals[0].id, { decision: 'approve' }));
  let mine = ctx.events.slice(before);
  assert.equal(completions(mine).length, 1);
  assert.equal(completions(mine)[0].outcome, 'failed');
  assert.equal(completions(mine)[0].turnId, mine[0].turnId);
  assert.equal(mine[0].type, 'turn-start');

  before = ctx.events.length;
  ctx.model.push(() => { throw new Error('provider exploded'); });
  await assert.rejects(() => ctx.workflow.runTurn(sessionId, { message: 'again' }), /provider exploded/);
  mine = ctx.events.slice(before);
  assert.equal(completions(mine).length, 1);
  assert.equal(completions(mine)[0].outcome, 'failed');
  assert.equal(completions(mine)[0].error, 'provider exploded');
  assert.equal(ctx.workflow.busy(sessionId), false);
});

test('a turn that ends holding an approval card says so in its completion', async (t) => {
  const ctx = setup(t);
  const { sessionId, first } = await proposeOne(ctx);
  const done = completions(ctx.events, first.turnId);
  assert.equal(done.length, 1);
  assert.equal(done[0].outcome, 'awaiting-approval');
  assert.deepEqual(done[0].proposalIds, [first.proposals[0].id]);
  assert.equal(ctx.events.filter((e) => e.type === 'turn-start' && e.turnId === first.turnId).length, 1);
  assert.ok(ctx.events.every((e) => typeof e.turnId === 'string' && e.turnId.startsWith('t-')));
});

/* ---------- 6. scoping: history, exports, live events ---------- */

test('the audit trail keeps the operational timeline and drops the words', async (t) => {
  const ctx = setup(t);
  const attached = await ctx.api.attach('p1');
  ctx.model.push('a plain answer');
  await ctx.workflow.runTurn(attached.sessionId, { message: 'a secret question about the customer database' });
  const chat = ctx.audits.filter((a) => a.action === 'ai-chat');
  assert.equal(chat.length, 2);
  for (const entry of chat) {
    assert.equal(entry.text, undefined);
    assert.equal(entry.sessionId, attached.sessionId);
    assert.ok(typeof entry.turnId === 'string');
    assert.ok(entry.chars > 0); // how much was said, never what
  }
  assert.ok(!JSON.stringify(ctx.audits).includes('secret question'));
});

test('audit reads redact conversation content and can be narrowed to one session', () => {
  const lines = [
    { ts: '1', action: 'ai-chat', sessionId: 'a', role: 'user', text: 'session A secret' },
    { ts: '2', action: 'ai-ssh-exec', sessionId: 'a', cmd: 'df -h', ok: true },
    { ts: '3', action: 'ai-chat', sessionId: 'b', role: 'assistant', reply: 'session B secret' },
    { ts: '4', action: 'ai-sql', prompt: 'show me every unpaid invoice', sql: 'SELECT 1' },
  ];
  const unscoped = lines.map((l) => auditEntryForViewer(l, null));
  assert.equal(unscoped.length, 4); // the timeline survives in full
  assert.ok(!JSON.stringify(unscoped).includes('secret'));
  assert.ok(!JSON.stringify(unscoped).includes('unpaid invoice'));
  assert.equal(unscoped[1].cmd, 'df -h');   // what ran on the box stays: that is the audit's job
  assert.equal(unscoped[3].sql, 'SELECT 1');
  assert.deepEqual(unscoped[0].redacted, ['text']);
  assert.equal(unscoped[0].textChars, 'session A secret'.length);

  const onlyA = lines.map((l) => auditEntryForViewer(l, 'a')).filter(Boolean);
  assert.deepEqual(onlyA.map((e) => e.ts), ['1', '2']);
  assert.equal(redactAuditEntry({ action: 'x' }).redacted, undefined); // untouched entries are not rewritten
});

test('live agent events reach the selected session only, and never carry another session\'s words', () => {
  const delta = { type: 'text', sessionId: 'a', turnId: 't-1', text: 'half a sentence' };
  assert.equal(agentEventForViewer(delta, 'a'), delta);
  assert.equal(agentEventForViewer(delta, 'b'), null);
  assert.equal(agentEventForViewer(delta, null), null);      // the unscoped activity view sees no prose
  assert.equal(agentEventForViewer({ type: 'text-discard', sessionId: 'a' }, null), null);

  const tool = { type: 'tool', sessionId: 'a', turnId: 't-1', tool: 'ssh_remember', input: '{"text":"private note"}' };
  const summary = agentEventForViewer(tool, null);
  assert.equal(summary.tool, 'ssh_remember');               // that something happened: yes
  assert.equal(summary.input, undefined);                   // what it said: no
  assert.equal(agentEventForViewer(tool, 'b'), null);

  const done = { type: 'done', sessionId: 'a', turnId: 't-1', outcome: 'final', reply: 'the whole answer' };
  assert.equal(agentEventForViewer(done, null).reply, undefined);
  assert.equal(agentEventForViewer(done, null).outcome, 'final');
  assert.equal(agentEventForViewer(done, 'a').reply, 'the whole answer');
  const global = { type: 'note', message: 'not session bound' };
  assert.equal(agentEventForViewer(global, 'a'), global);   // events with no session are everyone's
});

test('two sessions on one server keep separate histories, turns and completion events', async (t) => {
  const ctx = setup(t);
  const one = (await ctx.api.attach('p1')).sessionId;
  const two = (await ctx.api.attach('p1')).sessionId;
  ctx.model.push('answer for one', 'answer for two');
  const [a, b] = await Promise.all([
    ctx.workflow.runTurn(one, { message: 'question one' }),
    ctx.workflow.runTurn(two, { message: 'question two' }),
  ]);
  assert.notEqual(a.turnId, b.turnId);
  assert.equal(completions(ctx.events, a.turnId).length, 1);
  assert.equal(completions(ctx.events, b.turnId).length, 1);
  for (const e of ctx.events) assert.equal(e.sessionId, e.turnId === a.turnId ? one : two);
  assert.ok(!JSON.stringify(ctx.api.history(one)).includes('question two'));
  assert.ok(!JSON.stringify(ctx.api.history(two)).includes('question one'));
  // and an export of one session's timeline cannot show the other's
  const scoped = ctx.audits.map((x) => auditEntryForViewer(x, one)).filter(Boolean);
  assert.ok(scoped.every((x) => x.sessionId === one));
});

/* ---------- a card a module raised, described only by what crossed the bridge ---------- */

test('a proposal kind that describes no label is still decidable', async (t) => {
  /* A module's proposalKinds[kind].label() runs in that module's own process.
     A function cannot cross to the host, so what reaches the host is a handler
     with approve/reject and, at most, a label that travelled as text on the
     card. A handler with no label at all used to throw "handler.label is not a
     function" the moment the user pressed Accept - the decision failed, and the
     command the user had approved never ran. */
  const ctx = setup(t);
  const ran = [];
  ctx.agent.kinds['module-action'] = { approve: async (p) => { ran.push(p.id); return { ok: true }; } };  // no label
  const { sessionId } = await proposeOne(ctx);

  const bare = { id: 'card-bare', kind: 'module-action', sessionId, status: 'pending' };
  const described = { id: 'card-described', kind: 'module-action', sessionId, status: 'pending', label: 'restart "web-01"' };
  ctx.agent.proposals.push(bare, described);

  ctx.model.push('Done.');
  const first = await ctx.workflow.decide(sessionId, 'card-bare', { decision: 'approve' });
  assert.equal(first.decision, 'approved');
  assert.equal(first.executed, true);
  assert.deepEqual(ran, ['card-bare'], 'the approved action actually ran');

  /* The label a module did manage to send is what the transcript records. */
  ctx.model.push('Done.');
  await ctx.workflow.decide(sessionId, 'card-described', { decision: 'reject' });
  const notes = ctx.api.history(sessionId).filter((m) => m.kind === 'decision');
  assert.equal(notes.some((n) => n.text.includes('restart "web-01"')), true, JSON.stringify(notes.map((n) => n.text)));
  assert.equal(notes.some((n) => n.text.includes('module-action proposal')), true, 'and a card with no label still reads as something');
});
