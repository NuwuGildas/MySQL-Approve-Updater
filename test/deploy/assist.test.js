'use strict';
/* AI assistance capabilities (Settings → AI assistant): whitelisted repo
   files, plan diffs, guardrail templates, pre-ship review parsing, tool
   gating, and the before_ship hook running ahead of migrations. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { fakeCtx, fakeConn, registerFakeVps, deps, waitDone } = require('./helpers');
const { createEngine } = require('../../lib/deploy/engine');
const repofiles = require('../../lib/deploy/repofiles');
const plandiff = require('../../lib/deploy/plandiff');
const guardrails = require('../../lib/deploy/guardrails');
const preship = require('../../lib/deploy/preship');
const agent = require('../../lib/deploy/agent');

const fx = (n) => path.join(__dirname, '..', 'fixtures', 'repos', n);

function setup(connOpts = {}, targetExtra = {}, ctxOver = {}) {
  const ctx = fakeCtx(ctxOver);
  const d = deps(ctx);
  const conn = fakeConn(connOpts);
  const type = registerFakeVps(conn);
  d.stores.repos.get().repos.push({ id: 'r1', name: 'shop', source: { kind: 'local', path: fx('laravel') }, manifest: null });
  d.stores.targets.get().targets.push({ id: 't1', name: 'prod', repoId: 'r1', type, buildMode: 'auto', ssh: { profileId: 'p1' }, paths: { root: '/var/www/shop' }, web: { server: 'nginx', reloadCmd: 'sudo -n systemctl reload nginx' }, keepReleases: 3, ...targetExtra });
  const engine = createEngine(ctx, d);
  return { ctx, d, conn, engine };
}

test('repofiles: masks secret-looking values, keeps placeholders, refuses non-whitelisted paths', async () => {
  const masked = repofiles.maskSecrets('APP_NAME=shop\nDB_PASSWORD=s3cr3t\nAPI_KEY=\nSTRIPE_SECRET="<your key>"\n"token": "abc123",\nport: 3000');
  assert.equal(masked, 'APP_NAME=shop\nDB_PASSWORD=***\nAPI_KEY=\nSTRIPE_SECRET="<your key>"\n"token": ***\nport: 3000');
  assert.throws(() => repofiles.safeRel('../server.js'), /relative/);
  assert.throws(() => repofiles.safeRel('.env'), /only these files/);
  assert.throws(() => repofiles.safeRel('config/database.php'), /only these files/);
  assert.equal(repofiles.safeRel('./apps/web/package.json'), 'apps/web/package.json');
  const files = await repofiles.list(fx('laravel'));
  assert.ok(files.some((f) => f.path === 'composer.json'), JSON.stringify(files));
  const r = await repofiles.read(fx('laravel'), 'composer.json');
  assert.match(r.content, /laravel\/framework/);
  assert.equal(r.truncated, false);
  await assert.rejects(repofiles.read(fx('laravel'), 'Dockerfile'), /does not exist/);
});

test('plandiff: first deploy, then commits / manifest / steps / baseline mismatch', () => {
  const plan = { hash: 'h2', buildWhere: 'remote', release: '20260902000000', commit: 'bbbbbbbb1', steps: [{ stage: 'build', where: 'remote', cmd: 'composer install' }, { stage: 'ship', where: 'remote', cmd: 'echo BACKUP 20260902000000' }], manifest: { version: 1, stack: { type: 'php' }, keepReleases: 5 } };
  const first = plandiff.buildDiff({ previous: null, plan, commitLog: null, probeCurrent: '20260801000000' });
  assert.equal(first.firstDeploy, true);
  assert.equal(first.steps.added.length, 2);
  assert.ok(first.summary.some((l) => /already serves release 20260801000000/.test(l)));
  const prevPlan = { hash: 'h1', buildWhere: 'local', release: '20260901000000', commit: 'aaaaaaaa1', steps: [{ stage: 'build', where: 'remote', cmd: 'composer install' }, { stage: 'ship', where: 'remote', cmd: 'echo OLD 20260901000000' }], manifest: { version: 1, stack: { type: 'php' }, keepReleases: 3 } };
  const d = plandiff.buildDiff({ previous: { runId: 'run1', release: '20260901000000', commit: 'aaaaaaaa1', endedAt: 'x', summary: plandiff.summarizePlan(prevPlan) }, plan, commitLog: ['bbbbbbb fix', 'ccccccc feat'], probeCurrent: '20260815000000' });
  assert.equal(d.baseline.release, '20260901000000');
  assert.equal(d.commits.count, 2);
  assert.deepEqual(d.manifest, [{ path: 'keepReleases', from: 3, to: 5 }]);
  assert.equal(d.steps.added.length, 1); assert.equal(d.steps.removed.length, 1); assert.equal(d.steps.unchanged, 1);
  assert.equal(d.buildWhereChanged, true);
  assert.equal(d.releaseIsBaseline, false);
  assert.ok(d.summary.some((l) => /2 commit\(s\) since/.test(l)));
  assert.ok(d.summary.some((l) => /currently serves 20260815000000/.test(l)));
});

test('guardrails: templates pass, bare manifests report what is missing', () => {
  const t = guardrails.templateFor('laravel', { name: 'shop' });
  assert.equal(t.ok, true, JSON.stringify(t.violations));
  assert.ok(t.manifest.hooks.before_ship.some((h) => /backup-db/.test(h.cmd)));
  assert.deepEqual(t.manifest.shared.files, ['.env']);
  const bare = guardrails.check({ stack: { type: 'php', framework: 'laravel' }, runtime: { kind: 'php-fpm', docroot: 'public' } });
  const ids = bare.violations.map((v) => v.rule);
  assert.ok(ids.includes('backup-before-migrate') && ids.includes('laravel-shared-env') && ids.includes('laravel-shared-storage'), ids.join(','));
  const noMigrate = guardrails.check({ stack: { type: 'php', framework: 'laravel' }, migrate: false, shared: { files: ['.env'], dirs: ['storage/app'] } });
  assert.ok(!noMigrate.violations.some((v) => v.rule === 'backup-before-migrate'));
  const node = guardrails.check({ stack: { type: 'node', framework: 'express' }, runtime: { kind: 'node' } });
  assert.ok(node.violations.some((v) => v.rule === 'service-start') && node.violations.some((v) => v.rule === 'service-port'));
  const express = guardrails.templateFor('express');
  assert.equal(express.ok, true, JSON.stringify(express.violations));
  assert.equal(guardrails.check({ stack: { type: 'static' }, runtime: { kind: 'static' }, keepReleases: 2 }).ok, true);
});

test('preship.parseReview: structured, fenced and free-text replies', () => {
  const ok = preship.parseReview('{"verdict":"ready","summary":"Looks fine.","findings":[{"level":"ok","text":"backup hook present"},{"level":"bogus","text":"x"}]}');
  assert.equal(ok.verdict, 'ready'); assert.equal(ok.findings.length, 2); assert.equal(ok.findings[1].level, 'warn');
  const fenced = preship.parseReview('```json\n{"verdict":"block","summary":"No backup.","findings":[]}\n```');
  assert.equal(fenced.verdict, 'block');
  const prose = preship.parseReview('I think it is risky because the health URL is missing.');
  assert.equal(prose.verdict, 'caution'); assert.equal(prose.unstructured, true);
  const p = preship.buildPrompt({ target: { name: 'prod', type: 'vps-ssh' }, repo: null, manifest: { version: 1 }, guardrails: { ok: false, violations: [{ rule: 'x', message: 'm', fix: 'f' }] }, plan: null, lastRun: null, logTail: [], probe: null, expectedRelease: null, healthUrl: null });
  assert.match(p, /NONE configured/); assert.match(p, /x: m \(fix: f\)/);
  // loopback / private hosts are local tests whatever the name says; production-only blocks are downgraded
  assert.equal(preship.classifyEnv({ name: 'plain-html-prod' }, 'localhost'), 'local');
  assert.equal(preship.classifyEnv({ name: 'shop-prod' }, '192.168.1.20'), 'local');
  assert.equal(preship.classifyEnv({ name: 'shop-prod' }, 'shop.example.com'), 'production');
  assert.equal(preship.classifyEnv({ name: 'shop-staging' }, 'shop.example.com'), 'staging');
  const local = preship.applyEnvPolicy({ verdict: 'block', summary: 's', findings: [{ level: 'block', text: 'no health URL' }] }, 'local', true);
  assert.equal(local.verdict, 'caution'); assert.equal(local.findings[0].level, 'warn'); assert.equal(local.findings.length, 2);
  const stillBlocked = preship.applyEnvPolicy({ verdict: 'block', summary: 's', findings: [{ level: 'block', text: 'no backup' }] }, 'local', false);
  assert.equal(stillBlocked.verdict, 'block');
  assert.match(preship.buildPrompt({ target: { name: 'x', type: 'shared-hosting' }, repo: null, manifest: {}, guardrails: { ok: true, violations: [] }, plan: null, lastRun: null, logTail: [], probe: null, expectedRelease: null, healthUrl: null, env: 'local', host: 'localhost' }), /LOCAL TEST target/);
});

test('agent tools are gated by Settings → AI assistant and read whitelisted files only', async () => {
  const { ctx, d, engine } = setup({}, {}, { settings: { aiAssist: { repoFiles: false, templates: true } } });
  agent.register({ ctx, engine, stores: d.stores, vault: d.vault, redact: d.redact });
  const tools = ctx.agent.tools;
  assert.equal(tools.deploy_read_file.enabled(), false);
  await assert.rejects(tools.deploy_read_file.run({ repoId: 'r1' }), /disabled/);
  ctx.settings.aiAssist.repoFiles = true;
  assert.equal(tools.deploy_read_file.enabled(), true);
  const listed = await tools.deploy_read_file.run({ repoId: 'r1' });
  assert.ok(listed.files.some((f) => f.path === 'composer.json'));
  await assert.rejects(tools.deploy_read_file.run({ repoId: 'r1', path: '../../server.js' }), /relative/);
  const tpl = await tools.deploy_manifest_template.run({ framework: 'laravel' });
  assert.equal(tpl.ok, true);
  // proposals must pass the guardrails while templates are on
  const rejected = await tools.propose_deploy_manifest.run({ repoId: 'r1', manifest: { stack: { type: 'php', framework: 'laravel' }, runtime: { kind: 'php-fpm', docroot: 'public' } } });
  assert.equal(rejected.status, 'rejected_by_guardrails');
  assert.equal(ctx.agent.proposals.length, 0);
  const accepted = await tools.propose_deploy_manifest.run({ repoId: 'r1', manifest: tpl.manifest });
  assert.equal(accepted.status, 'pending_user_approval');
  assert.equal(ctx.agent.proposals[0].guardrails, 'passed');
});

test('deploy actions are proposals: approving runs them through the engine, rejects never run', async () => {
  const { ctx, d, engine } = setup();
  const api = agent.register({ ctx, engine, stores: d.stores, vault: d.vault, redact: d.redact });
  const tools = ctx.agent.tools;
  await assert.rejects(tools.propose_deploy_action.run({ targetId: 't1', action: 'delete' }), /action must be one of/);
  await assert.rejects(tools.propose_deploy_action.run({ targetId: 't1', action: 'rollback', release: 'latest' }), /14-digit/);
  const r = await tools.propose_deploy_action.run({ targetId: 't1', action: 'plan', reason: 'verify the fix' });
  assert.equal(r.status, 'pending_user_approval');
  const prop = ctx.agent.proposals.find((p) => p.id === r.proposalId);
  assert.equal(prop.kind, 'deploy-action'); assert.equal(engine.list({ targetId: 't1' }).length, 0, 'nothing runs before approval');
  await ctx.agent.kinds['deploy-action'].approve(prop);
  assert.ok(prop.result.runId);
  const run = engine.get(prop.result.runId); assert.equal(run.trigger, 'agent-approved'); assert.equal(run.mode, 'plan');
  await waitDone(run);
  assert.equal(run.status, 'succeeded', run.error);
  // explain parsing → optional action
  assert.deepEqual(preship.parseExplain('{"explanation":"Lock is stale.","action":{"action":"unlock","release":"","reason":"stale lock"}}'), { explanation: 'Lock is stale.', action: { action: 'unlock', release: null, reason: 'stale lock' } });
  assert.deepEqual(preship.parseExplain('{"explanation":"Fine.","action":{"action":"none"}}').action, null);
  assert.equal(preship.parseExplain('just prose').explanation, 'just prose');
  // share a run's log with the chat
  const notes = []; ctx.agent.chatNote = (n) => notes.push(n);
  const shared = await api.runToChat(run.id);
  assert.equal(shared.runId, run.id); assert.equal(notes[0].kind, 'run-log'); assert.ok(notes[0].lines.length > 0); assert.match(notes[0].text, /shared a deploy log/);
});

test('plan records a change summary; the next plan diffs against the last ship; before_ship runs before migrations', async () => {
  const { conn, d, engine } = setup({ current: '20260901000000', releases: ['20260901000000'] });
  d.stores.repos.get().repos[0].manifest = { hooks: { before_ship: [{ run: 'remote', cmd: 'echo BACKUP-FIRST' }] } };
  const plan1 = engine.start({ targetId: 't1', mode: 'plan' });
  await waitDone(plan1);
  assert.equal(plan1.status, 'succeeded', plan1.error);
  assert.equal(plan1.plan.diff.firstDeploy, true);
  assert.equal(plan1.plan.diff.currentRelease, '20260901000000');
  const shipIdx = plan1.plan.steps.findIndex((s) => s.cmd === 'echo BACKUP-FIRST');
  const migIdx = plan1.plan.steps.findIndex((s) => /artisan migrate/.test(s.cmd));
  assert.ok(shipIdx >= 0 && migIdx > shipIdx, 'before_ship hook must be planned ahead of the migration');
  const ship = engine.start({ targetId: 't1', mode: 'ship', confirm: true });
  await waitDone(ship);
  assert.equal(ship.status, 'succeeded', ship.error);
  const cmds = conn.cmds.map((c) => c.cmd);
  const iBackup = cmds.findIndex((c) => c.includes('echo BACKUP-FIRST')), iMig = cmds.findIndex((c) => c.includes('artisan migrate'));
  assert.ok(iBackup >= 0 && iMig > iBackup, `backup must run before migrate: ${iBackup} / ${iMig}`);
  // stored probe follows the activation
  assert.equal(d.stores.targets.get().targets[0].lastProbe.current, ship.release);
  // the index keeps a compact plan summary for future diffs
  const idx = d.stores.runs.get().runs.find((r) => r.id === ship.id);
  assert.ok(idx.planSummary && idx.planSummary.steps.length > 0 && !idx.plan);
  const plan2 = engine.start({ targetId: 't1', mode: 'plan' });
  await waitDone(plan2);
  assert.equal(plan2.status, 'succeeded', plan2.error);
  assert.equal(plan2.plan.diff.baseline.release, ship.release);
  assert.equal(plan2.plan.diff.firstDeploy, false);
  assert.ok(plan2.plan.diff.summary.some((l) => /same commit|same \d+ command/.test(l)), plan2.plan.diff.summary.join(' | '));
});
