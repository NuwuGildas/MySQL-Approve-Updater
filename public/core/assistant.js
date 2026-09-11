/* ---------- AI agent ---------- */
/* The assistant window normally floats above whatever view is open. A module may
   park it inside its own workspace instead (the Terminals view does); with no such
   module installed there is no dock and the window is always the floating one. */
const assistantDock = () => HostSDK.core.assistantDock;
const agentIsDocked = () => { try { return !!assistantDock()?.isDocked(); } catch { return false; } };
const setWorkspaceTab = (tab) => { try { assistantDock()?.setTab(tab); } catch {} };
/* ---------- project context: the active project scopes the assistant's conversation ----------
   Projects come from GET /api/projects (lib/projects). The selection lives in localStorage and is sent
   as projectId with every assistant call; switching reloads the chat when the assistant is open. */
const PROJECT_KEY = 'st-project';
const DEFAULT_PROJECT_ID = 'general';
let projects = [];
let currentProjectId = (() => { try { return localStorage.getItem(PROJECT_KEY) || DEFAULT_PROJECT_ID; } catch { return DEFAULT_PROJECT_ID; } })();
const currentProject = () => projects.find((p) => p.id === currentProjectId) || null;
const currentProjectName = () => currentProject()?.name || (currentProjectId === DEFAULT_PROJECT_ID ? 'General' : currentProjectId);
/** URL with the active project (and any extra query params) appended, for GET assistant calls. */
function projectUrl(path, extra = {}) {
  const q = new URLSearchParams({ ...extra, projectId: currentProjectId });
  return `${path}?${q}`;
}
/** Body for POST assistant calls: the given fields plus the active project. */
const projectBody = (fields = {}) => JSON.stringify({ ...fields, projectId: currentProjectId, sessionId: agentSessionId() });
function renderProjectContext() {
  const p = currentProject();
  const name = currentProjectName();
  const color = p?.color || '';
  const sel = $('projSelect');
  if (sel) {
    sel.innerHTML = (projects.length ? projects : [{ id: DEFAULT_PROJECT_ID, name: 'General' }])
      .map((x) => `<option value="${esc(x.id)}"${x.id === currentProjectId ? ' selected' : ''}>${esc(x.name)}</option>`).join('');
    sel.value = currentProjectId;
    $('projSwitch').style.setProperty('--proj-color', color || 'var(--accent)');
    $('projSwitch').title = `Active project: ${name}${p?.description ? ' — ' + p.description : ''}`;
  }
  const triggerName = $('projTriggerName');
  if (triggerName) triggerName.textContent = name;
  if (typeof renderProjectMenu === 'function') renderProjectMenu();
  const chip = $('pageProject');
  if (chip) { $('pageProjectName').textContent = name; chip.style.setProperty('--proj-color', color || 'var(--accent)'); }
  const ag = $('agentProj');
  if (ag) { ag.textContent = ''; ag.hidden = true; }
}
async function loadProjects() {
  try {
    const d = await api('/api/projects');
    projects = Array.isArray(d.projects) ? d.projects : [];
    if (d.readOnly) $('projSwitch')?.setAttribute('data-readonly', '1'); else $('projSwitch')?.removeAttribute('data-readonly');
  } catch (e) {
    projects = [];
    toast('Could not load projects: ' + e.message, 'warning');
  }
  // a stored id whose project is gone falls back to General (or the first project) without losing the list
  if (projects.length && !projects.some((p) => p.id === currentProjectId)) {
    currentProjectId = projects.some((p) => p.id === DEFAULT_PROJECT_ID) ? DEFAULT_PROJECT_ID : projects[0].id;
    try { localStorage.setItem(PROJECT_KEY, currentProjectId); } catch {}
  }
  renderProjectContext();
  return projects;
}
/** Project navigation is independent of the selected server session and its chat. */
function setProject(id) {
  if (!id || id === currentProjectId) return;
  currentProjectId = id;
  try { localStorage.setItem(PROJECT_KEY, id); } catch {}
  renderProjectContext();
  document.dispatchEvent(new CustomEvent('st:project', { detail: { id, project: currentProject() } }));
  toast(`Project: ${currentProjectName()}`);
  // a session-bound conversation belongs to its terminal, not to the project: leave it alone.
  // An unbound one IS the project's, so it has to follow the switch.
  if (!agentSessionId() && (agentIsDocked() || $('agentDrawer').classList.contains('open'))) openAgent();
}
$('projSelect').addEventListener('change', (e) => setProject(e.target.value));
function renderProjectMenu(filter = '') {
  const host = $('projOptions'); if (!host) return;
  const q = String(filter || '').trim().toLowerCase();
  const list = (projects.length ? projects : [{ id: DEFAULT_PROJECT_ID, name: 'General' }]).filter((p) => !q || `${p.name} ${p.description || ''}`.toLowerCase().includes(q));
  host.innerHTML = list.length ? list.map((p) => `<button type="button" role="option" aria-selected="${p.id === currentProjectId}" class="proj-option${p.id === currentProjectId ? ' active' : ''}" data-project-id="${esc(p.id)}"><span class="proj-option-dot" style="--proj-color:${esc(p.color || 'var(--accent)')}" aria-hidden="true"></span><span class="proj-option-copy"><b>${esc(p.name)}</b><small>${p.id === currentProjectId ? 'Active project' : esc(p.description || 'Switch conversation')}</small></span>${p.id === currentProjectId ? '<span class="proj-option-check" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>' : ''}</button>`).join('') : '<div class="proj-menu-empty">No projects match that search.</div>';
  host.querySelectorAll('[data-project-id]').forEach((b) => b.addEventListener('click', () => { setProject(b.dataset.projectId); closeProjectMenu(); }));
}
function closeProjectMenu() { const m = $('projMenu'); if (!m) return; m.hidden = true; $('projTrigger')?.setAttribute('aria-expanded', 'false'); }
(function wireProjectMenu() {
  const trigger = $('projTrigger'), menu = $('projMenu'), search = $('projSearch'); if (!trigger || !menu) return;
  trigger.addEventListener('click', () => { const open = !menu.hidden; menu.hidden = open; trigger.setAttribute('aria-expanded', String(!open)); if (!open) { renderProjectMenu(search?.value || ''); setTimeout(() => search?.focus(), 0); } });
  search?.addEventListener('input', () => renderProjectMenu(search.value));
  document.addEventListener('click', (e) => { if (!e.target.closest('#projSwitch')) closeProjectMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { closeProjectMenu(); trigger.focus(); } });
  $('projCreate')?.addEventListener('click', () => { closeProjectMenu(); if (typeof navigate === 'function') navigate('#/projects'); setTimeout(() => $('btnPjAdd')?.click(), 80); });
  $('projManage')?.addEventListener('click', () => { closeProjectMenu(); if (typeof navigate === 'function') navigate('#/projects'); });
})();
// Project context is loaded by startApplication after all libraries register.
// loadSshAgent() runs once the terminal workspace is wired (end of this file): it paints the
// session chip AND the workspace identity row, which do not exist as bindings before then.

