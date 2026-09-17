'use strict';
/* What the feed says about one recorded event.
 *
 * The audit trail is written by the host and by every module, each recording its own fields under
 * its own action name. The feed's whole job is to turn that into a sentence, and a wrong sentence is
 * worse than no sentence at all - so the summaries are tested here, away from the DOM.
 *
 * The entries below are written by hand from the shapes the code records. Nothing here is read from
 * anyone's real trail.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

let E;
test.before(async () => { E = await import('../frontend/events.mjs'); });

const at = (ts, action, rest = {}) => ({ ts, action, _n: 1, ...rest });

test('an event is filed under what it is about, not under whatever is left over', () => {
  const expected = {
    'ai-chat': 'ai',
    'ai-chat-cancelled': 'ai',
    'agent-rule-approved': 'approvals',
    approve: 'approvals',
    reject: 'approvals',
    edit: 'approvals',
    preview: 'rules',
    clear: 'rules',
    'ai-sql': 'sql',
    'console-write': 'sql',
    'ssh-terminal-open': 'ssh',
    'ai-ssh-exec': 'ssh',
    'deploy-ship-success': 'deploy',
    'deploy-wordpress-new': 'deploy',
    'project-link': 'projects',
    'connector-add': 'connectors',
    login: 'other',
  };
  for (const [action, cat] of Object.entries(expected)) {
    assert.equal(E.categoryOf(action), cat, `${action} should be filed under ${cat}`);
  }
});

test('nothing unrecognised is quietly filed as a rule', () => {
  /* The old version returned "rules" for everything it did not match, so SQL, projects and
     connectors all appeared under a heading they had nothing to do with. */
  for (const action of ['console-write', 'ai-sql', 'project-create', 'connector-verify', 'something-new']) {
    assert.notEqual(E.categoryOf(action), 'rules', `${action} is not a rule`);
  }
});

test('every event says what happened, to what, and how it went', () => {
  const chat = E.classify(at('2026-09-01T10:00:00Z', 'ai-chat', { role: 'user', text: 'deploy the site', tools: ['ssh_exec'], chars: 15 }));
  assert.match(chat.title, /you wrote/i);
  assert.equal(chat.subject, 'deploy the site');
  assert.equal(chat.actor, 'you');
  assert.deepEqual(chat.facts.map((f) => f.label), ['Tools', 'Characters']);

  const preview = E.classify(at('2026-09-01T10:01:00Z', 'preview', { rule: 'Trim titles', table: 'pages', matchedRows: 500, proposedChanges: 447, limit: 500 }));
  assert.equal(preview.cat, 'rules');
  assert.match(preview.subject, /Trim titles.*pages/);
  assert.deepEqual(
    preview.facts.map((f) => `${f.label} ${f.value}`),
    ['Matched 500', 'Would change 447', 'Limit 500'],
  );

  const ship = E.classify(at('2026-09-01T10:02:00Z', 'deploy-ship-success', { target: 'prod-web', release: '2026-09-01-1002', commit: 'abc1234def', ms: 41200, buildMode: 'remote' }));
  assert.equal(ship.status, 'success');
  assert.equal(ship.subject, 'prod-web');
  const shipFacts = Object.fromEntries(ship.facts.map((f) => [f.label, f.value]));
  assert.equal(shipFacts.Commit, 'abc1234d', 'a commit is shortened the way it is everywhere else');
  assert.equal(shipFacts.Took, '41.2s');
});

