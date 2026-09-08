'use strict';
/* Pre-ship review: the assistant reads the manifest, the latest plan (with its
   change summary), the last run and the server probe, and returns a verdict
   the UI shows before the Ship button is enabled. Advisory only: the user
   can still ship. */

const VERDICTS = ['ready', 'caution', 'block'];
const LOCAL_HOST_RE = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|::1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[^.]+\.(local|test|localhost|internal|lan))$/i;

/** Where does this target live? Loopback / private hosts are local tests whatever the name says. */
function classifyEnv(target, host) {
  const h = String(host || '').trim();
  if (h && LOCAL_HOST_RE.test(h)) return 'local';
  const n = String(target?.name || '').toLowerCase();
  if (/pre.?prod|stag|uat|qa|test/.test(n)) return 'staging';
  if (/prod|live/.test(n)) return 'production';
  if (/dev|local|sandbox/.test(n)) return 'dev';
  return 'unknown';
}
const LEVELS = ['ok', 'warn', 'block'];

function buildPrompt({ target, repo, manifest, guardrails, plan, lastRun, logTail, probe, expectedRelease, healthUrl, env = 'unknown', host = '' }) {
  const lines = [];
  lines.push(`You are reviewing a deployment BEFORE it is shipped by the "The Ascension" module of Server Tools. Be concrete and short.`);
  lines.push(`Target: ${target.name} (${target.type}${target.buildMode ? `, ${target.buildMode} build` : ''}) on host ${host || 'unknown'}; environment: ${env.toUpperCase()}. Repo: ${repo?.name || 'none'}${repo?.lastFetch?.commit ? ` at ${repo.lastFetch.commit.slice(0, 8)} (${repo.lastFetch.branch || ''})` : ''}.`);
  if (env === 'local') lines.push(`This is a LOCAL TEST target (loopback/private host): the name is not an indication of production. Judge only what can break the deploy or lose data. Do NOT use "block" or "warn" for: the host being unreachable on a previous run (the local test server was simply not running), a missing health URL, plain FTP without TLS, or the target name. Mention such points at most once as "ok"/informational.`);
  else if (env === 'dev' || env === 'staging') lines.push(`This is a ${env} environment: production hardening (TLS, health URL) is advisable but not blocking; data-loss risks still are.`);
  lines.push(`Health URL: ${healthUrl || 'NONE configured (no automatic rollback)'}.`);
  lines.push(`\nResolved manifest (JSON):\n${JSON.stringify(manifest)}`);
  lines.push(`\nGuardrail check: ${guardrails.ok ? 'all rules satisfied' : guardrails.violations.map((v) => `${v.rule}: ${v.message} (fix: ${v.fix})`).join('; ')}`);
  if (plan) {
    lines.push(`\nLatest plan (${plan.hash}, ${plan.buildWhere} build, ${plan.steps.length} steps${plan.commit ? `, commit ${plan.commit.slice(0, 8)}` : ''}):`);
    lines.push(plan.steps.map((s) => `  [${s.stage}] ${s.where} $ ${s.cmd}`).join('\n'));
    if (plan.warnings?.length) lines.push(`Plan warnings: ${plan.warnings.join(' | ')}`);
    if (plan.diff?.summary?.length) lines.push(`Changes versus the last successful ship: ${plan.diff.summary.join(' | ')}`);
    if (plan.diff?.commits?.log?.length) lines.push(`Commits:\n${plan.diff.commits.log.slice(0, 30).join('\n')}`);
  } else lines.push('\nNo plan has been run for this target yet.');
  if (lastRun) {
    lines.push(`\nLast run: ${lastRun.mode} ${lastRun.status}${lastRun.error ? ` (${lastRun.error})` : ''}, release ${lastRun.release || '-'}, ended ${lastRun.endedAt || '-'}.`);
    if (logTail?.length) lines.push(`Last log lines (redacted):\n${logTail.join('\n')}`);
  } else lines.push('\nNo previous run for this target.');
  if (probe) lines.push(`\nServer probe (${probe.at || 'unknown time'}): current release ${probe.current || 'none'}, ${probe.releases?.length ?? 0} release(s) on disk, user ${probe.user || '?'}${probe.sudo ? ' (sudo)' : ''}${probe.lock ? `, LOCK HELD: ${probe.lock}` : ''}.${expectedRelease ? ` Last shipped release: ${expectedRelease}${probe.current && probe.current !== expectedRelease ? ' (MISMATCH with what the server serves)' : ''}.` : ''}`);
  lines.push(`\nReply with ONLY one JSON object, no prose, no markdown fence:
{"verdict":"ready|caution|block","summary":"<one sentence>","findings":[{"level":"ok|warn|block","text":"<max 140 chars>"}]}
Rules: "block" only for things that would break the site or lose data (missing backup before migrations, missing shared storage, no health check on production, plan warnings about skipped steps, lock held, server release mismatch). "caution" for risks worth a look. List at most 6 findings, most important first, and include what looks fine as "ok" findings when it matters.`);
  return lines.join('\n');
}

