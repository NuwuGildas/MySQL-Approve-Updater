'use strict';
/* The assistant's half of a shared server terminal.
 *
 * The CONVERSATION is not here. Transcripts, notes and command memory are the
 * user's data and belong to the host (lib/shared/session-conversations), so they
 * survive this module being removed and the assistant always has something to
 * read. What lives here is everything that only makes sense with a terminal:
 * classification, the approval seal, the ssh_* tools and the prompt fragment
 * describing them.
 *
 * The safety model is unchanged. Every command the assistant wants to type is an
 * approval card sealed to the terminal's revision, so an approval cannot be
 * replayed after the context moved on; reading what is already on screen does
 * not need approval; Settings decide which classes may be approved at all. */

const crypto = require('node:crypto');
const { classify } = require('./classify');
const { boundText, boundTerminalView, DEFAULTS: MODEL_LIMITS } = require('./model-output');

const DEFAULT_TIMEOUT_MS = 20000;
const MAX_TIMEOUT_MS = 120000;
const fail = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();

function createSshAgent({ host, terminals, settings, modelLimits = {}, log = () => {} }) {
  /* How much of a terminal the MODEL may be given, independent of the viewer's
     own replay budget (backend/terminal.js outputMax). */
  const limits = { ...MODEL_LIMITS };
  for (const [key, value] of Object.entries(modelLimits)) {
    if (Number.isFinite(Number(value)) && Number(value) >= 0) limits[key] = Math.trunc(Number(value));
  }
  const approvals = new Map();

  /* Conversation storage, through the host. */
  const conversation = {
    create: (sessionId, fields) => host.call('conversation.create', { sessionId, fields }),
    push: (sessionId, message) => host.call('conversation.push', { sessionId, message }),
    history: (sessionId) => host.call('conversation.history', { sessionId }),
    remember: (sessionId, note) => host.call('conversation.remember', { sessionId, note }),
    rememberCommand: (sessionId, entry) => host.call('conversation.rememberCommand', { sessionId, entry }),
    digest: (sessionId, options) => host.call('conversation.digest', { sessionId, options }),
    status: (sessionId) => host.call('conversation.status', { sessionId }),
    listForProfile: (profileId) => host.call('conversation.listForProfile', { profileId }),
    has: (sessionId) => host.call('conversation.has', { sessionId }),
  };

  const guard = () => ({
    read: !!settings().aiAssist?.sshRead,
    write: !!settings().aiAssist?.sshWrite,
    destructive: !!settings().aiAssist?.sshDestructive,
    sudo: !!settings().aiAssist?.sshSudo,
    auto: false, approvalRequired: true,
    memory: !!settings().aiAssist?.sshMemory,
  });

  const terminalSnapshot = (id, options) => { try { return terminals.snapshot(id, options); } catch { return null; } };
  const isAttached = (id) => { const t = terminalSnapshot(id); return t?.status === 'open'; };

  /** What the host may say about a session while this module owns it, including
      the prompt fragment the assistant needs before a turn in that session. */
  async function sessionView() {
    const view = {};
    for (const terminal of terminals.sessions.values()) {
      const snapshot = terminalSnapshot(terminal.sessionId);
      view[terminal.sessionId] = {
        guard: guard(),
        memory: guard().memory,
        terminal: snapshot
          ? { sessionId: terminal.sessionId, profileId: terminal.profileId, status: snapshot.status, control: snapshot.control, revision: snapshot.revision, cursor: snapshot.cursor, busy: snapshot.busy }
          : { sessionId: terminal.sessionId, status: 'closed' },
        unusable: snapshot && snapshot.status !== 'open' ? 'This terminal session has ended. Open a new terminal on that server to continue.' : null,
        prompt: await promptFragment(terminal.sessionId).catch(() => null),
      };
    }
    return view;
  }
  const publish = async () => host.call('sessions.publish', { sessions: await sessionView() }).catch(() => {});

  /** Everything the assistant needs about one session, merged with its stored half. */
  async function status(sessionId) {
    if (!sessionId) return { attached: false, sessionId: null, guard: guard() };
    const stored = await conversation.status(sessionId);
    return { ...stored, guard: guard(), attached: isAttached(sessionId) && !stored.missing };
  }

  /** Open (or re-open) a terminal for a profile and give it a conversation. */
  async function attach(profileId, options = {}) {
    const profile = await host.call('connections.get', { id: profileId });
    if (!profile?.ssh?.enabled || !profile.ssh.host) throw fail(404, 'Server with SSH configured not found.');
    if (options.sessionId) {
      if (!(await conversation.has(options.sessionId))) throw fail(404, 'Server terminal session not found.');
      await terminals.open(profileId, { sessionId: options.sessionId, cols: options.cols, rows: options.rows });
      await publish();
      return status(options.sessionId);
    }
    const terminal = await terminals.open(profileId, { cols: options.cols, rows: options.rows });
    const id = terminal.sessionId;
    await conversation.create(id, {
      profileId, projectId: options.projectId || null, name: profile.name,
      host: profile.ssh.host, user: profile.ssh.user || '', port: profile.ssh.port || 22,
    });
    await conversation.push(id, {
      role: 'note', kind: 'ssh-attach',
      text: `Connected to ${profile.name} (${profile.ssh.user || ''}@${profile.ssh.host}). This conversation belongs only to this terminal session. You control the terminal until you hand it to the assistant. Every assistant command needs your approval.`,
    });
    await host.audit({ action: 'ai-ssh-attach', sessionId: id, profileId, profile: profile.name });
    await publish();
    return status(id);
  }

  async function detach(sessionId) {
    const state = await status(sessionId);
    // Closing is handled by the terminal DELETE endpoint, not by switching chat views.
    await host.audit({ action: 'ai-ssh-detach', sessionId, profileId: state.profileId });
    return { ...state, attached: false };
  }

  /* ---- the prompt fragment the host puts in front of the model ---- */
  async function promptFragment(sessionId) {
    if (!sessionId) return '\n- No server terminal session is selected. SSH tools are unavailable.';
    const state = await status(sessionId);
    if (state.missing) return '\n- The named terminal session does not exist. SSH tools are unavailable.';
    const g = guard();
    const terminal = terminalSnapshot(sessionId);
    const lines = [
      `\n- SERVER SESSION: ${sessionId}, "${state.name}" (${state.user}@${state.host}). This conversation and every tool call belong exclusively to this terminal session.`,
      `  Shared terminal: ${terminal?.status || 'closed'}, control: ${terminal?.control || 'user'}. Read existing output with ssh_terminal_read. Ask the user to hand terminal control to the assistant before proposing a command.`,
      '  EVERY command, including informational commands, needs a separate user approval before execution. A real shared shell can redefine commands. Never claim a pending command ran or bypass a refusal.',
      `  Permissions: read=${g.read}, write=${g.write}, destructive=${g.destructive}, sudo=${g.sudo}. Approval does not override these settings.`,
      '  The user can Accept, Reject, or supply an Alternative. Treat an alternative as a new instruction and propose a new command requiring its own approval. Never use another session or server conversation.',
    ];
    if (g.memory) lines.push(`  Earlier in THIS terminal session: ${JSON.stringify(await conversation.digest(sessionId, {}))}`);
    return lines.join('\n');
  }

  /* ---- proposing and running one command ---- */
  function commandContext(sessionId) {
    const terminal = terminals.snapshot(sessionId);
    if (terminal.status !== 'open') throw fail(409, 'This terminal session is closed or belongs to another server.');
    if (terminal.control !== 'assistant') throw fail(409, 'Hand terminal control to the assistant before running a command.');
    if (terminal.busy) throw fail(409, 'Wait for the current terminal command to finish.');
    return terminal;
  }
  function permission(classified) {
    const g = guard();
    if (classified.cls === 'blocked') return classified.reason;
    if (classified.sudo && !g.sudo) return 'Allow sudo in Settings → AI assistant → Server access first.';
    if (classified.cls === 'read' && !g.read) return 'Read-only commands are disabled in Settings → AI assistant → Server access.';
    if (classified.cls === 'write' && !g.write) return 'Write commands are disabled in Settings → AI assistant → Server access.';
    if (classified.cls === 'destructive' && !g.destructive) return 'Destructive commands are disabled in Settings → AI assistant → Server access.';
    return null;
  }
  const signedFields = (p) => JSON.stringify([p.id, p.sessionId, p.profileId, p.cmd, p.cls, p.revision, p.timeoutMs]);

  async function propose(sessionId, { cmd, why, timeoutMs }) {
    const state = await status(sessionId);
    if (state.missing) throw fail(404, 'Server terminal session not found.');
    const terminal = commandContext(sessionId);
    const classified = classify(cmd);
    const refusal = permission(classified);
    if (refusal) return { refused: true, class: classified.cls, reason: refusal, hint: refusal };
    const pending = await host.call('assistant.proposals', { sessionId });
    if (pending.filter((p) => ['pending', 'executing'].includes(p.status)).length >= 30) {
      return { refused: true, reason: 'This session has 30 unresolved command approvals. Resolve them before proposing another command.' };
    }
    const proposal = await host.call('assistant.propose', {
      id: crypto.randomUUID(), kind: 'ssh-command', sessionId, profileId: state.profileId,
      projectId: state.projectId, serverName: state.name, host: state.host,
      revision: terminal.revision, cmd, cls: classified.cls,
      why: String(why || '').slice(0, 300), timeoutMs, ts: now(),
    });
    approvals.set(proposal.id, { signature: signedFields(proposal), started: false });
    await host.audit({ action: 'ai-ssh-proposed', sessionId, profileId: state.profileId, cmd, class: classified.cls });
    return {
      proposalId: proposal.id, sessionId, status: 'pending_user_approval', class: classified.cls,
      reason: classified.reason, note: 'The command has not run. The user must approve it in this terminal session.',
    };
  }

  /** Run an approved command. Every check that made it safe is re-run here. */
  async function approve(proposal) {
    const state = await status(proposal.sessionId);
    if (state.missing) throw fail(409, 'Approval belongs to a terminal session that no longer exists.');
    if (state.profileId !== proposal.profileId) throw fail(409, 'Approval belongs to another terminal session.');
    const seal = approvals.get(proposal.id);
    if (!seal || seal.started || seal.signature !== signedFields(proposal) || ['rejected', 'approved', 'failed'].includes(proposal.status)) {
      throw fail(409, 'This approval is no longer pending or its command changed.');
    }
    const terminal = commandContext(proposal.sessionId);
    if (terminal.revision !== proposal.revision) throw fail(409, 'The terminal changed since this command was proposed. Request a new proposal.');
    const classified = classify(proposal.cmd);
    const denied = permission(classified);
    if (denied || classified.cls !== proposal.cls) throw fail(409, denied || 'Command classification changed. Request a new proposal.');

    seal.started = true;   // synchronous claim: a second simultaneous approval cannot execute
    const started = Date.now();
    let outcome;
    try { outcome = await terminals.sendCommand(proposal.sessionId, proposal.cmd, { expectedRevision: proposal.revision, timeoutMs: proposal.timeoutMs }); }
    catch (error) { await conversation.rememberCommand(proposal.sessionId, { cmd: proposal.cmd, cls: proposal.cls, ok: false, error: error.message }); throw error; }

    // Tail-first: a command that failed says why on its last lines. A small head
    // survives too, because the start of stdout is often a header.
    const out = boundText(outcome.stdout, { max: limits.stdout, head: limits.head });
    const err = boundText(outcome.stderr, { max: limits.stderr, head: limits.head });
    const result = {
      cmd: proposal.cmd, class: proposal.cls, sessionId: proposal.sessionId, exitCode: outcome.code ?? null,
      stdout: out.text, stderr: err.text,
      timedOut: !!outcome.timedOut, cancelled: !!outcome.cancelled, ms: Date.now() - started, revision: outcome.revision,
    };
    if (out.dropped || err.dropped) result.dropped = { stdout: out.dropped, stderr: err.dropped };
    if (outcome.truncated) result.captureTruncated = true;
    const ok = outcome.code === 0 && !outcome.timedOut && !outcome.cancelled;
    await conversation.rememberCommand(proposal.sessionId, { cmd: proposal.cmd, cls: proposal.cls, ok, code: result.exitCode });
    await conversation.push(proposal.sessionId, {
      role: 'note', kind: 'ssh-result',
      text: `Ran on "${state.name}": \`${proposal.cmd}\`\nexit ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}${result.cancelled ? ' (interrupted)' : ''}\n${[result.stdout, result.stderr].filter(Boolean).join('\n').slice(-1500)}`,
    });
    proposal.result = result;   // the card shows what its command produced
    await host.audit({ action: 'ai-ssh-exec', sessionId: proposal.sessionId, profileId: state.profileId, cmd: proposal.cmd, class: proposal.cls, ok, exitCode: result.exitCode });
    await publish();
    return result;
  }

  /* ---- the tools the assistant may call, all bound to one session ---- */
  const enabled = (sessionId) => !!sessionId && isAttached(sessionId);
  const requireLive = (meta) => {
    const sessionId = meta?.sessionId;
    if (!sessionId) throw fail(400, 'Open a server terminal session and use its assistant first.');
    return sessionId;
  };

  const commandTool = {
    description: 'Propose ONE command in this exact shared terminal. Input: {"cmd":"df -h","why":"disk check","timeoutSec":20}. EVERY command needs Accept/Reject/Alternative in this session, including read commands. pending_user_approval means it has not run. Requires user handoff of terminal control.',
    enabled, run: async (input, meta) => propose(requireLive(meta), {
      cmd: String(input?.cmd || '').trim(), why: input?.why,
      timeoutMs: Math.min(MAX_TIMEOUT_MS, Math.max(1000, (Number(input?.timeoutSec) || DEFAULT_TIMEOUT_MS / 1000) * 1000)),
    }),
  };

  const tools = {
    ssh_status: {
      description: 'Read metadata, permissions and ownership for this terminal session only.',
      enabled, run: async (input, meta) => status(requireLive(meta)),
    },
    ssh_terminal_read: {
      description: 'Read output already in this shared terminal. Input: {"cursor":0}. Returns output, cursor, status, control, revision and busy. A long read keeps the most recent output only, reports "dropped", and moves "baseCursor" to the first character returned; read again from "cursor" to follow along. Does not send input or execute commands.',
      enabled,
      run: async (input, meta) => {
        const sessionId = requireLive(meta);
        if (!guard().read) return { refused: true, reason: 'Terminal output read access is disabled.' };
        const cursor = input?.cursor == null ? undefined : Number(input.cursor);
        if (cursor != null && (!Number.isSafeInteger(cursor) || cursor < 0)) throw fail(400, 'cursor must be a nonnegative integer.');
        return boundTerminalView(terminals.snapshot(sessionId, { cursor }), { max: limits.terminalRead });
      },
    },
    ssh_exec: commandTool,
    ssh_terminal_command: commandTool,
    ssh_read_file: {
      description: 'Propose reading a file through the shared terminal. Input: {"path":"/etc/hosts","lines":200,"from":1}. Requires approval because shell commands can be redefined. Maximum 400 lines.',
      enabled,
      run: async (input, meta) => {
        const sessionId = requireLive(meta);
        const filename = String(input?.path || '').trim();
        if (!filename.startsWith('/') || /[\x00-\x1f\x7f'"$`\\(){}<>|;&]/.test(filename)) throw fail(400, 'Use a plain absolute path without quotes, substitutions or shell operators.');
        const from = Math.min(1000000, Math.max(1, Math.floor(Number(input?.from) || 1)));
        const lines = Math.min(400, Math.max(1, Math.floor(Number(input?.lines) || 200)));
        return propose(sessionId, { cmd: `head -n ${from + lines - 1} -- '${filename}' | tail -n ${lines}`, why: `Read ${filename}`, timeoutMs: DEFAULT_TIMEOUT_MS });
      },
    },
    ssh_recall: {
      description: 'Recall notes and command history from THIS terminal session only. Input: {"query":"nginx","limit":10}.',
      enabled,
      run: async (input, meta) => {
        const sessionId = requireLive(meta);
        if (!guard().memory) return { refused: true, reason: 'Session memory is disabled.' };
        const query = String(input?.query || '').toLowerCase();
        const limit = Math.min(30, Math.max(1, Number(input?.limit) || 10));
        const digest = await conversation.digest(sessionId, { notes: 60, commands: 40 });
        return {
          sessionId,
          notes: digest.notes.filter((n) => !query || String(n.text).toLowerCase().includes(query)).slice(-limit),
          commands: digest.commands.filter((c) => !query || String(c.cmd).toLowerCase().includes(query)).slice(-limit),
        };
      },
    },
    ssh_remember: {
      description: 'Store a note in THIS terminal session only. Input: {"text":"nginx serves /var/www/shop"}.',
      enabled,
      run: async (input, meta) => {
        const sessionId = requireLive(meta);
        if (!guard().memory) return { refused: true, reason: 'Session memory is disabled.' };
        const text = String(input?.text || '').trim().slice(0, 500);
        if (!text) throw fail(400, 'text is required');
        await conversation.remember(sessionId, { kind: 'fact', role: 'assistant', text });
        return { stored: true, sessionId };
      },
    },
  };

  return {
    attach, detach, status, promptFragment, propose, approve, publish, guard,
    listForProfile: (profileId) => conversation.listForProfile(profileId),
    tools, classify, conversation,
  };
}

module.exports = { createSshAgent, classify };