test('how it went is read from what was recorded, not from the wording', () => {
  assert.equal(E.statusOf({ action: 'ai-ssh-exec', exitCode: 0 }), 'success');
  assert.equal(E.statusOf({ action: 'ai-ssh-exec', exitCode: 1 }), 'failed', 'a command that ran and failed is a failure');
  assert.equal(E.statusOf({ action: 'deploy-ship-failed', stage: 'build' }), 'failed');
  assert.equal(E.statusOf({ action: 'deploy-ship-rolled-back' }), 'warn');
  assert.equal(E.statusOf({ action: 'deploy-ship-start' }), 'pending');
  assert.equal(E.statusOf({ action: 'connector-add', status: 'ok' }), 'success');
  assert.equal(E.statusOf({ action: 'connector-add', status: 'failed' }), 'failed');
  assert.equal(E.statusOf({ action: 'anything', error: 'it broke' }), 'failed');
  assert.equal(E.statusOf({ action: 'ssh-terminal-open' }), 'info', 'something that neither succeeds nor fails says nothing');
});

test('who set it off is worked out from the entry, since nothing records it directly', () => {
  assert.equal(E.actorOf({ action: 'ai-chat', role: 'user' }), 'you');
  assert.equal(E.actorOf({ action: 'ai-chat', role: 'assistant' }), 'ai');
  assert.equal(E.actorOf({ action: 'ai-ssh-exec' }), 'ai');
  assert.equal(E.actorOf({ action: 'deploy-target-add', by: 'agent-proposal' }), 'ai');
  assert.equal(E.actorOf({ action: 'deploy-webhook', trigger: 'webhook' }), 'system');
  assert.equal(E.actorOf({ action: 'approve' }), 'you');
});

test('an action nobody described is still readable', () => {
  /* Modules write their own actions. One that ships tomorrow must read sensibly today. */
  const c = E.classify(at('2026-09-01T11:00:00Z', 'backup-restore', { name: 'nightly-2026-09-01', rows: 1200, sessionId: 's1', module: 'backups' }));
  assert.equal(c.title, 'Backup restore', 'the action name itself, made readable');
  assert.equal(c.subject, 'nightly-2026-09-01');
  assert.deepEqual(c.facts.map((f) => `${f.label} ${f.value}`), ['Rows 1200']);
  assert.equal(c.cat, 'other');
  assert.ok(!c.facts.some((f) => /session|module/i.test(f.label)), 'plumbing is not a fact worth showing');
});

test('a line that could not be parsed is shown as one, not thrown away', () => {
  const c = E.classify({ _raw: '{"ts":"2026-09-01T11:00' });
  assert.equal(c.status, 'warn');
  assert.match(c.title, /could not be read/i);
  assert.match(c.subject, /2026-09-01/);
});

test('classifying never throws, whatever it is handed', () => {
  for (const input of [null, undefined, {}, { action: 'ai-chat' }, { action: 'preview', columns: 'a,b' }, { action: 'ssh-agent-detect', found: null }]) {
    const c = E.classify(input);
    assert.equal(typeof c.title, 'string');
    assert.ok(c.title.length, `an empty title for ${JSON.stringify(input)}`);
  }
});

test('the filters narrow on each thing they name, and on nothing else', () => {
  const now = new Date();
  const rows = [
    at(now.toISOString(), 'ai-chat', { role: 'user', text: 'restart nginx' }),
    at(now.toISOString(), 'ai-ssh-exec', { cmd: 'systemctl restart nginx', exitCode: 0, profile: 'web-01' }),
    at(new Date(now - 10 * 86400e3).toISOString(), 'deploy-ship-failed', { target: 'prod-web', stage: 'build', error: 'tests failed' }),
  ];
  const keep = (f) => rows.filter((r) => E.matches(r, f)).map((r) => r.action);

  assert.deepEqual(keep({}), rows.map((r) => r.action), 'no filter keeps everything');
  assert.deepEqual(keep({ time: 'today' }), ['ai-chat', 'ai-ssh-exec']);
  assert.deepEqual(keep({ outcome: 'failed' }), ['deploy-ship-failed']);
  assert.deepEqual(keep({ outcome: 'succeeded' }), ['ai-ssh-exec']);
  assert.deepEqual(keep({ actor: 'you' }), ['ai-chat', 'deploy-ship-failed'], 'an entry that names nobody is one of yours');
  assert.deepEqual(keep({ actor: 'ai' }), ['ai-ssh-exec']);
  assert.deepEqual(keep({ action: 'deploy-ship-failed' }), ['deploy-ship-failed']);
  assert.deepEqual(keep({ q: 'nginx' }), ['ai-chat', 'ai-ssh-exec'], 'search reaches the recorded fields');
  assert.deepEqual(keep({ q: 'Would change' }), [], 'and does not invent matches');
  assert.deepEqual(keep({ time: 'today', outcome: 'failed' }), [], 'filters narrow together');
});

