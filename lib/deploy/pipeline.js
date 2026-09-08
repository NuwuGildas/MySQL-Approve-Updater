'use strict';
/* The deploy pipeline: connect → fetch → detect → plan → [stop in plan mode]
   → build → package → ship → activate → verify → (rollback) → cleanup.
   Everything the run does is logged through run.log(); every remote path
   comes from the target adapter's layout helpers. */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { adapterFor } = require('./targets');
const { stackFor } = require('./stacks');
const { detect } = require('./detect');
const manifestLib = require('./manifest');
const git = require('./git');
const artifact = require('./artifact');
const health = require('./health');
const templates = require('./templates');
const { hooksFor, unsupportedRemoteHooks } = require('./hooks');
const { localExec, capture } = require('./exec');
const plandiff = require('./plandiff');
const { newReleaseName } = require('./targets/layout');
const { refName } = require('./vault');
const { q } = require('./shell');

class StageError extends Error {
  constructor(stage, msg, code) { super(msg); this.name = 'StageError'; this.stage = stage; this.exitCode = code; }
}
const EXIT = { connect: 4, fetch: 4, detect: 10, plan: 10, build: 5, package: 5, ship: 6, activate: 7, verify: 7, rollback: 8 };

const isCancel = (e) => /cancel/i.test(e?.message || '') || e?.name === 'AbortError';

