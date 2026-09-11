'use strict';
/* "What would change" for a plan: the new plan compared with the last
   successful ship of the same target (commits, manifest keys, commands,
   build location) plus whether the server's current release is that baseline. */

/** Compact, persistable summary of a plan (kept in the run index for future diffs). */
function summarizePlan(plan) {
  if (!plan) return null;
  const rel = plan.release || '';
  return {
    hash: plan.hash, buildWhere: plan.buildWhere, release: rel, commit: plan.commit || null,
    steps: (plan.steps || []).map((s) => ({ stage: s.stage, where: s.where, cmd: rel ? String(s.cmd).split(rel).join('<release>') : String(s.cmd) })),
    manifest: plan.manifest || null,
  };
}

function flatten(obj, prefix = '', out = {}) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) { out[prefix || '.'] = obj; return out; }
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out); else out[key] = v;
  }
  return out;
}

function diffManifest(a, b) {
  const fa = flatten(a || {}), fb = flatten(b || {});
  const out = [];
  for (const k of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
    if (k === 'version') continue;
    const va = JSON.stringify(fa[k]), vb = JSON.stringify(fb[k]);
    if (va !== vb) out.push({ path: k, from: fa[k] === undefined ? null : fa[k], to: fb[k] === undefined ? null : fb[k] });
  }
  return out.sort((x, y) => x.path.localeCompare(y.path));
}

function diffSteps(prevSteps, steps) {
  const key = (s) => `${s.stage}|${s.where}|${s.cmd}`;
  const prev = new Map((prevSteps || []).map((s) => [key(s), s]));
  const next = new Map((steps || []).map((s) => [key(s), s]));
  const added = [...next.values()].filter((s) => !prev.has(key(s))).map((s) => ({ stage: s.stage, where: s.where, cmd: s.cmd }));
  const removed = [...prev.values()].filter((s) => !next.has(key(s))).map((s) => ({ stage: s.stage, where: s.where, cmd: s.cmd }));
  return { added, removed, unchanged: [...next.keys()].filter((k) => prev.has(k)).length };
}

/**
 * @param {{previous: {runId, release, commit, endedAt, summary}|null, plan: {buildWhere, release, steps, manifest, commit}, commitLog: string[]|null, probeCurrent: string|null}} o
 */
function buildDiff({ previous, plan, commitLog, probeCurrent }) {
  const cur = summarizePlan(plan);
  const summary = [];
  if (!previous) {
    summary.push('no successful ship recorded for this target yet: every step is new');
    if (probeCurrent) summary.push(`the server already serves release ${probeCurrent} (deployed outside this tool or before its history)`);
    return { baseline: null, firstDeploy: true, currentRelease: probeCurrent || null, commits: null, manifest: [], steps: { added: cur.steps, removed: [], unchanged: 0 }, buildWhereChanged: false, summary };
  }
  const prevSum = previous.summary || null;
  const commits = previous.commit && plan.commit
    ? { from: previous.commit, to: plan.commit, same: previous.commit === plan.commit, count: commitLog ? commitLog.length : null, log: commitLog || null }
    : null;
  const manifest = prevSum?.manifest ? diffManifest(prevSum.manifest, cur.manifest) : [];
  const steps = prevSum?.steps ? diffSteps(prevSum.steps, cur.steps) : { added: [], removed: [], unchanged: cur.steps.length, unknown: true };
  const buildWhereChanged = !!(prevSum?.buildWhere && prevSum.buildWhere !== cur.buildWhere);
  const releaseIsBaseline = probeCurrent ? probeCurrent === previous.release : null;
  if (commits) {
    if (commits.same) summary.push(`same commit as the last ship (${plan.commit.slice(0, 8)}): a re-deploy of ${previous.release}`);
    else summary.push(`${commits.count == null ? 'new commits' : `${commits.count} commit(s)`} since the last ship (${previous.commit.slice(0, 8)} → ${plan.commit.slice(0, 8)})`);
  }
  if (manifest.length) summary.push(`manifest changed: ${manifest.slice(0, 6).map((m) => m.path).join(', ')}${manifest.length > 6 ? ` +${manifest.length - 6} more` : ''}`);
  else if (prevSum?.manifest) summary.push('manifest unchanged');
  if (steps.unknown) summary.push('command list of the last ship is not recorded (older run)');
  else if (steps.added.length || steps.removed.length) summary.push(`commands: +${steps.added.length} added, -${steps.removed.length} removed, ${steps.unchanged} unchanged`);
  else summary.push(`same ${steps.unchanged} command(s) as the last ship`);
  if (buildWhereChanged) summary.push(`build location changes: ${prevSum.buildWhere} → ${cur.buildWhere}`);
  if (releaseIsBaseline === false) summary.push(`the server currently serves ${probeCurrent}, not the last shipped release ${previous.release} (rolled back or changed by hand)`);
  return { baseline: { runId: previous.runId, release: previous.release, commit: previous.commit, endedAt: previous.endedAt }, firstDeploy: false, currentRelease: probeCurrent || null, releaseIsBaseline, commits, manifest, steps, buildWhereChanged, summary };
}

module.exports = { summarizePlan, flatten, diffManifest, diffSteps, buildDiff };