test('a time filter never lets an entry with no usable timestamp through as "recent"', () => {
  assert.equal(E.matches({ action: 'approve' }, { time: 'today' }), false);
  assert.equal(E.matches({ action: 'approve', ts: 'nonsense' }, { time: '7d' }), false);
  assert.equal(E.matches({ action: 'approve' }, { time: 'all' }), true);
});

test('the view can tell whether anything is being filtered at all', () => {
  assert.equal(E.isFiltering({ ...E.EMPTY_FILTERS }), false);
  assert.equal(E.isFiltering({ ...E.EMPTY_FILTERS, q: 'nginx' }), true);
  assert.equal(E.isFiltering({ ...E.EMPTY_FILTERS, action: 'approve' }), true);
  assert.equal(E.isFiltering({}), false, 'an empty object is not a filter');
});

test('the days are named the way a reader names them', () => {
  const today = new Date().toISOString();
  const yesterday = new Date(Date.now() - 86400000).toISOString();
  assert.equal(E.dayLabel(today), 'Today');
  assert.equal(E.dayLabel(yesterday), 'Yesterday');
  assert.equal(E.dayLabel('2024-03-05T09:00:00Z'), '2024-03-05');
  assert.equal(E.hhmm('2024-03-05T09:07:00Z'), '09:07');
});

test('what belongs together is taken from the identifiers actually recorded', () => {
  assert.deepEqual(E.relationOf({ runId: 'r1', sessionId: 's1' }), { kind: 'run', key: 'runId', value: 'r1', label: 'this deploy run' });
  assert.equal(E.relationOf({ turnId: 't1' }).key, 'turnId');
  assert.equal(E.relationOf({ sessionId: 's1' }).key, 'sessionId');
  assert.equal(E.relationOf({ action: 'approve', table: 'pages' }), null, 'nothing is invented for an entry that records no link');
});

test('the plain description is what search and screen readers get', () => {
  const line = E.describePlain(at('2026-09-01T10:02:00Z', 'deploy-ship-failed', { target: 'prod-web', stage: 'build', error: 'tests failed' }));
  assert.equal(line, 'A deploy failed — prod-web');
  assert.ok(!/[<>]/.test(line), 'no markup reaches a plain description');
});

test('an entry the host stripped says so, instead of showing a blank', () => {
  /* The host removes what was actually said from every entry before it leaves the server, leaving
     only its length. The old view drew the missing text as an empty bubble. */
  const c = E.classify(at('2026-09-01T10:00:00Z', 'ai-chat', { role: 'user', textChars: 23, redacted: ['text'], sessionId: 's1' }));
  assert.equal(c.subject, '', 'there is nothing to show, and nothing is shown');
  assert.equal(c.redacted, 'The message is not kept in the trail');
  assert.deepEqual(c.facts.map((f) => `${f.label} ${f.value}`), ['Characters 23']);
  assert.ok(!c.facts.some((f) => /redacted/i.test(f.label)), 'the bookkeeping field is not a fact');

  assert.equal(E.redactionNote({ redacted: ['text', 'reply'] }), 'The message and the reply are not kept in the trail');
  assert.equal(E.redactionNote({ action: 'approve' }), '', 'an entry that kept everything says nothing');
  assert.equal(E.classify(at('2026-09-01T10:00:00Z', 'approve', { rule: 'r', table: 't' })).redacted, '');
});
