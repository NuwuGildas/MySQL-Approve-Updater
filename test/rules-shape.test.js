'use strict';
/* The shape of a saved rule, and what happens to one that does not have it.
 *
 * rules.json is a plain file people edit. A rule written by hand - or pasted out of the chat - can
 * hold "id,page_url" where the application expects ["id","page_url"], and a string does not have
 * .join, spreads into characters, and iterates into characters. That took the editor out entirely:
 * "((intermediate value) || []).join is not a function", and the rule could not be opened at all.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { columnList, normalizeRule, normalizeRules } = require('../lib/shared/rules');

test('a column list is read the same whether it was written as a list or as text', () => {
  assert.deepEqual(columnList(['id', 'page_url']), ['id', 'page_url']);
  assert.deepEqual(columnList('id, page_url'), ['id', 'page_url']);
  assert.deepEqual(columnList('id,page_url'), ['id', 'page_url']);
  // and the tidying the old inline version did, kept
  assert.deepEqual(columnList('a,,b'), ['a', 'b']);
  assert.deepEqual(columnList(['a', ' b ', '']), ['a', 'b']);
  for (const empty of ['', null, undefined, 0]) assert.deepEqual(columnList(empty), [], String(empty));
});

test('a hand-written rule is usable: the list is a list, and it has an id', () => {
  /* Exactly the rule that produced the report: a draft, written into rules.json by hand, with the
     display columns as one string and no id at all. */
  const { rule, repaired } = normalizeRule({
    name: 'Canonicalise casino hub links → /casino/',
    table: 'x2950_site', pkColumn: 'id', draft: true,
    displayColumns: 'id,page_url,maintext,site_main_2,bottom_text,cta',
    transforms: [{ column: 'maintext', type: 'findReplace', params: { find: '/casinos/', replace: '/casino/' } }],
  });

  assert.deepEqual(rule.displayColumns, ['id', 'page_url', 'maintext', 'site_main_2', 'bottom_text', 'cta']);
  assert.ok(typeof rule.displayColumns.join === 'function', 'the editor calls .join on it');
  assert.match(rule.id, /^[0-9a-f-]{36}$/, 'and it can be edited, saved and deleted, which all address it by id');
  assert.deepEqual(repaired, ['missing id', 'displayColumns was not a list'], 'and it says what it had to correct');

  // spreading and iterating, which is what the preview does, must not walk over characters
  assert.deepEqual([...rule.displayColumns].slice(0, 2), ['id', 'page_url']);
  const seen = [];
  for (const column of rule.displayColumns) seen.push(column);
  assert.equal(seen[1], 'page_url', 'not "d"');
});

test('a rule that was already in shape is left exactly as it is', () => {
  const original = {
    id: '114b2214-d823-4270-8379-f1652a7f12eb', name: 'Fix links', table: 't', pkColumn: 'id',
    where: '1=1', limit: 500, displayColumns: ['id', 'page_url'], transforms: [{ column: 'a', type: 'trim' }], draft: false,
  };
  const { rule, repaired } = normalizeRule(original);
  assert.deepEqual(repaired, []);
  assert.deepEqual(rule, original);
  assert.notEqual(rule, original, 'a copy: the file on disk is not mutated');
});

test('every other field is carried through untouched', () => {
  const { rule } = normalizeRule({ id: 'x', name: 'n', table: 't', pkColumn: 'id', where: 'x > 1', limit: 250, draft: true, displayColumns: 'a', transforms: [] });
  assert.equal(rule.where, 'x > 1');
  assert.equal(rule.limit, 250);
  assert.equal(rule.draft, true);
  assert.equal(rule.name, 'n');
});

test('missing or nonsense transforms become an empty list rather than a crash', () => {
  for (const bad of [undefined, null, 'trim', 42, {}]) {
    const { rule, repaired } = normalizeRule({ id: 'x', transforms: bad });
    assert.deepEqual(rule.transforms, [], String(bad));
    assert.ok(repaired.includes('transforms was not a list'), String(bad));
  }
});

test('a whole file is normalised, and says out loud which rules it had to correct', () => {
  const warnings = [];
  const rules = normalizeRules([
    { id: 'a', name: 'Fine', displayColumns: ['id'], transforms: [] },
    { name: 'Hand-written', displayColumns: 'id,page_url', transforms: [] },
  ], (m) => warnings.push(m));

  assert.equal(rules.length, 2);
  assert.deepEqual(rules[1].displayColumns, ['id', 'page_url']);
  assert.equal(warnings.length, 1, 'only the one that needed it');
  assert.match(warnings[0], /Hand-written/);
  assert.match(warnings[0], /displayColumns was not a list/);
  assert.match(warnings[0], /until you save it/, 'and that the file itself has not been touched');
});

test('a rules file that is not a list of rules is empty, not an exception', () => {
  for (const junk of [null, undefined, {}, 'rules', 42]) assert.deepEqual(normalizeRules(junk), [], String(junk));
  assert.deepEqual(normalizeRules([null, 'nonsense']).length, 2, 'entries that are not objects still become usable rules');
});