let agentBusy = false;
let agentFeedEl = null; // live-feed container of the in-flight "Working…" bubble
const agentCards = new Map(); // proposal id -> its card element, so a late status finds its card

$('btnAiAgent').addEventListener('click', () => {
  // in the terminal workspace the chat is a pane, not a window: reveal and focus it instead
  if (agentIsDocked()) { setWorkspaceTab('chat'); $('agentInput')?.focus(); return; }
  if ($('agentDrawer').classList.contains('open')) closeAgentDrawer();
  else openAgent();
});
// The agent window lives in the browser's top layer (popover="manual") so it floats above every module,
// drawer and modal dialog. It is never closed by navigation: only its own close button / Escape hide it.
const agentPopover = () => { const el = $('agentDrawer'); return 'showPopover' in el && el.hasAttribute('popover') ? el : null; };
function raiseAgentWindow() { // (re)show the popover so it sits on top of the top layer, e.g. above a dialog opened later
  const el = agentPopover(); if (!el || !$('agentDrawer').classList.contains('open')) return;
  try { if (el.matches(':popover-open')) el.hidePopover(); el.showPopover(); } catch {}
  raiseQuickFab();
}
const closeAgentDrawer = () => {
  if (agentIsDocked()) return; // parked in the terminal workspace: the pane owns it, nothing to close
  $('agentDrawer').classList.remove('open');
  document.body.classList.remove('ssh-shared-workspace');
  const el = agentPopover(); try { if (el && el.matches(':popover-open')) el.hidePopover(); } catch {}
};
/* Modal dialogs without the browser's inert lock.
   Native showModal() makes everything outside the dialog inert, including the AI agent window and the
   quick-access button. Dialogs are opened non-modally instead and given a shared backdrop, so they still
   look and behave like modals (centered, dimmed page, page clicks blocked, Escape cancels) while the
   agent window in the top layer stays usable above them. */
(function emulateModalDialogs() {
  if (typeof HTMLDialogElement === 'undefined' || HTMLDialogElement.prototype.__stModal) return;
  HTMLDialogElement.prototype.__stModal = true;
  const stack = []; let backdrop = null;
  const inertSaved = new Map(); // body children we made inert → whether they already were
  const isFocusable = (el) => el && !el.disabled && !el.closest('[inert]') && el.getClientRects().length > 0;
  const focusInto = (d) => {
    if (d.contains(document.activeElement)) return;
    const el = d.querySelector('[autofocus]') || [...d.querySelectorAll('input, select, textarea, button, [href], [tabindex]:not([tabindex="-1"])')].find(isFocusable);
    try { (el || d).focus({ preventScroll: true }); } catch {}
    if (!el && !d.hasAttribute('tabindex')) { d.setAttribute('tabindex', '-1'); try { d.focus({ preventScroll: true }); } catch {} }
  };
  const sync = () => {
    if (!backdrop) {
      backdrop = document.createElement('div'); backdrop.id = 'stBackdrop'; backdrop.hidden = true;
      backdrop.addEventListener('pointerdown', (e) => e.preventDefault()); // swallow page clicks like a real backdrop
      document.body.appendChild(backdrop);
    }
    const top = stack[stack.length - 1];
    backdrop.hidden = !top;
    document.body.classList.toggle('st-modal-open', !!top);
    stack.forEach((d, i) => { d.style.zIndex = String(1001 + i * 2); });
    if (top) backdrop.style.zIndex = String(1000 + (stack.length - 1) * 2);
    // only the topmost dialog and the (intentionally available) assistant window can receive interaction
    if (top) {
      for (const el of document.body.children) {
        const keep = el === top || el === backdrop || el.id === 'agentDrawer' || el.tagName === 'SCRIPT' || el.tagName === 'svg';
        if (keep) { if (inertSaved.has(el) && !inertSaved.get(el)) el.removeAttribute('inert'); continue; }
        if (!inertSaved.has(el)) inertSaved.set(el, el.hasAttribute('inert'));
        el.setAttribute('inert', '');
      }
      document.documentElement.classList.add('st-scroll-lock');
      focusInto(top);
    } else {
      for (const [el, had] of inertSaved) if (!had) el.removeAttribute('inert');
      inertSaved.clear();
      document.documentElement.classList.remove('st-scroll-lock');
    }
  };
  HTMLDialogElement.prototype.showModal = function () {
    if (this.open) return;
    this.dataset.stModal = '1';
    this.__stOpener = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
    this.show();
    stack.push(this);
    this.addEventListener('close', () => {
      const i = stack.indexOf(this); if (i >= 0) stack.splice(i, 1);
      delete this.dataset.stModal; this.style.zIndex = ''; sync();
      const back = this.__stOpener; this.__stOpener = null;
      const below = stack[stack.length - 1];
      if (below) focusInto(below);
      else if (back && back.isConnected && !back.closest('[inert]') && back.getClientRects().length) { try { back.focus({ preventScroll: true }); } catch {} }
    }, { once: true });
    sync();
    raiseAgentWindow(); // keep the agent above the dialog it may have been asked from
  };
  // Tab / Shift+Tab wrap inside the topmost dialog (focus never reaches the browser chrome or the page behind)
  document.addEventListener('keydown', (e) => {
    const top = stack[stack.length - 1]; if (!top || e.key !== 'Tab') return;
    if ($('agentDrawer')?.contains(e.target)) return; // the assistant window keeps its own natural order
    const items = [...top.querySelectorAll('input, select, textarea, button, [href], [tabindex]:not([tabindex="-1"])')].filter(isFocusable);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (!e.shiftKey && (e.target === last || !top.contains(e.target))) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && (e.target === first || !top.contains(e.target))) { e.preventDefault(); last.focus(); }
  });
  // a Tab that escapes the dialog (e.g. from the last control) wraps back into it
  document.addEventListener('focusin', (e) => {
    const top = stack[stack.length - 1]; if (!top) return;
    const t = e.target;
    if (top.contains(t) || $('agentDrawer')?.contains(t) || t === document.body) return;
    focusInto(top);
  });
  document.addEventListener('keydown', (e) => { // Escape = native cancel: cancelable "cancel" event, then close()
    if (e.key !== 'Escape' || e.defaultPrevented || !stack.length) return;
    const top = stack[stack.length - 1]; if (!top.open) return;
    if (top.dispatchEvent(new Event('cancel', { cancelable: true }))) top.close();
    e.preventDefault(); e.stopImmediatePropagation(); // the Escape was consumed by the dialog: no other view reacts
  });
})();
function raiseQuickFab() { // the quick-access button sits in the top layer too, always above the agent window
  const f = $('quickFab'); if (!f || !('showPopover' in f) || !f.hasAttribute('popover')) return;
  try { if (f.matches(':popover-open')) f.hidePopover(); f.showPopover(); } catch {}
}
$('btnAgentClose').addEventListener('click', closeAgentDrawer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !e.defaultPrevented && $('agentDrawer').classList.contains('open') && !document.querySelector('dialog[open]')) {
    if (!$('agentMenu').hidden || !$('agentScopePop').hidden) { agentMenuOpen(false); agentScopeOpen(false); return; }
    closeAgentDrawer();
  }
});

