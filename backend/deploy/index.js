'use strict';
/* Deploy → Build → Ship module entry point.
   server.js calls mount(ctx) once; this wires stores, vault, engine, routes,
   SSE fan-out and the AI tools. The CLI (cli.js) reuses the same engine. */

const { validateCtx } = require('./ctx');
const { createStores } = require('./store');
const { createVault } = require('./vault');
const { createRedactor } = require('./redact');
const { createEngine } = require('./engine');
const { createRouter } = require('./routes');
const agent = require('./agent');
const { createAutoShip } = require('./webhooks');
const { createCloud } = require('./cloud');
const { sanitizeTarget, sanitizeRepo } = require('./routes');
const { createConfig } = require('./config');
const cli = require('./cli');

function mount(rawCtx) {
  const ctx = validateCtx(rawCtx);
  const stores = createStores(ctx.DATA_DIR, { log: ctx.logEvent, projects: ctx.projects });
  const vault = createVault(ctx.DATA_DIR);
  const redact = createRedactor(() => {
    const vals = vault.values();
    for (const p of ctx.connStore.profiles || []) { if (p.ssh?.password) vals.push(p.ssh.password); if (p.ssh?.passphrase) vals.push(p.ssh.passphrase); if (p.db?.password) vals.push(p.db.password); }
    return vals;
  });
  const engine = createEngine(ctx, { stores, vault, redact });
  const agentApi = agent.register({ ctx, engine, stores, vault, redact });
  engine.aiDetect = agentApi.aiDetect;
  // SSE fan-out: one `deploy` event carrying typed payloads
  engine.onEvent((type, payload) => ctx.sseBroadcast('deploy', { type, ...payload }));
  // opt-in (Settings → AI assistant): a failed run is analysed automatically and a fix may be proposed in the chat
  const explained = new Set();
  engine.onEvent((type, run) => {
    if (type !== 'run' || !['failed', 'rolled_back', 'rollback_failed'].includes(run?.status) || explained.has(run.id)) return;
    if ((ctx.modules && !ctx.modules.has('deployments')) || !ctx.settings.aiAssist?.autoExplain || !ctx.agent.isConnected()) return;
    explained.add(run.id);
    agentApi.explainRun(run.id).catch((e) => ctx.logEvent('warn', `AI auto-explain failed for ${run.id}: ${e.message}`));
  });
  const autoShip = createAutoShip({ ctx, engine, stores, vault });
  const cloud = createCloud({ ctx, stores, vault, engine, createTarget: async (body) => { const t = sanitizeTarget(body, ctx, stores, null); stores.targets.get().targets.push(t); await stores.targets.save(); ctx.audit({ action: 'deploy-target-add', target: t.name, type: t.type, by: 'cloud-provision' }); return t; } });
  const config = createConfig({ ctx, stores, vault, sanitizeRepo, sanitizeTarget });
  // Mounted on this module's own surface; the host proxies /api/m/deployments/http/* to it.
  ctx.app.use('/deploy', createRouter({ ctx, engine, stores, vault, redact, agentApi, autoShip, cloud, config }));
  // Git provider accounts are their own module now: it shares this vault, not this code.
  // webhook listener + pollers come up only when some target asks for them (and never in CLI mode)
  if (!ctx.cli) setTimeout(() => { try { autoShip.refresh(); } catch (e) { ctx.logEvent('warn', `auto-ship init failed: ${e.message}`); } }, 500);
  return { engine, stores, vault, redact, agentApi, autoShip, cloud, config };
}

module.exports = { mount, cli, createEngine };
