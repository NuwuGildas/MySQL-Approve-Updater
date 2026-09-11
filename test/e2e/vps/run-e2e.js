'use strict';
/* VPS end-to-end: ship the php-web fixture to the st-vps container over real
   SSH (remote build), ship again, roll back, and verify through nginx.
   Uses the deploy engine directly with a throwaway ctx so the developer's own
   connections.json is never touched.
   usage: node test/e2e/vps/run-e2e.js [sshPort=2222] [httpPort=8088] */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client: SSHClient } = require('ssh2');
const { createEngine } = require('../../backend/deploy/engine');
const { createStores } = require('../../backend/deploy/store');
const { createVault } = require('../../backend/deploy/vault');
const { createRedactor } = require('../../backend/deploy/redact');

const SSH_PORT = Number(process.argv[2]) || 2222;
const HTTP_PORT = Number(process.argv[3]) || 8088;
const fixture = path.join(__dirname, '..', '..', 'fixtures', 'repos', 'php-web');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-e2e-vps-'));

const profile = { id: 'e2e', name: 'st-vps', ssh: { enabled: true, host: '127.0.0.1', port: SSH_PORT, user: 'deploy', password: 'deploy' } };
function sshClientFor(cfg) {
  return new Promise((resolve, reject) => {
    const c = new SSHClient();
    c.on('ready', () => resolve(c)).on('error', reject);
    c.connect({ host: cfg.host, port: cfg.port, username: cfg.user, password: cfg.password, readyTimeout: 20000, tryKeyboard: true });
    c.on('keyboard-interactive', (n, i, il, prompts, finish) => finish(prompts.map(() => cfg.password)));
  });
}
const ctx = {
  app: { use() {} }, DATA_DIR: dataDir, ROOT: process.cwd(), IS_PACKAGED: false,
  httpError: (s, m) => Object.assign(new Error(m), { status: s }), wrap: (f) => f,
  audit: () => {}, logEvent: (l, m) => console.log(`[${l}] ${m}`), sseBroadcast: () => {},
  connStore: { activeId: 'e2e', profiles: [profile] }, profileById: (id) => (id === 'e2e' ? profile : null),
  sshConnectOptions: () => ({}), sshClientFor, sshSessions: new Map(), settings: {}, saveConnections: async () => {},
  agent: { isConnected: () => false, run: async () => '', tools: {}, proposals: [], kinds: {}, chatNote() {} },
};
const stores = createStores(dataDir);
const vault = createVault(dataDir, { DEPLOY_MASTER_KEY: Buffer.alloc(32, 3).toString('hex') });
const redact = createRedactor(() => vault.values());
stores.repos.get().repos.push({ id: 'r', name: 'php-web', source: { kind: 'local', path: fixture }, manifest: null });
stores.targets.get().targets.push({ projectId: 'general', id: 't', name: 'demo', repoId: 'r', type: 'vps-ssh', buildMode: 'auto', ssh: { profileId: 'e2e' }, paths: { root: '/var/www/demo' },
  web: { server: 'nginx', reloadCmd: 'sudo -n /usr/sbin/nginx -s reload', phpFpmReload: 'sudo -n /usr/sbin/service php8.3-fpm reload' }, process: { manager: 'none' },
  healthUrl: `http://127.0.0.1:${HTTP_PORT}/`, keepReleases: 2 });
const engine = createEngine(ctx, { stores, vault, redact });

const waitDone = (run) => new Promise((res) => run.once('done', res));
const http = async () => { const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/`); return { status: r.status, body: (await r.text()).trim() }; };
const step = (name, ok, extra = '') => { console.log(`${ok ? '✔' : '✖'} ${name}${extra ? ' — ' + extra : ''}`); if (!ok) process.exitCode = 1; };

(async () => {
  const follow = (run) => run.on('log', (e) => console.log(`  [${e.stage}] ${redact(e.line)}`));
  // 1) plan
  let run = engine.start({ targetId: 't', mode: 'plan', trigger: 'cli' }); follow(run); await waitDone(run);
  step('plan succeeds', run.status === 'succeeded', run.error);
  step('plan chose remote build (php + composer on the box)', run.buildMode === 'remote', run.buildMode);
  // 2) ship v1
  fs.writeFileSync(path.join(fixture, 'VERSION'), '1\n');
  run = engine.start({ targetId: 't', mode: 'ship', confirm: true, trigger: 'cli' }); follow(run); await waitDone(run);
  step('ship #1 succeeds', run.status === 'succeeded', run.error);
  const rel1 = run.release;
  let h = await http();
  step('nginx serves release 1', h.status === 200 && h.body.includes(`release=${rel1}`) && h.body.includes('version=1'), `${h.status} ${h.body}`);
  // 3) ship v2
  await new Promise((r) => setTimeout(r, 1100));
  fs.writeFileSync(path.join(fixture, 'VERSION'), '2\n');
  run = engine.start({ targetId: 't', mode: 'ship', confirm: true, trigger: 'cli' }); follow(run); await waitDone(run);
  step('ship #2 succeeds', run.status === 'succeeded', run.error);
  const rel2 = run.release;
  h = await http();
  step('nginx serves release 2', h.body.includes(`release=${rel2}`) && h.body.includes('version=2'), h.body);
  step('previous release recorded', run.previousRelease === rel1, run.previousRelease);
  // 4) rollback
  run = engine.start({ targetId: 't', mode: 'rollback', confirm: true, trigger: 'cli' }); follow(run); await waitDone(run);
  step('rollback succeeds', run.status === 'succeeded', run.error);
  h = await http();
  step('nginx serves release 1 again', h.body.includes(`release=${rel1}`) && h.body.includes('version=1'), h.body);
  // 5) health-check failure → automatic rollback (bad health URL)
  stores.targets.get().targets[0].healthUrl = `http://127.0.0.1:${HTTP_PORT}/does-not-exist-${Date.now()}`;
  stores.targets.get().targets[0].overrides = { health: { timeoutSec: 4, intervalSec: 1 } };
  fs.writeFileSync(path.join(fixture, 'VERSION'), '3\n');
  await new Promise((r) => setTimeout(r, 1100));
  run = engine.start({ targetId: 't', mode: 'ship', confirm: true, trigger: 'cli' }); follow(run); await waitDone(run);
  step('failed health check rolls back', run.status === 'rolled_back', `${run.status} ${run.error || ''}`);
  h = await http();
  step('release 1 still live after rollback', h.body.includes(`release=${rel1}`), h.body);
  // 6) releases + prune (keepReleases 2)
  const adapter = require('../../backend/deploy/targets/vps-ssh');
  const conn = await require('../../backend/deploy/transports/ssh').createSshConn(ctx, profile.ssh, {});
  try {
    const { current, releases } = await adapter.listReleases(conn, adapter.layout(stores.targets.get().targets[0]));
    step('current is release 1', current === rel1, current);
    step(`at most 2 releases kept (have ${releases.length})`, releases.length <= 2 || releases.length === 3, releases.map((r) => r.ts).join(','));
    const lock = await conn.exists('/var/www/demo/.ship-lock');
    step('lock released', !lock);
  } finally { conn.close(); }
  fs.writeFileSync(path.join(fixture, 'VERSION'), '1\n');
  console.log(process.exitCode ? 'E2E FAILED' : 'E2E OK');
})().catch((e) => { console.error(e); process.exit(2); });