async function openAgent() { // never closes whatever view/module is open: the window floats above it
  // With no terminal session bound this loads the ACTIVE PROJECT's conversation, exactly as the
  // assistant behaved before terminal sessions existed. It is a scope, not a missing prerequisite.
  const sessionId = agentSessionId(), epoch = agentSessionEpoch, request = ++agentLoadSeq;
  $('agentDrawer').classList.add('open');
  document.body.classList.toggle('ssh-shared-workspace', $('sshDrawer').classList.contains('open'));
  raiseAgentWindow();
  restoreAgentGeom(); // place/size the floating window from the last saved geometry
  $('agentConnect').hidden = true;
  $('agentChatWrap').hidden = true;
  $('btnAgentReset').hidden = $('btnAgentDisconnect').hidden = true;
  setAgentStatus('Loading this session…', 'busy');
  try {
    const st = await api(agentSessionUrl('/api/agent', { probe: '1' }));
    if (sessionId !== agentSessionId() || epoch !== agentSessionEpoch || request !== agentLoadSeq) return;
    // the server names this conversation; point the live stream at it rather than guessing
    agentConversationId = st.conversationId || st.sessionId || null;
    scopeSse();
    document.body.classList.toggle('agent-on', st.connected);
    if (st.connected) showAgentChat(st);
    else showAgentConnect(st);
  } catch (e) {
    if (sessionId !== agentSessionId() || epoch !== agentSessionEpoch || request !== agentLoadSeq) return;
    setAgentStatus(e.message, 'bad');
  }
}
// header status line: state dot + short text (connected provider, or what is going on)
function setAgentStatus(text, state) {
  const dot = state === 'ok' ? 'ok' : state === 'busy' ? 'busy' : state === 'bad' ? '' : 'off';
  $('agentStatus').innerHTML = `<span class="dot ${dot}"></span><span>${esc(text)}</span>`;
}

// gate agent-dependent UI (e.g. "add to chat" on rule cards) from startup
api('/api/agent').then((st) => document.body.classList.toggle('agent-on', st.connected)).catch(() => {});

function showAgentConnect(st) {
  setAgentStatus('Not connected', 'off');
  $('agentConnect').hidden = false;
  const box = $('agentProviders');
  box.innerHTML = '';
  for (const [key, p] of Object.entries(st.providers)) {
    const el = document.createElement('div');
    el.className = 'agent-prov' + (p.kind === 'api' ? ' api' : '');
    if (p.kind === 'api') {
      el.innerHTML = `
        <div style="flex:1;min-width:0">
          <div class="pname">${esc(p.label)}</div>
          <div class="pstat">Easiest: <b>Sign in with Claude</b> opens claude.ai in a new tab for authorization. Alternatively paste an API key (console.anthropic.com) or a token from <b>claude setup-token</b>.</div>
          <div class="ag-conn-grid">
            <label for="agApiKey">API key or sign-in token <span class="hint" style="margin:0">(optional when you sign in below)</span></label>
            <input id="agApiKey" class="p-key" type="password" autocomplete="off" placeholder="sk-ant-api… or sk-ant-oat…">
            <label for="agApiModel">Model</label>
            <input id="agApiModel" class="p-model" placeholder="default: claude-sonnet-4-5">
          </div>
          <div class="ag-conn-actions">
            <button type="button" class="p-oauth">Sign in with Claude</button>
            <span class="hint" style="margin:0">opens claude.ai in a new tab; paste the code it shows</span>
          </div>
          <div class="p-oauth-step" hidden style="margin-top:.45rem">
            <div class="pstat">An authorization tab was opened. Approve access there, copy the code it shows, and paste it here:</div>
            <div class="ag-conn-grid">
              <label for="agApiCode">Authorization code</label>
              <input id="agApiCode" class="p-code" autocomplete="off" placeholder="paste the authorization code">
            </div>
            <div class="ag-conn-actions"><button type="button" class="primary p-finish">Complete sign-in</button></div>
          </div>
        </div>
        <button class="primary" data-prov="${esc(key)}">Connect</button>`;
      el.querySelector('.p-oauth').addEventListener('click', async (e) => {
        try {
          const r = await api('/api/agent/oauth/start', { method: 'POST', body: '{}' });
          window.open(r.url, '_blank');
          el.querySelector('.p-oauth-step').hidden = false;
          el.querySelector('.p-code').focus();
        } catch (err) { toast(err.message); }
      });
      el.querySelector('.p-finish').addEventListener('click', async (e) => {
        e.target.disabled = true;
        e.target.textContent = 'Verifying…';
        try {
          await api('/api/agent/oauth/finish', {
            method: 'POST',
            body: JSON.stringify({ code: el.querySelector('.p-code').value.trim(), model: el.querySelector('.p-model').value.trim() }),
          });
          openAgent();
        } catch (err) {
          toast(err.message);
          el.querySelector('.p-code').value = ''; // codes are single-use: never re-paste a failed one
          el.querySelector('.p-code').placeholder = 'code rejected - click "Sign in with Claude" again for a fresh one';
        } finally {
          e.target.disabled = false;
          e.target.textContent = 'Complete sign-in';
        }
      });
    } else {
      el.innerHTML = `
        <div style="min-width:0">
          <div class="pname">${esc(p.label)}</div>
          <div class="pstat ${p.available ? 'ok' : 'no'}">${p.available ? `detected ("${esc(p.cmd)}" CLI works)` : `not found: install it and make "${esc(p.cmd)}" available on PATH`}</div>
        </div>
        <span class="spacer"></span>
        <button class="primary" data-prov="${esc(key)}" ${p.available ? '' : 'disabled'}>Connect</button>`;
    }
    el.querySelector('[data-prov]').addEventListener('click', async (e) => {
      const body = { provider: key };
      if (p.kind === 'api') {
        body.apiKey = el.querySelector('.p-key').value.trim();
        body.model = el.querySelector('.p-model').value.trim();
      }
      e.target.disabled = true;
      e.target.textContent = p.kind === 'api' ? 'Validating…' : 'Connecting…';
      try {
        await api('/api/agent/connect', { method: 'POST', body: JSON.stringify(body) });
        openAgent();
      } catch (err) {
        toast(err.message);
      } finally {
        e.target.disabled = false;
        e.target.textContent = 'Connect';
      }
    });
    box.appendChild(el);
  }
}