function parseReview(text) {
  const raw = String(text || '').trim().replace(/^```(json)?\s*|\s*```$/g, '');
  let j = null;
  try { j = JSON.parse(raw); } catch { const m = raw.match(/\{[\s\S]*\}/); if (m) { try { j = JSON.parse(m[0]); } catch {} } }
  if (!j || typeof j !== 'object') return { verdict: 'caution', summary: raw.slice(0, 400) || 'The assistant did not return a structured review.', findings: [], unstructured: true };
  const verdict = VERDICTS.includes(j.verdict) ? j.verdict : 'caution';
  const findings = Array.isArray(j.findings) ? j.findings.filter((f) => f && typeof f.text === 'string').slice(0, 8).map((f) => ({ level: LEVELS.includes(f.level) ? f.level : 'warn', text: String(f.text).slice(0, 300) })) : [];
  return { verdict, summary: String(j.summary || '').slice(0, 400), findings };
}

/** Local test targets are never "blocked" for production-only reasons; guardrail violations still are. */
function applyEnvPolicy(review, env, guardrailsOk) {
  if (env !== 'local' || !review) return review;
  const out = { ...review, findings: review.findings.map((f) => (f.level === 'block' && guardrailsOk ? { ...f, level: 'warn' } : f)) };
  if (out.verdict === 'block' && guardrailsOk) { out.verdict = 'caution'; out.findings = [...out.findings, { level: 'ok', text: 'Local test target: production-only concerns are informational here.' }]; }
  return out;
}

const ACTIONS = ['plan', 'ship', 'rollback', 'unlock', 'cancel'];
/** Failure analysis reply: {"explanation":"...","action":{"action":"plan|ship|rollback|unlock|cancel|none","release":"","reason":""}} or plain text. */
function parseExplain(text) {
  const raw = String(text || '').trim().replace(/^```(json)?\s*|\s*```$/g, '');
  let j = null;
  try { j = JSON.parse(raw); } catch { const m = raw.match(/\{[\s\S]*\}/); if (m) { try { j = JSON.parse(m[0]); } catch {} } }
  if (!j || typeof j !== 'object' || typeof j.explanation !== 'string') return { explanation: raw, action: null };
  const a = j.action && typeof j.action === 'object' ? j.action : null;
  const action = a && ACTIONS.includes(a.action) ? { action: a.action, release: a.release && /^\d{14}$/.test(String(a.release)) ? String(a.release) : null, reason: String(a.reason || '').slice(0, 300) } : null;
  return { explanation: j.explanation, action };
}

module.exports = { buildPrompt, parseReview, parseExplain, classifyEnv, applyEnvPolicy, VERDICTS, LEVELS, ACTIONS, LOCAL_HOST_RE };
