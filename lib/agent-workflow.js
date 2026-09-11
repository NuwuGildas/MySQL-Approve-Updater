'use strict';
/* The assistant's turn machinery for ONE server terminal session.
   Three things live here because they are one problem - "which session does this belong to, and is
   the turn finished?" - and because server.js cannot be driven by fakes in a test:
     1. turn identity + exactly one completion event per turn, on every path;
     2. the approval decision, which resumes the SAME turn instead of leaving the model mid-thought;
     3. the scoping rules that keep one session's words out of another viewer's stream and out of
        the operational audit trail.
   A decision and the interpretation it feeds are ONE reserved operation per session, so a second
   click cannot interleave with a command that is still running or still being explained. */

const crypto = require('crypto');
const { boundText } = require('./model-output');
// Global ceiling for one serialised tool result. The head keeps the JSON's opening keys, which identify
// the result; the rest of the budget goes to the tail, where a failure states what went wrong.
const TOOL_RESULT_MAX = 12000, TOOL_RESULT_HEAD = 2000;

const MAX_STEPS = 6;          // model steps in one turn, as before
const HISTORY_WINDOW = 16;    // conversation tail sent to the model
const now = () => new Date().toISOString();
const fail = (status, message) => Object.assign(new Error(message), { status });

/* What the model is told after a decision. Kept out of the visible conversation: it steers this one
   turn, it is not something the user said. */
const GUIDANCE = {
  approve: 'TURN GUIDANCE: the user approved your proposal and the command has now run on the shared terminal; its result is the latest system note above. Interpret that result for the user in plain text. Nothing else ran. If more work is needed, propose ONE new command - it will need its own approval.',
  reject: 'TURN GUIDANCE: the user rejected your proposal. The command did NOT run and produced no output. Acknowledge that, then say what you would do instead. Any new command still needs its own approval.',
  alternative: 'TURN GUIDANCE: the user rejected your previous proposal (it did NOT run) and gave the instruction above instead. Plan from that instruction. Any command you need still requires its own approval.',
};

/* Conversation content never belongs in the operational timeline, so the audit writer is given
   lengths instead of words. These names are also stripped when reading historical entries. */
const AUDIT_CONTENT_FIELDS = ['text', 'reply', 'message', 'alternative', 'prompt'];

function redactAuditEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  let out = entry, redacted = null;
  for (const field of AUDIT_CONTENT_FIELDS) {
    if (!Object.hasOwn(entry, field)) continue;
    if (out === entry) out = { ...entry };
    const value = out[field];
    delete out[field];
    (redacted ||= []).push(field);
    if (typeof value === 'string' && out[`${field}Chars`] === undefined) out[`${field}Chars`] = value.length;
  }
  if (redacted) out.redacted = redacted;
  return out;
}

/* One audit line as a given reader may see it: null when a session-scoped view asks for it and the
   line belongs elsewhere, otherwise the line with its conversation content removed. */
function auditEntryForViewer(entry, wantSessionId) {
  if (wantSessionId && entry?.sessionId !== wantSessionId) return null;
  return redactAuditEntry(entry);
}

/* What a live 'agent' event may show a given subscriber.
   viewerSessionId === null is the unscoped activity view: it sees that something happened, never
   what was said. A subscriber scoped to another session sees nothing at all. */
const AGENT_CONTENT_TYPES = new Set(['text', 'text-discard']);
const AGENT_CONTENT_FIELDS = ['text', 'reply', 'input'];
function agentEventForViewer(data, viewerSessionId) {
  if (!data || !data.sessionId) return data;                       // not session-bound: everyone
  if (viewerSessionId) return viewerSessionId === data.sessionId ? data : null;
  if (AGENT_CONTENT_TYPES.has(data.type)) return null;             // live prose is conversation
  const summary = { ...data };
  for (const field of AGENT_CONTENT_FIELDS) delete summary[field];
  return summary;
}