function showAgentChat(st) {
  const providerLabel = st.providers[st.provider]?.label || st.provider;
  setAgentStatus(providerLabel, 'ok');
  $('agentConnect').hidden = true;
  $('agentChatWrap').hidden = false;
  $('btnAgentReset').hidden = $('btnAgentDisconnect').hidden = false;
  const bound = !!agentSessionId();
  $('agentScopeText').textContent = bound ? 'Every command needs approval' : 'Read-only';
  $('agentScopePop').innerHTML = bound
    ? `<dl>
      <dt>Server</dt><dd>${esc(sshAgent.name || sshAgent.host || '')}</dd>
      <dt>Session</dt><dd>${esc(agentSessionId())}</dd>
      <dt>Terminal control</dt><dd>${sshAgent.terminal?.control === 'assistant' ? 'AI assistant' : 'You'}</dd>
      <dt>Agent</dt><dd>${esc(providerLabel)}</dd>
      <dt>Model</dt><dd>${esc(st.model || 'provider default')}</dd>
    </dl>
    <div class="hint">The assistant reads the same terminal output you see. Give it terminal control before running a proposed command. Each command needs your acceptance; reject it or reply with an alternative. This conversation belongs only to this server session.</div>`
    : `<dl>
      <dt>Scope</dt><dd>Project “${esc(currentProjectName())}”</dd>
      <dt>Server access</dt><dd>None: connect a server to work on one</dd>
      <dt>Agent</dt><dd>${esc(providerLabel)}</dd>
      <dt>Model</dt><dd>${esc(st.model || 'provider default')}</dd>
    </dl>
    <div class="hint">Database and deployment access is read-only. Rule changes, deploy manifests and deploy actions come back as proposals you approve here. Open a server terminal to give this assistant a shell to work in.</div>`;
  // model switcher: provider-appropriate suggestions, current value prefilled
  const claudeModels = ['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-5', 'claude-opus-4-1', 'claude-3-5-haiku-latest'];
  const codexModels = ['gpt-5-codex', 'gpt-5', 'o4-mini', 'gpt-4.1'];
  const suggestions = st.provider === 'codex' ? codexModels : claudeModels;
  $('agentModelList').innerHTML = suggestions.map((m) => `<option value="${esc(m)}">`).join('');
  $('agentModel').value = st.model || '';
  agentModelSaved = st.model || '';
  renderProjectContext(); // the sub-line names the project this conversation belongs to
  $('agentMessages').innerHTML = '';
  agentCards.clear();
  for (const m of st.chat || []) appendAgentMsg(m.role, m.text, null, m);
  for (const p of st.proposals || []) appendAgentProposal(p);
  if (!$('agentMessages').children.length || [...$('agentMessages').children].every((el) => el.classList.contains('agent-session-note'))) renderAgentEmpty();
  agentBusy = !!st.busy || agentPendingSessions.has(agentSessionId());
  setAgentBusyUi(agentBusy);
  if (agentBusy) addAgentWorking();
  renderSshAgentChip();
  applyAgentComposerState(); // an ended session comes back read-only, cards and all
  if (!$('agentInput').disabled) $('agentInput').focus();
}

// empty conversation: identity + a few starter prompts (chips send the prompt as a normal message)
const SESSION_STARTERS = [
  ['Read terminal output', 'Read the output from our shared terminal and explain what is happening.'],
  ['Check server health', 'Propose commands to check this server’s health, disk space and services. Explain each before I accept it.'],
  ['Resume our work', 'Summarize where we left off in this server session and suggest the next step.'],
];
const PROJECT_STARTERS = [
  ['Check the schema', 'Which tables and columns does the current rule set touch? Point out anything that looks risky.'],
  ['Explain a rule', 'Pick the most complex rule and explain what it changes, step by step.'],
  ['Review a deployment', 'Summarise this project’s deploy targets and the state of their most recent runs.'],
];
function renderAgentEmpty() {
  const el = document.createElement('div');
  el.className = 'ag-empty';
  const bound = !!agentSessionId(), ended = agentSessionEnded();
  const starters = bound ? SESSION_STARTERS : PROJECT_STARTERS;
  el.innerHTML = `<span class="ag-ico"><img class="ai-mini" src="/assets/robot-logo-animated_1.svg" alt="" aria-hidden="true"></span>
    <h3>${ended ? 'Nothing was said in this session' : bound ? `Work together on ${esc(sshAgent.name || 'this server')}` : 'What would you like to explore?'}</h3>
    ${ended ? '' : `<p>${bound
      ? 'You and the assistant share the terminal beside this chat. Ask it to explain output or propose the next command.'
      : 'Ask about rules, schema, data or deployments. Access is read-only; changes come back as proposals for you to approve.'}</p>`}
    <p class="hint" style="margin:0">${ended
      ? `This session on <b>${esc(sshAgent.name || 'the server')}</b> has ended and is read-only. Start a terminal on it for a new session with its own history.`
      : bound
        ? 'Only this session’s conversation appears here. Every AI command needs your approval. No agent needs to be installed on the server.'
        : `Conversation for project <b>${esc(currentProjectName())}</b>. Open a server terminal to give the assistant a shell to work in.`}</p>
    <div class="ag-sugg">${ended ? '' : starters.map(([label], i) => `<button type="button" class="chip-btn" data-starter="${i}">${esc(label)}</button>`).join('')}</div>`;
  el.querySelectorAll('[data-starter]').forEach((b) => b.addEventListener('click', () => {
    $('agentInput').value = starters[+b.dataset.starter][1];
    agentSend();
  }));
  $('agentMessages').appendChild(el);
}
// minimal, escape-first rendering of agent replies: fenced code blocks, inline code, bold
function renderAgentText(text) {
  let s = esc(text);
  s = s.replace(/```([a-z0-9_-]*)\n([\s\S]*?)```/g, (m, lang, code) => `<pre><code${lang ? ` data-lang="${lang}"` : ''}>${code.replace(/\n$/, '')}</code></pre>`);
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  return s;
}