async function runPipeline({ ctx, run, target: rawTarget, repo, stores, vault, redact, aiDetect, previousShip = null }) {
  const adapter = adapterFor(rawTarget);
  const target = adapter.validate(rawTarget, ctx);
  const out = (l, s) => run.log(l, s === 'err' ? 'err' : 'out');
  const sys = (l) => run.log(l, 'sys');
  const warn = (m) => run.warn(m);
  const checkCancel = () => { if (run.signal.aborted) throw new Error('cancelled'); };
  let conn = null;
  let L = null, probe = null, manifest = null, stack = null, appDir = null, repoDir = null, ts = null, buildWhere = null, strategy = null;
  let releaseCreated = false, activated = false, inPlaceResult = null;
  const stageTimer = { t: 0 };
  const stage = (name) => { stageTimer.t = Date.now(); run.setStage(name); checkCancel(); };
  const fail = (name, e) => { const err = e instanceof StageError ? e : new StageError(name, e.message || String(e), EXIT[name] || 1); err.cause = e; return err; };

  run.setStatus('running');
  const startedStage = () => run.stage;
  try {
    /* ---------------- connect ---------------- */
    stage('connect');
    try {
      sys(`target "${target.name}" (${adapter.label}): ${target.ssh?.profileId ? `ssh profile ${target.ssh.profileId}` : target.transport ? `${target.transport.kind}${target.transport.host ? ' ' + target.transport.host : ''}` : target.type}`);
      conn = await adapter.connect(ctx, target, vault, { signal: run.signal });
      sys(`connected as ${conn.user || '?'}@${conn.host}${conn.canExec ? '' : ' (no shell: file transfer only)'}`);
      probe = await adapter.probe(conn, target);
      if (conn.canExec) {
        const tools = Object.entries(probe.versions || {}).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ');
        sys(`remote: ${probe.os || 'unknown OS'} ${probe.arch || ''}, user ${probe.user}${probe.sudo ? ' (passwordless sudo)' : ''}`);
        sys(`tools: ${tools || 'none detected'}`);
        if (probe.current) sys(`current release: ${probe.current}; ${probe.releases.length} release(s) on disk`);
        if (probe.user === 'root') warn('deploying as root: consider a dedicated deploy user');
        if (probe.rootWritable === false) throw new Error(`${target.paths.root || target.paths.home} is not writable by ${probe.user}`);
        if (probe.lock) sys(`lock file present: ${probe.lock}`);
        // remember what the server looked like (read-only facts) for the UI and the assistant's health tool
        rawTarget.lastProbe = { current: probe.current || null, releases: probe.releases || [], user: probe.user || conn.user || null, os: probe.os || null, sudo: !!probe.sudo, lock: probe.lock || null, at: probe.pulledAt || new Date().toISOString() };
        Promise.resolve(stores.targets.save()).catch(() => {});
      }
      strategy = adapter.strategyFor ? adapter.strategyFor(target, conn, probe) : null;
      if (strategy) sys(`docroot strategy: ${strategy}`);
    } catch (e) { throw fail('connect', e); }

    /* ---------------- rollback mode ---------------- */
    if (run.mode === 'rollback') { await doRollbackMode(); return; }

    /* ---------------- fetch ---------------- */
    stage('fetch');
    try {
      const src = repo.source;
      if (src.kind === 'local') {
        repoDir = src.path;
        if (!fs.existsSync(repoDir)) throw new Error(`local folder not found: ${repoDir}`);
        const info = await git.inspectLocal(repoDir);
        Object.assign(run, { commit: info.commit, shortCommit: info.shortCommit, branch: info.branch });
        sys(`local folder ${repoDir}${info.commit ? ` @ ${info.shortCommit} (${info.branch})` : ' (not a git repo)'}`);
        if (info.dirty) warn('working tree has uncommitted changes: they WILL be deployed');
      } else {
        repoDir = path.join(stores.workDir, repo.id, 'src');
        const token = src.auth?.kind === 'https-token' && src.auth.tokenRef ? vault.get(refName(src.auth.tokenRef)) : null;
        sys(`git ${src.url} (${run.ref || src.branch || 'default branch'})`);
        const info = await git.sync(src, repoDir, { ref: run.ref || src.branch, token, onLine: out, signal: run.signal });
        Object.assign(run, { commit: info.commit, shortCommit: info.shortCommit, branch: info.branch });
        sys(`checked out ${info.shortCommit} ${info.subject ? ': ' + info.subject : ''}`);
        repo.lastFetch = { commit: info.commit, branch: info.branch, at: new Date().toISOString(), subject: info.subject };
        stores.repos.save();
      }
    } catch (e) { throw fail('fetch', e); }

    /* ---------------- detect ---------------- */
    stage('detect');
    try {
      const det = await detect(repoDir);
      const savedHasStack = !!repo.manifest?.stack?.type;
      const shipHasStack = !!det.shipJson?.stack?.type;
      if (det.shipJsonError) warn(det.shipJsonError);
      if (det.best) sys(`detected ${det.best.label} (${det.best.id}, confidence ${det.best.score}) from ${det.best.evidence.join(', ')}${det.best.root !== '.' ? ` in ${det.best.root}/` : ''}`);
      let fragment = det.best?.fragment || null;
      if (det.ambiguous && !savedHasStack && !shipHasStack) {
        sys(`heuristics are not confident: ${det.reason}`);
        if (run.ai && aiDetect && ctx.agent.isConnected()) {
          sys('asking the AI assistant to identify the stack…');
          const ai = await aiDetect(det, run);
          if (ai) { fragment = ai.fragment; sys(`AI suggestion (confidence ${ai.confidence}): ${ai.reasoning || ''}`); warn('stack chosen by the AI fallback: review and save the manifest to make it permanent'); }
        }
        if (!fragment || (det.ambiguous && fragment === det.best?.fragment && !det.best)) throw new Error(`could not detect the stack (${det.reason}); save a manifest for this repo or add a ship.json`);
        if (det.candidates.length > 1 && fragment === det.best?.fragment) throw new Error(`ambiguous project layout (${det.reason}); set "root" and the stack in the repo manifest`);
      }
      manifest = manifestLib.resolve(fragment, det.shipJson, repo.manifest, target.overrides);
      if (!manifest.stack.type) throw new Error('manifest has no stack.type');
      if (!manifest.name) manifest.name = String(repo.name || 'app').toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'app';
      stack = stackFor(manifest);
      if (!stack) throw new Error(`no stack module for ${manifest.stack.type}`);
      appDir = path.join(repoDir, manifest.root || '.');
      if (!fs.existsSync(appDir)) throw new Error(`manifest root "${manifest.root}" does not exist in the checkout`);
      sys(`manifest: ${manifest.stack.type}/${manifest.stack.framework} via ${manifest.stack.packageManager || 'no package manager'}, runtime ${manifest.runtime.kind}, docroot ${manifest.runtime.docroot}`);
    } catch (e) { throw fail('detect', e); }

    /* ---------------- platform (PaaS) targets take a short path ---------------- */
    if (adapter.capabilities.paas) { await doPaasFlow(); return; }

    /* ---------------- plan ---------------- */
    stage('plan');
    let plan;
    try {
      ts = newReleaseName();
      L = adapter.layout(target);
      // where to build
      const wanted = run.buildMode || target.buildMode || 'auto';
      const required = stack.requiredTools ? stack.requiredTools(manifest) : [];
      const missing = required.filter((t) => !probe.tools?.[t]);
      if (stack.remoteOnly) {
        if (!conn.canExec || target.type === 'shared-hosting') throw new Error(`${stack.label} stacks need a server with a shell (VPS target): they are built where they run`);
        if (missing.length) throw new Error(`the server lacks ${missing.join(', ')} needed to build and run this ${stack.label} app`);
        if (wanted === 'local') warn(`${stack.label} apps are always built on the server`);
        buildWhere = 'remote';
      } else if (!conn.canExec || target.type === 'shared-hosting') { buildWhere = 'local'; if (wanted === 'remote') warn('shared hosting always builds locally'); }
      else if (wanted === 'remote') { if (missing.length) throw new Error(`remote build requested but the server lacks: ${missing.join(', ')}`); buildWhere = 'remote'; }
      else if (wanted === 'local') buildWhere = 'local';
      else if (manifest.stack.type === 'static') buildWhere = 'local';
      else if (missing.length) { buildWhere = 'local'; warn(`server lacks ${missing.join(', ')}: building locally and shipping the artifact`); }
      else buildWhere = 'remote';
      if (buildWhere === 'local' && manifest.build.steps.length) {
        const localMissing = [];
        for (const t of required) if (!(await require('./exec').probeTool(t, t === 'php' ? '-v' : t === 'node' || t === 'npm' || t === 'pnpm' || t === 'yarn' || t === 'bun' ? '-v' : '--version'))) localMissing.push(t);
        if (localMissing.length) throw new Error(`local build needs ${localMissing.join(', ')} on this machine`);
        if (manifest.stack.type === 'node' && manifest.runtime.kind === 'node') warn('node_modules built on this machine are shipped as-is; native modules may not match the server');
        if (manifest.stack.type === 'php' && process.platform === 'win32') warn('composer vendor built on Windows: packages with platform-specific binaries may not run on Linux');
      }
      run.buildMode = buildWhere;
      const vars = { release: L.release(ts), current: L.current, shared: L.shared, root: L.root, commit: run.commit || '', shortCommit: run.shortCommit || '', ts, branch: run.branch || '', name: manifest.name };
      manifest = manifestLib.interpolate(manifest, vars, (name) => vault.get(name));
      const remoteSteps = stack.remoteSteps ? stack.remoteSteps(manifest) : { afterShip: [], beforeActivate: [], afterActivate: [], permissions: [] };
      const steps = [];
      const add = (st, where, cwd, cmd, label) => steps.push({ stage: st, where, cwd, cmd, label });
      const relDir = L.release(ts);
      const buildCwd = buildWhere === 'local' ? appDir : relDir;
      if (buildWhere === 'remote') add('build', 'remote', L.releases, `upload source archive → ${L.releaseSrcTgz(ts)} and extract into ${relDir}`, 'upload source');
      for (const h of hooksFor(manifest, 'before_build', buildWhere, buildWhere)) add('build', buildWhere, buildCwd, h, 'hook before_build');
      for (const s of manifest.build.steps) add('build', buildWhere, buildCwd, s, 'build');
      for (const h of hooksFor(manifest, 'after_build', buildWhere, buildWhere)) add('build', buildWhere, buildCwd, h, 'hook after_build');
      if (buildWhere === 'local') {
        add('package', 'local', appDir, `stage ${manifest.build.outputDir ? manifest.build.outputDir + '/' : './'} (include ${manifest.artifact.include.join(' ')}; exclude ${manifest.artifact.exclude.length} pattern(s))${conn.canExec ? ' → tar.gz' : ''}`, 'package');
        if (conn.canExec) add('ship', 'remote', L.releases, `upload artifact → ${L.releaseTgz(ts)}; extract into ${relDir}`, 'upload');
        else add('ship', 'remote', target.paths.docroot, `upload files → ${target.paths.docroot}-new-${ts}; rename swap into ${target.paths.docroot}`, 'upload (in-place)');
      }
      if (conn.canExec) {
        if (target.envFile?.fromVault) add('ship', 'remote', L.root, `write ${target.envFile.target} from vault ${target.envFile.fromVault} (${target.envFile.mode})`, 'env file');
        for (const d of manifest.shared.dirs) add('ship', 'remote', relDir, `link ${d} → ${L.shared}/${d}`, 'shared dir');
        for (const f of manifest.shared.files) add('ship', 'remote', relDir, `link ${f} → ${L.shared}/${f}`, 'shared file');
        for (const c of remoteSteps.permissions || []) add('ship', 'remote', relDir, c, 'permissions');
        if (target.process?.manager === 'pm2') add('ship', 'remote', relDir, 'write ecosystem.config.cjs (if absent)', 'pm2 config');
        for (const h of hooksFor(manifest, 'before_ship', 'remote', buildWhere)) add('ship', 'remote', relDir, h, 'hook before_ship');
        for (const c of remoteSteps.afterShip) add('ship', 'remote', relDir, c, `${stack.label} after ship`);
        for (const h of hooksFor(manifest, 'after_ship', 'remote', buildWhere)) add('ship', 'remote', relDir, h, 'hook after_ship');
        for (const c of remoteSteps.beforeActivate) add('activate', 'remote', relDir, c, `${stack.label} before activate`);
        for (const h of hooksFor(manifest, 'before_activate', 'remote', buildWhere)) add('activate', 'remote', relDir, h, 'hook before_activate');
        add('activate', 'remote', L.root, `ln -sfn releases/${ts} current (atomic swap)`, 'activate');
        if (strategy === 'symlink') add('activate', 'remote', L.root, `ln -sfn ${L.current}${manifest.runtime.docroot !== '.' ? '/' + manifest.runtime.docroot : ''} ${target.paths.docroot}`, 'bind docroot');
        if (strategy === 'htaccess') add('activate', 'remote', target.paths.docroot, `.htaccess rewrite → current/ (link current → ${L.current}${manifest.runtime.docroot !== '.' ? '/' + manifest.runtime.docroot : ''})`, 'bind docroot');
        for (const { cmd, label } of adapter.reloadCommands(target, manifest, L)) add('activate', 'remote', L.current, cmd, label);
        if (adapter.routeCommands) for (const { cmd, label } of adapter.routeCommands(target, manifest, L)) add('route', 'remote', L.root, label === 'write nginx vhost' ? `write /etc/nginx vhost for ${target.domain.name} → ${adapter.webRoot(L, manifest)}` : cmd, label);
        for (const c of remoteSteps.afterActivate) add('activate', 'remote', L.current, c, `${stack.label} after activate`);
        for (const h of hooksFor(manifest, 'after_activate', 'remote', buildWhere)) add('activate', 'remote', L.current, h, 'hook after_activate');
      } else {
        for (const u of unsupportedRemoteHooks(manifest, buildWhere)) warn(`hook ${u.hook} "${u.cmd}" needs a shell on the server and will be skipped`);
        for (const c of [...remoteSteps.afterShip, ...remoteSteps.beforeActivate, ...remoteSteps.afterActivate]) warn(`${stack.label} step "${c}" needs a shell on the server and will be skipped`);
      }
      for (const hk of ['before_ship', 'after_ship', 'before_activate', 'after_activate']) for (const h of hooksFor(manifest, hk, 'local', buildWhere)) add(hk === 'after_ship' || hk === 'before_ship' ? 'ship' : 'activate', 'local', appDir, h, `hook ${hk} (local)`);
      if (target.healthUrl) add('verify', target.healthRemote ? 'remote' : 'local', null, `GET ${target.healthUrl} → expect ${manifest.health.expectStatus.join('-')} within ${manifest.health.timeoutSec}s`, 'health check');
      else warn('no healthUrl on the target: the deploy will not be verified');
      if (conn.canExec) add('cleanup', 'remote', L.releases, `keep ${target.keepReleases} release(s)`, 'prune');
      else add('cleanup', 'remote', target.paths.docroot, `keep ${target.keepReleases} previous copy(ies)`, 'prune');
      const hash = crypto.createHash('sha256').update(JSON.stringify(steps).split(ts).join('<release>')).digest('hex').slice(0, 16);
      // what changes versus the last successful ship (commits, manifest keys, commands, build location)
      let diff = null;
      try {
        let commitLog = null;
        const prevCommit = previousShip?.commit;
        if (prevCommit && run.commit && prevCommit !== run.commit && repoDir && fs.existsSync(path.join(repoDir, '.git'))) {
          const outLog = await capture(`git log --oneline --no-decorate --max-count=60 ${q(prevCommit)}..${q(run.commit)}`, { cwd: repoDir, timeoutMs: 30000 }).catch(() => null);
          commitLog = outLog == null ? null : outLog.split('\n').filter(Boolean);
        }
        diff = plandiff.buildDiff({
          previous: previousShip ? { runId: previousShip.id, release: previousShip.release, commit: previousShip.commit, endedAt: previousShip.endedAt, summary: previousShip.planSummary || null } : null,
          plan: { buildWhere, release: ts, steps, manifest: manifestLib.compact(manifest), commit: run.commit }, commitLog, probeCurrent: probe?.current || null,
        });
      } catch (e) { warn(`could not compute the change summary: ${e.message}`); }
      plan = { hash, buildWhere, release: ts, strategy, steps, warnings: run.warnings.map((w) => w.msg), manifest: manifestLib.compact(manifest), commit: run.commit, target: { id: target.id, name: target.name, type: target.type }, diff };
      run.release = ts; run.plan = plan; run.emit('plan', plan);
      sys(`plan: ${steps.length} step(s), build ${buildWhere}, release ${ts}, hash ${hash}`);
      for (const l of diff?.summary || []) sys(`change: ${l}`);
      for (const s of steps) sys(`  [${s.stage}] ${s.where}${s.cwd ? ' ' + s.cwd : ''} $ ${s.cmd}`);
      if (run.mode === 'plan') { run.setStatus('succeeded'); return; }
      if (run.planHash && run.planHash !== hash) throw new Error(`plan changed since you reviewed it (${run.planHash} → ${hash}); re-run Plan and ship again`);
    } catch (e) { throw fail('plan', e); }

    /* ---------------- build ---------------- */
    stage('build');
    const buildEnv = { ...manifest.build.env, CI: manifest.build.env.CI || 'true', RELEASE: L.release(ts), CURRENT: L.current, SHARED: L.shared, ROOT: L.root, COMMIT: run.commit || '', TS: ts, NAME: manifest.name, PORT: String(manifest.runtime.port || '') };
    try {
      if (conn.canExec && adapter.lock) {
        await adapter.prepare(conn, L);
        await adapter.lock(conn, L, { runId: run.id, host: require('os').hostname() }, { force: run.force });
        sys('lock acquired');
      }
      const localCmds = async (cmds, cwd) => { for (const c of cmds) { checkCancel(); sys(`$ ${c}`); await localExec(c, { cwd, env: buildEnv, onLine: out, signal: run.signal, timeoutMs: 45 * 60000 }); } };
      const remoteCmds = async (cmds, cwd, extraEnv = {}) => { for (const c of cmds) { checkCancel(); sys(`$ ${c}`); await conn.exec(c, { cwd, env: { ...buildEnv, ...extraEnv }, onLine: out, signal: run.signal, timeoutMs: 45 * 60000 }); } };
      run.remoteCmds = remoteCmds; run.localCmds = localCmds;
      if (buildWhere === 'remote') {
        const buildDir = path.join(stores.workDir, repo.id, '.build', run.id);
        await fsp.mkdir(buildDir, { recursive: true });
        const srcTgz = path.join(buildDir, 'source.tgz');
        if (repo.source.kind === 'git' || fs.existsSync(path.join(repoDir, '.git'))) { sys('git archive HEAD → source.tgz'); await git.archive(repoDir, srcTgz, { onLine: out, signal: run.signal }); }
        else { sys('packing working tree → source.tgz'); await artifact.packDir(repoDir, srcTgz); }
        const size = (await fsp.stat(srcTgz)).size;
        sys(`uploading source (${artifact.fmtBytes(size)}) → ${L.releaseSrcTgz(ts)}`);
        await conn.exec(`mkdir -p ${q(L.release(ts))}`);
        releaseCreated = true;
        await conn.uploadFile(srcTgz, L.releaseSrcTgz(ts), (done, total) => sys(`  ${artifact.fmtBytes(done)} / ${artifact.fmtBytes(total)}`));
        const rootSub = manifest.root && manifest.root !== '.' ? ` --strip-components=${manifest.root.split('/').filter(Boolean).length} ${q(manifest.root)}` : '';
        await conn.exec(`tar -xzf ${q(L.releaseSrcTgz(ts))} -C ${q(L.release(ts))}${rootSub} && rm -f ${q(L.releaseSrcTgz(ts))}`, { onLine: out });
        const cacheEnv = { COMPOSER_CACHE_DIR: `${L.cache}/composer`, npm_config_cache: `${L.cache}/npm`, PNPM_HOME: `${L.cache}/pnpm`, YARN_CACHE_FOLDER: `${L.cache}/yarn`, PIP_CACHE_DIR: `${L.cache}/pip`, UV_CACHE_DIR: `${L.cache}/uv`, POETRY_CACHE_DIR: `${L.cache}/poetry`, COMPOSER_ALLOW_SUPERUSER: '1', COMPOSER_NO_INTERACTION: '1' };
        await conn.exec(`mkdir -p ${q(L.cache + '/composer')} ${q(L.cache + '/npm')} ${q(L.cache + '/pip')} ${q(L.cache + '/uv')}`);
        await remoteCmds(hooksFor(manifest, 'before_build', 'remote', buildWhere), L.release(ts), cacheEnv);
        await remoteCmds(manifest.build.steps, L.release(ts), cacheEnv);
        await remoteCmds(hooksFor(manifest, 'after_build', 'remote', buildWhere), L.release(ts), cacheEnv);
        await localCmds([...hooksFor(manifest, 'before_build', 'local', buildWhere), ...hooksFor(manifest, 'after_build', 'local', buildWhere)], appDir);
      } else {
        await localCmds(hooksFor(manifest, 'before_build', 'local', buildWhere), appDir);
        await localCmds(manifest.build.steps, appDir);
        await localCmds(hooksFor(manifest, 'after_build', 'local', buildWhere), appDir);
      }
    } catch (e) { throw fail('build', e); }

    /* ---------------- package ---------------- */
    let stageDir = null, tgz = null;
    if (buildWhere === 'local') {
      stage('package');
      try {
        const buildDir = path.join(stores.workDir, repo.id, '.build', run.id);
        stageDir = path.join(buildDir, 'stage');
        const srcForArtifact = manifest.build.outputDir ? path.join(appDir, manifest.build.outputDir) : appDir;
        if (!fs.existsSync(srcForArtifact)) throw new Error(`build output "${manifest.build.outputDir}" was not produced`);
        const st = await artifact.stage(srcForArtifact, stageDir, manifest, { repoDir: appDir, commit: run.commit, shortCommit: run.shortCommit, branch: run.branch, ts, runId: run.id }, { onLine: (l) => (l.startsWith('WARN ') ? warn(l.slice(5)) : sys(l)) });
        sys(`staged ${st.files} file(s), ${artifact.fmtBytes(st.bytes)}`);
        if (conn.canExec) { tgz = path.join(buildDir, `release-${ts}.tgz`); const p = await artifact.pack(stageDir, tgz); sys(`artifact ${path.basename(tgz)} (${artifact.fmtBytes(p.size)})`); }
      } catch (e) { throw fail('package', e); }
    }

    /* ---------------- ship ---------------- */
    stage('ship');
    const remoteSteps = stack.remoteSteps ? stack.remoteSteps(manifest) : { afterShip: [], beforeActivate: [], afterActivate: [], permissions: [] };
    try {
      run.previousRelease = probe.current || null;
      if (conn.canExec) {
        if (buildWhere === 'local') { sys(`uploading artifact → ${L.releaseTgz(ts)}`); releaseCreated = true; await adapter.extractTgz(conn, L, ts, tgz, { onLine: out, onProgress: (d, t) => sys(`  ${artifact.fmtBytes(d)} / ${artifact.fmtBytes(t)}`) }); }
        // env file from the vault
        if (target.envFile?.fromVault) {
          const dst = `${L.root}/${target.envFile.target}`;
          const exists = await conn.exists(dst);
          if (target.envFile.mode === 'always' || (target.envFile.mode === 'upload' && !exists)) { await conn.mkdirp(path.posix.dirname(dst)); await conn.writeFile(dst, vault.get(target.envFile.fromVault), 0o600); sys(`wrote ${target.envFile.target} from the vault`); }
          else if (!exists) warn(`${target.envFile.target} does not exist on the server (mode keep)`);
        }
        await adapter.linkShared(conn, L, ts, manifest, { onLine: out, warn });
        if (manifest.shared.dirs.length || manifest.shared.files.length) sys(`linked ${manifest.shared.dirs.length} shared dir(s), ${manifest.shared.files.length} shared file(s)`);
        await run.remoteCmds(remoteSteps.permissions || [], L.release(ts));
        if (target.process?.manager === 'pm2' && !(await conn.exists(`${L.release(ts)}/ecosystem.config.cjs`))) {
          await conn.writeFile(`${L.release(ts)}/ecosystem.config.cjs`, templates.pm2Ecosystem({ name: target.process.name, start: manifest.runtime.start, port: manifest.runtime.port }).replace('cwd: __dirname', `cwd: ${JSON.stringify(L.current)}`));
          sys('wrote ecosystem.config.cjs');
        }
        await run.localCmds(hooksFor(manifest, 'before_ship', 'local', buildWhere), appDir);
        await run.remoteCmds(hooksFor(manifest, 'before_ship', 'remote', buildWhere), L.release(ts)); // e.g. a database backup before the migrations below
        await run.remoteCmds(remoteSteps.afterShip, L.release(ts));
        await run.remoteCmds(hooksFor(manifest, 'after_ship', 'remote', buildWhere), L.release(ts));
      } else {
        // in-place (no shell)
        const swap = await adapter.canSwap(conn, target);
        const prevManifest = (() => null)();
        inPlaceResult = await adapter.shipInPlace(conn, target, ts, stageDir, { onLine: sys, warn, swap, previousManifest: prevManifest, onProgress: (d, t, b, f) => { if (d % 25 === 0 || d === t) sys(`  ${d}/${t} files (${artifact.fmtBytes(b)}) ${f}`); } });
        run.previousRelease = inPlaceResult.previous;
        activated = true; // the swap is the activation
      }
      await run.localCmds(hooksFor(manifest, 'after_ship', 'local', buildWhere), appDir);
    } catch (e) {
      if (releaseCreated && conn.canExec && !isCancel(e)) { sys('discarding the partial release'); await adapter.discardRelease(conn, L, ts); }
      throw fail('ship', e);
    }

    /* ---------------- activate ---------------- */
    stage('activate');
    try {
      if (conn.canExec) {
        await run.remoteCmds(remoteSteps.beforeActivate, L.release(ts));
        await run.remoteCmds(hooksFor(manifest, 'before_activate', 'remote', buildWhere), L.release(ts));
        await run.localCmds(hooksFor(manifest, 'before_activate', 'local', buildWhere), appDir);
        await adapter.activate(conn, L, ts, target, manifest, { onLine: out, warn, probe, strategy });
        activated = true;
        sys(`current → releases/${ts}`);
        await run.remoteCmds(remoteSteps.afterActivate, L.current);
        await run.remoteCmds(hooksFor(manifest, 'after_activate', 'remote', buildWhere), L.current);
      }
      await run.localCmds(hooksFor(manifest, 'after_activate', 'local', buildWhere), appDir);
    } catch (e) { await rollbackAfterFailure('activate', e); return; }

    /* ---------------- route + secure (domain, TLS): surfaces problems, never fails the deploy ---------------- */
    if (conn.canExec && adapter.routeCommands && target.domain?.name) {
      stage('route');
      run.actionRequired = run.actionRequired || [];
      if (probe.sudo === false) { const m = `domain ${target.domain.name}: passwordless sudo is missing: run the vhost/certbot steps from the plan as root`; warn(m); run.actionRequired.push(m); }
      else {
        for (const c of adapter.routeCommands(target, manifest, L)) {
          try { sys(`${c.label}…`); await conn.exec(c.cmd, { onLine: out, timeoutMs: 180000 }); sys(`${c.label}: ok`); }
          catch (e) { const m = `${c.label} failed for ${target.domain.name}: ${String(e.message).split('\n')[0]}${c.optional ? ' (DNS not pointing here yet? re-run Ship once it resolves)' : ''}`; warn(m); run.actionRequired.push(m); if (!c.optional) break; }
        }
      }
      if (!run.actionRequired.length) sys(`${target.domain.ssl ? 'https' : 'http'}://${target.domain.name} → releases/${ts}`);
    }

    /* ---------------- verify ---------------- */
    if (target.healthUrl) {
      stage('verify');
      try {
        await health.verify(target.healthUrl, { ...manifest.health, signal: run.signal, onLine: sys, remote: target.healthRemote && conn.canExec ? { conn } : null });
      } catch (e) { await rollbackAfterFailure('verify', e); return; }
    }

    /* ---------------- cleanup ---------------- */
    stage('cleanup');
    try {
      if (conn.canExec) { const removed = await adapter.prune(conn, L, target.keepReleases, [run.previousRelease], { onLine: sys }); if (!removed.length) sys('nothing to prune'); }
      else if (adapter.pruneInPlace) await adapter.pruneInPlace(conn, target, target.keepReleases, { onLine: sys });
      await run.localCmds(hooksFor(manifest, 'on_success', 'local', buildWhere), appDir);
      await pruneLocalBuilds();
    } catch (e) { warn(`cleanup problem: ${e.message}`); }
    if (rawTarget.lastProbe) { rawTarget.lastProbe.current = ts; rawTarget.lastProbe.releases = [...new Set([...(rawTarget.lastProbe.releases || []), ts])]; rawTarget.lastProbe.at = new Date().toISOString(); Promise.resolve(stores.targets.save()).catch(() => {}); }
    run.setStatus('succeeded');
    sys(`deployed ${run.shortCommit ? run.shortCommit + ' ' : ''}as release ${ts} in ${Math.round((Date.now() - Date.parse(run.startedAt)) / 1000)}s`);
    ctx.audit({ action: 'deploy-ship-success', target: target.name, targetId: target.id, repo: repo.name, release: ts, commit: run.commit, runId: run.id, ms: Date.now() - Date.parse(run.startedAt), buildMode: buildWhere, trigger: run.trigger });
  } catch (e) {
    if (isCancel(e) || run.signal.aborted) {
      run.setStatus('cancelled', 'cancelled by the user');
      if (releaseCreated && !activated && conn?.canExec && L) { try { await adapter.discardRelease(conn, L, ts); } catch {} }
      ctx.audit({ action: 'deploy-cancel', target: target.name, targetId: target.id, runId: run.id, stage: startedStage() });
    } else {
      const se = e instanceof StageError ? e : fail(startedStage() || 'connect', e);
      run.exitCode = se.exitCode;
      run.setStatus('failed', `${se.stage}: ${se.message}`);
      if (run.mode !== 'plan') ctx.audit({ action: 'deploy-ship-failed', target: target.name, targetId: target.id, repo: repo?.name, release: ts, commit: run.commit, runId: run.id, stage: se.stage, error: redact(se.message), trigger: run.trigger });
    }
  } finally {
    if (conn?.canExec && L && adapter.unlock && run.mode !== 'plan') { try { await adapter.unlock(conn, L); } catch {} }
    if (conn) { try { conn.close(); } catch {} }
  }

  /* ---------------- helpers ---------------- */
  async function rollbackAfterFailure(failedStage, e) {
    if (isCancel(e)) { throw e; }
    warn(`${failedStage} failed: ${e.message}`);
    run.exitCode = EXIT[failedStage];
    stage('rollback');
    const prev = run.previousRelease;
    try {
      if (!activated) { sys('nothing was activated; current release untouched'); if (releaseCreated && conn.canExec) await adapter.discardRelease(conn, L, ts); run.setStatus('failed', `${failedStage}: ${e.message}`); }
      else if (!prev) { warn('no previous release to roll back to'); run.setStatus('rollback_failed', `${failedStage}: ${e.message} (no previous release)`); run.exitCode = 8; }
      else {
        sys(`rolling back to ${prev}`);
        if (conn.canExec) await adapter.rollback(conn, L, prev, target, manifest, { onLine: out, warn, probe, strategy });
        else await adapter.rollbackInPlace(conn, target, prev, { onLine: sys });
        try { await run.remoteCmds?.(hooksFor(manifest, 'on_failure', 'remote', buildWhere), L.current); } catch (he) { warn(`on_failure hook failed: ${he.message}`); }
        run.setStatus('rolled_back', `${failedStage}: ${e.message}`);
        run.exitCode = 7;
      }
      try { await run.localCmds?.(hooksFor(manifest, 'on_failure', 'local', buildWhere), appDir); } catch (he) { warn(`on_failure hook failed: ${he.message}`); }
    } catch (re) {
      warn(`rollback failed: ${re.message}`);
      run.setStatus('rollback_failed', `${failedStage}: ${e.message}; rollback: ${re.message}`);
      run.exitCode = 8;
    }
    ctx.audit({ action: run.status === 'rolled_back' ? 'deploy-ship-rolled-back' : 'deploy-ship-failed', target: target.name, targetId: target.id, repo: repo?.name, release: ts, previousRelease: prev, commit: run.commit, runId: run.id, stage: failedStage, error: redact(e.message), trigger: run.trigger });
  }

  async function doPaasFlow() {
    const prov = adapter.PROVIDERS[target.paas.provider];
    let plan;
    stage('plan');
    try {
      ts = newReleaseName(); L = adapter.layout(target);
      buildWhere = prov.buildLocal ? 'local' : 'provider'; run.buildMode = buildWhere;
      if (prov.buildLocal && manifest.build.steps.length) {
        const required = stack.requiredTools ? stack.requiredTools(manifest) : [];
        const localMissing = [];
        for (const t of required) if (!(await require('./exec').probeTool(t, ['php'].includes(t) ? '-v' : ['node', 'npm', 'pnpm', 'yarn', 'bun'].includes(t) ? '-v' : '--version'))) localMissing.push(t);
        if (localMissing.length) throw new Error(`local build needs ${localMissing.join(', ')} on this machine`);
      }
      if (!prov.buildLocal && manifest.build.steps.length) sys(`${prov.label} builds the app itself; local build steps are skipped`);
      const vars = { release: L.release(ts), current: L.current, shared: L.shared, root: L.root, commit: run.commit || '', shortCommit: run.shortCommit || '', ts, branch: run.branch || '', name: manifest.name };
      manifest = manifestLib.interpolate(manifest, vars, (name) => vault.get(name));
      const dir = prov.buildLocal ? (manifest.build.outputDir ? path.join(appDir, manifest.build.outputDir) : appDir) : appDir;
      const c = { dir, appDir, prod: target.paas.prod !== false, release: ts, commit: run.commit || '', shortCommit: run.shortCommit || '', branch: run.branch || '' };
      const steps = [];
      const add = (st, where, cwd, cmd, label) => steps.push({ stage: st, where, cwd, cmd, label });
      if (prov.buildLocal) { for (const h of hooksFor(manifest, 'before_build', 'local', 'local')) add('build', 'local', appDir, h, 'hook before_build'); for (const s of manifest.build.steps) add('build', 'local', appDir, s, 'build'); for (const h of hooksFor(manifest, 'after_build', 'local', 'local')) add('build', 'local', appDir, h, 'hook after_build'); }
      const ps = adapter.planStep(target, c); add('ship', 'local', ps.cwd, ps.cmd, ps.label);
      for (const h of hooksFor(manifest, 'after_ship', 'local', 'local')) add('ship', 'local', appDir, h, 'hook after_ship (local)');
      if (target.healthUrl) add('verify', 'local', null, `GET ${target.healthUrl} → expect ${manifest.health.expectStatus.join('-')} within ${manifest.health.timeoutSec}s`, 'health check');
      else add('verify', 'local', null, `GET <deployment url reported by ${prov.label}> → expect ${manifest.health.expectStatus.join('-')}`, 'health check');
      const hooksRemote = ['after_ship', 'before_activate', 'after_activate'].flatMap((h) => hooksFor(manifest, h, 'remote', buildWhere));
      if (hooksRemote.length) warn(`${hooksRemote.length} remote hook(s) cannot run on a platform target and are skipped`);
      const hash = crypto.createHash('sha256').update(JSON.stringify(steps).split(ts).join('<release>')).digest('hex').slice(0, 16);
      plan = { hash, buildWhere, release: ts, strategy: prov.id, steps, warnings: run.warnings.map((w) => w.msg), manifest: manifestLib.compact(manifest), commit: run.commit, target: { id: target.id, name: target.name, type: target.type } };
      run.release = ts; run.plan = plan; run.emit('plan', plan);
      sys(`plan: ${steps.length} step(s), ${prov.label}, build ${buildWhere}, hash ${hash}`);
      for (const s of steps) sys(`  [${s.stage}] ${s.where}${s.cwd ? ' ' + s.cwd : ''} $ ${s.cmd}`);
      if (run.mode === 'plan') { run.setStatus('succeeded'); return; }
      if (run.planHash && run.planHash !== hash) throw new Error(`plan changed since you reviewed it (${run.planHash} → ${hash}); re-run Plan and ship again`);
      run._paas = c;
    } catch (e) { throw fail('plan', e); }

    const c = run._paas;
    const buildEnv = { ...manifest.build.env, CI: manifest.build.env.CI || 'true', RELEASE: ts, COMMIT: run.commit || '', TS: ts, NAME: manifest.name };
    const localCmds = async (cmds, cwd) => { for (const cmd of cmds) { checkCancel(); sys(`$ ${cmd}`); await localExec(cmd, { cwd, env: buildEnv, onLine: out, signal: run.signal, timeoutMs: 45 * 60000 }); } };
    if (prov.buildLocal && manifest.build.steps.length) {
      stage('build');
      try {
        await localCmds(hooksFor(manifest, 'before_build', 'local', 'local'), appDir);
        await localCmds(manifest.build.steps, appDir);
        await localCmds(hooksFor(manifest, 'after_build', 'local', 'local'), appDir);
        if (!fs.existsSync(c.dir)) throw new Error(`build output "${manifest.build.outputDir}" was not produced`);
      } catch (e) { throw fail('build', e); }
    }
    stage('ship');
    let info;
    try {
      sys(`${prov.label}: deploying${prov.buildLocal ? ' ' + c.dir : ''} (${c.prod ? 'production' : 'preview'})`);
      info = await adapter.deploy(target, vault, c, { onLine: out, signal: run.signal });
      run.deployment = { ...info, provider: prov.id, commit: run.commit, release: ts, appDir, at: new Date().toISOString() };
      sys(`deployed${info.id ? ' · id ' + info.id : ''}${info.url ? ' · ' + info.url : ''}`);
      await localCmds(hooksFor(manifest, 'after_ship', 'local', 'local'), appDir);
    } catch (e) { throw fail('ship', e); }
    const verifyUrl = target.healthUrl || info.url || info.prodUrl || null;
    if (verifyUrl) {
      stage('verify');
      try { await health.verify(verifyUrl, { ...manifest.health, signal: run.signal, onLine: sys }); }
      catch (e) {
        warn(`verify failed: ${e.message}`);
        run.exitCode = 7;
        const prev = previousPaasDeployment();
        if (prev && adapter.canRollback(target, prev)) {
          stage('rollback');
          try { sys(`rolling back to ${prev.id || prev.release}`); const cmd = await adapter.rollback(target, vault, prev, { onLine: out, signal: run.signal }); sys(`$ ${cmd}`); run.previousRelease = prev.release || prev.id; run.setStatus('rolled_back', `verify: ${e.message}`); ctx.audit({ action: 'deploy-ship-rolled-back', target: target.name, targetId: target.id, repo: repo?.name, release: ts, previousRelease: run.previousRelease, commit: run.commit, runId: run.id, stage: 'verify', error: redact(e.message), trigger: run.trigger }); }
          catch (re) { run.exitCode = 8; run.setStatus('rollback_failed', `verify: ${e.message}; rollback: ${re.message}`); ctx.audit({ action: 'deploy-ship-failed', target: target.name, targetId: target.id, runId: run.id, stage: 'rollback', error: redact(re.message) }); }
          return;
        }
        run.setStatus('failed', `verify: ${e.message}${prev ? '' : ' (no previous deployment to roll back to)'}`);
        ctx.audit({ action: 'deploy-ship-failed', target: target.name, targetId: target.id, repo: repo?.name, release: ts, commit: run.commit, runId: run.id, stage: 'verify', error: redact(e.message), trigger: run.trigger });
        return;
      }
    } else warn('no URL to verify: add a healthUrl to the target');
    stage('cleanup');
    try { await localCmds(hooksFor(manifest, 'on_success', 'local', 'local'), appDir); } catch (e) { warn(`on_success hook failed: ${e.message}`); }
    run.setStatus('succeeded');
    sys(`deployed ${run.shortCommit ? run.shortCommit + ' ' : ''}to ${prov.label}${info.url ? ' → ' + info.url : ''} in ${Math.round((Date.now() - Date.parse(run.startedAt)) / 1000)}s`);
    ctx.audit({ action: 'deploy-ship-success', target: target.name, targetId: target.id, repo: repo.name, release: ts, commit: run.commit, runId: run.id, ms: Date.now() - Date.parse(run.startedAt), buildMode: buildWhere, trigger: run.trigger, url: info.url || null });
  }

  /** The successful platform deployment before the current run (from the run index). */
  function previousPaasDeployment() {
    const runs = stores.runs.get().runs.filter((r) => r.targetId === target.id && r.mode === 'ship' && r.status === 'succeeded' && r.deployment && r.id !== run.id).sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
    return runs[0]?.deployment || null;
  }

  async function doRollbackMode() {
    stage('rollback');
    if (adapter.capabilities.paas) {
      try {
        manifest = manifestLib.resolve(repo?.manifest || {}, target.overrides);
        const all = stores.runs.get().runs.filter((r) => r.targetId === target.id && r.mode === 'ship' && r.status === 'succeeded' && r.deployment).sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
        const prev = run.rollbackTo ? all.find((r) => r.release === run.rollbackTo || r.deployment.id === run.rollbackTo)?.deployment : all[1]?.deployment;
        if (!prev) throw new Error(`no previous ${adapter.PROVIDERS[target.paas.provider].label} deployment recorded to roll back to`);
        if (!adapter.canRollback(target, prev)) throw new Error(`${adapter.PROVIDERS[target.paas.provider].label} does not support rollback for this deployment: redeploy the previous commit`);
        run.previousRelease = all[0]?.release || null; run.release = prev.release || prev.id;
        const cmd = await adapter.rollback(target, vault, prev, { onLine: out, signal: run.signal });
        sys(`$ ${cmd}`);
        run.deployment = { ...prev, rolledBackAt: new Date().toISOString() };
        if (target.healthUrl || prev.url) { stage('verify'); await health.verify(target.healthUrl || prev.url, { ...manifest.health, signal: run.signal, onLine: sys }); }
        run.setStatus('succeeded');
        ctx.audit({ action: 'deploy-rollback', target: target.name, targetId: target.id, release: run.release, previousRelease: run.previousRelease, runId: run.id, trigger: run.trigger });
      } catch (e) { run.exitCode = 8; throw fail('rollback', e); }
      return;
    }
    try {
      manifest = manifestLib.resolve(repo?.manifest || {}, target.overrides);
      if (conn.canExec) {
        const { current, releases } = await adapter.listReleases(conn, L = adapter.layout(target));
        const names = releases.map((r) => r.ts);
        let to = run.rollbackTo;
        if (!to) { const i = names.indexOf(current); to = i > 0 ? names[i - 1] : null; }
        if (!to || !names.includes(to)) throw new Error(`no release to roll back to${to ? ` (${to} not found)` : ''}; available: ${names.join(', ') || 'none'}`);
        if (to === current) throw new Error(`${to} is already the current release`);
        run.previousRelease = current; run.release = to;
        sys(`current ${current} → ${to}`);
        await adapter.rollback(conn, L, to, target, manifest, { onLine: out, warn, probe, strategy });
      } else {
        const { releases } = await adapter.listInPlace(conn, target);
        const olds = releases.filter((r) => !r.current);
        const pick = run.rollbackTo ? olds.find((r) => r.ts === run.rollbackTo) : olds[olds.length - 1];
        if (!pick) throw new Error('no previous copy to roll back to');
        run.release = pick.ts;
        await adapter.rollbackInPlace(conn, target, pick.path, { onLine: sys });
      }
      if (target.healthUrl) { stage('verify'); await health.verify(target.healthUrl, { ...manifest.health, signal: run.signal, onLine: sys, remote: target.healthRemote && conn.canExec ? { conn } : null }); }
      run.setStatus('succeeded');
      ctx.audit({ action: 'deploy-rollback', target: target.name, targetId: target.id, release: run.release, previousRelease: run.previousRelease, runId: run.id, trigger: run.trigger });
    } catch (e) { run.exitCode = 8; throw fail('rollback', e); }
  }

  async function pruneLocalBuilds() {
    try {
      const dir = path.join(stores.workDir, repo.id, '.build');
      const ents = (await fsp.readdir(dir)).sort();
      for (const e of ents.slice(0, Math.max(0, ents.length - 3))) await fsp.rm(path.join(dir, e), { recursive: true, force: true });
    } catch {}
  }
}

module.exports = { runPipeline, StageError, EXIT };
