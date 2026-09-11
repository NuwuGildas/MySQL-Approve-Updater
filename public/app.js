'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

let state = { session: null, transformTypes: {}, rules: [], schema: null, maxPreviewRows: 500 };
let sshAgent = { attached: false, profileId: null, name: null, guard: {}, memory: null }; // the AI assistant's SSH attachment (lib/ssh-agent)
let agentSessionEpoch = 0;
let agentLoadSeq = 0;
const agentPendingSessions = new Set();
/* The assistant addresses ONE of two conversations: a terminal session's, while the user has a
   server session selected, or the ACTIVE PROJECT's, when they have not. "No session" is a valid
   scope, not a disabled state, so everything below - the guards included - settles which. */
const agentSessionId = () => sshAgent.sessionId || null;
// A shell that has gone: its conversation is still readable, but nothing can be typed or run into it.
const DEAD_TERMINAL = ['closed', 'ended', 'error', 'disconnected'];
const sessionIsDead = (s) => DEAD_TERMINAL.includes(String(s?.terminal?.status || s?.status || '').toLowerCase());
// only a BOUND session can be ended; with none bound the conversation is the project's, always open
const agentSessionEnded = () => !!agentSessionId() && sessionIsDead(sshAgent);
/* What the SERVER calls this conversation on the live stream: the terminal session id, or
   "project:<id>" when there is no session. It is echoed from GET /api/agent, never constructed
   here, and it is what every 'agent' event is matched against. */
let agentConversationId = null;
const agentConversation = () => agentConversationId || agentSessionId();
const agentSessionBody = (fields = {}, sessionId = agentSessionId()) =>
  JSON.stringify(sessionId ? { ...fields, sessionId } : { ...fields, projectId: currentProjectId });
const agentSessionUrl = (path, extra = {}) =>
  `${path}?${new URLSearchParams({ ...extra, ...(agentSessionId() ? { sessionId: agentSessionId() } : { projectId: currentProjectId }) })}`;

/* ---------- API helper ---------- */
async function api(url, opts) {
  const res = await fetch(url, opts ? { headers: {'Content-Type':'application/json'}, ...opts } : undefined);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}
/* ---------- toast (gooey-toast, themed to the app) ---------- */
let toastTimer;
let _toasterReady = false;
const TOAST_FILL = '#1b222c'; // matches app panel tone; see style.css overrides
function ensureToaster() {
  const g = window.gooeyToast;
  if (!g || _toasterReady) return g;
  try { g.mountToaster({ position: 'bottom-center', options: { fill: TOAST_FILL } }); } catch {}
  _toasterReady = true;
  return g;
}
// classify a plain message so single-string calls still get a sensible colour/badge
function toastState(text) {
  if (/\b(fail(ed|s)?|error|unavailable|invalid|cannot|can't|denied|unable|no such|not loaded|not connected)\b/i.test(text) || /\b(ECONN[A-Z]+|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|EPIPE|ER_[A-Z_]+|PROTOCOL_[A-Z_]+)\b/.test(text)) return 'error';
  if (/\b(copied|loaded|added|saved|approved|imported|exported|done|created|updated|removed|deleted|set to|connected|success|complete)\b/i.test(text)) return 'success';
  return 'info';
}
const TOAST_TITLES = { error: 'Error', success: 'Done', warning: 'Warning', info: 'Notice', loading: 'Working' };
// toast(message): backwards-compatible single-string API. toast(message, state) to force a state.
function toast(msg, state) {
  const text = String(msg == null ? '' : msg);
  const g = ensureToaster();
  if (g && g.toast) {
    const st = state || toastState(text);
    const fn = g.toast[st] || g.toast.info;
    try {
      fn({ title: TOAST_TITLES[st] || 'Notice', description: text, fill: TOAST_FILL, duration: st === 'error' ? 7000 : 5000 });
      return;
    } catch {}
  }
  // fallback: legacy inline strip if the library failed to load
  const t = $('toast');
  if (!t) return;
  t.textContent = text; t.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.style.display = 'none', 4500);
}

/* ---------- confirm modal (replaces window.confirm) ---------- */
let confirmResolve = null;
function confirmDialog({ title = 'Please confirm', message = '', okLabel = 'Confirm', okClass = 'primary', cancelLabel = 'Cancel' } = {}) {
  if (confirmResolve) { confirmResolve(false); confirmResolve = null; } // settle any dangling ask
  return new Promise((resolve) => {
    confirmResolve = resolve;
    $('confirmTitle').textContent = title;
    $('confirmMsg').innerHTML = message; // messages are app-authored; dynamic parts must be esc()-ed by callers
    const ok = $('btnConfirmOk');
    ok.textContent = okLabel;
    ok.className = okClass;
    $('btnConfirmCancel').textContent = cancelLabel;
    $('confirmModal').showModal();
    ok.focus();
  });
}
function settleConfirm(v) {
  const r = confirmResolve;
  confirmResolve = null;
  if ($('confirmModal').open) $('confirmModal').close();
  if (r) r(v);
}
$('btnConfirmOk').addEventListener('click', () => settleConfirm(true));
$('btnConfirmCancel').addEventListener('click', () => settleConfirm(false));
$('confirmModal').addEventListener('close', () => settleConfirm(false)); // Esc or backdrop = cancel