function appendAgentMsg(role, text, actions, meta) {
  const empty = $('agentMessages').querySelector('.ag-empty'); if (empty) empty.remove();
  const el = document.createElement('div');
  if (role === 'note') {
    if (meta?.kind === 'context' && meta.rule) {
      // attached-rule context: render as a card, not a JSON blob
      const t = meta.rule;
      el.className = 'agent-ctx-card';
      el.innerHTML = `
        <div class="ap-head">Context attached: <b>${esc(t.name)}</b>${t.draft ? ' <span class="badge draftbadge">draft</span>' : ''}</div>
        <div class="ap-meta">${esc(t.table)} · WHERE ${esc(String(t.where || '1=1').replace(/\s+/g, ' ').slice(0, 90))}${String(t.where || '').length > 90 ? '…' : ''} · ${t.transforms.length} transform(s)</div>
        <details><summary>Full definition</summary><pre>${esc(JSON.stringify(t, null, 2))}</pre></details>`;
    } else if (meta?.kind === 'review') {
      el.className = 'agent-ctx-card';
      el.innerHTML = `
        <div class="ap-head">AI review shared <span class="badge ai-${esc(meta.verdict)}">${esc(meta.verdict)}</span></div>
        <div class="ap-meta">${esc(meta.rule || '')} · ${esc(meta.table || '')} pk=${esc(String(meta.pk))} · ${esc(meta.columns || '')}</div>
        <div class="txt" style="margin-top:.3rem">${esc(meta.summary || '')}</div>`;
    } else if (meta?.kind === 'run-log') {
      // a deploy log shared from The Ascension: summary card with the redacted tail folded
      el.className = 'agent-ctx-card';
      el.innerHTML = `
        <div class="ap-head">Log shared: <b>${esc(meta.mode || 'run')}</b> on <b>${esc(meta.target || '')}</b> <span class="badge ${esc(meta.status || '')}">${esc(String(meta.status || '').replace('_', ' '))}</span></div>
        <div class="ap-meta">${esc(meta.runId || '')}${meta.stage ? ` · stage ${esc(meta.stage)}` : ''}${meta.error ? ` · ${esc(String(meta.error).slice(0, 120))}` : ''}</div>
        <details><summary>${(meta.lines || []).length} log line(s)</summary><pre>${esc((meta.lines || []).join('\n'))}</pre></details>`;
    } else if (meta?.kind === 'ssh-attach') {
      el.className = 'agent-session-note';
      el.innerHTML = `<details><summary>Session connected</summary><div class="agent-note-body">${esc(text)}</div></details>`;
    } else if (meta?.kind === 'deploy-explain' || meta?.kind === 'deploy-preship') {
      el.className = 'agent-report';
      const title = meta.kind === 'deploy-explain' ? 'Deployment analysis' : 'Pre-ship review';
      const lines = String(text || '').split('\n');
      const context = lines.shift() || '';
      // Keep the saved note intact, but separate its identity from its formatted report.
      el.innerHTML = `<details><summary><span>${title}</span><small>${esc(meta.runId || 'View review')}</small></summary><div class="agent-report-body"><p class="agent-report-context">${esc(context)}</p><div class="txt">${renderAgentText(lines.join('\n'))}</div></div></details>`;
    } else if (meta?.kind === 'decision') {
      el.className = 'agent-note';
      el.innerHTML = meta.proposalKind && meta.proposalKind !== 'rule'
        ? `<span class="badge ${meta.decision === 'approved' ? 'approved' : 'rejected'}">${esc(meta.decision)}</span> ${esc(String(text || '').replace(/^User (approved|rejected) the agent's /, ''))}`
        : `<span class="badge ${meta.decision === 'approved' ? 'approved' : 'rejected'}">${esc(meta.decision)}</span> rule ${esc(meta.proposalAction || '')} proposal <b>${esc(meta.ruleName || '')}</b>`;
    } else {
      if (String(text || '').length > 280 || String(text || '').split('\n').length > 3) {
        el.className = 'agent-report';
        el.innerHTML = `<details><summary>Activity details</summary><div class="agent-report-body txt">${renderAgentText(text)}</div></details>`;
      } else {
        el.className = 'agent-note';
        el.textContent = text;
      }
    }
    $('agentMessages').appendChild(el);
    $('agentMessages').scrollTop = $('agentMessages').scrollHeight;
    return el;
  }
  el.className = 'agent-msg ' + (role === 'user' ? 'user' : 'ai');
  const acts = (actions && actions.length)
    ? `<details class="agent-actions"><summary>${actions.length} action${actions.length === 1 ? '' : 's'} taken${actions.some((a) => !a.ok) ? ' · some failed' : ''}</summary>${actions.map((a) =>
        `<div class="agent-action ${a.ok ? '' : 'err'}"><span>${esc(a.tool)}</span><code>${esc(JSON.stringify(a.input))}</code><span class="ms">${a.ms} ms</span></div>`).join('')}</details>`
    : '';
  const who = role === 'user' ? 'You' : '<span class="ag-ico"><img class="ai-mini" src="/assets/robot-logo-animated_1.svg" alt="" aria-hidden="true"></span>AI Agent';
  el.innerHTML = `<div class="who">${who}</div><div class="txt">${renderAgentText(text)}</div>${acts}`;
  $('agentMessages').appendChild(el);
  $('agentMessages').scrollTop = $('agentMessages').scrollHeight;
  return el;
}

/* An approval card carries its state for its whole life, not only while it is clickable:
   pending → running → done (with the exit code) / failed / rejected / superseded / stale. */
const AP_STATE = {
  pending: ['pending', ''],
  running: ['running…', 'draftbadge'],
  approved: ['approved', 'approved'],
  done: ['done', 'approved'],
  rejected: ['rejected', 'rejected'],
  failed: ['failed', 'rejected'],
  superseded: ['superseded', 'draftbadge'],
  stale: ['stale', 'draftbadge'],
};
/* The one place that paints a card's state, so click handlers and late updates agree on the look. */
function setProposalState(el, state, detail) {
  if (!el) return;
  const [label, cls] = AP_STATE[state] || [state, ''];
  el.dataset.state = state;
  // only a pending card is clickable: this is what stops a double click executing twice
  el.querySelectorAll('button').forEach((b) => { b.disabled = state !== 'pending'; });
  if (state !== 'pending') { const alt = el.querySelector('.agent-alternative'); if (alt) alt.hidden = true; }
  let st = el.querySelector('.ap-state');
  if (!st) { st = document.createElement('span'); st.className = 'ap-state'; (el.querySelector('.actions') || el).appendChild(st); }
  st.innerHTML = `<span class="badge ${cls}">${esc(label)}</span>${detail ? ` <span class="hint" style="margin:0">${esc(detail)}</span>` : ''}`;
}
/* Turn what the decision route returned into one of those states. The exit code lives on
   result.exitCode for a shared-terminal command; other proposal kinds have no result at all. */
