'use strict';
/* Test doubles: a fake ctx, a fake SSH conn that records commands, and a
   fake target type that plugs into the registry. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { TARGETS } = require('../../backend/deploy/targets');
const vps = require('../../backend/deploy/targets/vps-ssh');
const { createStores } = require('../../backend/deploy/store');
const { createProjectView } = require('../../backend/deploy/project-view');
const { createVault } = require('../../backend/deploy/vault');
const { createRedactor } = require('../../backend/deploy/redact');

function fakeCtx(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-deploy-'));
  const audits = [], logs = [], sse = [];
  const profiles = [{ id: 'p1', name: 'box', ssh: { enabled: true, host: 'box.local', port: 22, user: 'deploy', privateKeyPath: '' } }];
  const ctx = {
    app: { use() {}, get() {}, post() {}, put() {}, delete() {} }, DATA_DIR: dataDir, ROOT: process.cwd(), IS_PACKAGED: false,
    httpError: (status, message) => Object.assign(new Error(message), { status }), wrap: (fn) => fn,
    audit: (e) => audits.push(e), logEvent: (l, m) => logs.push([l, m]), sseBroadcast: (ev, d) => sse.push([ev, d]),
    connStore: { activeId: 'p1', profiles }, profileById: (id) => profiles.find((p) => p.id === id),
    sshConnectOptions: () => ({}), sshClientFor: async () => { throw new Error('no real ssh in tests'); }, sshSessions: new Map(), settings: {}, saveConnections: async () => {},
    agent: { isConnected: () => false, run: async () => '', tools: {}, proposals: [], kinds: {}, chatNote() {} },
    _audits: audits, _logs: logs, _sse: sse, ...overrides,
  };
  return ctx;
}

/** Fake conn with a shell. `fsState` simulates releases/current. */
function fakeConn({ tools = 'php composer node npm git tar curl', current = null, releases = [], symlinkOk = true, sudo = true } = {}) {
  const cmds = [];
  const state = { current, releases: [...releases], uploaded: [], written: {}, locked: false };
  const conn = {
    kind: 'ssh', canExec: true, host: 'box.local', user: 'deploy', cmds, state,
    async exec(cmd, o = {}) {
      const list = Array.isArray(cmd) ? cmd : [cmd];
      const full = list.join('; ');
      cmds.push({ cmd: full, cwd: o.cwd || null });
      let out = '';
      if (full.includes('echo "USER=')) {
        out = ['USER=deploy', 'HOME=/home/deploy', 'HOST=box', 'OS=Ubuntu 24.04 LTS', 'ARCH=x86_64', `SUDO=${sudo ? 'yes' : 'no'}`, 'SHELL_OK=yes',
          ...tools.split(' ').filter(Boolean).map((t) => `TOOL_${t}=${t} version 9.9.9`),
          'ROOT_EXISTS=yes', 'ROOT_WRITABLE=yes', 'DISK=10G free of 40G', `CURRENT=${state.current ? 'releases/' + state.current : ''}`, `RELEASES=${state.releases.join(' ')}`, 'LOCK=', `SYMLINK_OK=${symlinkOk ? 'yes' : 'no'}`].join('\n');
      } else if (full.includes('.ship-lock') && full.includes('mkdir')) { out = state.locked ? 'BUSY\nrun-x host 2000-01-01T00:00:00Z' : (state.locked = true, 'LOCKED'); }
      else if (full.includes('rm -rf') && full.includes('.ship-lock')) state.locked = false;
      else if (full.includes('for d in releases/*/')) { out = [`CURRENT=${state.current ? 'releases/' + state.current : ''}`, ...state.releases.map((r) => `R=${r}|{"commit":"c-${r}"}`)].join('\n'); }
      else if (/ln -sfn releases\/(\d{14}) current\.tmp/.test(full)) { state.current = /ln -sfn releases\/(\d{14})/.exec(full)[1]; }
      else if (/tar -xzf .*releases\/(\d{14})/.test(full)) { const ts = /releases\/(\d{14})/.exec(full)[1]; if (!state.releases.includes(ts)) state.releases.push(ts); }
      else if (/^rm -rf .*releases\/(\d{14})/.test(full)) { const ts = /releases\/(\d{14})/.exec(full)[1]; state.releases = state.releases.filter((r) => r !== ts); }
      if (o.onLine && out) for (const l of out.split('\n')) o.onLine(l, 'out');
      return { code: 0, ms: 1, out };
    },
    async capture(cmd, o) { return (await this.exec(cmd, o)).out.trim(); },
    async uploadFile(local, remote) { state.uploaded.push({ local, remote }); },
    async uploadDir(local, remote) { state.uploaded.push({ local, remote, dir: true }); return { files: 1, bytes: 1 }; },
    async mkdirp() {}, async readFile(p) { return state.written[p] ?? null; }, async writeFile(p, d) { state.written[p] = String(d); },
    async rename() {}, async list() { return []; }, async exists(p) { return p in state.written; }, async removeTree() {}, async symlink() {}, async readlink() { return null; },
    close() { state.closed = true; },
  };
  return conn;
}

/** Register a fake VPS target type backed by `conn`. */
function registerFakeVps(conn, id = 'fake-vps') {
  TARGETS[id] = { ...vps, id, connect: async () => conn };
  return id;
}

/* Projects belong to the host. In tests they are an in-memory list standing in
   for what the host would have served, with the small write surface the
   ownership-migration suite needs to set a scenario up. */
function fakeProjects(initial = [{ id: 'general', name: 'General', resources: {} }], { readOnly = null } = {}) {
  const list = [...initial].map((project) => ({ resources: {}, ...project }));
  const view = createProjectView({ load: async () => list });
  view.list = () => list;
  view.get = (id) => list.find((project) => project.id === id) || null;
  Object.defineProperty(view, 'readOnly', { get: () => readOnly });
  view.create = async ({ name }) => {
    const project = { id: String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, resources: {} };
    list.push(project);
    await view.refresh();   // the host would have served the new list
    return project;
  };
  view.remove = async (id) => { const index = list.findIndex((p) => p.id === id); const [gone] = list.splice(index, 1); await view.refresh(); return gone; };
  view.link = async (id, kind, resourceId) => {
    const project = view.get(id);
    project.resources[kind] = [...new Set([...(project.resources[kind] || []), resourceId])];
    return project;
  };
  view.update = async (id, patch) => { const project = view.get(id); Object.assign(project, patch); return project; };
  view.unlink = async (id, kind, resourceId) => {
    const project = view.get(id);
    project.resources[kind] = (project.resources[kind] || []).filter((value) => value !== resourceId);
    return project;
  };
  return view;
}

function deps(ctx, { projects = fakeProjects() } = {}) {
  const stores = createStores(ctx.DATA_DIR, { projects });
  const vault = createVault(ctx.DATA_DIR, { DEPLOY_MASTER_KEY: Buffer.alloc(32, 1).toString('hex') });
  const redact = createRedactor(() => vault.values());
  return { stores, vault, redact };
}

const waitDone = (run) => new Promise((res) => (['queued', 'running'].includes(run.status) ? run.once('done', res) : res()));

module.exports = { fakeCtx, fakeConn, registerFakeVps, deps, waitDone, fakeProjects };
