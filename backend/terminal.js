'use strict';

const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');

const DEFAULT_OUTPUT_MAX = 256 * 1024;
const COMMAND_MAX = 2000;
const error = (status, message) => Object.assign(new Error(message), { status });
const bounded = (value, fallback, min, max) => Number.isFinite(Number(value))
  ? Math.min(max, Math.max(min, Math.trunc(Number(value)))) : fallback;
const BEGIN = 'S'; // marker code separating the shell's echo of our line from the command's own output
const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";

/** One SSH shell per terminal ID, independent of the lifetime of its browser viewers.
 * AI authorization belongs to the caller. Ownership and revision checks here prevent a
 * previously authorized command from running after someone changes the terminal context.
 * Handoff requires the user to leave interactive programs and confirm a shell prompt.
 * Ctrl+C/Ctrl+U clear a partial shell line, then a probe verifies shell responsiveness.
 * A successful probe is not a security boundary against aliases, functions or remote code.
 */
function createTerminalSessions(ctx) {
  const sessions = new Map();
  const connecting = new Map();
  const clientBindings = new Map();
  const pool = ctx.sshSessions || new Map();
  const outputMax = bounded(ctx.outputMax, DEFAULT_OUTPUT_MAX, 1024, 1024 * 1024);
  const captureMax = bounded(ctx.captureMax, 60000, 1024, 1024 * 1024);
  const maxSessions = bounded(ctx.maxSessions, 24, 1, 100);
  const retainedClosed = bounded(ctx.retainedClosed, 48, 0, 100);
  const probeTimeoutMs = bounded(ctx.probeTimeoutMs, 5000, 100, 20000);
  // Pause between the interrupt and the probe marker, always leaving most of the probe window for the reply.
  const probeSettleMs = Math.min(bounded(ctx.probeSettleMs, 180, 0, 2000), Math.floor(probeTimeoutMs / 3));

  function must(sessionId, profileId) {
    const session = sessions.get(sessionId);
    if (!session || (profileId && session.profileId !== profileId)) throw error(404, 'Terminal session not found for this server');
    return session;
  }
  function live(sessionId) {
    const session = must(sessionId);
    if (session.status !== 'open') throw error(409, 'Terminal session is closed; open a new terminal');
    return session;
  }
  function snapshot(sessionId, options = {}) {
    const session = must(sessionId);
    const baseCursor = session.cursor - session.output.length;
    const cursor = options.cursor === undefined ? baseCursor : Number(options.cursor);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > session.cursor) throw error(400, 'Invalid terminal output cursor');
    return {
      sessionId: session.sessionId, profileId: session.profileId, status: session.status,
      output: session.output.slice(Math.max(0, cursor - baseCursor)), cursor: session.cursor,
      baseCursor, truncated: cursor < baseCursor || (options.cursor === undefined && baseCursor > 0),
      revision: session.revision, busy: !!session.pending, control: session.control,
      createdAt: session.createdAt, lastActivityAt: session.lastActivityAt,
      cols: session.cols, rows: session.rows, closedReason: session.closedReason || null,
    };
  }
  function emit(session, event) {
    for (const listener of [...session.listeners]) {
      try { listener({ sessionId: session.sessionId, profileId: session.profileId, ...event }); }
      catch { /* A disconnected viewer cannot break the persistent shell. */ }
    }
  }
  function state(session, type = 'state') {
    const { output, ...view } = snapshot(session.sessionId);
    emit(session, { type, ...view });
  }
  function audit(session, action, detail = {}) {
    try { ctx.audit?.({ action, sessionId: session.sessionId, profileId: session.profileId, ...detail }); } catch {}
  }
  function append(session, text) {
    if (!text) return;
    session.lastActivityAt = new Date().toISOString();
    session.cursor += text.length;
    session.output += text;
    if (session.output.length > outputMax) {
      session.output = session.output.slice(-outputMax);
      // A replay buffer must not start halfway through a surrogate pair.
      if (/^[\uDC00-\uDFFF]/.test(session.output)) session.output = session.output.slice(1);
    }
    const op = session.pending;
    if (op?.kind === 'command') {
      op.capture += text;
      if (op.capture.length > captureMax) { op.capture = op.capture.slice(-captureMax); op.truncated = true; }
    }
    emit(session, { type: 'output', data: text, cursor: session.cursor, revision: session.revision });
  }
  function finish(session, op, result) {
    if (session.pending !== op) return;
    clearTimeout(op.timer); clearTimeout(op.settle);
    session.pending = null;
    if (result.timedOut || result.cancelled || result.closed) session.control = 'user';
    else if (op.kind === 'probe') session.control = 'assistant';
    session.revision++;
    state(session);
    // A real shell echoes the line it was given, marker and all, and a narrow tty even wraps it. That
    // echo is not output: consume() restarts the capture at the begin marker, so what is left here is
    // the command's own output.
    const stdout = op.capture;
    const response = {
      sessionId: session.sessionId, profileId: session.profileId, stdout,
      stderr: '', code: null, timedOut: false, truncated: !!op.truncated,
      ...result, revision: session.revision,
    };
    if (op.kind === 'probe' && (result.timedOut || result.cancelled || result.closed)) {
      op.reject(error(409, result.closed ? 'Terminal closed during handoff' : 'Assistant handoff did not complete. Return to a shell prompt and try again.'));
    } else op.resolve(op.kind === 'probe' ? snapshot(session.sessionId) : response);
  }
  function consume(session, text) {
    const op = session.pending;
    if (!op) return append(session, text);
    let pendingText = op.tail + text;
    op.tail = '';
    // A chunk can carry the begin marker, the end marker, or both.
    for (;;) {
      const start = pendingText.indexOf(op.start);
      if (start < 0) break;
      const end = pendingText.indexOf('\x1f', start + op.start.length);
      if (end < 0) {
        if (pendingText.length - start < op.start.length + 20) { append(session, pendingText.slice(0, start)); op.tail = pendingText.slice(start); return; }
        break;
      }
      const codeText = pendingText.slice(start + op.start.length, end);
      if (codeText === BEGIN) {
        // The shell has echoed our line back (a narrow tty even wraps it mid-token) and only now starts
        // the command's own output. Keep the echo on screen, but restart what the caller captures.
        append(session, pendingText.slice(0, start));
        op.capture = ''; op.truncated = false;
        pendingText = pendingText.slice(end + 1);
        continue;
      }
      if (/^\d{1,3}$/.test(codeText)) {
        append(session, pendingText.slice(0, start));
        finish(session, op, { code: Number(codeText) });
        append(session, pendingText.slice(end + 1));
        return;
      }
      break;
    }
    // Keep only a possible prefix of the delimiter between SSH packets.
    let keep = Math.min(pendingText.length, op.start.length - 1);
    while (keep && !op.start.startsWith(pendingText.slice(-keep))) keep--;
    if (keep) { op.tail = pendingText.slice(-keep); pendingText = pendingText.slice(0, -keep); }
    append(session, pendingText);
  }
  function interrupt(session, op, result) {
    if (session.pending !== op) return;
    if (op.tail) { append(session, op.tail); op.tail = ''; }
    // Never send a follow-up command after a timeout. Only the user may hand control back.
    try { session.stream?.write('\x03\x15'); } catch {}
    finish(session, op, result);
  }
  function unbind(session) {
    const binding = clientBindings.get(session.client);
    if (!binding) return;
    binding.sessions.delete(session);
    if (!binding.sessions.size) {
      session.client.removeListener?.('close', binding.close);
      session.client.removeListener?.('end', binding.close);
      session.client.removeListener?.('error', binding.failed);
      clientBindings.delete(session.client);
    }
  }
  function prune() {
    const closed = [...sessions.values()].filter((session) => session.status === 'closed');
    for (const session of closed.slice(0, Math.max(0, closed.length - retainedClosed))) {
      session.listeners.clear(); sessions.delete(session.sessionId);
    }
  }
  function end(session, reason = 'Terminal closed') {
    if (session.status === 'closed') return;
    session.status = 'closed'; session.closedReason = reason; session.control = 'user'; session.revision++;
    const op = session.pending;
    if (op) {
      if (op.tail) { append(session, op.tail); op.tail = ''; }
      finish(session, op, { cancelled: true, closed: true, error: reason });
    }
    unbind(session);
    state(session, 'closed'); audit(session, 'ssh-terminal-close', { reason });
    prune();
  }
  function bind(session) {
    let binding = clientBindings.get(session.client);
    if (!binding) {
      binding = { sessions: new Set() };
      const fail = (reason) => {
        if (pool.get(session.profileId)?.client === session.client) pool.delete(session.profileId);
        for (const attached of [...binding.sessions]) end(attached, reason);
      };
      binding.close = () => fail('SSH connection closed');
      binding.failed = (e) => fail(`SSH connection failed: ${e.message || 'connection error'}`);
      session.client.on('close', binding.close);
      session.client.on('end', binding.close);
      session.client.on('error', binding.failed);
      clientBindings.set(session.client, binding);
    }
    binding.sessions.add(session);
  }
  async function clientFor(profile) {
    const pooled = pool.get(profile.id)?.client;
    if (pooled) return pooled;
    if (connecting.has(profile.id)) return connecting.get(profile.id);
    const pending = Promise.resolve().then(() => ctx.sshClientFor(profile.ssh)).then((client) => {
      pool.set(profile.id, {
        client, connectedAt: new Date().toISOString(), meta: null,
        host: profile.ssh.host, user: profile.ssh.user, name: profile.name,
      });
      return client;
    });
    connecting.set(profile.id, pending);
    try { return await pending; } finally { connecting.delete(profile.id); }
  }
  async function open(profileId, options = {}) {
    const profile = ctx.profileById(profileId);
    if (!profile?.ssh?.enabled || !profile.ssh.host) throw error(400, 'That server has no SSH configured');
    if (options.sessionId) {
      const session = must(options.sessionId, profileId);
      if (session.ready) await session.ready;
      return snapshot(session.sessionId);
    }
    if ([...sessions.values()].filter((session) => session.status !== 'closed').length >= maxSessions) {
      throw error(409, 'Too many open terminal sessions. Close an unused terminal first.');
    }
    const session = {
      sessionId: crypto.randomUUID(), profileId, status: 'opening', output: '', cursor: 0,
      // a viewer that lost the session needs to find its way back to the one it was last using
      createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(),
      revision: 0, control: 'user', pending: null, listeners: new Set(),
      cols: bounded(options.cols, 100, 20, 500), rows: bounded(options.rows, 30, 5, 200),
      client: null, stream: null,
    };
    sessions.set(session.sessionId, session);
    session.ready = (async () => {
      session.client = await clientFor(profile);
      if (session.status === 'closed') throw error(409, 'Terminal closed while connecting');
      bind(session);
      session.stream = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(error(504, 'Timed out opening SSH terminal')), 30000);
        try {
          session.client.shell({ term: 'xterm-256color', cols: session.cols, rows: session.rows }, (err, stream) => {
            clearTimeout(timer);
            if (err) return reject(error(502, `Cannot open SSH terminal: ${err.message}`));
            if (session.status === 'closed') { try { stream.close(); } catch {} return reject(error(409, 'Terminal closed while connecting')); }
            resolve(stream);
          });
        } catch (e) { clearTimeout(timer); reject(e); }
      });
      const decoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      session.stream.on('data', (data) => { if (session.status !== 'closed') consume(session, Buffer.isBuffer(data) ? decoder.write(data) : String(data)); });
      session.stream.stderr?.on('data', (data) => { if (session.status !== 'closed') consume(session, Buffer.isBuffer(data) ? stderrDecoder.write(data) : String(data)); });
      session.stream.on('error', (e) => end(session, `SSH shell failed: ${e.message}`));
      const closed = () => { consume(session, decoder.end() + stderrDecoder.end()); end(session, 'SSH shell closed'); };
      session.stream.on('close', closed); session.stream.on('end', closed);
      session.status = 'open'; session.revision++; state(session); audit(session, 'ssh-terminal-open');
    })();
    try { await session.ready; } catch (e) { end(session, e.message); throw e; } finally { session.ready = null; }
    return snapshot(session.sessionId);
  }
  function subscribe(sessionId, listener) {
    const session = must(sessionId);
    if (typeof listener !== 'function') throw error(400, 'Terminal subscriber must be a function');
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  }
  function writeUser(sessionId, data) {
    const session = live(sessionId);
    if (session.control !== 'user' || session.pending) throw error(409, 'Take terminal control before typing');
    if (typeof data !== 'string' || data.length > 65536) throw error(400, 'Invalid terminal input');
    if (!data) return snapshot(sessionId);
    session.revision++;
    try { session.stream.write(data); } catch (e) { end(session, e.message); throw error(409, 'Terminal input failed'); }
    state(session);
    return snapshot(sessionId);
  }
  function resize(sessionId, cols, rows) {
    const session = live(sessionId);
    session.cols = bounded(cols, session.cols, 20, 500); session.rows = bounded(rows, session.rows, 5, 200);
    session.stream.setWindow?.(session.rows, session.cols, 0, 0);
    return snapshot(sessionId);
  }
  function startOperation(session, kind, command, timeoutMs) {
    const token = crypto.randomBytes(24).toString('hex');
    let resolve, reject;
    const done = new Promise((yes, no) => { resolve = yes; reject = no; });
    const op = { kind, token, start: `\x1e${token}:`, tail: '', capture: '', resolve, reject };
    session.pending = op; session.revision++;
    op.timer = setTimeout(() => interrupt(session, op, { timedOut: true }), timeoutMs);
    state(session);
    // eval preserves the shell's cwd/environment. The caller must authorize the command;
    // even a familiar read command can be shadowed by a remote alias or function.
    // The leading space is sacrificial: a remote line discipline discards the first byte written after an
    // interrupt, so the command itself must never be first. It also keeps these lines out of shell history
    // wherever HISTCONTROL includes ignorespace.
    const input = kind === 'probe'
      ? ` printf '\\036${token}:%s\\037\\n' 0\r`
      : ` printf '\\036${token}:${BEGIN}\\037'; eval ${quote(command)}; printf '\\036${token}:%s\\037\\n' "$?"\r`;
    try {
      if (kind === 'probe') {
        // Ctrl+C and Ctrl+U clear a partial line, but the line discipline swallows characters that
        // arrive while the interrupt is being handled, so the marker waits for the prompt to settle.
        session.stream.write('\x03\x15');
        op.settle = setTimeout(() => { try { session.stream.write(input); } catch (e) { end(session, `SSH input failed: ${e.message}`); } }, probeSettleMs);
      } else session.stream.write(input);
    } catch (e) { end(session, `SSH input failed: ${e.message}`); }
    return done;
  }
  async function setControl(sessionId, control) {
    const session = live(sessionId);
    if (!['user', 'assistant'].includes(control)) throw error(400, 'Unknown terminal control owner');
    if (control === 'user') {
      if (session.pending) interrupt(session, session.pending, { cancelled: true });
      if (session.control !== 'user') { session.control = 'user'; session.revision++; state(session); }
      audit(session, 'ssh-terminal-control', { control });
      return snapshot(sessionId);
    }
    if (session.pending) throw error(409, 'Terminal is busy');
    if (session.control === 'assistant') return snapshot(sessionId);
    audit(session, 'ssh-terminal-control-request', { control });
    return startOperation(session, 'probe', null, probeTimeoutMs);
  }
  async function sendCommand(sessionId, command, options = {}) {
    const session = live(sessionId);
    if (session.control !== 'assistant') throw error(409, 'Ask the user to hand terminal control to the assistant');
    if (session.pending) throw error(409, 'The shared terminal is busy');
    if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision !== session.revision) {
      throw error(409, 'Terminal context changed; review and approve the command again');
    }
    if (typeof command !== 'string' || !command.trim() || command.length > COMMAND_MAX || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(command)) {
      throw error(400, `Use one command line of at most ${COMMAND_MAX} characters without terminal control characters`);
    }
    const timeoutMs = bounded(options.timeoutMs, 20000, 100, 120000);
    audit(session, 'ssh-terminal-assistant-command', { revision: session.revision });
    return startOperation(session, 'command', command, timeoutMs);
  }
  function close(sessionId) {
    const session = must(sessionId);
    end(session, 'Closed by user');
    try { session.stream?.close(); } catch {}
    return sessions.has(sessionId) ? snapshot(sessionId) : { sessionId, profileId: session.profileId, status: 'closed' };
  }
  return { sessions, open, get: (id) => sessions.get(id), must, snapshot, subscribe, writeUser, resize, setControl, sendCommand, close };
}

module.exports = { createTerminalSessions };
