'use strict';
/* Which project a conversation is working in.
 *
 * The assistant always has a conversation, and every conversation belongs to a
 * project: a project conversation says so in its own id, and a conversation
 * bound to a module's session inherits the project that session was opened
 * from. That answer is what scopes the assistant's tools - it may only see what
 * the project it is in can see - so it is resolved in one place rather than at
 * each tool.
 *
 * Pure: the caller supplies how to recognise a project conversation and how to
 * look a session up, which is why this can be tested without a server. */

const PROJECT_CONVO = 'project:';

const isProjectConversation = (id) => typeof id === 'string' && id.startsWith(PROJECT_CONVO);
const conversationOfProject = (projectId) => PROJECT_CONVO + projectId;

/**
 * @param convoId          a project conversation id, a module session id, or nothing
 * @param sessionProject   (sessionId) => projectId | null, for a session-bound conversation
 * @param defaultProjectId what an unrecognised or unbound conversation belongs to
 */
function projectOfConversation(convoId, { sessionProject = () => null, defaultProjectId = 'general' } = {}) {
  if (!convoId || typeof convoId !== 'string') return defaultProjectId;
  if (isProjectConversation(convoId)) return convoId.slice(PROJECT_CONVO.length) || defaultProjectId;
  // A session whose module is gone, or one that never recorded a project, is
  // not an error here: its conversation simply belongs to the default project.
  let found = null;
  try { found = sessionProject(convoId); } catch { found = null; }
  return found || defaultProjectId;
}

module.exports = { projectOfConversation, isProjectConversation, conversationOfProject, PROJECT_CONVO };
