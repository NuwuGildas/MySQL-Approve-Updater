'use strict';
/* CLI entry: `node server.js ship <target> …` (or server-tools.exe …).
   server.js loads normally (so the deploy module has its real ctx) but skips
   app.listen when isCliInvocation() is true and calls main() instead. */

const path = require('path');

const COMMANDS = ['ship', 'plan', 'rollback', 'releases', 'detect', 'targets', 'secrets', 'runs', 'deploy-help'];
const isCliInvocation = (argv) => COMMANDS.includes(String(argv[2] || ''));

const HELP = `Server Tools · The Ascension (deploy CLI)

  server-tools ship <target> [--ref <branch|tag|sha>] [--build local|remote] [--yes] [--ai] [--json] [--force-unlock]
  server-tools plan <target> [--ref …] [--build …] [--ai] [--json]
  server-tools rollback <target> [--to <release>] [--yes]
  server-tools releases <target>
  server-tools runs [<target>] [--limit N]
  server-tools detect [<path>] [--ai] [--json]
  server-tools targets [--json]
  server-tools secrets list | set <NAME> [--value <v> | --stdin] | rm <NAME>
  server-tools deploy-help

  <target> is a target id or its unique name. Shipping needs --yes (or CI=true).

Exit codes: 0 ok · 1 unexpected · 2 usage/confirmation · 3 target/repo not found · 4 connect/fetch failed
            5 build failed · 6 ship failed (target untouched) · 7 activate/verify failed, rolled back
            8 rollback failed · 10 detection ambiguous / manifest invalid · 130 cancelled
`;

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) out.flags[k] = v;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--') && ['ref', 'build', 'to', 'value', 'limit', 'timeout'].includes(k)) out.flags[k] = argv[++i];
      else out.flags[k] = true;
    } else out._.push(a);
  }
  return out;
}

const useColor = () => process.stdout.isTTY && !process.env.NO_COLOR;
const C = { dim: (s) => (useColor() ? `\x1b[2m${s}\x1b[0m` : s), red: (s) => (useColor() ? `\x1b[31m${s}\x1b[0m` : s), green: (s) => (useColor() ? `\x1b[32m${s}\x1b[0m` : s), yellow: (s) => (useColor() ? `\x1b[33m${s}\x1b[0m` : s), bold: (s) => (useColor() ? `\x1b[1m${s}\x1b[0m` : s) };

function statusExit(run) {
  if (run.status === 'succeeded') return 0;
  if (run.status === 'cancelled') return 130;
  if (run.exitCode) return run.exitCode;
  if (run.status === 'rolled_back') return 7;
  if (run.status === 'rollback_failed') return 8;
  return 1;
}

