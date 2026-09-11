'use strict';
/* Deployments (The Ascension) - backend.
 *
 * The whole engine moved here unchanged: it is the same lib/deploy the base
 * application used to carry, now inside the package that owns it. This file is
 * only the adapter between what that engine expects (an Express app, a
 * connection store, an SSH client factory, the assistant's tool table) and what
 * the module host offers (its own HTTP surface, capability-gated services).
 *
 * Shared infrastructure stays shared: connection profiles and their credentials
 * come from the host, and the encrypted vault is the host's file. The host only
 * ever READS the vault (to redact secrets out of anything printed); this module
 * is the one that writes it, so there is no second writer. */

const fs = require('node:fs');
const path = require('node:path');
const deploy = require('./deploy');
const { createProjectView } = require('./deploy/project-view');

const httpError = (status, message) => Object.assign(new Error(message), { status });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** ssh2 connect options for a profile. The same shape the base application uses. */
function connectOptions(sshCfg, client) {
  const options = { host: sshCfg.host, port: sshCfg.port, username: sshCfg.user, readyTimeout: 20000, keepaliveInterval: 15000, keepaliveCountMax: 4 };
  if (sshCfg.privateKeyPath) {
    options.privateKey = fs.readFileSync(sshCfg.privateKeyPath);
    if (sshCfg.passphrase) options.passphrase = sshCfg.passphrase;
  } else if (sshCfg.password) {
    options.password = sshCfg.password;
    options.tryKeyboard = true;
    client.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => finish(prompts.map(() => sshCfg.password)));
  } else {
    throw new Error('SSH enabled but neither an SSH password nor a private key is configured');
  }
  return options;
}

async function activate(host) {
  const express = host.shared('express');
  const { Client: SSHClient } = host.shared('ssh2');

  const app = express();
  app.use(express.json({ limit: '2mb' }));

  /* ---- what the engine calls a connection store ----
     A snapshot of the host's profiles, refreshed when this module changes them
     and on a slow tick, because a profile edited in Connections must be usable
     here without a restart. */
  const connStore = { profiles: await host.call('connections.list', { secrets: true }) };
  async function refreshConnections() {
    try { connStore.profiles = await host.call('connections.list', { secrets: true }); }
    catch (error) { host.log('warn', `connection profiles could not be refreshed: ${error.message}`); }
  }
  const connectionTimer = setInterval(refreshConnections, 15000);
  connectionTimer.unref?.();
  const saveConnections = async () => {
    // Cloud provisioning adds a server profile; the host owns the file.
    for (const profile of connStore.profiles) if (profile.__new) { delete profile.__new; await host.call('connections.save', profile); }
    await refreshConnections();
  };
  const profileById = (id) => connStore.profiles.find((p) => p.id === id);

  const sshSessions = new Map();
  const sshClientFor = (sshCfg) => new Promise((resolve, reject) => {
    const client = new SSHClient();
    let options;
    try { options = connectOptions(sshCfg, client); }
    catch (error) { return reject(new Error(error.message)); }
    let settled = false;
    client.on('ready', () => { settled = true; resolve(client); });
    client.on('error', (error) => { if (!settled) { settled = true; reject(new Error(error.message)); } });
    client.connect(options);
  });

  /* Projects belong to the host; this is the read model the engine checks
     ownership against, refreshed from it. */
  const projects = createProjectView({
    load: () => host.call('projects.list', {}),
    visible: (projectId, kind, ids) => host.call('projects.visible', { projectId, kind, ids }),
    log: (level, message) => host.log(level, message),
  });
  await projects.refresh();
  const projectTimer = setInterval(() => projects.refresh(), 15000);
  projectTimer.unref?.();

  /* ---- the assistant's tables, filled by the engine and published to the host ---- */
  const tools = {};
  const proposalKinds = {};
  /* The engine pushes approval cards onto this array; each one is handed to the
     host, which is where the user actually sees and decides it. */
  const proposals = [];
  const originalPush = proposals.push.bind(proposals);
  proposals.push = (...items) => {
    for (const item of items) host.call('assistant.propose', item).catch((error) => host.log('warn', `proposal could not be raised: ${error.message}`));
    return originalPush(...items);
  };

  let settings = await host.settings();
  const settingsProxy = new Proxy({}, {
    get: (target, key) => settings[key],
    has: (target, key) => key in settings,
    ownKeys: () => Reflect.ownKeys(settings),
    getOwnPropertyDescriptor: (target, key) => ({ value: settings[key], enumerable: true, configurable: true }),
  });

  const ctx = {
    app, DATA_DIR: host.appDataDir, ROOT: host.codeDir, IS_PACKAGED: !!process.env.MODULE_IS_PACKAGED,
    httpError, wrap,
    audit: (entry) => { host.audit(entry).catch(() => {}); },
    logEvent: (level, message) => host.log(level, message),
    sseBroadcast: (event, payload) => host.emit(event, payload),
    connStore, profileById, sshConnectOptions: connectOptions, sshClientFor, sshSessions, saveConnections,
    settings: settingsProxy,
    cli: false,
    agent: {
      isConnected: () => cachedAssistantConnected,
      run: (prompt) => host.call('assistant.run', { prompt }),
      tools, proposals, kinds: proposalKinds,
      chatNote: (note) => { host.call('assistant.note', note || {}).catch(() => {}); },
    },
  };

  /* The engine asks this synchronously before offering AI help. */
  let cachedAssistantConnected = false;
  const refreshAssistant = async () => { cachedAssistantConnected = !!(await host.call('assistant.isConnected', {}).catch(() => false)); };
  await refreshAssistant();
  const assistantTimer = setInterval(refreshAssistant, 20000);
  assistantTimer.unref?.();

  /* The engine mounts its routers on this app under /deploy; the host proxies
     /api/m/deployments/http/* to it, so nothing in the host's routing table
     grows and removing the module removes the only way in. */
  const mounted = deploy.mount({ ...ctx, projects });

  app.use((error, req, res, next) => {   // eslint-disable-line no-unused-vars
    res.status(error.status || 500).json({ error: error.message || 'Internal error' });
  });

  /* Deployment targets belong to one project; the host shows that ownership in
     the project read model for as long as this module is installed. */
  const publishOwnership = () => host.call('projects.publishOwnership', {
    kind: 'targets',
    owners: mounted.stores.targets.get().targets.map((t) => ({ id: t.id, projectId: t.projectId })),
  }).catch(() => {});
  mounted.engine.onEvent(() => publishOwnership());
  await publishOwnership();

  return {
    http: app,

    methods: {
      settingsChanged: async () => { settings = await host.settings(); mounted.autoShip.refresh(); return { ok: true }; },
      connectionsChanged: async () => { await refreshConnections(); return { ok: true }; },
      /** Everything the frontend needs in one call when the page opens. */
      overview: async () => ({
        targets: mounted.stores.targets.get().targets,
        repos: mounted.stores.repos.get().repos,
        active: mounted.engine.activeIds(),
      }),
    },

    assistantTools: tools,
    proposalKinds,

    /* A running deploy, rollback or cloud provisioning cannot safely stop, so it
       blocks removal and blocks an update. */
    busy: () => mounted.engine.activeIds().length > 0,

    async deactivate() {
      clearInterval(connectionTimer);
      clearInterval(assistantTimer);
      clearInterval(projectTimer);
      try { mounted.autoShip.stop?.(); } catch {}
      for (const client of sshSessions.values()) { try { client.end?.(); } catch {} }
      await host.call('projects.publishOwnership', { kind: 'targets', owners: [] }).catch(() => {});
    },
  };
}

module.exports = { activate };
