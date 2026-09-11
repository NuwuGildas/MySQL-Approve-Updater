'use strict';
/* Conversations the assistant addresses, and the memory it keeps for each one.
 *
 * This is host-owned shared infrastructure, not a module.
 *  - The assistant always has a conversation, with or without any optional
 *    module installed: a project's, or a session another module opened.
 *  - A user's saved conversations, notes and command history are THEIR data.
 *    Removing the module that created a session must not lose them, so the
 *    store lives here and survives the module.
 *
 * What this file deliberately does not know: what a "terminal" is, how to reach
 * a server, or whether a session is still live. A module that owns sessions
 * publishes a read model through `setSessionView()`; with no such module the
 * view is empty, every session reads as closed, and the store is still usable
 * for history.
 *
 * Extracted from lib/ssh-agent.js, whose remaining half (classification,
 * approval and the ssh_* tools) belongs to the Servers module. */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const FILE_NAME = 'ssh-session-chats.json';
const MAX_MESSAGES = 200;
const MAX_NOTES = 60;
const MAX_COMMANDS = 40;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;
const now = () => new Date().toISOString();
const copy = (value) => JSON.parse(JSON.stringify(value));
const fail = (status, message) => Object.assign(new Error(message), { status });

function createSessionConversations({ dataDir, log = () => {}, httpError = fail, proposals = [] } = {}) {
  const file = path.join(dataDir, FILE_NAME);
  let data = { version: 1, sessions: {} };
  let readOnly = null;
  let chain = Promise.resolve();
  /* A module that owns sessions publishes what it knows here. Nothing else in
     the host asks it questions it cannot answer while that module is absent. */
  let sessionView = { snapshot: () => null };

  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed?.version !== 1 || !parsed.sessions || Array.isArray(parsed.sessions) || typeof parsed.sessions !== 'object') throw new Error('unsupported session history format');
    for (const [id, entry] of Object.entries(parsed.sessions)) {
      if (!ID_RE.test(id) || entry.sessionId !== id || !Array.isArray(entry.messages) || !Array.isArray(entry.notes) || !Array.isArray(entry.commands)) throw new Error('invalid session history entry');
    }
    data = parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') { readOnly = `${FILE_NAME} cannot be read: ${error.message}. History is read-only until the file is repaired.`; log('warn', readOnly); }
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
    chain = work.catch((error) => { readOnly = `${FILE_NAME} could not be saved: ${error.message}`; log('error', readOnly); });
    return work;
  }
  const saveLater = () => { save().catch(() => {}); };

  const has = (id) => typeof id === 'string' && ID_RE.test(id) && Object.hasOwn(data.sessions, id);
  function session(id) {
    if (!has(id)) throw httpError(404, 'Server terminal session not found.');
    return copy(data.sessions[id]);
  }
  /** The session exists AND the module that owns it says it is still usable. */
  function requireSession(id) {
    if (!id) throw httpError(400, 'Open a server terminal session and use its assistant first.');
    const stored = session(id);
    const live = sessionView.snapshot(id);
    if (!live) throw httpError(409, 'The module that owns this session is not installed, so it cannot be used. Its conversation is still readable.');
    if (live.unusable) throw httpError(409, live.unusable);
    return stored;
  }

  function create(id, fields) {
    writable();
    if (!ID_RE.test(id)) throw httpError(400, 'Invalid session identifier.');
    if (Object.hasOwn(data.sessions, id)) throw httpError(409, 'Terminal session identifier is already in use.');
    data.sessions[id] = { sessionId: id, createdAt: now(), updatedAt: now(), messages: [], notes: [], commands: [], ...fields };
    saveLater();
    return copy(data.sessions[id]);
  }

  const history = (id) => session(id).messages;

  function push(id, message) {
    writable(); session(id);
    if (!message || !['user', 'assistant', 'note'].includes(message.role)) throw httpError(400, 'Invalid chat message role.');
    const s = data.sessions[id];
    const stored = { ...copy(message), sessionId: id, profileId: s.profileId, ts: message.ts || now() };
    s.messages.push(stored);
    s.messages = s.messages.slice(-MAX_MESSAGES);
    s.updatedAt = now();
    saveLater();
    return copy(stored);
  }

  function reset(id) {
    writable(); session(id);
    Object.assign(data.sessions[id], { messages: [], notes: [], commands: [], updatedAt: now() });
    for (const proposal of (typeof proposals === 'function' ? proposals() : proposals)) if (proposal.sessionId === id && proposal.status === 'pending') proposal.status = 'rejected';
    saveLater();
    return true;
  }

  function remember(id, note) {
    writable(); session(id);
    const s = data.sessions[id];
    s.notes.push({ ts: now(), ...copy(note) });
    s.notes = s.notes.slice(-MAX_NOTES);
    s.updatedAt = now();
    saveLater();
  }
  function rememberCommand(id, entry) {
    writable(); session(id);
    const s = data.sessions[id];
    s.commands.push({ ts: now(), ...copy(entry) });
    s.commands = s.commands.slice(-MAX_COMMANDS);
    s.updatedAt = now();
    saveLater();
  }
  function digest(id, { notes = 6, commands = 5 } = {}) {
    const s = session(id);
    return { updatedAt: s.updatedAt, notes: s.notes.slice(-notes), commands: s.commands.slice(-commands), totals: { notes: s.notes.length, commands: s.commands.length } };
  }

  /** Everything the assistant needs to describe one conversation. */
  function status(id) {
    if (!id) return { attached: false, sessionId: null };
    if (!has(id)) return { attached: false, sessionId: id, missing: true };
    const s = session(id);
    const live = sessionView.snapshot(id);
    return {
      attached: !!live && !live.unusable && live.terminal?.status === 'open',
      sessionId: id, profileId: s.profileId, projectId: s.projectId, name: s.name,
      host: s.host, user: s.user, since: s.createdAt, readOnly,
      terminal: live?.terminal || { sessionId: id, status: 'closed' },
      guard: live?.guard || null,
      memory: live?.memory === false ? null : digest(id, { notes: 3, commands: 3 }),
      owned: !!live,
    };
  }

  const listForProfile = (profileId) => Object.values(data.sessions)
    .filter((s) => s.profileId === profileId)
    .map((s) => ({
      sessionId: s.sessionId, profileId, name: s.name, projectId: s.projectId,
      createdAt: s.createdAt, updatedAt: s.updatedAt,
      status: sessionView.snapshot(s.sessionId)?.terminal?.status || 'closed',
      messageCount: s.messages.length,
    }));

  return {
    file, FILE_NAME,
    get readOnly() { return readOnly; },
    has, session, requireSession, create, history, push, reset,
    remember, rememberCommand, digest, status, listForProfile,
    flush: () => chain,
    /** Called by the host when a module publishes (or withdraws) its session view. */
    setSessionView(view) { sessionView = view || { snapshot: () => null }; },
    ids: () => Object.keys(data.sessions),
  };
}

module.exports = { createSessionConversations, FILE_NAME, ID_RE };