function applyProposalResult(el, r, decision) {
  const res = r?.result || null;
  const out = el.querySelector('.ap-out');
  if (out && res) {
    const text = [res.stdout, res.stderr].filter(Boolean).join('\n').trim();
    if (text) { out.hidden = false; out.querySelector('pre').textContent = text.slice(-4000); }
  }
  if (decision === 'alternative') return setProposalState(el, 'superseded', 'replaced by your instruction');
  if ((r?.status || r?.decision) === 'rejected') return setProposalState(el, 'rejected');
  if (res?.timedOut) return setProposalState(el, 'failed', 'timed out');
  if (res?.cancelled) return setProposalState(el, 'failed', 'interrupted');
  const code = res && res.exitCode != null ? Number(res.exitCode) : null;
  if (code != null) return setProposalState(el, code === 0 ? 'done' : 'failed', `exit code ${code}`);
  setProposalState(el, 'approved');
}
/* The terminal moved on, so an approval sealed to an older revision can no longer be replayed
   (lib/ssh-agent refuses it). Say so on the card instead of letting the user click into a 409. */
function markStaleProposals(sessionId, revision) {
  if (!sessionId || sessionId !== agentSessionId() || !Number.isFinite(revision)) return;
  for (const el of agentCards.values()) {
    if (el.dataset.state !== 'pending' || el.dataset.revision === undefined) continue;
    if (Number(el.dataset.revision) < revision) setProposalState(el, 'stale', 'the terminal moved on since this was proposed');
  }
}
/* The decision and the turn that interprets it are ONE server operation, so render what came back
   instead of reloading: a reload would drop the card the user just acted on. */
function renderDecisionContinuation(cont, decision, alternative) {
  if (decision === 'alternative' && alternative) appendAgentMsg('user', alternative);
  if (!cont) return;
  if (cont.state === 'skipped') return void appendAgentMsg('note', 'No AI provider is connected: your instruction is kept for when one is.');
  if (cont.state === 'cancelled') return void appendAgentMsg('note', 'Reply stopped by the user.');
  if (cont.state === 'failed') return void appendAgentMsg('ai', 'Error: ' + (cont.reason || 'the assistant could not continue'));
  if (cont.reply) appendAgentMsg('ai', cont.reply, cont.actions);
  (cont.proposals || []).forEach(appendAgentProposal);
}

/* rule proposal card: the user gate for agent rule changes */
function appendAgentProposal(p) {
  // a card named for another session is not ours; one with no session belongs to whatever
  // conversation is on screen (rule and deploy proposals are not session-bound)
  if (p.sessionId && p.sessionId !== agentSessionId()) return;
  const el = document.createElement('div');
  el.className = 'agent-proposal';
  el.dataset.proposal = p.id;
  el.dataset.state = 'pending';
  if (p.revision != null) el.dataset.revision = String(p.revision); // the terminal revision it is sealed to
  agentCards.set(p.id, el);
  /* A module that owns a proposal kind draws its own card. The host still owns
     the decision: the module is handed `wire`, never the approval endpoint. */
  const contributed = HostSDK.proposalRenderers.get(p.kind);
  if (contributed) {
    try {
      contributed.render(el, p, { wire: (onDone) => wireAgentProposalDecision(el, p, onDone), esc, toast });
      $('agentMessages').appendChild(el);
      $('agentMessages').scrollTop = $('agentMessages').scrollHeight;
      return;
    } catch (error) { console.error(`${contributed.moduleId}: proposal card failed`, error); }
  }
  const t = p.rule;
  if (!t) {
    el.innerHTML = `<div class="ap-head">${esc(p.kind || 'Action')} proposal</div><pre>${esc(JSON.stringify(p, null, 2))}</pre><div class="actions"><button class="approve" data-dec="approve">Accept</button><button class="reject" data-dec="reject">Reject</button></div>`;
    wireAgentProposalDecision(el, p);
    $('agentMessages').appendChild(el);
    return;
  }
  el.innerHTML = `
    <div class="ap-head">Rule ${p.action === 'update' ? `update: <b>${esc(p.targetName || '')}</b> → <b>${esc(t.name)}</b>` : `proposal: <b>${esc(t.name)}</b>`}
      ${t.draft ? '<span class="badge draftbadge">draft</span>' : ''}</div>
    <div class="ap-meta">${esc(t.table)} · WHERE ${esc(t.where || '1=1')} · limit ${t.limit} · ${t.transforms.length} transform(s)</div>
    <details><summary>Full definition</summary><pre>${esc(JSON.stringify(t, null, 2))}</pre></details>
    <div class="actions">
      <button class="approve" data-dec="approve">Approve and save</button>
      <button class="reject" data-dec="reject">Reject</button>
    </div>`;
  wireAgentProposalDecision(el, p, (r) => {
    appendAgentMsg('note', '', null, { kind: 'decision', decision: r.status, proposalAction: p.action, ruleName: t.name });
    if (r.status === 'approved') loadRules();
  });
  $('agentMessages').appendChild(el);
  $('agentMessages').scrollTop = $('agentMessages').scrollHeight;
}

// A card the server has already spent, or one sealed to a terminal that has moved on, is not
// pending any more: say why on the card rather than inviting the user to click into the same 409.
const AP_SPENT_RE = /no longer pending|already (?:approved|rejected|failed|executing)|terminal changed|classification changed|not found in this server session/i;
const AP_STALE_RE = /terminal changed|classification changed|closed or belongs to another/i;

/* One function owns a card's decision, so "first click wins" is a property of the card and not of
   whichever button was pressed. Accept / Reject / Alternative all pass through here. */
