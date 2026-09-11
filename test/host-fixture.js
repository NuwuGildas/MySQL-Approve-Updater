'use strict';
/* A host stand-in for this module's tests.
 *
 * It is the real split, not a mock of it: the CONVERSATION store is the host's
 * own (lib/shared/session-conversations), reached exactly the way the worker
 * reaches it - by name, over host.call - while the terminal half is this
 * module's agent. Anything that passes here passes against the real host too. */

const { createSessionConversations } = require('../../../lib/shared/session-conversations');
const { createSshAgent } = require('../backend/agent');

const httpError = (status, message) => Object.assign(new Error(message), { status });

/**
 * @returns { agent, conversations, host, audits, proposals, published }
 *          plus the small conversation surface the old suites used.
 */
function createTestHost({ dataDir, terminals, settings, profiles, modelLimits = {} }) {
  const audits = [];
  const proposals = [];
  let published = {};

  const conversations = createSessionConversations({ dataDir, httpError, proposals: () => proposals });
  conversations.setSessionView({ snapshot: (id) => published[id] || null });

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
    'sessions.publish': ({ sessions }) => { published = sessions; return true; },
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

  const agent = createSshAgent({ host, terminals, settings: () => settings, modelLimits });

  return {
    host, agent, conversations, audits, proposals,
    published: () => published,
    history: (id) => conversations.history(id),
    push: (id, message) => conversations.push(id, message),
    status: (id) => agent.status(id),
    flush: () => conversations.flush(),
    file: conversations.file,
  };
}

module.exports = { createTestHost, httpError };
