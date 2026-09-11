'use strict';
/* Heuristic stack detection over a checkout. Returns every candidate with a
   score and evidence so the UI (and the AI fallback) can explain the pick. */

const fs = require('fs');
const path = require('path');
const { scanTree, readKeyFiles, subRoots, json } = require('./tree');
const { STACKS } = require('../stacks');

const AMBIGUITY_GAP = 0.1;
const MIN_CONFIDENCE = 0.6;

/**
 * @param {string} dir absolute path of the checkout
 * @returns {Promise<{best, candidates, ambiguous, tree, keyFiles, shipJson}>}
 */
async function detect(dir) {
  if (!fs.existsSync(dir)) throw Object.assign(new Error(`checkout not found: ${dir}`), { status: 404 });
  const tree = await scanTree(dir, { depth: 2 });
  const roots = ['.', ...subRoots(tree)];
  const keyFiles = await readKeyFiles(dir, roots);
  const candidates = [];
  for (const root of roots) {
    for (let i = 0; i < STACKS.length; i++) {
      let r = null;
      try { r = STACKS[i].detect(tree, keyFiles, root); } catch { r = null; }
      if (r) candidates.push({ id: STACKS[i].id, label: STACKS[i].label, root, score: r.score, evidence: r.evidence, fragment: r.fragment, order: i + (root === '.' ? 0 : 100) });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.order - b.order);
  const best = candidates[0] || null;
  const second = candidates.find((c) => c !== best && c.root !== best?.root) || candidates[1] || null;
  const ambiguous = !best || best.score < MIN_CONFIDENCE || (second && second.root !== best.root && best.score - second.score < AMBIGUITY_GAP);
  const shipJson = keyFiles['ship.json'] ? json(keyFiles['ship.json']) : null;
  return {
    best: best ? strip(best) : null,
    candidates: candidates.map(strip),
    ambiguous: !!ambiguous,
    reason: !best ? 'no known stack markers found' : best.score < MIN_CONFIDENCE ? `low confidence (${best.score})` : ambiguous ? `multiple app roots detected (${best.root}, ${second.root})` : null,
    tree, keyFiles, shipJson, shipJsonError: keyFiles['ship.json'] && !shipJson ? 'ship.json is not valid JSON' : null,
  };
}
function strip(c) { const { order, ...rest } = c; return rest; }

module.exports = { detect, AMBIGUITY_GAP, MIN_CONFIDENCE };
