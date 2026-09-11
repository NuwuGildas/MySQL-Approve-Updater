'use strict';
/* Servers & Terminals - backend.
 *
 * Everything about reaching a server lives in this worker: the ssh2 clients, the
 * shared shells, the WebSocket viewer and the assistant's terminal tools. The
 * base application keeps only what it needs for itself - a database connection
 * may still tunnel over SSH with this module absent, because that tunnel is the
 * core's own code and its own ssh2 client.
 *
 * The module answers over its own HTTP surface (an Express app the host proxies
 * to) so its routes and its WebSocket endpoint disappear completely when it is
 * removed: the host's routing table never grows. */

const { createSshSessions } = require('./ssh');
const { createTerminalSessions } = require('./terminal');
const { createTerminalViewer } = require('./terminal-ws');
const { createSshAgent } = require('./agent');
const { createRemoteAgents } = require('./remote-agent');

const fail = (status, message) => Object.assign(new Error(message), { status });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function activate(host) {
  const express = host.shared('express');
  const { WebSocketServer } = require('ws');   // bundled with this package
  const { Client: SSHClient } = host.shared('ssh2');

  const log = (level, message) => host.log(level, message);
  let settings = await host.settings();
  const refreshSettings = async () => { settings = await host.settings(); return settings; };

  const ssh = createSshSessions({ host, SSHClient, log });

  /* The shells ask for a profile synchronously, so the credentials fetched for a
     connection are kept here for as long as that server is in use. */
  const profileCache = new Map();

  /* The shared shells. One per terminal id, independent of who is watching. */
  const terminals = createTerminalSessions({
    sshSessions: ssh.sessions,
    sshClientFor: (sshCfg) => ssh.clientFor(sshCfg),
    profileById: (id) => profileCache.get(id) || null,
    audit: (entry) => host.audit(entry).catch(() => {}),
  });

  /* The coding agent installed ON a server: Claude Code or Codex, run read-only,
     proposing rather than changing. Connecting is this module's job, so the
     agent tool asks by profile id and never handles a client itself. */
  const agents = createRemoteAgents({ exec: (client, command, options) => ssh.execCapture(client, command, options), log });
  const remoteAgents = {
    detect: async (profileId) => {
      const { profile, session } = await ssh.connect(profileId);
      const found = await agents.detect(session.client);
      /* Recorded so "nothing happened" is answerable from the activity history
         rather than from a browser console: this is the check that decides
         whether the user is offered an agent at all. */
      const installed = Object.entries(found).filter(([, agent]) => agent.installed).map(([id, agent]) => `${id} ${agent.version || ''}`.trim());
      await host.audit({ action: 'ssh-agent-detect', profile: profile.name, sshHost: profile.ssh.host, found: installed.join(', ') || 'none' });
      log('info', `coding agents on "${profile.name}": ${installed.join(', ') || 'none'}`);
      return found;
    },
    install: async (profileId, agentId) => {
      const { profile, session } = await ssh.connect(profileId);
      const result = await agents.install(session.client, agentId);
      await host.audit({ action: 'ssh-agent-install', profile: profile.name, sshHost: profile.ssh.host, agent: agentId, ok: result.ok });
      log(result.ok ? 'info' : 'warn', `${agentId} on "${profile.name}": ${result.alreadyInstalled ? 'already installed' : result.ok ? 'installed' : 'did not install'}`);
      return result;
    },
    /** Pick the agent to use: the one asked for, else whichever is installed. */
    run: async (profileId, { agent: wanted, task, serverName, timeoutSec }) => {
      const { session } = await ssh.connect(profileId);
      const found = await agents.detect(session.client);
      const chosen = wanted && agents.ids().includes(wanted) ? wanted : agents.ids().find((id) => found[id].installed);
      if (!chosen) {
        throw Object.assign(new Error(`No coding agent is installed on "${serverName}". Install Claude Code or Codex from the server's card first.`), { status: 409 });
      }
      /* The agent on the server may borrow the assistant's own sign-in, if the
         user turned that on. The host refuses unless it is on and it actually
         holds a token, and a refusal is not a failure here: the agent's own
         login on the box is the normal case. The token is fetched per run and
         held only for the length of this call. */
      let credential = null;
      if (settings.aiAssist?.shareCredentialWithAgents) {
        try { credential = await host.call('assistant.credential', {}); }
        catch (error) { log('info', `not sharing the assistant sign-in with "${serverName}": ${error.message}`); }
      }

      return agents.ask(session.client, {
        agent: chosen, task, serverName, known: found, credential,
        timeoutMs: Math.min(600000, Math.max(10000, (Number(timeoutSec) || 180) * 1000)),
      });
    },
  };

  const agent = createSshAgent({ host, terminals, settings: () => settings, remoteAgents, log });

  /* The host's read model of which sessions are live, and what the assistant may
     do in each. Republished whenever a terminal changes, and on a slow tick so a
     shell that died on its own is not reported as open. */
  const publishTimer = setInterval(() => agent.publish(), 5000);
  publishTimer.unref?.();

  /* ---------------- HTTP surface ---------------- */
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const profiles = async () => (await host.call('connections.list', {})).filter((p) => p.ssh?.enabled && p.ssh.host);
  const profileWithSecrets = async (id) => {
    const profile = await host.call('connections.credentials', { id });
    if (profile) profileCache.set(id, profile);
    return profile;
  };

  /* ---- server profiles (SSH-only) ----
     A server attached to a project exists only inside it. The host says which
     project the caller is in (X-Project) and owns the rule; this only asks. */
  const scopeTo = async (req, kind, items, id = (x) => x.id) => {
    const projectId = req.get('x-project');
    if (!projectId) return items;
    const visible = new Set(await host.call('projects.visible', { projectId, kind, ids: items.map(id) }));
    return items.filter((item) => visible.has(id(item)));
  };

  app.get('/sessions', wrap(async (req, res) => {
    const list = await scopeTo(req, 'servers', await profiles());
    res.json({ sessions: list.map((p) => ssh.view(p)) });
  }));

  app.get('/app-key', wrap(async (req, res) => {
    const key = await host.call('connections.appKey', {});
    res.json({ publicKey: key.publicKey, fingerprint: key.fingerprint, installCmd: key.installCmd });
  }));

  app.post('/profiles', wrap(async (req, res) => {
    const saved = await host.call('connections.save', { ...req.body, sshOnly: true });
    res.json(saved);
  }));
  app.delete('/profiles/:id', wrap(async (req, res) => {
    closeTerminalsFor(req.params.id);
    ssh.disconnect(req.params.id);
    await host.call('connections.remove', { id: req.params.id });
    res.json({ ok: true });
  }));

  app.post('/sessions/:id/connect', wrap(async (req, res) => {
    const { profile, session } = await ssh.connect(req.params.id);
    profileCache.set(profile.id, profile);
    try { session.meta = await ssh.pullMeta(session.client); }
    catch (error) { session.meta = { error: error.message, pulledAt: new Date().toISOString() }; }
    res.json(ssh.view(profile));
  }));

  app.post('/sessions/:id/refresh', wrap(async (req, res) => {
    const session = ssh.sessions.get(req.params.id);
    if (!session) throw fail(409, 'Not connected');
    const profile = await profileWithSecrets(req.params.id);
    try { session.meta = await ssh.pullMeta(session.client); }
    catch (error) { throw fail(500, `Meta refresh failed: ${error.message}`); }
    res.json(ssh.view(profile));
  }));

  app.post('/sessions/:id/disconnect', wrap(async (req, res) => {
    const killed = closeTerminalsFor(req.params.id);   // end the shared shells on this server first
    const profile = await host.call('connections.get', { id: req.params.id });
    const wasConnected = ssh.disconnect(req.params.id);
    if (wasConnected) log('info', `SSH session disconnected: ${profile?.ssh?.host} ("${profile?.name}")${killed ? `, ${killed} terminal(s) killed` : ''}`);
    res.json({ ok: true, terminalsClosed: killed, cleaned: [] });
  }));

  /* ---- the coding agent on the server ----
     Which agents a server has, installing one, and asking it something. The
     answer is a report plus approval cards; nothing it proposes runs here. */
  app.get('/sessions/:id/agents', wrap(async (req, res) => {
    res.json({ agents: await remoteAgents.detect(req.params.id) });
  }));

  app.post('/sessions/:id/agents/:agent/install', wrap(async (req, res) => {
    res.json(await remoteAgents.install(req.params.id, req.params.agent));
  }));

  /* Ask this session's server agent something. Deliberately the SAME call the
     assistant makes, so the guards are not written twice: it needs a live
     session, it obeys Settings, and whatever comes back is proposals. */
  app.post('/agent/ask', wrap(async (req, res) => {
    res.json(await agent.tools.ssh_server_agent.run(
      { task: req.body?.task, agent: req.body?.agent, timeoutSec: req.body?.timeoutSec },
      { sessionId: String(req.body?.sessionId || '') },
    ));
  }));

  /* Kept for the "Auto-install Claude CLI" box on the add-server form, which is
     older than the choice of agent. */
  app.post('/sessions/:id/bootstrap-claude', wrap(async (req, res) => {
    const result = await remoteAgents.install(req.params.id, 'claude');
    res.json({ ...result, output: result.output || '' });
  }));

  /* ---- one-shot console (command per exec, cwd-aware) ---- */
  app.post('/console/exec', wrap(async (req, res) => {
    const id = String(req.body?.profileId || '');
    const command = String(req.body?.command || '').trim();
    if (!command) throw fail(400, 'command is required');
    const { session } = await ssh.connect(id);
    const out = await ssh.exec(session.client, command, 60000);
    res.json({ output: out });
  }));

  /* ---- shared terminals ---- */
  const shellView = (snapshot) => { const { output, ...rest } = snapshot; return rest; };
  function closeTerminalsFor(profileId) {
    const ids = [...terminals.sessions.values()].filter((t) => t.profileId === profileId && t.status !== 'closed').map((t) => t.sessionId);
    for (const id of ids) { try { terminals.close(id); } catch {} }
    return ids.length;
  }

  app.get('/terminal', wrap(async (req, res) => {
    const list = [...terminals.sessions.values()].filter((t) => t.status !== 'closed')
      .map((t) => ({ ...shellView(terminals.snapshot(t.sessionId)), profileName: profileCache.get(t.profileId)?.name || null }));
    res.json({ terminals: list });
  }));
  app.get('/terminal/:id', wrap(async (req, res) => {
    const cursor = req.query.cursor === undefined ? undefined : Number(req.query.cursor);
    res.json(terminals.snapshot(req.params.id, { cursor }));
  }));
  app.post('/terminal/:id/control', wrap(async (req, res) => {
    const view = shellView(await terminals.setControl(req.params.id, String(req.body?.control || '')));
    log('info', `shared terminal ${req.params.id.slice(0, 8)}: control → ${view.control}`);
    await agent.publish();
    res.json({ terminal: view, ...view });
  }));
  app.post('/terminal/:id/input', wrap(async (req, res) => res.json(shellView(terminals.writeUser(req.params.id, String(req.body?.data ?? ''))))));
  app.post('/terminal/:id/resize', wrap(async (req, res) => res.json(shellView(terminals.resize(req.params.id, req.body?.cols, req.body?.rows)))));
  app.delete('/terminal/:id', wrap(async (req, res) => {
    const view = shellView(terminals.close(req.params.id));
    log('info', `shared terminal ${req.params.id.slice(0, 8)} ended`);
    await agent.publish();
    res.json({ terminal: view, ...view });
  }));

  /* ---- the assistant's attachment to a terminal ---- */
  app.get('/agent', wrap(async (req, res) => res.json(await agent.status(req.query?.sessionId))));
  app.get('/agent/sessions', wrap(async (req, res) => {
    const id = String(req.query?.profileId || '');
    res.json({ profileId: id, sessions: await agent.listForProfile(id) });
  }));
  app.post('/agent/attach', wrap(async (req, res) => {
    const id = String(req.body?.profileId || '');
    await profileWithSecrets(id);            // the shell needs the credentials
    res.json(await agent.attach(id, req.body || {}));
  }));
  app.post('/agent/detach', wrap(async (req, res) => res.json(await agent.detach(req.body?.sessionId))));

  app.use((error, req, res, next) => {   // eslint-disable-line no-unused-vars
    res.status(error.status || 500).json({ error: error.message || 'Internal error' });
  });

  /* ---- the live terminal view (WebSocket), served by this module ---- */
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', createTerminalViewer(terminals));
  app.handleUpgrade = (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return void socket.destroy(); }
    if (!url.pathname.endsWith('/terminal')) return void socket.destroy();
    const sessionId = url.searchParams.get('sessionId') || '';
    const known = !!sessionId && !!terminals.get(sessionId);
    // The handshake completes even for a refusal, so the browser gets a readable
    // reason and close code rather than an opaque failed upgrade.
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!known) {
        try { ws.send(JSON.stringify({ type: 'error', code: 'unknown-terminal-session', sessionId: sessionId || null, message: 'That terminal session no longer exists. Open a new terminal session for this server.' })); } catch {}
        try { ws.close(4404, 'unknown terminal session'); } catch {}
        return;
      }
      wss.emit('connection', ws, req);
    });
  };

  await agent.publish();
  await host.call('assistant.setPromptFragment', { text: '\n- A server terminal session may be selected; when one is, the ssh_* tools work only inside it.' });

  return {
    http: app,

    methods: {
      /** The prompt fragment for one conversation, asked for by the host. */
      promptFragment: ({ sessionId }) => agent.promptFragment(sessionId),
      settingsChanged: async () => { await refreshSettings(); await agent.publish(); return { ok: true }; },
    },

    assistantTools: agent.tools,

    proposalKinds: {
      'ssh-command': {
        label: (p) => `command on "${p.serverName}": ${p.cmd}`,
        approve: (proposal) => agent.approve(proposal),
      },
    },

    /* A live shell is work that cannot safely stop, so it blocks removal. */
    busy: () => [...terminals.sessions.values()].some((t) => !['closed', 'ended', 'error', 'disconnected'].includes(t.status)),

    async deactivate() {
      clearInterval(publishTimer);
      for (const terminal of [...terminals.sessions.values()]) { try { terminals.close(terminal.sessionId); } catch {} }
      for (const id of [...ssh.sessions.keys()]) ssh.disconnect(id);
      try { wss.close(); } catch {}
      await host.call('sessions.publish', { sessions: {} }).catch(() => {});
      await host.call('assistant.setPromptFragment', { text: '' }).catch(() => {});
    },
  };
}

module.exports = { activate };
