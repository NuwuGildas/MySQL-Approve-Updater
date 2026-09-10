'use strict';
/* One assistant conversation per shared SSH terminal. AsyncLocalStorage captures a session for
   the entire model turn, so a tab switch cannot move a tool call or reply to another server.
   The terminal is a real, user-controlled shell: even `ls` can be a user-defined function.
   Consequently all AI command input needs approval; reading existing output does not. */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { boundText, boundTerminalView, DEFAULTS: MODEL_LIMITS } = require('./model-output');

const FILE_NAME = 'ssh-session-chats.json';
const CMD_MAX = 2000;
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_TIMEOUT_MS = 120000;
const MAX_MESSAGES = 200;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;
const now = () => new Date().toISOString();
const copy = (value) => JSON.parse(JSON.stringify(value));
const fail = (status, message) => Object.assign(new Error(message), { status });

// This is an informational, conservative allowlist, never an authorization to type into a shell.
const SIMPLE_READ = new Set(['cat', 'head', 'tail', 'ls', 'dir', 'stat', 'file', 'readlink', 'realpath',
  'dirname', 'basename', 'grep', 'egrep', 'fgrep', 'cut', 'tr', 'uniq', 'wc', 'cmp', 'od', 'md5sum',
  'sha1sum', 'sha256sum', 'df', 'du', 'free', 'uptime', 'uname', 'whoami', 'id', 'groups', 'who', 'w',
  'arch', 'nproc', 'ps', 'pgrep', 'pidof', 'lsof', 'netstat', 'ss', 'lsblk', 'lscpu', 'lsmem',
  'lsusb', 'lspci', 'which', 'whereis', 'printenv', 'true', 'false']);
const INTERACTIVE = new Set(['vi', 'vim', 'nvim', 'nano', 'emacs', 'pico', 'ed', 'top', 'htop', 'tmux',
  'screen', 'ssh', 'scp', 'sftp', 'telnet', 'ftp', 'su', 'passwd', 'visudo', 'login']);

function tokens(segment) {
  const result = []; let word = '', quote = null, started = false;
  for (const char of segment) {
    if (quote) { if (char === quote) quote = null; else word += char; started = true; }
    else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) result.push(word); word = ''; started = false; }
    else { word += char; started = true; }
  }
  if (quote) return null;
  if (started) result.push(word);
  return result;
}

