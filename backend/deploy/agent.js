'use strict';
/* AI assistant integration: read-only deploy tools, a manifest proposal
   (approved by the user through the existing proposal UI), and a failure
   explainer. The agent can never ship, roll back or read secrets. */

const crypto = require('crypto');
const manifestLib = require('./manifest');
const { detect } = require('./detect');
const { aiDetect } = require('./detect/ai');
const { maskRepo, maskTarget, maskAutoShip } = require('./routes');
const repofiles = require('./repofiles');
const guardrails = require('./guardrails');
const preship = require('./preship');
const { verify: healthVerify } = require('./health');
const { adapterFor } = require('./targets');

function register({ ctx, engine, stores, vault, redact }) {
  const path = require('path');
  const tools = ctx.agent.tools;
  // opt-in capabilities (Settings → AI assistant): a gated tool is hidden from the prompt and refuses to run while off
  const assistOn = (k) => !!ctx.settings.aiAssist?.[k];
  const gated = (key, tool) => ({ ...tool, enabled: () => assistOn(key), run: async (inp) => { if (!assistOn(key)) throw new Error(`this capability is disabled: the user can enable "${key}" under Settings → AI assistant`); return tool.run(inp); } });
  const repoDirOf = (repo) => (repo.source.kind === 'local' ? repo.source.path : path.join(stores.workDir, repo.id, 'src'));
  const findRun = (id) => { const live = engine.get(id); return live ? live.toJSON() : engine.list({ limit: 200 }).find((r) => r.id === id); };
  const lastShipOf = (targetId) => engine.list({ targetId, limit: 200 }).find((r) => r.mode === 'ship' && r.status === 'succeeded') || null;

  tools.deploy_list_targets = {
    desc: 'Deploy module: connected repos and deploy targets (secrets masked) with the status of the last run of each target. Input: none.',
    run: async () => ({
      repos: stores.repos.get().repos.map(maskRepo).map((r) => ({ id: r.id, name: r.name, source: r.source, hasManifest: !!r.manifest, lastFetch: r.lastFetch })),
      targets: stores.targets.get().targets.map((t) => { const m = maskAutoShip(maskTarget(t, engine)); const last = engine.list({ targetId: t.id, limit: 1 })[0]; return { id: m.id, name: m.name, type: m.type, repoId: m.repoId, buildMode: m.buildMode, paths: m.paths, healthUrl: m.healthUrl, lastRun: last ? { id: last.id, status: last.status, mode: last.mode, release: last.release, endedAt: last.endedAt, error: last.error } : null }; }),
    }),
  };
  tools.deploy_get_run = {
    desc: 'Deploy module: one run (plan/ship/rollback) with its stages, error and the last N redacted log lines. Input: {"runId":"...","tail":100}',
    run: async (inp) => {
      const id = String(inp?.runId || '');
      const live = engine.get(id);
      const run = live ? live.toJSON() : engine.list({ limit: 200 }).find((r) => r.id === id);
      if (!run) throw new Error('run not found: use deploy_list_targets to find recent runs');
      const { lines } = await engine.readLog(id, 0);
      const n = Math.min(300, Number(inp?.tail) || 100);
      return { ...run, plan: run.plan ? { buildWhere: run.plan.buildWhere, steps: run.plan.steps } : undefined, log: lines.slice(-n).map((l) => `[${l.stage}] ${l.line}`) };
    },
  };
  tools.deploy_detect = {
    desc: 'Deploy module: run heuristic stack detection on a connected repo (must be fetched). Input: {"repoId":"..."}',
    run: async (inp) => {
      const repo = stores.findRepo(String(inp?.repoId || ''));
      if (!repo) throw new Error('repoId not found');
      const dir = repo.source.kind === 'local' ? repo.source.path : path.join(stores.workDir, repo.id, 'src');
      const det = await detect(dir);
      return { best: det.best, candidates: det.candidates.map((c) => ({ id: c.id, root: c.root, score: c.score, evidence: c.evidence })), ambiguous: det.ambiguous, reason: det.reason, shipJson: det.shipJson, savedManifest: repo.manifest, tree: det.tree.slice(0, 120) };
    },
  };
  tools.deploy_get_manifest = {
    desc: 'Deploy module: the resolved manifest (build steps, shared paths, hooks, runtime) a target would use. Input: {"targetId":"..."}',
    run: async (inp) => {
      const t = stores.findTarget(String(inp?.targetId || ''));
      if (!t) throw new Error('targetId not found');
      const repo = stores.findRepo(t.repoId);
      return { target: t.name, manifest: manifestLib.compact(manifestLib.resolve(repo?.manifest || {}, t.overrides)) };
    },
  };
  tools.propose_deploy_manifest = {
    desc: 'Deploy module: PROPOSE a deploy manifest (ship.json shape) for a repo. Requires the user\'s explicit approval in the UI before it is saved; nothing happens without it. Input: {"repoId":"...","manifest":{...}}',
    run: async (inp) => {
      const repo = stores.findRepo(String(inp?.repoId || ''));
      if (!repo) throw new Error('repoId not found: use deploy_list_targets');
      const clean = manifestLib.compact(manifestLib.validate(inp?.manifest || {}));
      let guard = null;
      if (assistOn('templates')) { // proposals must start safe: the guardrail check gates them
        guard = guardrails.check(clean);
        if (!guard.ok) return { status: 'rejected_by_guardrails', violations: guard.violations, note: 'Fix these and propose again (deploy_manifest_template gives a compliant starting point). Nothing was submitted to the user.' };
      }
      const prop = { id: crypto.randomUUID(), kind: 'deploy-manifest', action: 'update', repoId: repo.id, targetName: repo.name, manifest: clean, status: 'pending', ts: new Date().toISOString(), guardrails: guard ? 'passed' : null };
      ctx.agent.proposals.push(prop);
      while (ctx.agent.proposals.length > 30) ctx.agent.proposals.shift();
      ctx.logEvent('info', `AI agent proposed a deploy manifest for "${repo.name}" (awaiting user approval)`);
      return { proposalId: prop.id, status: 'pending_user_approval', note: 'Submitted. The user must approve it in the chat UI; do not assume it is saved.' };
    },
  };

  tools.deploy_read_file = gated('repoFiles', {
    desc: `Deploy module: read-only view of a connected repo's key files (${repofiles.WHITELIST.join(', ')}; also under apps/*, packages/*, backend/, frontend/). Secret-looking values are masked. Input: {"repoId":"..."} lists the files present; {"repoId":"...","path":"composer.json"} returns one file (max 32 KB).`,
    run: async (inp) => {
      const repo = stores.findRepo(String(inp?.repoId || ''));
      if (!repo) throw new Error('repoId not found: use deploy_list_targets');
      const dir = repoDirOf(repo);
      if (!require('fs').existsSync(dir)) throw new Error('the repo has not been fetched yet (run Fetch or Plan first)');
      if (!inp?.path) return { repo: repo.name, files: await repofiles.list(dir), hint: 'pass "path" to read one of these files' };
      return { repo: repo.name, ...(await repofiles.read(dir, inp.path)) };
    },
  });
  tools.deploy_plan_diff = gated('planDiff', {
    desc: 'Deploy module: what a plan would change versus the last successful ship of the same target: commits since, manifest keys that changed, commands added/removed, build location, and whether the server still serves that baseline release. Input: {"runId":"<plan run>"} or {"targetId":"..."} (latest plan).',
    run: async (inp) => {
      let run = inp?.runId ? findRun(String(inp.runId)) : null;
      if (!run && inp?.targetId) { const t = stores.findTarget(String(inp.targetId)); if (!t) throw new Error('targetId not found'); run = engine.list({ targetId: t.id, limit: 200 }).map((r) => engine.get(r.id)?.toJSON() || r).find((r) => r.plan?.diff || r.planSummary) || null; }
      if (!run) throw new Error('no plan found: run Plan on the target first, or pass a runId');
      const live = engine.get(run.id)?.toJSON();
      const diff = live?.plan?.diff || run.plan?.diff || null;
      if (!diff) return { runId: run.id, note: 'this run has no change summary (planned before the feature was enabled, or the plan is no longer in memory): run Plan again', planSummary: run.planSummary || null };
      return { runId: run.id, target: run.targetName, release: run.release, commit: run.commit, ...diff };
    },
  });
  tools.deploy_health = gated('healthProbe', {
    desc: 'Deploy module: verify a target after a ship instead of inferring it: probes the health URL now (one GET), and returns the stored server probe (current release on disk, releases, lock) with the release the last successful ship activated. Input: {"targetId":"..."}',
    run: async (inp) => {
      const t = stores.findTarget(String(inp?.targetId || ''));
      if (!t) throw new Error('targetId not found');
      const last = lastShipOf(t.id);
      let live = null;
      if (t.healthUrl) {
        const t0 = Date.now();
        try { const r = await healthVerify(t.healthUrl, { expectStatus: t.healthExpect || [200, 399], timeoutSec: 1, intervalSec: 1 }); live = { ok: true, status: r.status, ms: Date.now() - t0 }; }
        catch (e) { live = { ok: false, error: redact(e.message), ms: Date.now() - t0 }; }
      }
      const probe = t.lastProbe || null;
      return {
        target: t.name, healthUrl: t.healthUrl || null, live, probe,
        lastShip: last ? { runId: last.id, release: last.release, commit: last.commit, endedAt: last.endedAt } : null,
        servesLastShip: probe?.current && last?.release ? probe.current === last.release : null,
        note: probe ? `probe taken ${probe.at}: re-run Test on the target for a fresh one` : 'no server probe stored yet: run Test or Plan on the target',
      };
    },
  });
  tools.deploy_search_log = gated('logSearch', {
    desc: 'Deploy module: grep a run\'s full redacted log. Input: {"runId":"...","pattern":"<regex or text>","stage":"build|ship|...(optional)","context":1,"max":40}. Returns matching lines with line numbers and context.',
    run: async (inp) => {
      const id = String(inp?.runId || '');
      if (!findRun(id)) throw new Error('run not found: use deploy_list_targets');
      const pat = String(inp?.pattern || '').trim(); if (!pat) throw new Error('pattern is required');
      let re; try { re = new RegExp(pat, 'i'); } catch { re = new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
      const { lines } = await engine.readLog(id, 0);
      const pool = inp?.stage ? lines.filter((l) => l.stage === inp.stage) : lines;
      const ctxN = Math.min(5, Math.max(0, Number(inp?.context ?? 1))), max = Math.min(200, Math.max(1, Number(inp?.max) || 40));
      const hits = [];
      for (let i = 0; i < pool.length && hits.length < max; i++) {
        if (!re.test(pool[i].line)) continue;
        hits.push({ n: pool[i].n, stage: pool[i].stage, stream: pool[i].stream, line: pool[i].line, before: pool.slice(Math.max(0, i - ctxN), i).map((l) => l.line), after: pool.slice(i + 1, i + 1 + ctxN).map((l) => l.line) });
      }
      const total = pool.filter((l) => re.test(l.line)).length;
      return { runId: id, pattern: pat, totalLines: lines.length, matches: total, shown: hits.length, hits };
    },
  });
  tools.deploy_manifest_template = gated('templates', {
    desc: `Deploy module: a starter manifest for a framework with the guardrails already applied (backup before migrate, shared .env/storage, start command and port for services, health path, keepReleases). Frameworks: ${require('./frameworks').CATALOG.map((c) => c.id).join(', ')}. Input: {"framework":"laravel","name":"optional app name"} or {"check":{...manifest}} to run only the guardrail check.`,
    run: async (inp) => {
      if (inp?.check) return { guardrails: guardrails.check(inp.check) };
      const id = String(inp?.framework || '');
      if (!id) throw new Error('framework is required');
      return guardrails.templateFor(id, { name: inp?.name || '' });
    },
  });

  /* Deploy actions: the assistant may PROPOSE plan / ship / rollback / unlock / cancel; nothing runs until the
     user approves the card in the chat. Approval executes through the same engine path as the UI buttons. */
  const ACTION_LABEL = { plan: 'run a Plan (read-only dry run)', ship: 'Ship', rollback: 'roll back', unlock: 'force-unlock the target', cancel: 'cancel the running deploy' };
  function proposeAction({ targetId, action, release, reason, source }) {
    const t = stores.findTarget(String(targetId || ''));
    if (!t) throw new Error('targetId not found: use deploy_list_targets');
    if (!preship.ACTIONS.includes(action)) throw new Error(`action must be one of ${preship.ACTIONS.join(', ')}`);
    if (release && !/^\d{14}$/.test(String(release))) throw new Error('release must be a 14-digit release name (see deploy_list_targets / releases)');
    const latestPlan = action === 'ship' ? engine.list({ targetId: t.id, limit: 50 }).map((r) => engine.get(r.id)?.toJSON() || r).find((r) => r.mode === 'plan' && r.status === 'succeeded' && (r.plan?.hash || r.planSummary?.hash)) : null;
    const prop = { id: crypto.randomUUID(), kind: 'deploy-action', action, projectId: t.projectId, targetId: t.id, targetName: t.name, release: release || null, reason: String(reason || '').slice(0, 400), planHash: latestPlan ? (latestPlan.plan?.hash || latestPlan.planSummary?.hash) : null, source: source || 'agent', status: 'pending', ts: new Date().toISOString() };
    ctx.agent.proposals.push(prop);
    while (ctx.agent.proposals.length > 30) ctx.agent.proposals.shift();
    ctx.logEvent('info', `AI agent proposed to ${ACTION_LABEL[action]} on "${t.name}" (awaiting user approval)`);
    return prop;
  }
  tools.propose_deploy_action = {
    desc: 'Deploy module: PROPOSE a deploy action on a target: "plan" (read-only dry run), "ship", "rollback" (optionally to a release), "unlock" (force-remove a stale deploy lock) or "cancel" (stop the running deploy). The user must approve the card in the chat before anything runs; never assume it ran. Input: {"targetId":"...","action":"plan|ship|rollback|unlock|cancel","release":"<14-digit, rollback only>","reason":"<why, one sentence>"}',
    run: async (inp) => {
      const prop = proposeAction({ targetId: inp?.targetId, action: String(inp?.action || ''), release: inp?.release, reason: inp?.reason, source: 'agent' });
      return { proposalId: prop.id, status: 'pending_user_approval', note: `Submitted: the user must approve "${ACTION_LABEL[prop.action]}" on ${prop.targetName} in the chat UI.` };
    },
  };
  ctx.agent.kinds['deploy-action'] = {
    label: (p) => `proposal to ${ACTION_LABEL[p.action] || p.action} on "${p.targetName}"`,
    approve: async (p) => {
      const t = stores.findTarget(p.targetId);
      if (!t) throw ctx.httpError(409, 'the target no longer exists');
      if (p.projectId && p.projectId !== t.projectId) throw ctx.httpError(409, 'The deployment has moved to another project. Request a new proposal');
      const common = { targetId: t.id, trigger: 'agent-approved', ai: true };
      let result = {};
      try {
        if (p.action === 'plan') result = { runId: engine.start({ ...common, mode: 'plan' }).id };
        else if (p.action === 'ship') result = { runId: engine.start({ ...common, mode: 'ship', confirm: true, planHash: p.planHash || undefined }).id };
        else if (p.action === 'rollback') result = { runId: engine.start({ ...common, mode: 'rollback', confirm: true, release: p.release || undefined }).id };
        else if (p.action === 'cancel') { const active = engine.list({ targetId: t.id, limit: 20 }).find((r) => ['queued', 'running'].includes(r.status)); if (!active) throw Object.assign(new Error('no run is active on this target'), { status: 409 }); engine.cancel(active.id); result = { runId: active.id, cancelled: true }; }
        else if (p.action === 'unlock') {
          if (engine.isLocked(t.id)) throw Object.assign(new Error('a deploy is running on this target right now'), { status: 409 });
          const adapter = adapterFor(t); const norm = adapter.validate(t, ctx);
          if (adapter.unlock) { const conn = await adapter.connect(ctx, norm, vault, {}); try { if (conn.canExec) await adapter.unlock(conn, adapter.layout(norm)); } finally { conn.close(); } }
          result = { unlocked: true };
        } else throw Object.assign(new Error(`unknown action ${p.action}`), { status: 400 });
      } catch (e) { throw ctx.httpError(e.status || 400, redact(e.message)); }
      p.result = result;
      ctx.audit({ action: 'deploy-agent-action', target: t.name, targetId: t.id, deployAction: p.action, release: p.release || null, runId: result.runId || null, by: 'agent-proposal' });
      ctx.logEvent('info', `AI agent action approved: ${p.action} on "${t.name}"${result.runId ? ` (run ${result.runId})` : ''}`);
    },
  };

  /* "Send to AI chat": the run's summary and redacted log tail become a context note in the conversation */
  async function runToChat(runId, { lines = 150 } = {}) {
    const run = findRun(runId);
    if (!run) throw ctx.httpError(404, 'run not found');
    const log = (await engine.readLog(runId, 0)).lines.slice(-Math.min(400, Math.max(20, lines)));
    const failing = (run.stages || []).find((s) => s.status === 'failed');
    const head = `${run.mode} run ${run.id} on "${run.targetName}" (${run.repoName || 'no repo'}): ${run.status}${run.error ? `, error: ${run.error}` : ''}${failing ? `, failed stage: ${failing.name}` : ''}${run.release ? `, release ${run.release}` : ''}`;
    ctx.agent.chatNote({ projectId: run.projectId, kind: 'run-log', runId: run.id, targetId: run.targetId, target: run.targetName, mode: run.mode, status: run.status, error: run.error || null, stage: failing?.name || run.stage || null, lines: log.map((l) => `[${l.stage}/${l.stream}] ${l.line}`),
      text: `The user shared a deploy log. ${head}. Last ${log.length} log lines (secrets redacted):\n${log.map((l) => `[${l.stage}/${l.stream}] ${l.line}`).join('\n')}\nIf something failed, explain the cause and, when a deploy action would fix it, propose it with propose_deploy_action (the user approves it in the chat).` });
    ctx.audit({ action: 'deploy-log-to-chat', runId: run.id, target: run.targetName, lines: log.length });
    return { runId: run.id, projectId: run.projectId, lines: log.length };
  }

  // proposal kind: approving writes repo.manifest
  ctx.agent.kinds['deploy-manifest'] = {
    label: (p) => `deploy manifest for "${p.targetName}"`,
    approve: async (p) => {
      const repo = stores.findRepo(p.repoId);
      if (!repo) throw ctx.httpError(409, 'the repo no longer exists');
      repo.manifest = p.manifest;
      await stores.repos.save();
      ctx.audit({ action: 'deploy-manifest-save', repo: repo.name, stack: p.manifest?.stack?.type || null, by: 'agent-proposal' });
    },
  };

  async function explainRun(runId) {
    const live = engine.get(runId);
    const run = live ? live.toJSON() : engine.list({ limit: 200 }).find((r) => r.id === runId);
    if (!run) throw ctx.httpError(404, 'run not found');
    const { lines } = await engine.readLog(runId, 0);
    const failing = run.stages.find((s) => s.status !== 'ok') || run.stages[run.stages.length - 1];
    const step = run.plan?.steps?.filter((s) => s.stage === failing?.name).map((s) => `${s.where} ${s.cwd || ''} $ ${s.cmd}`).join('\n') || '(no plan)';
    const tgt = stores.findTarget(run.targetId);
    const host = tgt?.transport?.host || ctx.profileById(tgt?.ssh?.profileId || tgt?.transport?.profileId || '')?.ssh?.host || '';
    const env = preship.classifyEnv(tgt || { name: run.targetName }, host);
    const prompt = `A deployment run in the "Deploy" module of Server Tools ended with status "${run.status}"${run.error ? ` and error: ${run.error}` : ''}.
Target host: ${host || 'unknown'}; environment: ${env.toUpperCase()}${env === 'local' ? ' (a loopback/private LOCAL TEST target: an unreachable host usually means the local test server is not running; do not suggest replacing it with a real hosting provider)' : ''}.
Target: ${run.targetName} (${run.buildMode || 'unknown'} build). Failing stage: ${failing?.name || 'unknown'}.
Planned steps of that stage:
${step}
Last log lines (secrets already redacted):
${lines.slice(-200).map((l) => `[${l.stage}/${l.stream}] ${l.line}`).join('\n')}

Reply with ONLY one JSON object, no prose, no markdown fence:
{"explanation":"<plain text, max 20 lines: (1) most likely root cause, (2) the exact fix the user should apply (server command, manifest change or target setting), (3) whether the site is currently up>",
 "action":{"action":"plan|ship|rollback|unlock|cancel|none","release":"<14-digit release, rollback only, else empty>","reason":"<one sentence>"}}
Propose an action only when it would actually help now: "plan" after a config/manifest fix to re-verify, "ship" to retry a transient failure, "rollback" when the live release is broken and a previous one exists, "unlock" when a stale deploy lock blocks the target, "cancel" when a run is stuck. Otherwise use "none". The user approves every action before it runs.`;
    const parsed = preship.parseExplain(redact(await ctx.agent.run(prompt)));
    let proposal = null;
    if (parsed.action && parsed.action.action !== 'none' && !['queued', 'running'].includes(run.status)) {
      try { proposal = proposeAction({ targetId: run.targetId, action: parsed.action.action, release: parsed.action.release, reason: parsed.action.reason, source: 'explain' }); } catch (e) { ctx.logEvent('warn', `AI action proposal skipped: ${e.message}`); }
    }
    ctx.agent.chatNote({ projectId: run.projectId, kind: 'deploy-explain', runId, text: `Deploy run ${runId} (${run.status}) · AI analysis:\n${parsed.explanation}${proposal ? `\n\nProposed next step (awaiting your approval): ${ACTION_LABEL[proposal.action]} on "${proposal.targetName}"${proposal.reason ? `: ${proposal.reason}` : ''}` : ''}` });
    return { text: parsed.explanation, proposal: proposal ? { id: proposal.id, action: proposal.action, targetName: proposal.targetName, reason: proposal.reason } : null };
  }

  /* Pre-ship review (Settings → AI assistant): manifest + guardrails + latest plan/diff + last run + probe → verdict. Advisory. */
  async function preShipReview(targetId) {
    if (!assistOn('preShipReview')) throw ctx.httpError(400, 'the pre-ship review is disabled: enable it under Settings → AI assistant');
    if (!ctx.agent.isConnected()) throw ctx.httpError(400, 'no AI agent connected: open the AI agent and connect a provider first');
    const t = stores.findTarget(targetId); if (!t) throw ctx.httpError(404, 'target not found');
    const repo = stores.findRepo(t.repoId);
    const manifest = manifestLib.compact(manifestLib.resolve(repo?.manifest || {}, t.overrides));
    const runs = engine.list({ targetId: t.id, limit: 200 }).map((r) => engine.get(r.id)?.toJSON() || r);
    const planRun = runs.find((r) => r.plan && r.status === 'succeeded') || null;
    const lastRun = runs.find((r) => !['queued', 'running'].includes(r.status)) || null;
    const logTail = lastRun ? (await engine.readLog(lastRun.id, 0)).lines.slice(-60).map((l) => `[${l.stage}/${l.stream}] ${l.line}`) : [];
    const lastShip = lastShipOf(t.id);
    const host = t.transport?.host || ctx.profileById(t.ssh?.profileId || t.transport?.profileId || '')?.ssh?.host || (t.type === 'paas' ? t.paas?.provider : '') || '';
    const env = preship.classifyEnv(t, host);
    const guard = guardrails.check(manifest);
    const prompt = preship.buildPrompt({ target: t, repo, manifest, guardrails: guard, plan: planRun?.plan || null, lastRun, logTail, probe: t.lastProbe || null, expectedRelease: lastShip?.release || null, healthUrl: t.healthUrl || null, env, host });
    const review = preship.applyEnvPolicy(preship.parseReview(redact(await ctx.agent.run(prompt))), env, guard.ok);
    const rec = { ...review, env, host, at: new Date().toISOString(), planHash: planRun?.plan?.hash || null, commit: repo?.lastFetch?.commit || planRun?.commit || null, runId: lastRun?.id || null };
    t.preShip = rec; await stores.targets.save();
    ctx.audit({ action: 'deploy-preship-review', target: t.name, targetId: t.id, verdict: rec.verdict, findings: rec.findings.length });
    ctx.agent.chatNote({ projectId: t.projectId, kind: 'deploy-preship', targetId: t.id, text: `Pre-ship review of "${t.name}": ${rec.verdict.toUpperCase()}: ${rec.summary}${rec.findings.length ? '\n' + rec.findings.map((f) => `- [${f.level}] ${f.text}`).join('\n') : ''}` });
    return rec;
  }

  return { explainRun, aiDetect: (det) => aiDetect(ctx, det), preShipReview, runToChat, proposeAction };
}

module.exports = { register };
