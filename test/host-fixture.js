'use strict';
/* The host, as this module sees it.
 *
 * A module only ever reaches the host by name, over host.call(...), so that is
 * all this fixture implements. It is deliberately self-contained: a module's
 * suite must run from a checkout of this package alone, with no host source
 * beside it. What the real host does behind those names - persisting
 * conversations, capping notes, refusing a corrupt file - is the host's own
 * business and is tested there.
 *
 * The one behaviour worth mirroring faithfully is the session VIEW: a session
 * conversation is readable whether or not a module owns it, but can only be
 * worked in while one does. */

const { createSshAgent } = require('../backend/agent');

const httpError = (status, message) => Object.assign(new Error(message), { status });
const copy = (value) => JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();

/** The host's conversation store, in memory. */
function conversationStore() {
  const sessions = new Map();
  let view = {};

  const has = (id) => sessions.has(id);
  const session = (id) => {
    if (!has(id)) throw httpError(404, 'Server terminal session not found.');
    return copy(sessions.get(id));
  };
  return {
    setView(next) { view = next || {}; },
    has,
    session,
    create(id, fields) {
      if (has(id)) throw httpError(409, 'Terminal session identifier is already in use.');
      sessions.set(id, { sessionId: id, createdAt: now(), updatedAt: now(), messages: [], notes: [], commands: [], ...fields });
      return copy(sessions.get(id));
    },
    history: (id) => session(id).messages,
    push(id, message) {
      if (!['user', 'assistant', 'note'].includes(message?.role)) throw httpError(400, 'Invalid chat message role.');
      const stored = { ...copy(message), sessionId: id, ts: message.ts || now() };
      sessions.get(id).messages.push(stored);
      return copy(stored);
    },
    remember(id, note) { session(id); sessions.get(id).notes.push({ ts: now(), ...copy(note) }); },
    rememberCommand(id, entry) { session(id); sessions.get(id).commands.push({ ts: now(), ...copy(entry) }); },
    digest(id, { notes = 6, commands = 5 } = {}) {
      const s = session(id);
      return { updatedAt: s.updatedAt, notes: s.notes.slice(-notes), commands: s.commands.slice(-commands), totals: { notes: s.notes.length, commands: s.commands.length } };
    },
    status(id) {
      if (!has(id)) return { attached: false, sessionId: id, missing: true };
      const s = session(id);
      const live = view[id] || null;
      return {
        attached: !!live && !live.unusable && live.terminal?.status === 'open',
        sessionId: id, profileId: s.profileId, projectId: s.projectId, name: s.name,
        host: s.host, user: s.user, since: s.createdAt,
        terminal: live?.terminal || { sessionId: id, status: 'closed' },
        owned: !!live,
      };
    },
    /** Readable always; workable only while a module owns it. */
    requireSession(id) {
      const stored = session(id);
      const live = view[id];
      if (!live) throw httpError(409, 'The module that owns this session is not installed, so it cannot be used. Its conversation is still readable.');
      if (live.unusable) throw httpError(409, live.unusable);
      return stored;
    },
    listForProfile: (profileId) => [...sessions.values()].filter((s) => s.profileId === profileId).map((s) => ({
      sessionId: s.sessionId, profileId, name: s.name, projectId: s.projectId,
      createdAt: s.createdAt, updatedAt: s.updatedAt,
      status: view[s.sessionId]?.terminal?.status || 'closed',
      messageCount: s.messages.length,
    })),
  };
}

/**
 * @returns the module's agent, plus everything the suites assert against:
 *          the conversations the host would have stored, what was audited, and
 *          what the module published about its sessions.
 */
function createTestHost({ terminals, settings, profiles, modelLimits = {}, remoteAgents = null }) {
  const audits = [];
  const proposals = [];
  const conversations = conversationStore();

  const services = {
    'connections.get': ({ id }) => profiles[id] || null,
    'connections.credentials': ({ id }) => profiles[id] || null,
    'conversation.create': ({ sessionId, fields }) => conversations.create(sessionId, fields),
    'conversation.push': ({ sessionId, message }) => conversations.push(sessionId, message),
    'conversation.history': ({ sessionId }) => conversations.history(sessionId),
    'conversation.remember': ({ sessionId, note }) => { conversations.remember(sessionId, note); return true; },
    'conversation.rememberCommand': ({ sessionId, entry }) => { conversations.rememberCommand(sessionId, entry); return true; },
    'conversation.digest': ({ sessionId, options }) => conversations.digest(sessionId, options || {}),
    'conversation.status': ({ sessionId }) => conversations.status(sessionId),
    'conversation.listForProfile': ({ profileId }) => conversations.listForProfile(profileId),
    'conversation.has': ({ sessionId }) => conversations.has(sessionId),
    'sessions.publish': ({ sessions }) => { conversations.setView(sessions); return true; },
    'assistant.propose': (proposal) => { const stored = { ...proposal, status: 'pending' }; proposals.push(stored); return stored; },
    'assistant.proposals': ({ sessionId }) => proposals.filter((p) => !sessionId || p.sessionId === sessionId),
    'assistant.setPromptFragment': () => true,
    'audit.record': (entry) => { audits.push(entry); return true; },
  };

  const host = {
    id: 'servers',
    async call(method, params) {
      if (!services[method]) throw new Error(`unknown host service ${method}`);
      return services[method](params || {});
    },
    async audit(entry) { audits.push(entry); },
    log() {}, emit() {},
  };

  const agent = createSshAgent({ host, terminals, settings: () => settings, modelLimits, remoteAgents });

  return {
    host, agent, conversations, audits, proposals,
    history: (id) => conversations.history(id),
    push: (id, message) => conversations.push(id, message),
    status: (id) => agent.status(id),
    flush: async () => {},
  };
}

module.exports = { createTestHost, conversationStore, httpError };
