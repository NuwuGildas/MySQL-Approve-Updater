'use strict';
/* Minimal semver used by the module host. No dependency is added for it, and the
   subset is deliberately small: exact versions, `^`, `~`, comparisons and `*`.
   Anything this parser cannot understand is rejected rather than guessed at. */

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function parse(version) {
  const m = VERSION_RE.exec(String(version || '').trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null };
}

function valid(version) { return parse(version) !== null; }

function compare(a, b) {
  const x = parse(a), y = parse(b);
  if (!x || !y) throw new Error(`Not a version: ${!x ? a : b}`);
  if (x.major !== y.major) return x.major - y.major;
  if (x.minor !== y.minor) return x.minor - y.minor;
  if (x.patch !== y.patch) return x.patch - y.patch;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;      // 1.0.0 > 1.0.0-rc1
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

const gte = (a, b) => compare(a, b) >= 0;
const lt = (a, b) => compare(a, b) < 0;

/** Upper bound (exclusive) for a caret/tilde range, following npm's rules. */
function ceiling(v, kind) {
  if (kind === '~') return `${v.major}.${v.minor + 1}.0`;
  if (v.major > 0) return `${v.major + 1}.0.0`;
  if (v.minor > 0) return `0.${v.minor + 1}.0`;
  return `0.0.${v.patch + 1}`;
}

/** Does `version` satisfy `range`? Comma/space separated comparators are ANDed, `||` is ORed. */
function satisfies(version, range) {
  if (!valid(version)) return false;
  const text = String(range == null ? '*' : range).trim();
  if (!text || text === '*' || text === 'x' || text === 'latest') return true;
  return text.split('||').some((alternative) =>
    alternative.trim().split(/\s+|,/).filter(Boolean).every((comparator) => satisfiesOne(version, comparator)));
}

function satisfiesOne(version, comparator) {
  const m = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(comparator.trim());
  if (!m) return false;
  const operator = m[1] || '=';
  const target = parse(m[2]);
  if (!target) return false;
  const base = `${target.major}.${target.minor}.${target.patch}${target.pre ? '-' + target.pre : ''}`;
  switch (operator) {
    case '^': case '~': return gte(version, base) && lt(version, ceiling(target, operator));
    case '>=': return gte(version, base);
    case '<=': return compare(version, base) <= 0;
    case '>': return compare(version, base) > 0;
    case '<': return lt(version, base);
    default: return compare(version, base) === 0;
  }
}

/** Highest version in `versions` that satisfies `range`, or null. */
function maxSatisfying(versions, range) {
  return versions.filter((v) => satisfies(v, range)).sort(compare).pop() || null;
}

/** A range is only usable if every comparator in it parses. */
function validRange(range) {
  const text = String(range == null ? '*' : range).trim();
  if (!text || text === '*' || text === 'x' || text === 'latest') return true;
  return text.split('||').every((alternative) => {
    const parts = alternative.trim().split(/\s+|,/).filter(Boolean);
    return parts.length > 0 && parts.every((c) => {
      const m = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(c.trim());
      return !!m && parse(m[2]) !== null;
    });
  });
}

module.exports = { parse, valid, validRange, compare, satisfies, maxSatisfying };