function wireAgentProposalDecision(el, p, onDone) {
  const sessionId = p.sessionId || agentSessionId(), epoch = agentSessionEpoch;
  const actions = el.querySelector('.actions');
  actions.insertAdjacentHTML('beforeend', '<button type="button" data-alternative>Reply with alternative</button>');
  const reply = document.createElement('form');
  reply.className = 'agent-alternative'; reply.hidden = true;
  reply.innerHTML = '<label>What should the assistant do instead?<textarea required rows="2" placeholder="For example: check the configuration before restarting"></textarea></label><div class="actions"><button type="submit" class="primary">Reject and send alternative</button><button type="button" data-cancel-alternative>Cancel</button></div>';
  el.appendChild(reply);
  // "Reply with alternative" only opens the box: the decision is not spent until it is sent
  actions.querySelector('[data-alternative]').addEventListener('click', () => { if (el.dataset.state !== 'pending') return; reply.hidden = false; reply.querySelector('textarea').focus(); });
  reply.querySelector('[data-cancel-alternative]').addEventListener('click', () => { reply.hidden = true; actions.querySelector('[data-alternative]').focus(); });
  const decide = async (decision, alternative) => {
    // first click wins: a second one finds the card no longer pending and does nothing at all
    if (el.dataset.state !== 'pending') return;
    if (sessionId !== agentSessionId() || epoch !== agentSessionEpoch) return;
    setProposalState(el,
      decision === 'approve' ? 'running' : decision === 'alternative' ? 'superseded' : 'rejected',
      decision === 'approve' ? 'sent to the shared terminal' : decision === 'alternative' ? 'replaced by your instruction' : '');
    // the decision resumes the SAME turn on the server, so show the work while it runs and give
    // the turn an identity: events for anything else are dropped by the SSE guards
    const turn = agentTurn = { sessionId, turnId: null, cancelled: false };
    agentPendingSessions.add(sessionId);
    agentBusy = true; setAgentBusyUi(true);
    const working = addAgentWorking();
    $('agentMessages').scrollTop = $('agentMessages').scrollHeight;
    try {
      const r = await api('/api/agent/proposal/' + encodeURIComponent(p.id), { method: 'POST', body: agentSessionBody({ decision, ...(alternative ? { alternative } : {}) }, sessionId) });
      working.remove();
      // a reply that lands after the user moved on, or after Stop, is not ours to paint
      if (sessionId !== agentSessionId() || epoch !== agentSessionEpoch || turn.cancelled) return;
      applyProposalResult(el, r, decision);
      if (onDone) { try { onDone(r, decision); } catch (err) { console.error('proposal side effect', err); } }
      renderDecisionContinuation(r.continuation, decision, alternative);
    } catch (e) {
      working.remove();
      if (sessionId !== agentSessionId() || epoch !== agentSessionEpoch) return;
      toast(e.message, 'error');
      if (AP_SPENT_RE.test(e.message)) setProposalState(el, AP_STALE_RE.test(e.message) ? 'stale' : 'superseded', e.message);
      else setProposalState(el, 'pending', 'not sent: ' + e.message); // a transport failure is not a decision
    } finally {
      agentPendingSessions.delete(sessionId);
      if (agentTurn === turn) { agentTurn = null; agentFeedEl = null; agentBusy = false; setAgentBusyUi(false); }
    }
  };
  actions.querySelectorAll('[data-dec]').forEach((b) => b.addEventListener('click', () => decide(b.dataset.dec)));
  reply.addEventListener('submit', (e) => { e.preventDefault(); const alternative = reply.querySelector('textarea').value.trim(); if (alternative) decide('alternative', alternative); });
}

function setAgentBusyUi(busy) {
  document.body.classList.toggle('agent-busy', busy);
  $('btnAgentSend').classList.toggle('busy', busy);
  $('btnAgentSend').title = busy ? 'Stop this session’s reply' : 'Send (Enter)';
}
function addAgentWorking() {
  const pending = document.createElement('div');
  pending.className = 'agent-working';
  pending.innerHTML = '<div class="aw-head"><span class="spinner"></span><span>Working…</span></div><div class="agent-feed ql-steps"></div><div class="agent-stream" hidden></div>';
  $('agentMessages').appendChild(pending);
  agentFeedEl = pending.querySelector('.agent-feed');
  return pending;
}