async function main(argv, ctx, deploy) {
  const { engine, stores, vault, redact, agentApi } = deploy;
  const args = parseArgs(argv);
  const [cmd, arg1, arg2] = args._;
  const json = !!args.flags.json;
  const print = (s) => process.stdout.write(s + '\n');
  const printErr = (s) => process.stderr.write(C.red(s) + '\n');

  const findTarget = (idOrName) => {
    if (!idOrName) { printErr('usage: missing <target>'); return null; }
    const t = stores.findTarget(idOrName);
    if (!t) { printErr(`target "${idOrName}" not found. Known: ${stores.targets.get().targets.map((x) => x.name).join(', ') || 'none'}`); return null; }
    return t;
  };

  const followRun = (run) => new Promise((resolve) => {
    run.on('log', (e) => {
      if (json) print(JSON.stringify({ type: 'log', runId: run.id, ...e, line: redact(e.line) }));
      else if (e.stream === 'sys' && e.line.startsWith('── ')) print(C.bold(e.line));
      else if (e.stream === 'err') print(C.dim(`[${e.stage}] `) + C.yellow(redact(e.line)));
      else print(C.dim(`[${e.stage}] `) + redact(e.line));
    });
    if (json) run.on('status', () => print(JSON.stringify({ type: 'status', runId: run.id, status: run.status, stage: run.stage, release: run.release, error: run.error })));
    run.once('done', () => resolve(run));
    process.once('SIGINT', () => { run.cancel(); });
  });

  try {
    switch (cmd) {
      case 'deploy-help': case undefined: print(HELP); return 0;
      case 'targets': {
        const list = stores.targets.get().targets.map((t) => ({ id: t.id, name: t.name, type: t.type, repo: stores.findRepo(t.repoId)?.name || null, buildMode: t.buildMode, root: t.paths?.root || t.paths?.docroot, lastRun: engine.list({ targetId: t.id, limit: 1 })[0]?.status || null }));
        if (json) print(JSON.stringify(list, null, 2)); else for (const t of list) print(`${C.bold(t.name.padEnd(24))} ${t.type.padEnd(15)} ${String(t.repo).padEnd(20)} ${String(t.root).padEnd(30)} last: ${t.lastRun || '-'}  ${C.dim(t.id)}`);
        if (!list.length) print(C.dim('no targets yet: create one in the Deploy module of the web UI'));
        return 0;
      }
      case 'runs': {
        const t = arg1 ? findTarget(arg1) : null; if (arg1 && !t) return 3;
        const list = engine.list({ targetId: t?.id, limit: Number(args.flags.limit) || 20 });
        if (json) print(JSON.stringify(list, null, 2)); else for (const r of list) print(`${r.id}  ${r.mode.padEnd(8)} ${r.status.padEnd(15)} ${String(r.targetName).padEnd(20)} ${r.release || ''} ${C.dim(r.error || '')}`);
        return 0;
      }
      case 'secrets': {
        if (arg1 === 'list' || !arg1) { const l = vault.names(); if (json) print(JSON.stringify(l)); else { for (const s of l) print(`${s.name}  ${C.dim(s.updatedAt)}`); if (!l.length) print(C.dim('vault is empty')); } return 0; }
        if (arg1 === 'set') {
          if (!arg2) { printErr('usage: secrets set <NAME> [--value <v> | --stdin]'); return 2; }
          let value = args.flags.value;
          if (args.flags.stdin || value === undefined) { value = await new Promise((res) => { let d = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => (d += c)); process.stdin.on('end', () => res(d.replace(/\r?\n$/, ''))); }); }
          try { vault.set(arg2, String(value)); } catch (e) { printErr(e.message); return 2; }
          ctx.audit({ action: 'deploy-secret-set', name: arg2, trigger: 'cli' });
          print(C.green(`secret ${arg2} saved`)); return 0;
        }
        if (arg1 === 'rm') { if (!arg2) { printErr('usage: secrets rm <NAME>'); return 2; } const ok = vault.remove(arg2); if (ok) ctx.audit({ action: 'deploy-secret-remove', name: arg2, trigger: 'cli' }); print(ok ? `removed ${arg2}` : `${arg2} not found`); return ok ? 0 : 3; }
        printErr('usage: secrets list | set <NAME> | rm <NAME>'); return 2;
      }
      case 'detect': {
        const { detect } = require('./detect');
        const dir = path.resolve(arg1 || process.cwd());
        let det;
        try { det = await detect(dir); } catch (e) { printErr(e.message); return 3; }
        let suggestion = null;
        if (det.ambiguous && args.flags.ai && agentApi?.aiDetect && ctx.agent.isConnected()) suggestion = await agentApi.aiDetect(det);
        if (json) { const { tree, keyFiles, ...rest } = det; print(JSON.stringify({ ...rest, suggestion }, null, 2)); }
        else {
          if (det.best) print(`${C.green('detected')} ${det.best.label} (${det.best.id}) confidence ${det.best.score}${det.best.root !== '.' ? ` in ${det.best.root}/` : ''}\n  evidence: ${det.best.evidence.join(', ')}`);
          if (det.ambiguous) print(C.yellow(`ambiguous: ${det.reason}`));
          for (const c of det.candidates) print(C.dim(`  candidate ${c.id} root=${c.root} score=${c.score}`));
          if (suggestion) print(`${C.bold('AI suggestion')} (confidence ${suggestion.confidence}): ${suggestion.reasoning}\n${JSON.stringify(suggestion.fragment, null, 2)}`);
          if (det.best?.fragment) print(`\nmanifest fragment:\n${JSON.stringify(require('./manifest').compact(require('./manifest').validate(det.best.fragment)), null, 2)}`);
        }
        return det.ambiguous && !suggestion ? 10 : 0;
      }
      case 'releases': {
        const t = findTarget(arg1); if (!t) return 3;
        const { adapterFor } = require('./targets');
        const adapter = adapterFor(t); const norm = adapter.validate(t, ctx);
        let conn;
        try { conn = await adapter.connect(ctx, norm, vault, {}); } catch (e) { printErr(`connection failed: ${redact(e.message)}`); return 4; }
        try {
          const out = conn.canExec ? await adapter.listReleases(conn, adapter.layout(norm)) : await adapter.listInPlace(conn, norm);
          if (json) print(JSON.stringify(out, null, 2)); else { for (const r of out.releases) print(`${r.current ? C.green('* ') : '  '}${r.ts}  ${C.dim(r.shortCommit || r.commit || '')} ${C.dim(r.builtAt || '')}`); if (!out.releases.length) print(C.dim('no releases')); }
        } finally { conn.close(); }
        return 0;
      }
      case 'plan': case 'ship': case 'rollback': {
        const t = findTarget(arg1); if (!t) return 3;
        const confirmed = !!args.flags.yes || /^(1|true|yes)$/i.test(String(process.env.CI || ''));
        if (cmd !== 'plan' && !confirmed) {
          printErr(`${cmd} needs --yes (or CI=true). Running "plan" instead so you can review the steps:`);
          const run = engine.start({ targetId: t.id, mode: 'plan', ref: args.flags.ref, buildMode: args.flags.build, ai: !!args.flags.ai, trigger: 'cli' });
          await followRun(run);
          return run.status === 'succeeded' ? 2 : statusExit(run);
        }
        let run;
        try {
          run = engine.start({ targetId: t.id, mode: cmd, ref: args.flags.ref, buildMode: ['local', 'remote'].includes(args.flags.build) ? args.flags.build : undefined, confirm: cmd === 'plan' ? undefined : true, release: args.flags.to, ai: !!args.flags.ai, force: !!args.flags['force-unlock'], trigger: 'cli' });
        } catch (e) { printErr(e.message); return e.status === 404 ? 3 : 2; }
        if (cmd !== 'plan') ctx.audit({ action: cmd === 'ship' ? 'deploy-ship-start' : 'deploy-rollback-start', target: t.name, targetId: t.id, runId: run.id, ref: run.ref, trigger: 'cli' });
        await followRun(run);
        const code = statusExit(run);
        if (!json) print(code === 0 ? C.green(`✔ ${cmd} ${run.status}${run.release ? `release ${run.release}` : ''}`) : C.red(`✖ ${cmd} ${run.status}${run.error ? `${redact(run.error)}` : ''} (exit ${code})`));
        return code;
      }
      default: printErr(`unknown command "${cmd}"\n`); print(HELP); return 2;
    }
  } catch (e) {
    printErr(`error: ${redact(e.message)}`);
    return 1;
  }
}

module.exports = { isCliInvocation, main, parseArgs, COMMANDS, HELP, statusExit };