function createAgentWorkflow(ctx) {
  const httpError = ctx.httpError || fail;
  const audit = ctx.audit || (() => {});
  const log = ctx.logEvent || (() => {});
  const emit = ctx.emit || (() => {});
  const { agent, sessions, model } = ctx;
  const maxSteps = ctx.maxSteps || MAX_STEPS;

  /* ONE in-flight operation per session, covering a command execution AND the continuation that
     interprets it. The claim is synchronous: nothing awaits between the check and the set. */
  const inflight = new Map(); // sessionId -> hold

  function turnEvents(hold, reason) {
    let started = false, settled = false;
    const base = () => ({ sessionId: hold.sessionId, turnId: hold.turnId });
    return {
      start() { if (started) return; started = true; emit({ ...base(), type: 'turn-start', reason: hold.reason }); },
      say(payload) { emit({ ...base(), ...payload }); },
      /* Exactly one completion per turn, whatever happened: viewers key their spinner off it and
         a turn that failed early owes one just as much as a turn that answered. */
      done(outcome, extra = {}) {
        if (settled) return false;
        settled = true;
        emit({ ...base(), ...extra, type: 'done', outcome, reason: hold.reason });
        return true;
      },
      get settled() { return settled; },
      get started() { return started; },
    };
  }

  function reserve(sessionId, phase, reason) {
    const held = inflight.get(sessionId);
    if (held) {
      throw httpError(409, held.phase === 'decision'
        ? 'This session is still applying a decision. Wait for it to finish.'
        : 'This session’s assistant is still answering. Stop it first.');
    }
    const hold = { sessionId, phase, reason, ac: new AbortController(), turnId: `t-${crypto.randomUUID()}` };
    hold.events = turnEvents(hold, reason);
    inflight.set(sessionId, hold);
    return hold;
  }
  const release = (hold) => { if (inflight.get(hold.sessionId) === hold) inflight.delete(hold.sessionId); };
  const busy = (sessionId) => inflight.has(sessionId);
  const held = (sessionId) => inflight.get(sessionId) || null;
  function cancel(sessionId) {
    const hold = inflight.get(sessionId);
    if (!hold) return null;
    hold.ac.abort();
    return { sessionId, turnId: hold.turnId, phase: hold.phase };
  }

  function buildPrompt(sessionId, { moduleNote, transcriptExtra, guidance }) {
    const recent = sessions.history(sessionId).slice(-HISTORY_WINDOW);
    return model.systemPrompt(sessionId) + (moduleNote || '') + '\n\n--- Conversation ---\n' +
      recent.map((m) => `${m.role === 'user' ? 'User' : m.role === 'note' ? 'System note' : 'Assistant'}: ${m.text}`).join('\n\n') +
      transcriptExtra + (guidance ? `\n\n${guidance}` : '') + '\n\nAssistant:';
  }

  async function turn(hold, sessionId, { message, guidance = '', moduleNote = '' }) {
    const events = hold.events, signal = hold.ac.signal;
    events.start();
    if (message) {
      sessions.push(sessionId, { role: 'user', text: message, ts: now() });
      audit({ action: 'ai-chat', sessionId, turnId: hold.turnId, role: 'user', chars: message.length });
    }
    const actions = [];
    const propBefore = new Set(agent.proposals.map((p) => p.id));
    const pendingNow = () => agent.proposals.filter((p) => !propBefore.has(p.id) && p.sessionId === sessionId && p.status === 'pending');
    const stopped = (extra = {}) => {
      sessions.push(sessionId, { role: 'note', kind: 'cancelled', text: 'Reply stopped by the user.', ts: now() });
      audit({ action: 'ai-chat-cancelled', sessionId, turnId: hold.turnId, tools: actions.map((a) => a.tool) });
      events.done('cancelled', extra);
      return { cancelled: true, outcome: 'cancelled', sessionId, turnId: hold.turnId, actions };
    };
    let transcriptExtra = '', reply = null;
    try {
      for (let step = 0; step < maxSteps; step++) {
        events.say({ type: 'step', step: step + 1, msg: `thinking with ${model.label()}` });
        const prompt = buildPrompt(sessionId, { moduleNote, transcriptExtra, guidance });
        // live typing: forward text deltas once the answer is clearly prose (a tool call starts with "{" or a fence)
        let streamed = '', streaming = false;
        const onText = (delta) => {
          streamed += delta;
          if (!streaming) {
            const lead = streamed.trimStart();
            if (!lead) return;
            if (lead.startsWith('{') || lead.startsWith('```')) return; // keep a probable tool call private until it is parsed
            if (lead.length < 8) return;
            streaming = true;
            events.say({ type: 'text', text: streamed, reset: true });
            return;
          }
          events.say({ type: 'text', text: delta });
        };
        let outRaw;
        try { outRaw = (await model.run(prompt, { signal, onText })).trim(); }
        catch (e) {
          if (e.cancelled || signal.aborted) {
            if (streaming) events.say({ type: 'text-discard' });
            log('info', 'AI chat: reply stopped by the user');
            return stopped();
          }
          if (e.truncated) { reply = 'My response was too long and got cut off before it was complete. If I was building a rule, ask me to split it into smaller rules or use fewer transforms per rule.'; break; }
          throw e;
        }
        const call = model.parseToolCall(outRaw, sessionId);
        // 'final' stays a progress marker ("no more tools, writing the answer"); the ONE completion
        // notification for a turn is always 'done', on every path including cancellation and failure.
        if (!call) { events.say({ type: 'final' }); reply = outRaw; break; }
        if (streaming) events.say({ type: 'text-discard' }); // prose turned out to wrap a tool call
        events.say({ type: 'tool', tool: call.tool, input: JSON.stringify(call.input || {}).slice(0, 140) });
        const t0 = Date.now();
        let result, ok = true;
        // Tools are told which conversation they are running in; a module's tool has no
        // other way to know, because it runs in its own process.
        try { result = await agent.tools[call.tool].run(call.input || {}, { sessionId, turnId: hold.turnId }); }
        catch (e) { ok = false; result = { error: e.message }; }
        actions.push({ tool: call.tool, input: call.input || {}, ok, ms: Date.now() - t0 });
        events.say({ type: 'tool-done', tool: call.tool, ok, ms: Date.now() - t0 });
        if (signal.aborted) return stopped(); // stopped while the tool ran: do not start another model step
        let resultStr = JSON.stringify(result);
        // Safety net only: tools that can produce a lot of text bound it themselves, honestly, before it
        // gets here (see lib/model-output). A blind head-slice would throw away the end of a long result,
        // which is exactly where a failing command puts its error and its exit code.
        resultStr = boundText(resultStr, { max: TOOL_RESULT_MAX, head: TOOL_RESULT_HEAD }).text;
        log('info', `AI agent action: ${call.tool} ${JSON.stringify(call.input || {}).slice(0, 120)} (${Date.now() - t0}ms${ok ? '' : ', FAILED'})`);
        transcriptExtra += `\n\nAssistant: ${outRaw}\n\nTool result for ${call.tool}: ${resultStr}`;
      }
    } catch (e) {
      events.done('failed', { error: e.message });
      throw e;
    }
    if (reply == null) reply = 'I hit the tool-step limit before finishing. Ask again more specifically.';
    sessions.push(sessionId, { role: 'assistant', text: reply, actions, ts: now() });
    audit({ action: 'ai-chat', sessionId, turnId: hold.turnId, role: 'assistant', chars: reply.length, tools: actions.map((a) => a.tool) });
    try { sessions.noteTurn?.(message || null, reply, sessionId); } catch {} // remember this exchange for the attached session
    const proposals = pendingNow();
    // A turn that ends holding an approval card is not finished work: say so in the one completion event.
    const outcome = proposals.length ? 'awaiting-approval' : 'final';
    events.done(outcome, { proposalIds: proposals.map((p) => p.id) });
    return { reply, actions, sessionId, turnId: hold.turnId, outcome, proposals };
  }

  /* Run one model turn. `hold` continues an operation that is already reserved (a decision); without
     it the turn reserves the session for itself. */
  async function runTurn(sessionId, options = {}) {
    const hold = options.hold || reserve(sessionId, 'turn', options.reason || 'chat');
    try {
      return await sessions.withSession(sessionId, () => turn(hold, sessionId, options));
    } finally {
      // Safety net: no path may leave a viewer waiting for a completion that never comes.
      if (hold.events.started) hold.events.done('failed');
      if (!options.hold) release(hold);
    }
  }

  /* Accept / Reject / Alternative on one approval card, followed - under the SAME reservation - by
     the model turn that interprets or replans. The continuation can propose, never execute: only
     this route executes, and only a card the user has just clicked. */
  async function decide(sessionId, proposalId, body = {}) {
    const choice = body.decision;
    if (!['approve', 'reject', 'alternative'].includes(choice)) throw httpError(400, 'Choose approve, reject, or alternative');
    const alternative = choice === 'alternative' ? String(body.alternative || '').trim() : '';
    if (choice === 'alternative' && (!alternative || alternative.length > 8000)) throw httpError(400, 'Provide an alternative instruction (up to 8000 characters)');
    const prop = agent.proposals.find((p) => p.id === proposalId);
    // A card belongs to the conversation it was raised in. Terminal cards carry that session's id; rule
    // and deploy cards are raised outside a terminal, so they belong to whichever conversation is open.
    const belongs = prop && (prop.sessionId ? prop.sessionId === sessionId : !sessions.isTerminal?.(sessionId));
    if (!belongs) throw httpError(404, 'Proposal not found in this conversation');
    if (prop.status !== 'pending') throw httpError(409, `Proposal already ${prop.status}`);
    const kind = prop.kind || 'rule';
    const handler = agent.kinds[kind];
    if (!handler) throw httpError(500, `No handler for proposal kind "${kind}"`);

    // Reserve first, then claim the card - both synchronous, so a second click finds one or the other.
    const hold = reserve(sessionId, 'decision', `decision:${choice}`);
    const decision = choice === 'approve' ? 'approved' : 'rejected';
    prop.status = choice === 'approve' ? 'executing' : 'rejected';
    hold.events.start();
    const label = kind === 'rule' ? `rule-${prop.action} proposal "${prop.rule?.name}"` : handler.label(prop);
    try {
      if (choice === 'approve') {
        const t0 = Date.now();
        hold.events.say({ type: 'tool', tool: 'decision', kind, proposalId: prop.id, input: label.slice(0, 140) });
        try { await sessions.withSession(sessionId, () => handler.approve(prop)); }
        catch (e) {
          prop.status = 'failed';
          sessions.push(sessionId, { role: 'note', kind: 'decision', text: `Command was not completed: ${e.message}`, ts: now() });
          hold.events.say({ type: 'tool-done', tool: 'decision', ok: false, ms: Date.now() - t0 });
          audit({ action: `agent-${kind}-failed`, sessionId, turnId: hold.turnId, target: prop.targetName || null, error: e.message });
          hold.events.done('failed', { error: e.message, proposalId: prop.id });
          throw e;
        }
        hold.events.say({ type: 'tool-done', tool: 'decision', ok: true, ms: Date.now() - t0 });
        prop.status = 'approved';
      } else {
        prop.status = 'rejected';
      }
      recordDecision(sessionId, hold, prop, kind, decision, label);

      const continuation = await continueAfter(sessionId, hold, choice, alternative, body.module ? `\n\nContext: the user is currently in the "${String(body.module).slice(0, 60)}" module: tailor your help to it.` : '');
      // If no turn ran, the decision itself is the whole operation and still owes one completion.
      hold.events.done(continuation.state === 'failed' ? 'failed' : 'final', { proposalId: prop.id });
      return {
        ok: true, sessionId, proposalId: prop.id, turnId: hold.turnId,
        decision, status: decision, executed: choice === 'approve',
        result: prop.result || null, continuation,
      };
    } finally {
      hold.events.done('failed'); // net: every decision emits exactly one completion
      release(hold);
    }
  }

  function recordDecision(sessionId, hold, prop, kind, decision, label) {
    if (kind === 'rule') {
      sessions.push(sessionId, {
        role: 'note', kind: 'decision', decision, proposalAction: prop.action, ruleName: prop.rule?.name,
        text: `User ${decision} the agent's rule-${prop.action} proposal "${prop.rule?.name}".`,
      });
      audit({ action: `agent-rule-${decision}`, sessionId, turnId: hold.turnId, rule: prop.rule?.name, table: prop.rule?.table, proposalAction: prop.action });
    } else {
      sessions.push(sessionId, { role: 'note', kind: 'decision', decision, proposalKind: kind, proposalAction: prop.action, targetName: prop.targetName, text: `User ${decision} the agent's ${label}.` });
      audit({ action: `agent-${kind}-${decision}`, sessionId, turnId: hold.turnId, target: prop.targetName, proposalAction: prop.action });
    }
    log(decision === 'approved' ? 'info' : 'warn', `AI agent ${label} ${decision}`);
  }

  async function continueAfter(sessionId, hold, choice, alternative, moduleNote) {
    if (!model.connected()) {
      // No provider: an alternative is still the user's next instruction, waiting for a connection.
      if (alternative) sessions.push(sessionId, { role: 'user', text: alternative, ts: now() });
      return { state: 'skipped', reason: 'no-provider', turnId: hold.turnId };
    }
    const options = { hold, guidance: GUIDANCE[choice] };
    if (choice === 'alternative') options.message = alternative;
    if (moduleNote) options.moduleNote = moduleNote;
    try {
      const body = await runTurn(sessionId, options);
      return {
        state: body.cancelled ? 'cancelled' : 'completed', turnId: body.turnId,
        outcome: body.outcome, reply: body.reply ?? null,
        actions: body.actions || [], proposals: body.proposals || [],
      };
    } catch (e) {
      // The decision itself stands (an approved command really ran); only the interpretation failed.
      log('warn', `AI agent continuation after ${choice} failed: ${e.message}`);
      return { state: 'failed', reason: e.message, turnId: hold.turnId };
    }
  }

  return { inflight, reserve, release, busy, held, cancel, runTurn, decide, GUIDANCE };
}

module.exports = { createAgentWorkflow, agentEventForViewer, auditEntryForViewer, redactAuditEntry, AUDIT_CONTENT_FIELDS, GUIDANCE, MAX_STEPS };