function classify(raw) {
  const line = String(raw || '').trim();
  const result = (cls, reason, sudo = false) => ({ cls, reason, sudo, segments: [line] });
  if (!line || line.length > CMD_MAX || /[\r\n\x00-\x1f\x7f]/.test(line)) return result('blocked', 'Use one command of at most 2000 characters, without control characters.');
  let sudo = /\bsudo\b/.test(line);
  // Shell expansion, escaped tokens, control constructs and wrappers cannot be proven read-only.
  // Refusing these also prevents hiding a destructive operation behind a write-only permission.
  if (/[$`\\(){}]/.test(line)) return result('blocked', 'Shell substitutions, escaping and control constructs require the user terminal.', sudo);
  if (/&\s*$/.test(line) || /\|\s*(?:sudo\s+)?(?:ba|da|z)?sh\b/.test(line)) return result('blocked', 'Background commands and piping into a shell require the user terminal.', sudo);
  const destructive = /\b(?:rm|rmdir|unlink|shred|truncate|wipefs|mkfs(?:\.\w+)?|fdisk|parted|dd|shutdown|reboot|halt|poweroff|userdel|groupdel|deluser|delgroup)\b|\b(?:drop|truncate)\s+(?:database|table|schema)\b|\b(?:flushall|flushdb)\b|\b(?:prune|purge|autoremove)\b|\breset\s+--hard\b|\bclean\s+-[^\s]*[fdx]|\bdelete\b|\binit\s+[06]\b|\bchmod\s+(?:-R\s+)?777\b|\bcrontab\s+-r\b|\bfind\b.*-delete\b/i;
  if (destructive.test(line)) return result('destructive', 'This command can remove data, permissions, services or system state.', sudo);
  // Split conservatively, including operators inside quotes: uncertain cases become write/blocked.
  const segments = line.split(/\s*(?:&&|\|\||[;|])\s*/);
  let cls = 'read', reason = 'Known informational command.';
  for (const segment of segments) {
    const words = tokens(segment);
    if (!words || !words.length) return result('blocked', 'Unbalanced quotes or empty shell segment.', sudo);
    let bin = words[0], args = words.slice(1);
    // Quoting may concatenate a command name (`su''do`, `r''m`). Classify decoded words too.
    if (bin.split('/').pop() === 'sudo') { sudo = true; bin = 'sudo'; }
    if (bin === 'sudo') {
      // Options can change sudo behavior; require a plain prefix with an identifiable command.
      if (!args[0] || args[0].startsWith('-')) return result('blocked', 'Use sudo followed directly by a command, without sudo options.', true);
      bin = args[0]; args = args.slice(1);
    }
    if (destructive.test([bin, ...args].join(' '))) return result('destructive', 'This command can remove data, permissions, services or system state.', sudo);
    if (INTERACTIVE.has(bin) || (['bash', 'sh', 'dash', 'zsh', 'python', 'python3', 'node', 'mysql', 'psql'].includes(bin) && !args.length)) return result('blocked', `${bin} requires the user-controlled terminal.`, sudo);
    if (['env', 'command', 'exec', 'eval', 'xargs', 'watch', 'timeout', 'nohup', 'bash', 'sh', 'dash', 'zsh', 'awk', 'gawk', 'sed', 'perl', 'python', 'python3', 'node', 'ruby', 'php'].includes(bin) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(bin)) {
      if (['python', 'python3', 'node', 'ruby', 'php'].includes(bin) && args.length === 1 && ['-v', '-V', '--version', '--help'].includes(args[0])) continue;
      return result('blocked', 'Command wrappers, scripts and interpreters must be run by the user in the terminal.', sudo);
    }
    let read = SIMPLE_READ.has(bin);
    if (bin === 'rg') read = !args.some((a) => /^(--pre(?:=|$)|--hostname-bin(?:=|$)|--search-zip$)/.test(a));
    if (bin === 'find') read = !args.some((a) => /^-(exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls|delete)$/.test(a));
    if (bin === 'systemctl') read = ['status', 'is-active', 'is-enabled', 'is-failed', 'show', 'list-units', 'list-unit-files'].includes(args[0]) && !args.slice(1).some((a) => a.startsWith('-') && !['--no-pager', '--all', '--full', '--plain'].includes(a));
    if (bin === 'journalctl') read = args.every((a) => !a.startsWith('-') || /^(?:-u|-n|-b|-p|-f|--no-pager|--since|--until|--unit|--lines|--boot|--priority)(?:=|$)/.test(a));
    if (bin === 'git') {
      const gitArgs = args[0] === '-C' && args[1] ? args.slice(2) : args;
      read = ['status', 'log', 'show', 'diff', 'branch'].includes(gitArgs[0]) && gitArgs.slice(1).every((a) => /^(-[0-9]+|--oneline|--short|--stat|--name-only|--no-pager|--all|--list)$/.test(a));
    }
    if (bin === 'docker' || bin === 'podman') read = ['ps', 'logs', 'inspect', 'stats', 'version', 'info'].includes(args[0]) && !args.includes('--format');
    if (bin === 'crontab') read = args.length === 1 && args[0] === '-l';
    if (bin === 'date') read = args.length === 0 || args.every((a) => ['-u', '--utc', '--iso-8601'].includes(a) || a.startsWith('+'));
    if (bin === 'hostname') read = args.length === 0;
    if (bin === 'echo' || bin === 'printf') read = true;
    if (!read || /[<>]/.test(segment)) { cls = 'write'; reason = 'This command is not on the narrow informational allowlist or redirects output.'; }
  }
  return { cls, reason, sudo, segments };
}

function createSshAgent(ctx) {
  const { app, DATA_DIR, settings, profileById, terminals, agent } = ctx;
  const audit = ctx.audit || (() => {}), log = ctx.logEvent || (() => {});
  const httpError = ctx.httpError || fail, wrap = ctx.wrap || ((fn) => fn);
  if (!terminals) throw new Error('SSH assistant requires the shared terminals registry');
  // What the model may read, independent of the viewer's replay buffer (lib/ssh-terminal outputMax).
  const limits = { ...MODEL_LIMITS };
  for (const [key, value] of Object.entries(ctx.modelLimits || {})) {
    if (Number.isFinite(Number(value)) && Number(value) >= 0) limits[key] = Math.trunc(Number(value));
  }
  const context = new AsyncLocalStorage();
  const file = path.join(DATA_DIR, FILE_NAME);
  let data = { version: 1, sessions: {} }, readOnly = null, chain = Promise.resolve();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed?.version !== 1 || !parsed.sessions || Array.isArray(parsed.sessions) || typeof parsed.sessions !== 'object') throw new Error('unsupported session history format');
    for (const [id, entry] of Object.entries(parsed.sessions)) {
      if (!ID_RE.test(id) || entry.sessionId !== id || !ID_RE.test(entry.profileId) || !Array.isArray(entry.messages) || !Array.isArray(entry.notes) || !Array.isArray(entry.commands)) throw new Error('invalid session history entry');
    }
    data = parsed;
  } catch (e) {
    if (e.code !== 'ENOENT') { readOnly = `${FILE_NAME} cannot be read: ${e.message}. History is read-only until the file is repaired.`; log('warn', readOnly); }
  }
  const writable = () => { if (readOnly) throw httpError(503, readOnly); };
  function save() {
    writable();
    const snapshot = JSON.stringify(data);
    const work = chain.then(async () => {
      const tmp = `${file}.tmp`;
      await fsp.writeFile(tmp, snapshot, 'utf8');
      await fsp.rename(tmp, file);
    });
    chain = work.catch((e) => { readOnly = `${FILE_NAME} could not be saved: ${e.message}`; log('error', readOnly); });
    return work;
  }
  const saveLater = () => { save().catch(() => {}); };
  const guard = () => ({ read: !!settings.aiAssist?.sshRead, write: !!settings.aiAssist?.sshWrite,
    destructive: !!settings.aiAssist?.sshDestructive, sudo: !!settings.aiAssist?.sshSudo,
    auto: false, approvalRequired: true, memory: !!settings.aiAssist?.sshMemory });
  function session(id) {
    if (typeof id !== 'string' || !ID_RE.test(id) || !Object.hasOwn(data.sessions, id)) throw httpError(404, 'Server terminal session not found.');
    return copy(data.sessions[id]);
  }
  function current() { const id = context.getStore()?.sessionId; return id ? session(id) : null; }
  function requireSession(id = context.getStore()?.sessionId) {
    if (!id) throw httpError(400, 'Open a server terminal session and use its assistant first.');
    const s = session(id);
    const profile = profileById(s.profileId);
    if (!profile?.ssh?.enabled || !profile.ssh.host) throw httpError(409, 'The server for this terminal session is no longer available.');
    if (profile.ssh.host !== s.host || (profile.ssh.user || '') !== s.user || (profile.ssh.port || 22) !== s.port) throw httpError(409, 'The server connection changed. Open a new terminal session.');
    return s;
  }
  function withSession(id, fn) { requireSession(id); return context.run({ sessionId: id }, fn); }
  function terminalSnapshot(id, options) { try { return terminals.snapshot(id, options); } catch { return null; } }
  const isAttached = (id = context.getStore()?.sessionId) => {
    if (!id) return false;
    try { const s = requireSession(id); const t = terminalSnapshot(id); return t?.status === 'open' && t.profileId === s.profileId; } catch { return false; }
  };
  function history(id) { return session(id).messages; }
  function push(id, message) {
    writable(); session(id);
    if (!message || !['user', 'assistant', 'note'].includes(message.role)) throw httpError(400, 'Invalid chat message role.');
    const s = data.sessions[id];
    const stored = { ...copy(message), sessionId: id, profileId: s.profileId, ts: message.ts || now() };
    s.messages.push(stored); s.messages = s.messages.slice(-MAX_MESSAGES); s.updatedAt = now(); saveLater();
    return copy(stored);
  }
  function reset(id) {
    writable(); session(id);
    Object.assign(data.sessions[id], { messages: [], notes: [], commands: [], updatedAt: now() });
    for (const p of agent.proposals) if (p.sessionId === id && p.status === 'pending') p.status = 'rejected';
    saveLater(); return true;
  }
  function remember(id, note) {
    writable(); session(id); const s = data.sessions[id];
    s.notes.push({ ts: now(), ...copy(note) }); s.notes = s.notes.slice(-60); s.updatedAt = now(); saveLater();
  }
  function rememberCommand(id, entry) {
    writable(); session(id); const s = data.sessions[id];
    s.commands.push({ ts: now(), ...copy(entry) }); s.commands = s.commands.slice(-40); s.updatedAt = now(); saveLater();
  }
  function digest(id, { notes = 6, commands = 5 } = {}) {
    const s = session(id);
    return { updatedAt: s.updatedAt, notes: s.notes.slice(-notes), commands: s.commands.slice(-commands), totals: { notes: s.notes.length, commands: s.commands.length } };
  }
  function status(id = context.getStore()?.sessionId) {
    if (!id) return { attached: false, sessionId: null, guard: guard() };
    const s = session(id), t = terminalSnapshot(id);
    return { attached: isAttached(id), sessionId: id, profileId: s.profileId, projectId: s.projectId, name: s.name,
      host: s.host, user: s.user, since: s.createdAt, guard: guard(), readOnly,
      terminal: t ? { sessionId: id, profileId: s.profileId, status: t.status, control: t.control, revision: t.revision, cursor: t.cursor, busy: t.busy } : { sessionId: id, status: 'closed' },
      memory: guard().memory ? digest(id, { notes: 3, commands: 3 }) : null };
  }
  function listForProfile(profileId) {
    return Object.values(data.sessions).filter((s) => s.profileId === profileId).map((s) => ({ sessionId: s.sessionId,
      profileId, name: s.name, projectId: s.projectId, createdAt: s.createdAt, updatedAt: s.updatedAt,
      status: terminalSnapshot(s.sessionId)?.status || 'closed', messageCount: s.messages.length }));
  }
  async function attach(profileId, options = {}) {
    writable();
    if (typeof options !== 'object' || options === null) options = { projectId: options || null };
    const profile = profileById(profileId);
    if (!profile?.ssh?.enabled || !profile.ssh.host) throw httpError(404, 'Server with SSH configured not found.');
    if (options.sessionId) {
      const existing = requireSession(options.sessionId);
      if (existing.profileId !== profileId) throw httpError(409, 'The terminal session belongs to another server.');
      await terminals.open(profileId, { sessionId: options.sessionId, cols: options.cols, rows: options.rows });
      return status(options.sessionId);
    }
    const terminal = await terminals.open(profileId, { cols: options.cols, rows: options.rows });
    const id = terminal.sessionId;
    if (!ID_RE.test(id) || Object.hasOwn(data.sessions, id)) throw httpError(409, 'Terminal session identifier is already in use.');
    data.sessions[id] = { sessionId: id, profileId, projectId: options.projectId || null, name: profile.name,
      host: profile.ssh.host, user: profile.ssh.user || '', port: profile.ssh.port || 22, createdAt: now(), updatedAt: now(),
      messages: [], notes: [], commands: [] };
    push(id, { role: 'note', kind: 'ssh-attach', text: `Connected to ${profile.name} (${profile.ssh.user || ''}@${profile.ssh.host}). This conversation belongs only to this terminal session. You control the terminal until you hand it to the assistant. Every assistant command needs your approval.` });
    await chain;
    if (readOnly) throw httpError(503, readOnly);
    audit({ action: 'ai-ssh-attach', sessionId: id, profileId, profile: profile.name });
    return status(id);
  }
  function detach(id) {
    const s = requireSession(id);
    // Closing is explicitly handled by the terminal DELETE endpoint, not by switching chat views.
    audit({ action: 'ai-ssh-detach', sessionId: id, profileId: s.profileId });
    return { ...status(id), attached: false };
  }
  function noteTurn(userText, assistantText, id = context.getStore()?.sessionId) {
    if (!id || !guard().memory) return;
    requireSession(id);
    if (userText) remember(id, { role: 'user', text: String(userText).slice(0, 600) });
    if (assistantText) remember(id, { role: 'assistant', text: String(assistantText).slice(0, 900) });
  }
  function promptFragment(id = context.getStore()?.sessionId) {
    if (!id) return '\n- No server terminal session is selected. SSH tools are unavailable.';
    const s = requireSession(id), g = guard(), t = terminalSnapshot(id);
    const lines = [`\n- SERVER SESSION: ${id}, "${s.name}" (${s.user}@${s.host}). This conversation and every tool call belong exclusively to this terminal session.`,
      `  Shared terminal: ${t?.status || 'closed'}, control: ${t?.control || 'user'}. Read existing output with ssh_terminal_read. Ask the user to hand terminal control to the assistant before proposing a command.`,
      '  EVERY command, including informational commands, needs a separate user approval before execution. A real shared shell can redefine commands. Never claim a pending command ran or bypass a refusal.',
      `  Permissions: read=${g.read}, write=${g.write}, destructive=${g.destructive}, sudo=${g.sudo}. Approval does not override these settings.`,
      '  The user can Accept, Reject, or supply an Alternative. Treat an alternative as a new instruction and propose a new command requiring its own approval. Never use another session or server conversation.'];
    if (g.memory) { const d = digest(id); lines.push(`  Earlier in THIS terminal session: ${JSON.stringify(d)}`); }
    return lines.join('\n');
  }

  function commandContext(id = context.getStore()?.sessionId) {
    const s = requireSession(id), t = terminals.snapshot(s.sessionId);
    if (t.profileId !== s.profileId || t.status !== 'open') throw httpError(409, 'This terminal session is closed or belongs to another server.');
    if (t.control !== 'assistant') throw httpError(409, 'Hand terminal control to the assistant before running a command.');
    if (t.busy) throw httpError(409, 'Wait for the current terminal command to finish.');
    return { s, t };
  }
  function permission(c) {
    const g = guard();
    if (c.cls === 'blocked') return c.reason;
    if (c.sudo && !g.sudo) return 'Allow sudo in Settings → AI assistant → Server access first.';
    if (c.cls === 'read' && !g.read) return 'Read-only commands are disabled in Settings → AI assistant → Server access.';
    if (c.cls === 'write' && !g.write) return 'Write commands are disabled in Settings → AI assistant → Server access.';
    if (c.cls === 'destructive' && !g.destructive) return 'Destructive commands are disabled in Settings → AI assistant → Server access.';
    return null;
  }
  const approvals = new Map();
  const signedFields = (p) => JSON.stringify([p.id, p.sessionId, p.profileId, p.cmd, p.cls, p.revision, p.timeoutMs]);
  function propose({ cmd, why, timeoutMs }) {
    writable();
    const { s, t } = commandContext(), c = classify(cmd), reason = permission(c);
    if (reason) return { refused: true, class: c.cls, reason, hint: reason };
    if (agent.proposals.filter((p) => p.sessionId === s.sessionId && ['pending', 'executing'].includes(p.status)).length >= 30) {
      return { refused: true, reason: 'This session has 30 unresolved command approvals. Resolve them before proposing another command.' };
    }
    const p = { id: crypto.randomUUID(), kind: 'ssh-command', sessionId: s.sessionId, profileId: s.profileId,
      projectId: s.projectId, serverName: s.name, host: s.host, revision: t.revision, cmd, cls: c.cls,
      why: String(why || '').slice(0, 300), timeoutMs, status: 'pending', ts: now() };
    approvals.set(p.id, { signature: signedFields(p), started: false });
    agent.proposals.push(p);
    audit({ action: 'ai-ssh-proposed', sessionId: s.sessionId, profileId: s.profileId, cmd, class: c.cls });
    return { proposalId: p.id, sessionId: s.sessionId, status: 'pending_user_approval', class: c.cls,
      reason: c.reason, note: 'The command has not run. The user must approve it in this terminal session.' };
  }
  agent.kinds['ssh-command'] = {
    label: (p) => `command on "${p.serverName}": ${p.cmd}`,
    approve: async (p) => {
      writable();
      const active = requireSession();
      if (active.sessionId !== p.sessionId || active.profileId !== p.profileId) throw httpError(409, 'Approval belongs to another terminal session.');
      const seal = approvals.get(p.id);
      if (!seal || seal.started || seal.signature !== signedFields(p) || ['rejected', 'approved', 'failed'].includes(p.status)) throw httpError(409, 'This approval is no longer pending or its command changed.');
      const { s, t } = commandContext(p.sessionId);
      if (t.revision !== p.revision) throw httpError(409, 'The terminal changed since this command was proposed. Request a new proposal.');
      const c = classify(p.cmd), denied = permission(c);
      if (denied || c.cls !== p.cls) throw httpError(409, denied || 'Command classification changed. Request a new proposal.');
      seal.started = true; // Synchronous claim prevents a second simultaneous approval from executing.
      const started = Date.now();
      let r;
      try { r = await terminals.sendCommand(s.sessionId, p.cmd, { expectedRevision: p.revision, timeoutMs: p.timeoutMs }); }
      catch (e) { rememberCommand(s.sessionId, { cmd: p.cmd, cls: p.cls, ok: false, error: e.message }); throw e; }
      // Tail-first: a command that failed says why on its last lines. A small head survives too,
      // because the start of stdout is often a header or the top of a file that was asked for.
      const out = boundText(r.stdout, { max: limits.stdout, head: limits.head });
      const err = boundText(r.stderr, { max: limits.stderr, head: limits.head });
      const result = { cmd: p.cmd, class: p.cls, sessionId: s.sessionId, exitCode: r.code ?? null,
        stdout: out.text, stderr: err.text,
        timedOut: !!r.timedOut, cancelled: !!r.cancelled, ms: Date.now() - started, revision: r.revision };
      if (out.dropped || err.dropped) result.dropped = { stdout: out.dropped, stderr: err.dropped };
      if (r.truncated) result.captureTruncated = true; // the terminal's capture cap had already clipped this
      const ok = r.code === 0 && !r.timedOut && !r.cancelled;
      rememberCommand(s.sessionId, { cmd: p.cmd, cls: p.cls, ok, code: result.exitCode });
      p.result = result;
      push(s.sessionId, { role: 'note', kind: 'ssh-result', text: `Ran on "${s.name}": \`${p.cmd}\`\nexit ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}${result.cancelled ? ' (interrupted)' : ''}\n${[result.stdout, result.stderr].filter(Boolean).join('\n').slice(-1500)}` });
      audit({ action: 'ai-ssh-exec', sessionId: s.sessionId, profileId: s.profileId, cmd: p.cmd, class: p.cls, ok, exitCode: result.exitCode });
      return result;
    },
  };
  const enabled = () => isAttached();
  agent.tools.ssh_status = { desc: 'Read metadata, permissions and ownership for this terminal session only.', enabled, run: async () => { requireSession(); return status(); } };
  agent.tools.ssh_terminal_read = {
    desc: 'Read output already in this shared terminal. Input: {"cursor":0}. Returns output, cursor, status, control, revision and busy. A long read keeps the most recent output only, reports "dropped", and moves "baseCursor" to the first character returned; read again from "cursor" to follow along. Does not send input or execute commands.', enabled,
    run: async (input) => {
      const s = requireSession();
      if (!guard().read) return { refused: true, reason: 'Terminal output read access is disabled.' };
      const cursor = input?.cursor == null ? undefined : Number(input.cursor);
      if (cursor != null && (!Number.isSafeInteger(cursor) || cursor < 0)) throw httpError(400, 'cursor must be a nonnegative integer.');
      // Bounded here, not by a blind slice of the serialised result: the model must still get a
      // window whose cursor metadata it can trust, and the viewer's replay stays untouched.
      return boundTerminalView(terminals.snapshot(s.sessionId, { cursor }), { max: limits.terminalRead });
    },
  };
  const commandTool = {
    desc: 'Propose ONE command in this exact shared terminal. Input: {"cmd":"df -h","why":"disk check","timeoutSec":20}. EVERY command needs Accept/Reject/Alternative in this session, including read commands. pending_user_approval means it has not run. Requires user handoff of terminal control.', enabled,
    run: async (input) => propose({ cmd: String(input?.cmd || '').trim(), why: input?.why,
      timeoutMs: Math.min(MAX_TIMEOUT_MS, Math.max(1000, (Number(input?.timeoutSec) || DEFAULT_TIMEOUT_MS / 1000) * 1000)) }),
  };
  agent.tools.ssh_exec = commandTool;
  agent.tools.ssh_terminal_command = commandTool;
  agent.tools.ssh_read_file = {
    desc: 'Propose reading a file through the shared terminal. Input: {"path":"/etc/hosts","lines":200,"from":1}. Requires approval because shell commands can be redefined. Maximum 400 lines.', enabled,
    run: async (input) => {
      requireSession();
      const filename = String(input?.path || '').trim();
      if (!filename.startsWith('/') || /[\x00-\x1f\x7f'"$`\\(){}<>|;&]/.test(filename)) throw httpError(400, 'Use a plain absolute path without quotes, substitutions or shell operators.');
      const from = Math.min(1000000, Math.max(1, Math.floor(Number(input?.from) || 1)));
      const lines = Math.min(400, Math.max(1, Math.floor(Number(input?.lines) || 200)));
      return propose({ cmd: `head -n ${from + lines - 1} -- '${filename}' | tail -n ${lines}`, why: `Read ${filename}`, timeoutMs: DEFAULT_TIMEOUT_MS });
    },
  };
  agent.tools.ssh_recall = {
    desc: 'Recall notes and command history from THIS terminal session only. Input: {"query":"nginx","limit":10}.', enabled,
    run: async (input) => {
      const s = requireSession();
      if (!guard().memory) return { refused: true, reason: 'Session memory is disabled.' };
      const query = String(input?.query || '').toLowerCase(), limit = Math.min(30, Math.max(1, Number(input?.limit) || 10));
      return { sessionId: s.sessionId, notes: s.notes.filter((n) => !query || String(n.text).toLowerCase().includes(query)).slice(-limit),
        commands: s.commands.filter((c) => !query || c.cmd.toLowerCase().includes(query)).slice(-limit) };
    },
  };
  agent.tools.ssh_remember = {
    desc: 'Store a note in THIS terminal session only. Input: {"text":"nginx serves /var/www/shop"}.', enabled,
    run: async (input) => {
      const s = requireSession();
      if (!guard().memory) return { refused: true, reason: 'Session memory is disabled.' };
      const text = String(input?.text || '').trim().slice(0, 500);
      if (!text) throw httpError(400, 'text is required');
      remember(s.sessionId, { kind: 'fact', role: 'assistant', text }); return { stored: true, sessionId: s.sessionId };
    },
  };

  app.get('/api/ssh/agent', wrap(async (req, res) => res.json(status(req.query?.sessionId))));
  app.get('/api/ssh/agent/sessions', wrap(async (req, res) => {
    const id = String(req.query?.profileId || '');
    if (!profileById(id)) throw httpError(404, 'Server not found.');
    res.json({ profileId: id, sessions: listForProfile(id) });
  }));
  app.post('/api/ssh/agent/attach', wrap(async (req, res) => res.json(await attach(String(req.body?.profileId || ''), req.body || {}))));
  app.post('/api/ssh/agent/detach', wrap(async (req, res) => res.json(detach(req.body?.sessionId))));
  return { attach, detach, status, session, requireSession, current, withSession, history, push, reset,
    listForProfile, promptFragment, noteTurn, classify, isAttached, file, get readOnly() { return readOnly; },
    flush: () => chain, memory: { digest, remember, rememberCommand } };
}

module.exports = { createSshAgent, classify, FILE_NAME };
