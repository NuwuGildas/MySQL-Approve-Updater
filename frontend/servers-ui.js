/* Servers, shared terminals and the terminal workspace.

   Moved out of the base application: the code is the code that shipped, with the
   seams changed. API calls go to this module's own backend through the host
   dispatcher, the assistant window and the conversation it addresses stay
   host-owned, and every listener, timer and observer is registered through the
   host so removing the module takes all of them with it. */
'use strict';

export function createServersUI({ host, mount, Terminal, FitAddon }) {
  const { esc, toast, confirm } = host.ui;
  /* Module markup first, then the shell's own elements (the assistant window). */
  const $ = (id) => mount.querySelector('#' + id) || document.getElementById(id);
  const http = (path, options) => host.http(path, options);
  const state = () => host.database.state();
  const hostOn = (target, ...rest) => (target ? host.on(target, ...rest) : null);
  /* The terminal viewer socket is this module's own endpoint; the host proxies it. */
  const socketUrl = (path) => {
    const url = new URL(`/api/m/${host.id}/ws${path}`, location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.href;
  };

  /* ---------- SSH servers (cards with live VM meta) ---------- */
  const closeServers = () => $('serversDrawer').classList.remove('open');
  async function openServers() {
    $('serversDrawer').classList.add('open');
    await loadServers();
  }
  async function loadServers() {
    const list = $('serversList');
    try {
      await refreshLiveTerminals(); // so each card can say whether it has a shell to go back to
      const d = await http('/sessions');
      $('serversCount').textContent = d.sessions.length ? `- ${d.sessions.filter((s) => s.connected).length}/${d.sessions.length} connected` : '';
      if (!d.sessions.length) { list.innerHTML = '<div class="empty" style="padding:1rem">No SSH-enabled connection profiles. Enable SSH on a profile in Connections.</div>'; return; }
      list.innerHTML = '';
      d.sessions.forEach((s) => list.appendChild(serverCard(s)));
    } catch (e) { list.innerHTML = `<div class="empty" style="padding:1rem;color:var(--red)">${esc(e.message)}</div>`; }
  }

  const meterClass = (pct) => (pct >= 90 ? 'bad' : pct >= 75 ? 'warn' : 'ok');
  function meter(label, pct, valueText) {
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    return `<div class="meter-row">
      <div class="meter-top"><span>${label}</span><span class="meter-val">${esc(valueText)}</span></div>
      <div class="meter"><i class="${meterClass(p)}" style="width:${p}%"></i></div>
    </div>`;
  }

  /* ---- the assistant on a server: attach state shared by the cards, the agent header and settings ---- */
  async function loadSshAgent() {
    const sessionId = host.session.id(), epoch = host.session.epoch();
    if (sessionId) {
      try {
        const result = await http(`/agent?sessionId=${encodeURIComponent(host.session.id() || '')}`);
        if (sessionId === host.session.id() && epoch === host.session.epoch()) host.session.set(result);
      } catch { /* leave the explicitly selected session in place */ }
    }
    host.assistantUi.renderChip();
    host.assistantUi.composerState();
    renderWorkspaceIdentity();
    return host.session.current();
  }
  /* ---- the coding agent installed ON a server ----
     It investigates for the assistant and proposes; it changes nothing. */
  const AGENT_LABELS = { claude: 'Claude Code', codex: 'Codex CLI' };

  async function installServerAgent(profileId, agentId, serverName) {
    const label = AGENT_LABELS[agentId] || agentId;
    toast(`Installing ${label} on ${serverName}…`, 'loading');
    try {
      const result = await http(`/sessions/${profileId}/agents/${agentId}/install`, { method: 'POST' });
      toast(result.ok
        ? `${label} ${result.alreadyInstalled ? 'is already on' : 'installed on'} ${serverName}. ${result.next}`
        : `${label} did not install on ${serverName}. ${result.next}`, result.ok ? 'success' : 'warning');
      await loadServers();
      return result;
    } catch (error) {
      toast(`${label} install failed: ${error.message}`, 'error');
      return { ok: false, error: error.message };
    }
  }

  /**
   * The bottom of the terminal menu: which coding agents this server has, and an
   * offer to install one it does not. Only shown for a connected server, because
   * finding out means asking it.
   */
  function serverAgentMenu(s) {
    const found = serverAgents.get(s.id);
    if (!found) return '<div class="term-dd-note">Open a terminal to see which coding agents are on this server.</div>';
    const rows = Object.values(AGENT_LABELS).length ? Object.keys(AGENT_LABELS).map((id) => {
      const agent = found[id];
      return agent?.installed
        ? `<div class="term-dd-note">${esc(AGENT_LABELS[id])} ${esc(agent.version || '')} is on this server</div>`
        : `<button data-act="agent-install" data-agent="${id}">Install ${esc(AGENT_LABELS[id])}</button>`;
    }) : [];
    return `<div class="term-dd-sep"></div>${rows.join('')}`;
  }

  /**
   * "Terminal + AI" promises the assistant working ON this server, so opening it
   * makes sure there is a coding agent there to work with. Installing one runs
   * an installer on the user's SERVER, so it is ASKED - once per server, and
   * never in the way: the terminal opens regardless, and a refusal is remembered
   * for the rest of the session.
   */
  const agentOffered = new Set();
  async function ensureServerAgent(profileId, serverName) {
    let found;
    try { found = await refreshServerAgents(profileId, { quiet: false }); }
    catch (error) {
      // Saying nothing is the one thing this must not do: the user pressed a
      // button called "Terminal + AI" and is entitled to know why half of it
      // did not happen.
      toast(`Could not check which coding agents are on ${serverName}: ${error.message}`, 'warning');
      return null;
    }
    if (!found || !Object.keys(found).length) {
      toast(`Could not read the coding agents on ${serverName}. Open its Terminal menu to install one.`, 'warning');
      return null;
    }
    if (Object.values(found).some((agent) => agent.installed)) { await loadServers().catch(() => {}); return found; }
    if (agentOffered.has(profileId)) return found;
    agentOffered.add(profileId);

    const ok = await confirm({
      title: 'Install a coding agent on this server?',
      message: `<b>${esc(serverName)}</b> has no coding agent. One lets the assistant investigate the server directly instead of asking you to approve every single command.`
        + '<br><br>It can change nothing by itself: whatever it thinks should change still comes back as an approval card here.'
        + '<br><br>Installing runs the official installer on the server, and you sign in to it once from the server\'s own terminal.',
      okLabel: 'Install Claude Code',
      cancelLabel: 'Not now',
    });
    if (!ok) {
      toast(`No coding agent on ${serverName}: the assistant will work one approved command at a time. Install one later from the Terminal menu.`);
      return found;
    }
    await installServerAgent(profileId, 'claude', serverName);
    return refreshServerAgents(profileId);
  }

  /**
   * Which agents a connected server has. Cached per server for the card.
   *
   * `quiet` is for the places that only want to decorate the card - connecting,
   * refreshing - where a failure is not worth a message. Anywhere the answer
   * changes what the user gets, ask loudly and let the error out.
   */
  const serverAgents = new Map();
  async function refreshServerAgents(profileId, { quiet = true } = {}) {
    try {
      const answer = await http(`/sessions/${profileId}/agents`);
      const agents = answer?.agents;
      if (!agents || typeof agents !== 'object') throw new Error('the server did not report its coding agents');
      serverAgents.set(profileId, agents);
      return agents;
    } catch (error) {
      serverAgents.delete(profileId);
      if (quiet) return null;
      throw error;
    }
  }

  /* Swap the bound session ATOMICALLY. Everything that identifies the old conversation - its
     messages, its approval cards, the composer target and the turn in flight - is dropped
     synchronously, before any await, so a reply still travelling for the old session has nowhere
     left to land. The SSE stream is re-pointed in the same breath. */
  function selectAgentSession(session) {
    if (session.sessionId !== host.session.id()) {
      host.session.bumpEpoch();
      host.session.bumpLoadSeq();
      host.assistantUi.setFeed(null);
      host.assistantUi.setTurn(null);              // whatever was running now counts as a late reply
      host.assistantUi.cards().clear();            // no card from the previous conversation survives the swap
      host.assistantUi.setBusyFlag(host.session.pending().has(session.sessionId));
      host.assistantUi.setCancelling(false);
      $('agentMessages').replaceChildren();
      $('agentInput').value = '';
      $('agentConnect').hidden = true;
      $('agentChatWrap').hidden = true;
      $('agentCtx').textContent = '';
      $('agentScopePop').replaceChildren();
      host.assistantUi.setBusy(host.assistantUi.isBusy());
      host.assistantUi.setStatus('Loading this server session…', 'busy');
    }
    host.session.set(session);
    // a terminal session IS its own conversation id, so the stream can move at once; the project
    // conversation's id is only known once GET /api/agent answers (openAgent re-scopes then)
    host.session.setConversation(session.sessionId || null);
    host.database.scopeSse();
    host.assistantUi.composerState();
    host.assistantUi.renderChip();
    renderWorkspaceIdentity();
  }

  /* Point the conversation at a terminal session and paint its saved history. The swap itself is the
     synchronous part above; only the reload is awaited, and it is guarded by session id + sequence. */
  async function switchAgentSession(seed) {
    const id = seed.sessionId;
    if (!id) return;
    selectAgentSession({ attached: false, guard: {}, memory: null, ...seed });
    await loadSshAgent();                        // the real terminal state (open / closed, control)
    if (id !== host.session.id()) return;         // the user moved on while we were asking
    await host.assistantUi.open();
  }

  /** An ended session is a readable archive: open its saved conversation without touching SSH. */
  async function viewEndedSession(seed) {
    await switchAgentSession({ ...seed, terminal: { sessionId: seed.sessionId, status: 'closed' } });
    if (seed.sessionId === host.session.id()) showSshDrawer();
  }

  /* The Terminal menu's two ACTIONS always come first and are always what Enter starts. Earlier
     sessions are offered underneath, in their own scrolling group (live first, ended marked
     read-only) so a long history can never push the actions off screen, and no group at all when
     the server has none. Filled when the menu opens, so the list is never stale. */
  function closeServerTermMenu(menu, restoreFocus = false) {
    menu.hidden = true;
    const trigger = menu.parentElement.querySelector('[data-act="terminal-menu"]');
    trigger?.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger?.focus();
  }

  function positionServerTermMenu(menu) {
    if (menu.hidden) return;
    const anchor = menu.parentElement.getBoundingClientRect();
    const gap = 6, margin = 12;
    const below = window.innerHeight - anchor.bottom - gap - margin;
    const above = anchor.top - gap - margin;
    menu.style.maxHeight = Math.max(0, Math.max(below, above)) + 'px';
    const height = menu.getBoundingClientRect().height;
    const top = below >= height || below >= above ? anchor.bottom + gap : anchor.top - gap - height;
    menu.style.top = Math.max(margin, top) + 'px';
    menu.style.left = Math.max(margin, Math.min(anchor.left, window.innerWidth - menu.offsetWidth - margin)) + 'px';
  }

  host.on(document, 'click', (event) => {
    document.querySelectorAll('.term-dd-menu:not([hidden])').forEach((menu) => {
      if (!menu.parentElement.contains(event.target)) closeServerTermMenu(menu);
    });
  });
  host.on(window, 'resize', () => document.querySelectorAll('.term-dd-menu:not([hidden])').forEach(positionServerTermMenu));
  host.on(document, 'scroll', (event) => {
    document.querySelectorAll('.term-dd-menu:not([hidden])').forEach((menu) => {
      if (!menu.contains(event.target)) positionServerTermMenu(menu);
    });
  }, true);

  async function fillServerSessionMenu(card, srv) {
    const menu = card.querySelector('.term-dd-menu');
    if (!menu || menu.hidden) return;
    menu.querySelector('.term-dd-sessions')?.remove();
    let list = [];
    try { list = (await http('/agent/sessions?profileId=' + encodeURIComponent(srv.id))).sessions || []; } catch { return; }
    // the servers list rebuilds itself on every SSE nudge: never append to a card that has gone
    if (!list.length || menu.hidden || !menu.isConnected) return;
    const live = list.filter((x) => !host.session.isDead(x)).reverse();
    const dead = list.filter(sessionIsDead).reverse().slice(0, 6);
    const group = document.createElement('div');
    group.className = 'term-dd-sessions';
    group.innerHTML = '<div class="term-dd-sec">Recent sessions</div>';
    for (const x of [...live, ...dead]) {
      const ended = host.session.isDead(x);
      const b = document.createElement('button');
      b.type = 'button'; b.dataset.act = 'session'; b.dataset.sid = x.sessionId;
      b.textContent = `${String(x.sessionId).slice(0, 8)}${x.messageCount ? ` · ${x.messageCount} msg` : ''}${ended ? ' · ended (read-only)' : ' · live'}`;
      b.title = ended ? 'Read this ended session’s conversation without connecting' : 'Resume this session and its conversation';
      // wired here rather than through the card's delegate: these buttons are added after it was built
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeServerTermMenu(menu);
        if (ended) viewEndedSession({ sessionId: x.sessionId, profileId: srv.id, name: x.name || srv.name });
        else openSsh(srv.id, { ai: true, label: srv.name, sessionId: x.sessionId });
      });
      group.appendChild(b);
    }
    menu.appendChild(group);
    positionServerTermMenu(menu);
  }

  /* Keyboard path for the Terminal menu: arrows move, Home/End jump, Escape closes and returns
     focus to the trigger. Enter is the button's own activation, so it starts whatever is focused -
     and focus starts on "Terminal", never on a dead transcript. */
  function wireTermMenuKeys(menu, trigger) {
    trigger.setAttribute('aria-expanded', 'true');
    menu.addEventListener('focusout', () => {
      requestAnimationFrame(() => {
        if (!menu.parentElement.contains(document.activeElement)) closeServerTermMenu(menu);
      });
    });
    menu.addEventListener('keydown', (e) => {
      const items = [...menu.querySelectorAll('button')];
      if (e.key === 'Escape') { closeServerTermMenu(menu, true); e.preventDefault(); e.stopPropagation(); return; }
      const i = items.indexOf(document.activeElement);
      let n = -1;
      if (e.key === 'ArrowDown') n = (i + 1) % items.length;
      else if (e.key === 'ArrowUp') n = (i - 1 + items.length) % items.length;
      else if (e.key === 'Home') n = 0;
      else if (e.key === 'End') n = items.length - 1;
      if (n < 0) return;
      e.preventDefault();
      items[n]?.focus();
    });
  }

  function serverCard(s) {
    const el = document.createElement('div');
    el.className = 'srv-card' + (s.connected ? ' connected' : '');
    // a shell already running on this box: say so, and make going back to it the first action
    const live = liveTerminals.filter((t) => t.profileId === s.id);
    const m = s.meta;
    let body = '';
    if (s.connected && m && !m.error) {
      // parse the meters
      const mem = /(\d+)\s*\/\s*(\d+)/.exec(m.mem || '');
      const memPct = mem ? (+mem[1] / +mem[2]) * 100 : 0;
      const memTxt = mem ? `${(+mem[1] / 1024).toFixed(1)} / ${(+mem[2] / 1024).toFixed(1)} GB` : (m.mem || '?');
      const diskPctM = /(\d+)%/.exec(m.disk || '');
      const diskPct = diskPctM ? +diskPctM[1] : 0;
      const diskTxt = (m.disk || '?').replace(/\s*\d+%$/, '') + (diskPctM ? ` · ${diskPct}%` : '');
      const load1 = parseFloat((m.load || '').split(/\s+/)[0]);
      const cpus = +m.cpus || 1;
      const loadPct = isFinite(load1) ? (load1 / cpus) * 100 : 0;
      body = `
        <div class="srv-os">${esc(m.distro || m.kernel || '?')}</div>
        <div class="srv-metaline">${esc(m.kernel || '')} · ${esc(m.arch || '')} · up ${esc(m.uptime || '?')}</div>
        <div class="srv-meters">
          ${meter('Memory', memPct, memTxt)}
          ${meter('Disk /', diskPct, diskTxt)}
          ${meter(`Load (${esc(String(cpus))} CPU${cpus > 1 ? 's' : ''})`, loadPct, m.load || '?')}
        </div>`;
    } else if (m?.error) {
      body = `<div class="srv-err">Could not read VM info: ${esc(m.error)}</div>`;
    } else if (!s.connected) {
      body = `<div class="srv-metaline">Not connected: connect to pull live VM stats.</div>`;
    } else {
      body = '<div class="srv-metaline">Connected. Refresh to load server statistics.</div>';
    }
    el.innerHTML = `
      <div class="srv-head">
        <span class="srv-dot ${s.connected ? 'on' : ''}"></span>
        <div class="srv-id">
          <div class="srv-nameRow">
            <span class="srv-name" title="${esc(m?.host ? `${s.name} (${m.host})` : s.name)}">${esc(s.name)}</span>
            ${s.active ? '<span class="badge approved">active DB</span>' : ''}
            ${live.length ? `<span class="badge approved srv-live" title="This server has a running shell you can go back to">${live.length} live terminal${live.length === 1 ? '' : 's'}</span>` : ''}
          </div>
          <span class="srv-sub">${esc(s.user)}@${esc(s.host)}</span>
        </div>
      </div>
      ${body}
      <div class="srv-actions">
        ${s.connected
          ? `<button data-act="refresh">Refresh</button><div class="term-dd"><button data-act="terminal-menu" class="primary">${live.length ? 'Resume' : 'Terminal'} <svg class="caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button><div class="term-dd-menu" hidden><button data-act="terminal">${live.length ? 'Resume terminal' : 'Terminal'}</button><button data-act="terminal-ai" class="aireview glossy" title="Open a terminal and work in it with the assistant">${AI_LOGO_REST}<span>${live.length ? 'Resume with AI' : 'Terminal + AI'}</span></button><button data-act="terminal-new">New terminal</button>${serverAgentMenu(s)}</div></div><span class="spacer"></span><button data-act="disconnect" class="warn">Disconnect</button>`
          : `<button data-act="connect" class="primary">Connect</button><span class="spacer"></span>${s.sshOnly ? '<button data-act="remove" class="iconbtn danger" title="Remove this SSH server">' + RULE_ICONS.trash + '</button>' : ''}`}
      </div>`;
    el.querySelector('[data-act="terminal-menu"]')?.setAttribute('aria-expanded', 'false');
    const closeTermMenu = () => { const m = el.querySelector('.term-dd-menu'); if (m) closeServerTermMenu(m); };
    el.querySelectorAll('.srv-actions [data-act]').forEach((b) => b.addEventListener('click', async (ev) => {
      const act = b.dataset.act;
      if (act === 'terminal-menu') {
        ev.stopPropagation();
        const m = el.querySelector('.term-dd-menu');
        const willOpen = m.hidden;
        document.querySelectorAll('.term-dd-menu').forEach((x) => closeServerTermMenu(x));
        m.hidden = !willOpen;
        b.setAttribute('aria-expanded', String(willOpen));
        if (willOpen) {
          positionServerTermMenu(m);
          if (!m.dataset.keys) { wireTermMenuKeys(m, b); m.dataset.keys = '1'; }
          m.querySelector('[data-act="terminal"]').focus(); // Enter starts a terminal, never a dead transcript
          fillServerSessionMenu(el, s);
        }
        return;
      }
      // "terminal" resumes this server's most recent live session when there is one (openSsh
      // prefers a live session over minting a shell); "terminal-new" always mints one
      if (act === 'terminal') { closeTermMenu(); openSsh(s.id, { label: s.name }); return; }
      if (act === 'terminal-ai') { closeTermMenu(); openSsh(s.id, { ai: true, label: s.name }); return; }
      if (act === 'agent-install') {
        closeTermMenu();
        const which = b.dataset.agent;
        await installServerAgent(s.id, which, s.name);
        await refreshServerAgents(s.id);
        await loadServers();
        return;
      }
      if (act === 'terminal-new') { closeTermMenu(); openSsh(s.id, { ai: true, newSession: true, label: s.name }); return; }
      if (act === 'remove') {
        const ok = await confirm({ title: 'Remove SSH server', message: `Remove the SSH server <b>${esc(s.name)}</b>? Its stored credentials are deleted from connections.json.`, okLabel: 'Remove', okClass: 'reject' });
        if (!ok) return;
        try { await http(`/profiles/${s.id}`, { method: 'DELETE' }); await loadServers(); } catch (e) { toast(e.message); }
        return;
      }
      b.disabled = true;
      const orig = b.textContent;
      if (act === 'connect') b.textContent = 'Connecting…';
      if (act === 'refresh') b.textContent = 'Refreshing…';
      try {
        await http(`/sessions/${s.id}/${act}`, { method: 'POST' });
        if (act === 'disconnect') { closeConsolesForProfile(s.id); serverAgents.delete(s.id); } // tear down this server's open consoles too
        // Now that it is reachable, find out which coding agents it has.
        if (act === 'connect' || act === 'refresh') await refreshServerAgents(s.id);
        await loadServers();
      } catch (e) { toast(e.message); b.disabled = false; b.textContent = orig; }
    }));
    return el;
  }

  /* add SSH server (creates an ssh-only connection profile) */
  host.on($('btnAddServer'), 'click', () => { $('addServerForm').hidden = false; $('asName').focus(); loadAppKey(); });
  /* authentication choice: app-managed key (default), pasted key, or password */
  let asAuth = 'app-key';
  function setAsAuth(mode) {
    asAuth = mode;
    $('asAuthChoice').querySelectorAll('[data-auth]').forEach((b) => { const on = b.dataset.auth === mode; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
    $('asAuthApp').hidden = mode !== 'app-key'; $('asAuthOwn').hidden = mode !== 'own-key'; $('asAuthPass').hidden = mode !== 'password';
    $('asPass').required = mode === 'password';
  }
  host.on($('asAuthChoice'), 'click', (e) => { const b = e.target.closest('[data-auth]'); if (b) setAsAuth(b.dataset.auth); });
  let appKeyInfo = null;
  async function loadAppKey() {
    if (appKeyInfo) return appKeyInfo;
    try { appKeyInfo = await http('/app-key'); $('asAppKeyCmd').textContent = appKeyInfo.installCmd; $('asAppKeyFp').textContent = `Key fingerprint ${appKeyInfo.fingerprint}`; }
    catch (e) { $('asAppKeyCmd').textContent = 'could not load the key: ' + e.message; }
    return appKeyInfo;
  }
  host.on($('btnAsCopyKey'), 'click', async () => { if (!appKeyInfo) await loadAppKey(); try { await navigator.clipboard.writeText(appKeyInfo.installCmd); toast('Install command copied', 'success'); } catch { toast('Clipboard blocked: select the command and copy it', 'warning'); } });
  host.on($('btnAddServerCancel'), 'click', () => { $('addServerForm').hidden = true; $('addServerForm').reset(); setAsAuth('app-key'); });
  host.on($('addServerForm'), 'submit', async (e) => {
    e.preventDefault();
    const body = {
      name: $('asName').value.trim(),
      sshOnly: true,
      db: {},
      ssh: {
        enabled: true, host: $('asHost').value.trim(), port: Number($('asPort').value) || 22,
        user: $('asUser').value.trim(), auth: asAuth,
        password: asAuth === 'password' ? $('asPass').value : '',
        privateKeyInline: asAuth === 'own-key' ? $('asKeyInline').value : '',
        privateKeyPath: asAuth === 'own-key' ? $('asKey').value.trim() : '', passphrase: asAuth === 'own-key' ? $('asPhrase').value : '',
      },
    };
    if (asAuth === 'own-key' && !body.ssh.privateKeyInline.trim() && !body.ssh.privateKeyPath) { toast('Paste a private key or give a key file path', 'warning'); $('asKeyInline').focus(); return; }
    const bootstrap = $('asBootstrapClaude').checked;
    try {
      const saved = await http('/profiles', { method: 'POST', body: JSON.stringify(body) });
      $('addServerForm').hidden = true; $('addServerForm').reset(); setAsAuth('app-key');
      await loadServers();
      toast(`SSH server "${body.name}" added`, 'success');
      if (bootstrap) await installServerAgent(saved.id, $('asBootstrapAgent')?.value || 'claude', body.name);
    } catch (err) { toast(err.message, 'error'); }
  });
  host.on($('btnServersClose'), 'click', closeServers);
  host.on($('btnServersRefresh'), 'click', loadServers);
  host.on(document, 'keydown', (e) => {
    if (e.key === 'Escape' && $('serversDrawer').classList.contains('open') && !document.querySelector('dialog[open]')) closeServers();
  });

  /* ---------- SSH consoles (xterm.js + WebSocket viewer) ----------
     Up to MAX_CONSOLES views at once inside the Terminals view, one visible at a time via the tab
     strip. A console is only a VIEW of a shared session: closing it never touches the shell.
     The pop-out-to-floating-window affordance went with the drawer it belonged to. */
  const consoles = new Map();
  const MAX_CONSOLES = 3;
  let consoleSeq = 0;
  let activeConsoleId = null;
  const SSH_ICON = {
    clear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M20 20H8.5L3 14.5a2 2 0 0 1 0-2.8l7-7a2 2 0 0 1 2.8 0l6 6a2 2 0 0 1 0 2.8L15 18"/><path d="M8.5 20 14 14.5"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  };

  // Fitting a pane that is currently hidden (the other workspace tab, an inactive console) would
  // size the PTY to a 0x0 box, so skip until it has a real one: the ResizeObserver refits on reveal.
  const refitConsole = (c) => {
    if (!c || !c.fit || !c.termHost || !c.termHost.isConnected) return;
    const r = c.termHost.getBoundingClientRect();
    if (r.width < 24 || r.height < 24) return;
    try { c.fit.fit(); } catch {}
  };
  const refitConsoles = () => consoles.forEach(refitConsole);
  const dockedConsoles = () => [...consoles.values()]; // every console is in the view now
  const showSshDrawer = () => { $('sshDrawer').classList.add('open'); document.body.classList.toggle('ssh-shared-workspace', $('agentDrawer').classList.contains('open')); };
  const hideSshDrawer = () => { $('sshDrawer').classList.remove('open'); document.body.classList.remove('ssh-shared-workspace'); };

  function renderSshTabs() {
    $('sshHostInfo').textContent = consoles.size ? `${consoles.size}/${MAX_CONSOLES}` : '';
    const listHost = $('sshTabs'); listHost.innerHTML = '';
    const docked = dockedConsoles();
    docked.forEach((c) => {
      const t = document.createElement('button');
      t.className = 'ssh-tab' + (c.id === activeConsoleId ? ' active' : '');
      t.innerHTML = `<span class="ssh-tab-dot ${c.statusCls || ''}"></span><span class="ssh-tab-label">${esc(c.label)}</span><span class="ssh-tab-x" title="Close">✕</span>`;
      t.addEventListener('click', (e) => { if (e.target.closest('.ssh-tab-x')) closeConsole(c.id); else activateConsole(c.id); });
      listHost.appendChild(t);
    });
    listHost.hidden = !docked.length;
  }

  function activateConsole(id) {
    const c = consoles.get(id); if (!c) return;
    activeConsoleId = id;
    $('sshConsoleHost').querySelectorAll('.ssh-console').forEach((el) => el.classList.toggle('active', el.dataset.id === id));
    renderSshTabs();
    renderWorkspaceIdentity(); // the session bar names whichever console is on screen
    rememberTerminal(c.sessionId);
    syncTerminalRoute(c.sessionId);
    refitConsole(c); c.term.focus();
    // the conversation follows the console the user is looking at, atomically
    if (c.session && c.sessionId !== host.session.id()) {
      selectAgentSession(c.session);
      if (agentIsDocked() || $('agentDrawer').classList.contains('open')) host.assistantUi.open();
    }
  }

  function setConsoleStatus(c, msg, cls) {
    c.statusCls = cls || '';
    if (c.statusEl) { c.statusEl.textContent = msg; c.statusEl.className = 'ssh-console-status ' + (cls || ''); }
    renderSshTabs();
    renderWorkspaceIdentity();
  }

  function buildConsoleEl(c) {
    const el = document.createElement('div');
    el.className = 'ssh-console'; el.dataset.id = c.id;
    // the view's session bar owns identity, the session picker, new/end and ownership; this bar is
    // only the console's own chrome, so nothing here is a second copy of any of that
    el.innerHTML = `
      <div class="ssh-console-bar">
        <span class="ssh-console-title">${esc(c.label)}</span>
        <span class="ssh-console-status">connecting…</span>
        <span class="spacer"></span>
        <button type="button" data-cact="reconnect" hidden>Reconnect view</button>
        <button class="iconbtn" data-cact="clear" title="Clear output">${SSH_ICON.clear}</button>
        <button class="iconbtn" data-cact="close" title="Close this view; the session keeps running">${SSH_ICON.close}</button>
      </div>
      <div class="ssh-console-term"></div>`;
    c.el = el;
    c.statusEl = el.querySelector('.ssh-console-status');
    c.termHost = el.querySelector('.ssh-console-term');
    el.querySelector('[data-cact="clear"]').addEventListener('click', () => c.term.clear());
    el.querySelector('[data-cact="close"]').addEventListener('click', () => closeConsole(c.id));
    el.querySelector('[data-cact="reconnect"]').addEventListener('click', () => { c.term.reset(); connectConsole(c); });
    c.ro = new ResizeObserver(() => refitConsole(c));
    c.ro.observe(c.termHost);
    return el;
  }

  function closeConsole(id) {
    const c = consoles.get(id); if (!c) return;
    try { c.ws && c.ws.close(); } catch {}
    try { c.ro && c.ro.disconnect(); } catch {}
    try { c.term && c.term.dispose(); } catch {}
    c.el.remove(); consoles.delete(id);
    if (activeConsoleId === id) {
      activeConsoleId = null;
      const next = dockedConsoles()[0];
      if (next) activateConsole(next.id);
    }
    renderSshTabs();
    renderWorkspaceIdentity();  // the empty state takes over when the last view closes
    refreshLiveTerminals();     // the SESSION is untouched: it stays on the sidebar, ready to reopen
    if (host.session.id() === c.sessionId) {
      // the chat follows whatever console is left, or falls back to the project conversation
      const next = consoles.get(activeConsoleId) || [...consoles.values()][0];
      if (next) selectAgentSession(next.session);
      else selectAgentSession({ attached: false, sessionId: null });
      if (agentIsDocked() || $('agentDrawer').classList.contains('open')) host.assistantUi.open();
    }
  }

  function connectConsole(c) {
    const { cols, rows } = c.term;
    setConsoleStatus(c, 'connecting…');
    const ws = new WebSocket(socketUrl(`/terminal?sessionId=${encodeURIComponent(c.sessionId)}&cols=${cols}&rows=${rows}`));
    ws.binaryType = 'arraybuffer'; c.ws = ws;
    c.el.querySelector('[data-cact="reconnect"]').hidden = true;
    // the console's own bar shows only while this VIEW has lost its socket: otherwise the session
    // bar above says everything, and a permanent strip of icons just reads as leftover chrome
    ws.onopen = () => { c.el.classList.remove('view-detached'); setConsoleStatus(c, 'view connected', 'ok'); };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') { c.term.write(new Uint8Array(e.data)); return; }
      try {
        const event = JSON.parse(e.data);
        if (event.type === 'session' && event.sessionId === c.sessionId) updateTerminalSession(c, event);
        else if (event.type === 'error') { setConsoleStatus(c, event.message || 'Terminal error', 'err'); toast(event.message || 'Terminal error', 'error'); }
      } catch { /* terminal output is binary; ignore unknown control messages */ }
    };
    ws.onclose = () => { c.el.classList.add('view-detached'); setConsoleStatus(c, 'view disconnected', 'err'); c.el.querySelector('[data-cact="reconnect"]').hidden = false; };
    ws.onerror = () => setConsoleStatus(c, 'connection error', 'err');
    c.inputListener?.dispose(); c.resizeListener?.dispose();
    c.inputListener = c.term.onData((d) => { if (ws.readyState === 1 && c.session.terminal?.control === 'user') ws.send(new TextEncoder().encode(d)); });
    c.resizeListener = c.term.onResize(({ cols, rows }) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols, rows })); });
  }

  const openingTerminals = new Map();
  const openingNotices = document.createElement('div');
  openingNotices.className = 'ssh-opening-notices';
  mount.appendChild(openingNotices);
  host.styles.add(`
    .ssh-opening-notices { position: fixed; top: 80px; right: 24px; z-index: 10000; display: grid; gap: 8px; max-width: min(420px, calc(100vw - 48px)); }
    .ssh-opening-notice { display: flex; align-items: center; gap: 12px; padding: 14px 18px; border: 1px solid var(--accent); border-radius: 8px; background: var(--panel, #18202d); color: var(--text, #fff); box-shadow: 0 4px 18px #0004; }
    .ssh-opening-notice progress { width: 48px; flex-shrink: 0; }
  `);

  function openSsh(profileId, opts = {}) {
    if (!profileId) return openSshSession(profileId, opts);
    if (openingTerminals.has(profileId)) return openingTerminals.get(profileId);
    const notice = document.createElement('div');
    notice.className = 'ssh-opening-notice';
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');
    const progress = document.createElement('progress');
    progress.setAttribute('aria-label', 'Opening terminal');
    const label = document.createElement('span');
    label.textContent = opts.label ? `Opening terminal for ${opts.label}?` : 'Opening terminal?';
    notice.append(progress, label);
    openingNotices.appendChild(notice);
    const pending = openSshSession(profileId, opts).catch((error) => {
      toast(error.message, 'error');
    }).finally(() => {
      notice.remove();
      openingTerminals.delete(profileId);
    });
    openingTerminals.set(profileId, pending);
    return pending;
  }

  async function openSshSession(profileId, opts = {}) {
    const pid = (typeof profileId === 'string') ? profileId : null;
    if (!pid) { await openServers(); toast('Choose a server to open its shared terminal session.'); return; }
    if (typeof Terminal === 'undefined') { toast('Terminal library not loaded'); return; }
    const existing = !opts.newSession && [...consoles.values()].find((c) => c.profileId === pid && (!opts.sessionId || c.sessionId === opts.sessionId));
    if (existing) {
      showSshDrawer(); activateConsole(existing.id); selectAgentSession(existing.session);
      if (opts.ai || agentIsDocked()) await host.assistantUi.open();
      // The terminal is already up; finding or installing the agent follows it.
      if (opts.ai) ensureServerAgent(pid, opts.label || existing.label).catch((error) => toast(error.message, 'warning'));
      return existing.session;
    }
    if (consoles.size >= MAX_CONSOLES) { toast(`You can view ${MAX_CONSOLES} SSH consoles at once. Close a view first; its session will keep running.`); return; }
    let sessions = [], selected = opts.sessionId || null, attached;
    const requestEpoch = ++sshOpenEpoch;
    if (!opts.newSession) {
      try {
        const result = await http('/agent/sessions?profileId=' + encodeURIComponent(pid));
        sessions = result.sessions || [];
        let remembered = null; try { remembered = sessionStorage.getItem('st-ssh-session:' + pid); } catch {}
        const resumable = sessions.filter((s) => !['closed', 'ended', 'error', 'disconnected'].includes(s.terminal?.status || s.status));
        selected ||= resumable.find((s) => (s.sessionId || s.id) === remembered)?.sessionId || resumable[0]?.sessionId || resumable[0]?.id || null;
      } catch (e) { toast('Could not list earlier sessions: ' + e.message, 'warning'); }
    }
    try { attached = await http('/agent/attach', { method: 'POST', body: JSON.stringify({ profileId: pid, ...(selected ? { sessionId: selected } : {}), projectId: host.projects.activeId() }) }); }
    catch (e) { toast(e.message, 'error'); return; }
    if (requestEpoch !== sshOpenEpoch) return;
    if (!attached.sessionId) { toast('The server did not return a shared terminal session.', 'error'); return; }
    // An ended session is a readable archive: show its saved conversation, never open a socket for
    // it (a viewer socket on a dead session is refused, and reviving one silently is worse).
    if (host.session.isDead(attached)) {
      await viewEndedSession({ sessionId: attached.sessionId, profileId: pid, name: attached.name || opts.label });
      toast('That terminal session has ended. Its conversation is read-only; use "New session" to continue.', 'warning');
      return attached;
    }
    try { sessionStorage.setItem('st-ssh-session:' + pid, attached.sessionId); } catch {}
    const id = 'c' + (++consoleSeq);
    const label = opts.label || attached.name || 'Server';
    const c = { id, profileId: pid, sessionId: attached.sessionId, session: attached, label, statusCls: '' };
    consoles.set(id, c);
    $('sshConsoleHost').appendChild(buildConsoleEl(c));
    c.term = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: 'ui-monospace, Consolas, monospace', theme: host.ui.terminalTheme() });
    c.fit = new FitAddon(); c.term.loadAddon(c.fit);
    c.term.open(c.termHost);
    c.sessions = sessions;
    updateTerminalSession(c, { ...attached.terminal, sessionId: attached.sessionId });
    showSshDrawer(); activateConsole(id);
    refreshLiveTerminals(); // a new session belongs on the sidebar straight away
    setTimeout(() => { refitConsole(c); connectConsole(c); c.term.focus(); }, 30);
    if (opts.ai || agentIsDocked()) await host.assistantUi.open();
    if (opts.ai) ensureServerAgent(pid, label).catch((error) => toast(error.message, 'warning'));
    return attached;
  }
  let sshOpenEpoch = 0;

  function updateTerminalSession(c, info) {
    c.session = { ...c.session, terminal: { ...c.session.terminal, ...info } };
    const ai = c.session.terminal.control === 'assistant';
    c.term.options.disableStdin = ai; // the xterm is read-only while the assistant drives
    c.el.classList.toggle('assistant-driving', ai);
    if (info.lastActivityAt) c.lastActivityAt = info.lastActivityAt; // the server's own idea of "recently used"
    if (info.status) setConsoleStatus(c, info.status, ['ready', 'connected', 'open'].includes(info.status) ? 'ok' : '');
    if (c.sessionId === host.session.id()) {
      host.session.set({ ...host.session.current(), ...c.session });
      host.assistantUi.renderChip();
      host.assistantUi.composerState();          // an ended shell locks the composer, live or restored
      host.assistantUi.markStale(c.sessionId, Number(info.revision)); // an approval sealed to an older revision cannot run
    }
    renderWorkspaceIdentity();
  }
  async function changeTerminalControl(c) {
    if (!c) return;
    const control = c.session.terminal?.control === 'assistant' ? 'user' : 'assistant';
    try {
      const result = await http(`/terminal/${encodeURIComponent(c.sessionId)}/control`, { method: 'POST', body: JSON.stringify({ control }) });
      updateTerminalSession(c, { ...(result.terminal || result), sessionId: c.sessionId, control }); // announces in words
      document.dispatchEvent(new CustomEvent('st:terminal-control', { detail: { id: c.id, profileId: c.profileId, sessionId: c.sessionId, control } }));
      if (control === 'user') { c.term.focus(); if (host.session.id() === c.sessionId && $('agentDrawer').classList.contains('open')) await host.assistantUi.open(); }
    } catch (e) { toast(e.message, 'error'); }
  }
  // the console the workspace acts on: the docked one on screen, else any docked one
  const workspaceConsole = () => consoles.get(activeConsoleId) || dockedConsoles()[0] || null;
  hostOn($('btnAgentTerminalControl'), 'click', () => changeTerminalControl([...consoles.values()].find((c) => c.sessionId === host.session.id())));

  // close every console (docked or floating) tied to a given server profile · // used when that server is disconnected so no dead consoles linger
  function closeConsolesForProfile(pid) { [...consoles.values()].filter((c) => c.profileId === pid).forEach((c) => closeConsole(c.id)); }
  /* Leaving the view never touches a session: it detaches this browser's views and nothing else. */
  function closeSshDrawer() { hideSshDrawer(); host.assistantUi.close(); }
  host.on(document, 'keydown', (e) => {
    // don't close while typing in a terminal or in the workspace chat; only when focus is elsewhere
    if (e.key === 'Escape' && $('sshDrawer').classList.contains('open') && !document.querySelector('dialog[open]') && !document.activeElement?.closest('.ssh-console, #agentDrawer')) closeSshDrawer();
  });

  /* ---------- live terminal sessions: the way back to a running shell ----------
     A session outlives every view of it, including this browser tab, so "what is live" comes from
     the server (GET /api/ssh/terminal, status === 'open') rather than from the consoles we happen
     to have open. It drives the sidebar entry, the view's session picker and the servers page, and
     is kept fresh by our own actions, by activity on the event stream, and by a slow poll for
     sessions someone else opened or ended. */
  const LIVE_POLL_MS = 8000;
  const LAST_TERMINAL_KEY = 'st-last-terminal';
  let liveTerminals = [];      // newest activity first
  let livePollTimer = 0;

  const rememberTerminal = (sessionId) => { try { if (sessionId) localStorage.setItem(LAST_TERMINAL_KEY, sessionId); } catch {} };
  const rememberedTerminal = () => { try { return localStorage.getItem(LAST_TERMINAL_KEY) || null; } catch { return null; } };
  const terminalTime = (t) => Date.parse(t?.lastActivityAt || t?.createdAt || 0) || 0;
  /** The session to reopen when the user just asks for "terminals": their last one if it is still
      live, otherwise the most recently used one on the box. */
  function mostRecentTerminal() {
    const remembered = rememberedTerminal();
    return liveTerminals.find((t) => t.sessionId === remembered) || liveTerminals[0] || null;
  }
  async function refreshLiveTerminals() {
    let list = [];
    try { list = ((await http('/terminal')).terminals || []).filter((t) => t.status === 'open'); }
    catch { list = []; }
    liveTerminals = list.sort((a, b) => terminalTime(b) - terminalTime(a));
    renderTerminalsNavEntry();
    renderWorkspaceSessions();
    return liveTerminals;
  }
  function scheduleLivePoll() {
    host.clearTimer(livePollTimer);
    // only while the tab is in front: a hidden tab's sidebar is not being read
    livePollTimer = host.setTimeout(async () => { if (!document.hidden) await refreshLiveTerminals(); scheduleLivePoll(); }, LIVE_POLL_MS);
  }
  host.on(document, 'visibilitychange', () => { if (!document.hidden) refreshLiveTerminals(); });

  /** Sidebar entry: present only while at least one session is LIVE, with how many. */
  function renderTerminalsNavEntry() {
    const link = document.querySelector('#appNav [data-nav="terminals"]');
    if (!link) return;
    const n = liveTerminals.length;
    link.hidden = n === 0;
    const label = link.querySelector('.nav-label');
    if (label) label.innerHTML = `Terminals <span class="nav-count">${n}</span>`;
    link.title = n ? `${n} live terminal session${n === 1 ? '' : 's'} — reopen the most recent` : 'Terminals';
  }

  /** Keep the address on the session being watched, without a new history entry. */
  function syncTerminalRoute(sessionId) {
    if (!sessionId) return;
    const r = '#/terminals/' + sessionId;
    if (host.shell.parseRoute(location.hash)?.id !== 'terminals') {
      host.navigate(r);
    } else if (location.hash !== r) host.shell.replaceRoute(r);
  }

  /** The Terminals route: reopen a named session, else the most recently used live one. */
  async function openTerminals(sessionId) {
    showSshDrawer();
    const live = await refreshLiveTerminals();
    const existing = sessionId ? [...consoles.values()].find((c) => c.sessionId === sessionId) : null;
    if (existing) { activateConsole(existing.id); return; }
    const want = sessionId ? live.find((t) => t.sessionId === sessionId) : mostRecentTerminal();
    if (!want) {
      if (sessionId) toast('That terminal session is no longer running.', 'warning');
      if (consoles.size) activateConsole(activeConsoleId || dockedConsoles()[0].id);
      renderWorkspaceIdentity();
      return;
    }
    const open = [...consoles.values()].find((c) => c.sessionId === want.sessionId);
    if (open) { activateConsole(open.id); return; }
    await openSsh(want.profileId, { ai: true, sessionId: want.sessionId, label: want.profileName || 'Server' });
  }
  function closeTerminals() { dockedConsoles().forEach((c) => closeConsole(c.id)); hideSshDrawer(); host.assistantUi.close(); }

  /* The view's ONE session picker: every live session, grouped by server, plus this console's own
     if it has ended (so its transcript stays reachable). */
  function renderWorkspaceSessions() {
    const sel = $('wsSessionPick'); if (!sel) return;
    const c = workspaceConsole();
    const byServer = new Map();
    for (const t of liveTerminals) {
      const name = t.profileName || t.profileId || 'Server';
      if (!byServer.has(name)) byServer.set(name, []);
      byServer.get(name).push({ id: t.sessionId, label: `${String(t.sessionId).slice(0, 8)} · live` });
    }
    if (c && !liveTerminals.some((t) => t.sessionId === c.sessionId)) {
      const name = c.label || 'Server';
      if (!byServer.has(name)) byServer.set(name, []);
      byServer.get(name).unshift({ id: c.sessionId, label: `${String(c.sessionId).slice(0, 8)} · ended (read-only)` });
    }
    sel.innerHTML = [...byServer].map(([name, rows]) =>
      `<optgroup label="${esc(name)}">${rows.map((r) => `<option value="${esc(r.id)}"${c && r.id === c.sessionId ? ' selected' : ''}>${esc(r.label)}</option>`).join('')}</optgroup>`).join('');
    sel.disabled = !sel.options.length;
  }

  /* The empty state doubles as a picker when no console is open but sessions are running. */
  function renderWorkspaceEmpty() {
    const empty = $('wsEmpty'); if (!empty) return;
    const none = consoles.size === 0;
    empty.hidden = !none;
    $('sshConsoleHost').hidden = none;
    if (!none) return;
    const listHost = $('wsEmptyList');
    listHost.innerHTML = liveTerminals.map((t) =>
      `<button type="button" class="ws-resume" data-sid="${esc(t.sessionId)}"><b>${esc(t.profileName || 'Server')}</b><span>${esc(String(t.sessionId).slice(0, 8))} · last used ${esc(shortWhen(t.lastActivityAt || t.createdAt))}</span></button>`).join('');
    listHost.querySelectorAll('[data-sid]').forEach((b) => b.addEventListener('click', () => host.navigate('#/terminals/' + b.dataset.sid)));
  }
  const shortWhen = (iso) => {
    const t = Date.parse(iso || 0);
    if (!t) return 'recently';
    const mins = Math.round((Date.now() - t) / 60000);
    return mins < 1 ? 'just now' : mins < 60 ? mins + ' min ago' : Math.round(mins / 60) + ' h ago';
  };

  (function wireWorkspaceSessionBar() {
    host.on($('wsSessionPick'), 'change', (e) => {
      const id = e.target.value;
      if (!id || id === workspaceConsole()?.sessionId) return;
      host.navigate('#/terminals/' + id);
    });
    host.on($('btnWsClear'), 'click', () => { const c = workspaceConsole(); if (c) { c.term.clear(); c.term.focus(); } });
    host.on($('btnWsNewSession'), 'click', () => {
      const c = workspaceConsole();
      if (!c) { host.navigate('#/servers'); return; }
      openSsh(c.profileId, { ai: true, newSession: true, label: c.label });
    });
    host.on($('btnWsEndSession'), 'click', async () => {
      const c = workspaceConsole(); if (!c) return;
      const ok = await confirm({
        title: 'End terminal session',
        message: `End the terminal on <b>${esc(c.label)}</b>? Running commands stop and every viewer loses it. Closing this view instead keeps the session running.`,
        okLabel: 'End session', okClass: 'reject',
      });
      if (!ok) return;
      try { await http(`/terminal/${encodeURIComponent(c.sessionId)}`, { method: 'DELETE' }); } catch (e) { toast(e.message, 'error'); return; }
      closeConsole(c.id);
      await refreshLiveTerminals();
    });
    host.on($('btnWsGoServers'), 'click', () => host.navigate('#/servers'));
  })();

  /* ---------- Terminal workspace: the shared shell and its session's chat ----------
     One workspace, two panes. From 1100px up both are on screen side by side; below that they are
     Terminal/Chat tabs. The chat pane holds the REAL #agentDrawer element, moved out of the top
     layer and back again, so there is only ever one conversation in the DOM and every existing chat
     selector keeps resolving. This block is layout only: pane/tab switching, refitting, the
     ownership affordances and the aria wiring. Conversation state stays where it already lives. */
  const WS_SPLIT_MQ = window.matchMedia('(min-width: 1100px)');
  const WS_PANES = [['terminal', 'wsTabTerminal', 'wsPaneTerminal'], ['chat', 'wsTabChat', 'wsPaneChat']];
  const WS_OWNER = {
    user: { badge: 'You have control', say: 'You have control of the terminal.', act: 'Give AI control', hint: 'The assistant cannot type until you hand it over' },
    assistant: { badge: 'Assistant has control', say: 'The assistant has control of the terminal. Typing is disabled until you take it back.', act: 'Take control', hint: 'The terminal is read-only while the assistant drives' },
    ended: { badge: 'Session ended', say: 'This terminal session has ended. Its conversation is read-only.', act: 'Session ended', hint: 'Start a new session to run anything on this server' },
  };
  let wsTab = 'terminal';     // which pane the tabs show while the split is off
  let wsAgentWasOpen = false; // was the floating assistant open before the workspace borrowed it?
  let wsLastOwner = '';       // don't re-announce the same owner on every repaint

  const agentIsDocked = () => $('agentDrawer')?.classList.contains('ag-docked');
  const wsActive = () => $('sshDrawer').classList.contains('open');

  /* Park the assistant in the chat pane, or hand it back to its floating window. */
  function wsDockAgent(on) {
    const el = $('agentDrawer'); if (!el || on === !!agentIsDocked()) return;
    if (on) {
      wsAgentWasOpen = el.classList.contains('open');
      try { if (el.matches(':popover-open')) el.hidePopover(); } catch {}
      el.removeAttribute('popover'); // a top-layer popover cannot sit inside the split
      el.removeAttribute('style');   // drop the floating geometry
      el.classList.add('ag-docked', 'open');
      $('wsChatHost').appendChild(el);
      if (!wsAgentWasOpen) host.assistantUi.open(); // the existing loader: fetches THIS session's conversation
    } else {
      el.classList.remove('ag-docked');
      document.body.appendChild(el);
      el.setAttribute('popover', 'manual');
      if (wsAgentWasOpen) { host.assistantUi.restoreGeometry(); host.assistantUi.raise(); }
      else el.classList.remove('open'); // it was only open because the workspace borrowed it
    }
  }

  /* The one entry point: recompute panes, tabs, aria and sizing from the current state. */
  function applyWorkspaceLayout() {
    const on = wsActive();
    const split = on && WS_SPLIT_MQ.matches;
    document.body.classList.toggle('ws-page', on);
    document.body.classList.toggle('ws-wide', split);
    wsDockAgent(on);
    $('wsTabs').hidden = !on || split;
    for (const [name, tabId, paneId] of WS_PANES) {
      const tab = $(tabId), pane = $(paneId);
      pane.hidden = on ? !(split || wsTab === name) : name === 'chat'; // off the workspace the terminal is the whole drawer
      if (split || !on) { // both panes stand on their own: tab semantics would be a lie
        pane.setAttribute('role', 'group');
        pane.setAttribute('aria-label', name === 'chat' ? 'Assistant chat' : 'Terminal');
        pane.removeAttribute('aria-labelledby'); pane.removeAttribute('tabindex');
      } else {
        pane.setAttribute('role', 'tabpanel');
        pane.setAttribute('aria-labelledby', tabId);
        pane.removeAttribute('aria-label');
        pane.setAttribute('tabindex', '0'); // the panel is a scroll container, so it takes focus
      }
      tab.setAttribute('aria-selected', String(wsTab === name));
      tab.tabIndex = wsTab === name ? 0 : -1; // roving tabindex: one stop for the whole strip
    }
    renderWorkspaceIdentity();
    wsRefitSoon();
  }

  function setWorkspaceTab(tab, opts = {}) {
    wsTab = tab === 'chat' ? 'chat' : 'terminal';
    applyWorkspaceLayout();
    if (opts.focus) $(wsTab === 'chat' ? 'wsTabChat' : 'wsTabTerminal').focus();
    else if (wsTab === 'terminal') { const c = workspaceConsole(); if (c) try { c.term.focus(); } catch {} }
  }

  /* Identity (server + session), the ownership badge and both control buttons, in both panes.
     Ownership is carried by the WORD; the dot and the border only reinforce it. */
  function renderWorkspaceIdentity() {
    const c = workspaceConsole();
    const show = $('sshDrawer').classList.contains('open') && !!c;
    const ident = $('wsIdent'); if (!ident) return;
    ident.hidden = !show;
    renderWorkspaceEmpty();
    renderWorkspaceSessions();
    if (!show) { $('wsChatIdent').textContent = ''; return; }
    const dead = host.session.isDead(c.session);
    const owner = dead ? 'ended' : c.session?.terminal?.control === 'assistant' ? 'assistant' : 'user';
    const o = WS_OWNER[owner];
    const server = c.label;
    const session = `session ${String(c.sessionId || '').slice(0, 8)}`;
    $('wsServer').textContent = server;
    $('wsChatIdent').textContent = `${server} · ${session}${dead ? ' · ended' : ''}`;
    for (const id of ['wsOwner', 'wsChatOwner']) {
      const el = $(id); el.dataset.owner = owner;
      el.querySelector('.ws-owner-text').textContent = o.badge;
    }
    for (const id of ['btnWsControl', 'btnWsControlChat']) {
      const b = $(id); b.textContent = o.act; b.title = o.hint; b.disabled = dead;
      b.classList.toggle('warn', owner === 'assistant');
    }
    announceOwnership(owner);
  }
  /* One live region for both panes, and only when the owner actually changed. A handover briefly
     reports the OLD owner while the shell is probed, so the announcement waits for it to settle. */
  let wsAnnounceTimer = 0;
  function announceOwnership(owner) {
    if (wsLastOwner === owner) return;
    const first = !wsLastOwner; // the first paint states the situation, it does not announce it
    wsLastOwner = owner;
    if (first) return;
    clearTimeout(wsAnnounceTimer);
    wsAnnounceTimer = setTimeout(() => { if (wsLastOwner === owner) $('wsOwnerLive').textContent = WS_OWNER[owner].say; }, 250);
  }

  /* Refit whenever the visible box can have changed, coalesced into one frame. */
  let wsRefitRaf = 0;
  function wsRefitSoon() {
    if (wsRefitRaf) return;
    wsRefitRaf = requestAnimationFrame(() => { wsRefitRaf = 0; refitConsoles(); });
  }

  (function wireWorkspace() {
    WS_SPLIT_MQ.addEventListener('change', () => applyWorkspaceLayout());
    // the split box changes with the sidebar, the drawer orientation and the window
    new ResizeObserver(wsRefitSoon).observe($('wsSplit'));
    window.addEventListener('resize', wsRefitSoon);
    // .open is set by the router: follow it rather than duplicating the routing
    new MutationObserver(() => applyWorkspaceLayout()).observe($('sshDrawer'), { attributes: true, attributeFilter: ['class'] });
    host.on($('wsTabTerminal'), 'click', () => setWorkspaceTab('terminal'));
    host.on($('wsTabChat'), 'click', () => setWorkspaceTab('chat'));
    host.on($('wsTabs'), 'keydown', (e) => {
      const order = WS_PANES.map(([n]) => n), i = order.indexOf(wsTab);
      let n = -1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = (i + 1) % order.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = (i - 1 + order.length) % order.length;
      else if (e.key === 'Home') n = 0;
      else if (e.key === 'End') n = order.length - 1;
      if (n < 0) return;
      e.preventDefault();
      setWorkspaceTab(order[n], { focus: true });
    });
    for (const id of ['btnWsControl', 'btnWsControlChat']) $(id).addEventListener('click', () => changeTerminalControl(workspaceConsole()));
    applyWorkspaceLayout();
  })();
  refreshLiveTerminals(); // a session running from a previous visit must offer its way back at once
  scheduleLivePoll();

  return {
    openServers, closeServers, loadServers,
    openTerminals, closeTerminals, showSshDrawer, hideSshDrawer, openSsh,
    refreshLiveTerminals, renderTerminalsNavEntry, consoles,
    agentIsDocked, setWorkspaceTab, loadSshAgent, refitConsoles,
    liveTerminals: () => liveTerminals,
  };
}
