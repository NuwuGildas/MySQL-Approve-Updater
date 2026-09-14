'use strict';
/* Helpers installed into the page, shared by every check.
 *
 * These used to be globals: the terminal workspace was part of the base application, so a check
 * could call workspaceConsole() or read consoles.size straight off window. Servers and Terminals
 * are a MODULE now and all of that lives inside its closure, which is how it should be - so the
 * checks read the same facts the way a user's browser can see them:
 *
 *   consoles            .ssh-console elements, each stamped with its console id and session id
 *   the active console  .ssh-console.active
 *   terminal geometry   data-cols / data-rows, which refitConsole() writes after every fit
 *   read-only           xterm marks its helper textarea readOnly when stdin is disabled
 *   who has control     #wsOwner[data-owner], the same attribute the styling uses
 *
 * The one thing that still needs the module is opening a terminal with options, and the module
 * publishes that through the host's inter-module API (HostSDK.apis), not through a back door. */

const installPageHelpers = () => {
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  window.srvCard = (name) => $$('#serversList .srv-name')
    .find((el) => el.textContent.trim() === name)?.closest('.srv-card') || null;

  /** The Servers module's published API, or null while it is not running. */
  window.serversApi = () => (window.HostSDK ? HostSDK.apis.get('servers') : null);

  window.consoleEls = () => $$('#sshConsoleHost .ssh-console');
  window.consoleCount = () => consoleEls().length;
  window.activeConsole = () => document.querySelector('#sshConsoleHost .ssh-console.active');
  window.consoleFor = (sessionId) => consoleEls().find((el) => el.dataset.sessionId === sessionId) || null;

  /** Columns and rows the PTY is actually running at, written onto the element by every fit. */
  window.termSize = (el = activeConsole()) => {
    if (!el || !el.dataset.cols) return null;
    return { cols: Number(el.dataset.cols), rows: Number(el.dataset.rows) };
  };

  /** Typing is disabled: xterm sets readOnly on its helper textarea when stdin is off. */
  window.termReadOnly = (el = activeConsole()) => {
    const ta = el && el.querySelector('.xterm-helper-textarea');
    return ta ? ta.readOnly === true : null;
  };

  /** 'user' | 'assistant' | 'ended' - the attribute the ownership styling reads. */
  window.termOwner = () => document.getElementById('wsOwner')?.dataset.owner || null;

  /** The terminal session the workspace is showing, from its own session picker. */
  window.workspaceSessionId = () => document.getElementById('wsSessionPick')?.value || null;

  /* ---- the user's own routes into a session, used instead of the module's internals ---- */

  /** Switch to another live session the way the workspace's session picker does. */
  window.pickSession = (sessionId) => {
    const sel = document.getElementById('wsSessionPick');
    if (!sel || ![...sel.options].some((o) => o.value === sessionId)) return false;
    sel.value = sessionId;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };

  /** Open a server card's Terminal menu and click one of its entries. Returns false until it is open. */
  window.termMenuAction = (serverName, act) => {
    const card = srvCard(serverName); if (!card) return false;
    const menu = card.querySelector('.term-dd-menu'); if (!menu) return false;
    if (menu.hidden) { card.querySelector('[data-act="terminal-menu"]').click(); return false; }
    const item = menu.querySelector(`[data-act="${act}"]`);
    if (!item) return false;
    item.click();
    return true;
  };

  /** Read an ended session from the card's "Recent sessions" list. */
  window.openRecentSession = (serverName, sessionId) => {
    const card = srvCard(serverName); if (!card) return false;
    const menu = card.querySelector('.term-dd-menu'); if (!menu) return false;
    if (menu.hidden) { card.querySelector('[data-act="terminal-menu"]').click(); return false; }
    const entry = menu.querySelector(`[data-act="session"][data-sid="${sessionId}"]`);
    if (!entry) return false;
    entry.click();
    return true;
  };

  /** Close every open console, each by its own close button. The last one leaves the
      assistant on the project conversation, which is what "leaving a session" means. */
  window.closeAllConsoles = () => {
    consoleEls().forEach((el) => el.querySelector('[data-cact="close"]')?.click());
    return consoleCount();
  };
};

module.exports = { installPageHelpers };
