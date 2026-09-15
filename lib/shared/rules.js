'use strict';
/* The shape of a saved rule.
 *
 * rules.json is a plain, readable file, and people edit it: by hand, or by pasting a rule the
 * assistant showed them in the chat. Everything arriving through the API is normalised on the way
 * in (sanitizeRuleInput), but nothing normalised what was already on disk - so a single
 * hand-written `"displayColumns": "id,page_url"` reached code that spreads and iterates it, and a
 * string spreads into characters. The editor threw "(…||[]).join is not a function" and could not
 * open the rule; a preview would have validated a column called "i", then "d", then ",".
 *
 * Repairs are made to the copy in memory. The file belongs to the user and is rewritten only when
 * they save.
 */

const crypto = require('node:crypto');

/** A comma-separated list, however it was written: ["a","b"] or "a, b". */
function columnList(value) {
  if (Array.isArray(value)) return value.map((s) => String(s).trim()).filter(Boolean);
  // `||`, not `??`: every falsy value here is nonsense as a column list, and this is what the
  // sanitizer has always done with one
  return String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * One rule, in the shape the rest of the application is written against.
 * @param {object} raw whatever was in the file
 * @returns {{rule: object, repaired: string[]}} the rule, and what had to be corrected
 */
function normalizeRule(raw) {
  const rule = { ...(raw && typeof raw === 'object' ? raw : {}) };
  const repaired = [];
  if (!rule.id) { rule.id = crypto.randomUUID(); repaired.push('missing id'); }
  if (!Array.isArray(rule.displayColumns)) {
    const before = rule.displayColumns;
    rule.displayColumns = columnList(before);
    if (before != null && before !== '') repaired.push('displayColumns was not a list');
  }
  if (!Array.isArray(rule.transforms)) { rule.transforms = []; repaired.push('transforms was not a list'); }
  return { rule, repaired };
}

/**
 * A whole rules file.
 * @param {unknown} raw parsed rules.json
 * @param {(message: string) => void} [warn] told about each rule that had to be corrected
 */
function normalizeRules(raw, warn = () => {}) {
  return (Array.isArray(raw) ? raw : []).map((entry) => {
    const { rule, repaired } = normalizeRule(entry);
    if (repaired.length) warn(`rules.json: "${rule.name || rule.id}" — ${repaired.join('; ')}; using a corrected copy until you save it`);
    return rule;
  });
}

module.exports = { columnList, normalizeRule, normalizeRules };