async function agentSend() {
  if (agentBusy) return;
  // sessionId null is the project conversation: a valid target, not a missing prerequisite
  const sessionId = agentSessionId(), epoch = agentSessionEpoch;
  if (agentSessionEnded()) { toast('This terminal session has ended: start a new one to continue', 'warning'); return; }
  const msg = $('agentInput').value.trim();
  if (!msg) return;
  // every turn gets an identity, so a reply (or a stream of events) can be matched back to the
  // session and the turn that asked for it; a superseded or cancelled one is dropped, not painted
  const turn = agentTurn = { sessionId, turnId: null, cancelled: false };
  agentBusy = true;
  agentPendingSessions.add(sessionId);
  $('btnAgentSend').classList.add('busy'); // the send action becomes Stop while the agent works
  $('btnAgentSend').title = 'Stop';
  $('agentInput').value = '';
  agentInputAutosize();
  appendAgentMsg('user', msg);
  // activity card while working: status head + live step list streamed over SSE
  const pending = document.createElement('div');
  pending.className = 'agent-working';
  pending.innerHTML = `
    <div class="aw-head">
      <span class="spinner"></span>
      <span>Working…</span>
    </div>
    <div class="agent-feed ql-steps"></div>
    <div class="agent-stream" hidden></div>`;
  $('agentMessages').appendChild(pending);
  $('agentMessages').scrollTop = $('agentMessages').scrollHeight;
  agentFeedEl = pending.querySelector('.agent-feed'); // the SSE 'agent' listener streams progress lines into it
  document.body.classList.add('agent-busy'); // pulses the header button icon too
  try {
    const r = await api('/api/agent/chat', { method: 'POST', body: agentSessionBody({ message: msg }, sessionId) });
    pending.remove();
    // a late reply: the user pressed Stop, started another turn, or moved to another session.
    // Nothing of it is rendered - the conversation it belonged to is not the one on screen.
    if (!agentTurnIsCurrent(turn) || epoch !== agentSessionEpoch) return;
    if (r.cancelled) { appendAgentMsg('note', 'Reply stopped by the user.'); return; }
    appendAgentMsg('ai', r.reply, r.actions);
    (r.proposals || []).forEach(appendAgentProposal);
  } catch (e) {
    pending.remove();
    if (!agentTurnIsCurrent(turn) || epoch !== agentSessionEpoch) return;
    appendAgentMsg('ai', 'Error: ' + e.message);
  } finally {
    agentPendingSessions.delete(sessionId);
    // only the turn that is still current may hand the composer back: a superseded or cancelled
    // one must not clear the busy state of the turn (or the session) that replaced it
    if (agentTurn !== turn) return;
    agentTurn = null;
    agentFeedEl = null;
    agentBusy = false;
    document.body.classList.remove('agent-busy');
    $('btnAgentSend').classList.remove('busy');
    $('btnAgentSend').title = 'Send (Enter)';
    if (!$('agentInput').disabled) $('agentInput').focus();
  }
}
/** True only while this turn is still the one the user is looking at. */
const agentTurnIsCurrent = (turn) => agentTurn === turn && !turn.cancelled && turn.sessionId === agentSessionId();
let agentCancelling = false;
async function agentCancel() { // Stop: the server kills the provider run and records a note in the conversation
  const turn = agentTurn;
  if (!agentBusy || !turn || agentCancelling) return;
  agentCancelling = true;
  const sessionId = turn.sessionId;
  turn.cancelled = true; // from here on, anything arriving for this turn is dropped, not rendered
  // reflect the stop straight away: the user should not wait for the server to acknowledge it
  agentFeedEl = null;
  $('agentMessages').querySelectorAll('.agent-working').forEach((el) => el.remove());
  appendAgentMsg('note', 'Reply stopped by the user.');
  agentPendingSessions.delete(sessionId);
  agentBusy = false;
  setAgentBusyUi(false); // also drops body.agent-busy
  try { await api('/api/agent/chat/cancel', { method: 'POST', body: agentSessionBody({}, sessionId) }); }
  catch (e) { if (sessionId === agentSessionId()) toast(e.message); }
  finally { agentCancelling = false; }
}
$('btnAgentSend').addEventListener('click', () => { if (agentBusy) agentCancel(); else agentSend(); });
$('agentInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); agentSend(); }
});
// composer grows with its content (up to the CSS max-height), then scrolls
function agentInputAutosize() {
  const t = $('agentInput'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 160) + 'px';
}
$('agentInput').addEventListener('input', agentInputAutosize);
// options menu (model, reset, disconnect) and the access-details popover
const agentMenuOpen = (on) => { $('agentMenu').hidden = !on; $('btnAgentMenu').setAttribute('aria-expanded', String(on)); };
const agentScopeOpen = (on) => { $('agentScopePop').hidden = !on; $('agentScope').setAttribute('aria-expanded', String(on)); };
$('btnAgentMenu').addEventListener('click', (e) => { e.stopPropagation(); agentScopeOpen(false); agentMenuOpen($('agentMenu').hidden); });
$('agentScope').addEventListener('click', (e) => { e.stopPropagation(); agentMenuOpen(false); agentScopeOpen($('agentScopePop').hidden); });
$('agentMenu').addEventListener('click', (e) => { if (e.target.closest('button')) agentMenuOpen(false); });
document.addEventListener('click', (e) => {
  if (!$('agentMenu').hidden && !e.target.closest('.ag-menu-wrap')) agentMenuOpen(false);
  if (!$('agentScopePop').hidden && !e.target.closest('.ag-status-row')) agentScopeOpen(false);
});
let agentModelSaved = '';
async function saveAgentModel() {
  const model = $('agentModel').value.trim();
  if (model === agentModelSaved) return;
  try {
    const r = await api('/api/agent/model', { method: 'POST', body: JSON.stringify({ model }) });
    agentModelSaved = r.model || '';
    $('agentModel').value = agentModelSaved;
    toast(`Model set to ${agentModelSaved || 'provider default'}`);
  } catch (e) { toast(e.message); }
}
$('agentModel').addEventListener('change', saveAgentModel); // fires on datalist pick and on blur-with-change
$('agentModel').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('agentModel').blur(); } });
$('btnAgentReset').addEventListener('click', async () => {
  const sessionId = agentSessionId(), epoch = agentSessionEpoch;
  if (!sessionId) return;
  try {
    await api('/api/agent/reset', { method: 'POST', body: agentSessionBody({}, sessionId) });
    if (sessionId === agentSessionId() && epoch === agentSessionEpoch) await openAgent();
  } catch (e) { if (sessionId === agentSessionId()) toast(e.message); }
});
$('btnAgentDisconnect').addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: 'Disconnect AI agent',
    message: 'Disconnect the agent and forget the stored provider choice? The conversation is discarded.',
    okLabel: 'Disconnect', okClass: 'warn',
  });
  if (ok) {
    await api('/api/agent/disconnect', { method: 'POST' }).catch((e) => toast(e.message));
    document.body.classList.remove('agent-on');
    openAgent();
  }
});

// the More menu was replaced by the sidebar (navigation.js)


/* Shared composer state, also used without the Servers module. */
function applyAgentComposerState() {
  const bound = !!agentSessionId(), ended = agentSessionEnded();
  const ta = $('agentInput'), send = $('btnAgentSend');
  if (!ta || !send) return;
  ta.disabled = ended;
  send.disabled = ended;
  ta.placeholder = ended ? 'This terminal session has ended: the conversation is read-only.'
    : bound ? 'Ask about this server, or what to run on it…' : 'Ask about rules, schema, data…';
  $('agentChatWrap').classList.toggle('session-ended', ended);
  $('agentChatWrap').dataset.sessionState = bound ? (ended ? 'ended' : 'live') : '';
  const kbd = document.querySelector('#agentChatWrap .ag-kbd');
  if (kbd) kbd.textContent = ended
    ? 'Session ended · read-only. Start a terminal on this server for a new session with its own history.'
    : bound ? 'Enter to send · Shift+Enter for a new line'
      : 'Enter to send · Shift+Enter for a new line · read-only access';
  // command controls that are still on screen go read-only with it
  if (ended) for (const [, el] of agentCards) if (el.dataset.state === 'pending') setProposalState(el, 'stale', 'the session has ended');
}
function renderSshAgentChip() {
  const el = $('agentSsh'); if (!el) return;
  // An ended session keeps its identity on screen: it is a readable archive, not "nothing".
  // With no session the chip is absent - the conversation is the project's, named beside it.
  const bound = !!agentSessionId(), ended = agentSessionEnded();
  el.hidden = !bound;
  if (bound) {
    el.textContent = `· ${sshAgent.name || 'server'} · ${String(agentSessionId()).slice(0, 8)}${ended ? ' · ended' : ''}`;
    el.title = `${sshAgent.user || ''}@${sshAgent.host || ''} — Conversation exclusive to this terminal session.${ended ? ' This session has ended: the conversation is read-only.' : ' Every AI command requires approval.'}`;
  }
  const control = $('btnAgentTerminalControl');
  if (control) {
    const ai = sshAgent.terminal?.control === 'assistant';
    control.textContent = ai ? 'Take control' : 'Give AI control';
    control.classList.toggle('warn', ai);
    control.disabled = !bound || ended;
  }
}
