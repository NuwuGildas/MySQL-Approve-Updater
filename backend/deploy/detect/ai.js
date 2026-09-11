'use strict';
/* AI fallback for stack detection. Only used when heuristics are not
   confident AND the user opted in. The reply must be a single JSON object
   that passes manifest validation; anything else counts as "no answer". */

const manifestLib = require('../manifest');

const KEY_FILE_RE = /^(.*\/)?(package\.json|composer\.json|requirements.*\.txt|pyproject\.toml|Dockerfile|compose\.ya?ml|docker-compose\.ya?ml|[^/]*\.config\.(js|ts|mjs)|README\.md|Procfile|manage\.py|artisan)$/;
const SECRET_LINE_RE = /(password|secret|token|api[_-]?key|private[_-]?key)\s*[=:]/i;

function buildPrompt(det) {
  const tree = det.tree.slice(0, 400).join('\n');
  const files = Object.entries(det.keyFiles || {}).filter(([k]) => KEY_FILE_RE.test(k)).slice(0, 12)
    .map(([k, v]) => `--- ${k} ---\n${String(v).split('\n').filter((l) => !SECRET_LINE_RE.test(l)).join('\n').slice(0, 4000)}`).join('\n\n');
  const cands = det.candidates.map((c) => `${c.id} (root ${c.root}, score ${c.score}, evidence ${c.evidence.join(', ')})`).join('; ') || 'none';
  const intro = det.best && !det.ambiguous
    ? `Heuristic detection suggests ${det.best.id} at root "${det.best.root}" (score ${det.best.score}, evidence ${det.best.evidence.join(', ')}). Confirm or correct it, then fill in the build, runtime, shared paths and health details from the files.`
    : `Heuristic detection was not confident: ${det.reason || 'no match'}.`;
  return `You are helping a deploy tool identify how to build and run a project from its repository.
${intro} Candidates: ${cands}.

Repository tree (depth 2):
${tree}

Key files:
${files || '(none)'}

Reply with ONLY one JSON object (no prose, no markdown fence) with this shape:
{"root":"<subdir or .>","stack":{"type":"php|node|static|docker|python","framework":"...","packageManager":"composer|npm|pnpm|yarn|bun|pip|poetry|uv|null"},
 "build":{"steps":["..."],"env":{},"outputDir":null},"artifact":{"exclude":[]},"shared":{"files":[],"dirs":[]},
 "hooks":{"after_ship":[],"before_activate":[],"after_activate":[]},"runtime":{"kind":"php-fpm|node|static|docker|python","start":null,"port":null,"docroot":"."},
 "health":{"path":"/"},"confidence":0.0,"reasoning":"<max 300 chars>"}
Rules: commands must not contain secrets; use production install flags (no dev dependencies); keep steps minimal.`;
}

function parseReply(text) {
  const s = String(text || '').trim().replace(/^```(json)?\s*|\s*```$/g, '');
  const tryParse = (str) => { try { return JSON.parse(str); } catch { return null; } };
  return tryParse(s) || tryParse((s.match(/\{[\s\S]*\}/) || [])[0] || '');
}

/**
 * @returns {Promise<{fragment, confidence, reasoning, by:'ai'}|null>}
 */
async function aiDetect(ctx, det) {
  let text;
  try { text = await ctx.agent.run(buildPrompt(det)); } catch { return null; }
  const j = parseReply(text);
  if (!j || typeof j !== 'object') return null;
  const { confidence, reasoning, ...fragment } = j;
  try {
    const m = manifestLib.validate(fragment);
    if (!m.stack.type) return null;
    return { fragment: manifestLib.compact(m), confidence: Math.max(0, Math.min(1, Number(confidence) || 0)), reasoning: String(reasoning || '').slice(0, 300), by: 'ai' };
  } catch { return null; }
}

module.exports = { aiDetect, buildPrompt, parseReply };
