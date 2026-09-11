/* Servers & Terminals - frontend entry point.
 *
 * xterm belongs to this module, not to the base application: the base index.html
 * loads no terminal library at all, and this one brings its own copy. It is
 * loaded here, once, from the package. */
'use strict';

import { createServersUI } from './servers-ui.js';

let ui = null;

/** Load xterm from the package. The library is a classic script with globals,
    so it is added once and then read off window. */
function loadVendorScript(url) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-module-vendor="${url}"]`);
    if (existing) return existing.dataset.loaded ? resolve() : existing.addEventListener('load', () => resolve());
    const script = document.createElement('script');
    script.src = url;
    script.dataset.moduleVendor = url;
    script.onload = () => { script.dataset.loaded = '1'; resolve(); };
    script.onerror = () => reject(new Error('the terminal library could not be loaded'));
    document.head.appendChild(script);
  });
}

export async function activate(host) {
  host.styles.link(new URL('./servers.css', import.meta.url).href);
  host.styles.link(new URL('./vendor/xterm.css', import.meta.url).href);
  await loadVendorScript(new URL('./vendor/xterm.js', import.meta.url).href);
  await loadVendorScript(new URL('./vendor/xterm-addon-fit.js', import.meta.url).href);
  const Terminal = window.Terminal;
  const FitAddon = window.FitAddon?.FitAddon || window.FitAddon;
  if (!Terminal) throw new Error('the terminal library did not load');

  const mount = host.mount('servers');
  mount.innerHTML = [
    await fetch(new URL('./servers.html', import.meta.url)).then((r) => r.text()),
    await fetch(new URL('./terminals.html', import.meta.url)).then((r) => r.text()),
    await fetch(new URL('./server-form.html', import.meta.url)).then((r) => r.text()),
  ].join('\n');
  mount.hidden = false;
  const serversDrawer = mount.querySelector('#serversDrawer');
  const terminalsDrawer = mount.querySelector('#sshDrawer');

  /* The "Add server" form is a plain form the shell shows as a modal. */
  host.ui.formAsModal('addServerForm', 'serverFormModal', 'serverFormHost', 'btnServerFormClose');

  ui = createServersUI({ host, mount, Terminal, FitAddon });

  /* ---- pages ---- */
  host.registerPage({
    id: 'servers', segment: 'servers', label: 'Servers', group: 'Infrastructure', order: 21,
    icon: host.ui.icons.server, title: 'Servers',
    desc: 'SSH server profiles, live VM stats and terminals.',
    enter: (parts) => {
      ui.openServers();
      if (parts[1] === 'terminal' && parts[0]) ui.openSsh(parts[0], { label: 'server' });
    },
    leave: () => ui.closeServers(),
    focus: () => serversDrawer.querySelector('h2'),
  });

  host.registerPage({
    id: 'terminals', segment: 'terminals', label: 'Terminals', group: 'Infrastructure', order: 22,
    icon: host.ui.icons.console, title: 'Terminals', liveOnly: true,
    desc: 'Shared SSH shells you have open, side by side with the assistant that works in them.',
    enter: (parts) => ui.openTerminals(parts[0]),
    leave: () => ui.closeTerminals(),
    focus: () => terminalsDrawer.querySelector('h2'),
    afterRender: () => ui.renderTerminalsNavEntry(),
  });

  host.registerLauncherTile({
    id: 'servers', name: 'Servers', route: '#/servers', tag: 'Infrastructure', accent: '--amber', order: 21,
    icon: host.ui.icons.server,
    desc: 'Manage SSH servers, watch live VM stats, and open full terminals.',
    launch: () => host.navigate('#/servers'),
  });

  host.registerTourStep({
    id: 'servers', order: 20, element: '#serversDrawer .view-head', route: '#/servers', title: 'Servers',
    intro: '<b>+ Add server</b> asks how to authenticate: the <b>Server Tools key</b> (one command on the server, no key handling), your own key, or a password. It can also install the Claude CLI on the box. <b>Connect</b> shows live VM stats; <b>Terminal</b> opens a full console in its own page, shared with the assistant — every command it wants to run is an approval card.',
  });

  host.registerSearchSource({
    key: 'servers', prefixes: ['servers', 'server', 'ssh'], label: 'Servers', icon: 'server',
    tip: 'Search SSH servers',
    fetch: () => host.http('/sessions').then((d) => d.sessions || []),
    map: (s) => ({ title: s.name, sub: `${s.user}@${s.host}:${s.port}${s.connected ? ' · connected' : ''}`, action: { k: 'server', id: s.id, name: s.name } }),
    run: (action) => {
      host.navigate('#/servers');
      setTimeout(() => {
        const card = [...mount.querySelectorAll('#serversList .srv-card')].find((el) => el.textContent.includes(action.name));
        card?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 260);
    },
  });

  /* ---- settings the assistant's server access needs ---- */
  host.registerSettingsSection({
    id: 'ssh', label: 'SSH servers', order: 60,
    render: async (element) => {
      element.innerHTML = '<div class="settings-group"><div class="sg-head">SSH servers <span class="hint" data-count style="margin:0"></span></div><div class="settings-list" data-list></div><div class="settings-actions"><button class="primary" data-open>Open SSH servers</button></div></div>';
      element.querySelector('[data-open]').onclick = () => { document.getElementById('settingsModal')?.close(); host.navigate('#/servers'); };
      try {
        const { sessions } = await host.http('/sessions');
        const connected = sessions.filter((s) => s.connected).length;
        element.querySelector('[data-count]').textContent = sessions.length ? `${connected}/${sessions.length} connected` : '';
        element.querySelector('[data-list]').innerHTML = sessions.length
          ? sessions.map((s) => `<div class="settings-row"><span class="srv-dot ${s.connected ? 'on' : ''}"></span><span class="sr-name">${host.ui.esc(s.name)}</span><span class="spacer"></span><span class="sr-sub">${host.ui.esc(s.user)}@${host.ui.esc(s.host)}</span></div>`).join('')
          : '<div class="empty">No SSH-enabled profiles.</div>';
      } catch (error) {
        element.querySelector('[data-list]').innerHTML = `<div class="empty" style="color:var(--red)">${host.ui.esc(error.message)}</div>`;
      }
    },
  });

  host.registerSettingsGroup({
    section: 'ai', id: 'ssh-access', order: 20,
    render: async (element) => {
      if (element.dataset.built) return;
      element.dataset.built = '1';
      element.innerHTML = await fetch(new URL('./settings-ai.html', import.meta.url)).then((r) => r.text());
      // The host owns saving; these are the same server-side aiAssist flags.
      const settings = await host.api('/api/settings');
      element.querySelectorAll('[data-assist]').forEach((box) => {
        box.checked = !!settings.aiAssist?.[box.dataset.assist];
        host.on(box, 'change', async () => {
          try {
            await host.api('/api/settings', { method: 'PUT', body: JSON.stringify({ aiAssist: { [box.dataset.assist]: box.checked } }) });
            await host.rpc('settingsChanged', {});
          } catch { box.checked = !box.checked; }
        });
      });
    },
  });

  /* ---- assistant integration ---- */
  host.assistant.dock({ isDocked: () => ui.agentIsDocked(), setTab: (tab) => ui.setWorkspaceTab(tab) });
  host.assistant.registerProposalCard('ssh-command', (element, proposal, { wire, esc }) => {
    const danger = proposal.cls === 'destructive';
    element.innerHTML = `
      <div class="ap-head">Approve command on <b>${esc(proposal.serverName || '')}</b> <span class="badge ${danger ? 'failed' : 'plan'}">${danger ? 'destructive' : esc(proposal.cls || 'terminal input')}</span></div>
      <div class="ap-meta">${esc(proposal.host || '')}${proposal.why ? ' · ' + esc(proposal.why) : ''}${proposal.reason ? ' · ' + esc(proposal.reason) : ''}</div>
      <pre class="ap-cmd">$ ${esc(proposal.cmd || proposal.input || proposal.data || '')}</pre>
      <div class="hint">Runs in the shared terminal after you give the AI control and accept. Taking control cancels pending approvals.</div>
      <div class="actions">
        <button class="approve" data-dec="approve">Accept and run</button>
        <button class="reject" data-dec="reject">Reject</button>
      </div>
      <div class="ap-out" hidden><pre></pre></div>`;
    wire();
  });
  host.assistant.registerProposalCard('ssh-terminal-input', (element, proposal, helpers) =>
    HostSDK.proposalRenderers.get('ssh-command')?.render(element, proposal, helpers));

  /* ---- host events this module reacts to ---- */
  host.events.on('ssh-agent', (update) => {
    if (update.sessionId && update.sessionId === host.session.id()) {
      host.session.patch(update);
      host.assistantUi.renderChip();
    }
    if (serversDrawer.classList.contains('open')) ui.loadServers();
  });
  /* Switching project, or attaching a server to one, changes which servers
     this project can see. The list comes from the backend, which scopes it. */
  host.on(document, 'st:project', () => ui.loadServers());
  host.on(document, 'st:project-resources', () => ui.loadServers());
  host.events.on('log', (entry) => { if (/terminal/i.test(entry?.msg || '')) ui.refreshLiveTerminals(); });
  host.events.on('theme:change', () => {
    for (const console_ of ui.consoles.values()) { try { if (console_.term) console_.term.options.theme = host.ui.terminalTheme(); } catch {} }
  });
  host.events.on('layout:change', () => ui.refitConsoles());

  host.observe(host.shell.watchPage(serversDrawer, 'servers'));
  host.observe(host.shell.watchPage(terminalsDrawer, 'terminals'));

  await ui.refreshLiveTerminals().catch(() => {});
  await ui.loadSshAgent().catch(() => {});

  /* What other modules may use: Projects lists servers, Deployments picks one. */
  host.provide({
    serverProfiles: async () => (await host.http('/sessions')).sessions.filter((s) => s.sshOnly),
    openTerminal: (profileId) => ui.openSsh(profileId, { label: 'server' }),
    liveTerminals: () => ui.liveTerminals(),
  });
}

export async function deactivate() {
  // Terminals are closed by the host before removal is allowed (an open shell
  // makes the module busy), so there is nothing to tear down but our own state.
  ui?.closeTerminals?.();
  ui = null;
}
