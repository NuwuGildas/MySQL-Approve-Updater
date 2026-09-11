'use strict';
/* The base application's side of the host SDK.
 *
 * Loaded after the core scripts, this is the ONE place where core functions are
 * published to modules. A module reaches these through the object passed to its
 * activate(host); it never reads a global from app.js, and removing anything
 * from this file is the only way a module can lose access to it. */

HostSDK.provide({
  api: (url, options) => api(url, options),

  ui: {
    $, esc,
    icons: CC_ICON,
    toast: (message, state) => toast(message, state),
    confirm: (options) => confirmDialog(options),
    formAsModal: (formId, dialogId, hostId, closeBtnId) => formAsModal(formId, dialogId, hostId, closeBtnId),
    theme: () => document.documentElement.dataset.theme || 'dark',
    terminalTheme: () => termTheme(),
    openSettings: (section) => navigate('#/settings/' + (section || 'appearance')),
    startTour: () => (typeof startTour === 'function' ? startTour() : null),
    drawersHorizontal: () => document.body.classList.contains('drawers-h'),
    toggleDrawerOrientation: () => toggleDrawerOrient(),
    toggleTheme: () => toggleTheme(),
  },

  shell: {
    navigate: (route, options) => navigate(route, options),
    parseRoute: (hash) => parseRoute(hash),
    replaceRoute: (route) => replaceRoute(route),
    adoptPage: (id, route) => adoptPage(id, route),
    /** A view that closes itself sends the address home. Returns the observer. */
    watchPage: (element, pageId) => watchPageContainer(element, pageId),
    route: () => currentRoute,
    page: () => currentPageId,
    home: () => navigate(ROUTE_HOME, { replace: true, focus: false }),
    showCompass: () => showCompass(),
    moduleLabel: () => currentModuleLabel(),
  },

  /* The assistant window itself is core; modules drive it, they do not own it. */
  assistant: {
    open: () => openAgent(),
    close: () => closeAgentDrawer(),
    raise: () => raiseAgentWindow(),
    appendMessage: (role, text, actions, meta) => appendAgentMsg(role, text, actions, meta),
    appendProposal: (proposal) => appendAgentProposal(proposal),
    setStatus: (text, state) => setAgentStatus(text, state),
    setBusy: (busy) => setAgentBusyUi(busy),
    isBusy: () => agentBusy,
    cancel: () => agentCancel(),
    cancelling: () => agentCancelling,
    markStale: (sessionId, revision) => markStaleProposals(sessionId, revision),
    composerState: () => applyAgentComposerState(),
    renderChip: () => renderSshAgentChip(),
    cards: () => agentCards,
    feed: () => agentFeedEl,
    setFeed: (el) => { agentFeedEl = el; },
    /* A module that swaps the bound conversation must be able to drop the turn,
       the busy flag and the cancel flag in the same breath the host does. */
    setBusyFlag: (value) => { agentBusy = value; },
    setCancelling: (value) => { agentCancelling = value; },
    setTurn: (value) => { agentTurn = value; },
    restoreGeometry: () => restoreAgentGeom(),
    empty: () => renderAgentEmpty(),
    element: () => $('agentDrawer'),
    /* A module may park the assistant window inside its own workspace. Only one
       dock at a time, and it goes away with the module that provided it. */
    setDock: (implementation) => { HostSDK.provide({ assistantDock: implementation }); },
  },

  /* The conversation the assistant addresses. With no Servers module this is
     always the active project's; the module points it at a terminal session. */
  session: {
    current: () => sshAgent,
    set: (next) => { sshAgent = next; },
    patch: (fields) => { sshAgent = { ...sshAgent, ...fields }; },
    id: () => agentSessionId(),
    conversation: () => agentConversation(),
    setConversation: (id) => { agentConversationId = id; },
    epoch: () => agentSessionEpoch,
    bumpEpoch: () => ++agentSessionEpoch,
    bumpLoadSeq: () => ++agentLoadSeq,
    loadSeq: () => agentLoadSeq,
    pending: () => agentPendingSessions,
    isDead: (s) => sessionIsDead(s),
    ended: () => agentSessionEnded(),
    url: (path, extra) => agentSessionUrl(path, extra),
    body: (fields, sessionId) => agentSessionBody(fields, sessionId),
  },

  /* Read-only project context. Managing projects is the Projects module's job;
     having one is not, because the assistant always needs a conversation. */
  projects: {
    list: () => projects,
    load: () => api('/api/projects'),
    /* A module that just fetched the projects hands them back so the header
       switcher does not repeat the request. */
    publish: (list) => { if (Array.isArray(list)) { projects = list; renderProjectContext(); } },
    active: () => currentProject(),
    activeId: () => currentProjectId,
    set: (id) => setProject(id),
    reload: () => loadProjects(),
    renderContext: () => renderProjectContext(),
    body: (fields) => projectBody(fields),
    defaultId: () => DEFAULT_PROJECT_ID,
  },

  /* The core database tool, for modules that show or act on its state. */
  database: {
    loadRules: () => loadRules(),
    decide: (...args) => decide(...args),
    scopeSse: (sessionId) => scopeSse(sessionId),
    selectedRule: () => (typeof selected === 'function' ? selected() : null),
    ruleIcons: () => (typeof RULE_ICONS !== 'undefined' ? RULE_ICONS : {}),
    state: () => state,
  },
});

/* SSE traffic reaches modules through the host bus, so a module never installs
   its own EventSource handler on a core stream and never leaves one behind. */
function publishHostEvent(name, payload) { HostSDK.bus.emit(name, payload); }
