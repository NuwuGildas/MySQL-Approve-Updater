'use strict';
/* Activity History is a READER. The audit trail belongs to the host and is
   written whether or not this module is installed, so every test here goes
   through a fake host whose only job is to hand back recorded entries. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { activate } = require('../backend/index');

const entry = (i, action = 'deploy') => ({ ts: `2026-01-0${(i % 9) + 1}T00:00:0${i % 10}Z`, action, sessionId: i % 2 ? 'session-a' : 'session-b', detail: `event ${i}` });

/** A host that records what audit.read was asked for and answers with entries. */
function createTestHost({ entries = [] } = {}) {
  const reads = [];
  const logs = [];
  return {
    reads,
    logs,
    host: {
      id: 'history',
      version: '1.0.0',
      log: (level, message) => logs.push({ level, message }),
      emit() {},
      async call(method, params = {}) {
        if (method !== 'audit.read') throw new Error(`the module made an undeclared host call: ${method}`);
        reads.push(params);
        const narrowed = params.sessionId ? entries.filter((e) => e.sessionId === params.sessionId) : entries;
        return { entries: narrowed.slice(0, params.limit || narrowed.length), total: narrowed.length };
      },
    },
  };
}

async function setup(t, options) {
  const fixture = createTestHost(options);
  const instance = await activate(fixture.host);
  t.after(() => instance.deactivate());
  return { ...fixture, instance, api: instance.methods };
}

test('the timeline is read from the host, newest first, with a bounded limit', async (t) => {
  const entries = Array.from({ length: 50 }, (_, i) => entry(i));
  const ctx = await setup(t, { entries });

  await ctx.api.list();
  assert.deepEqual(ctx.reads.at(-1), { limit: 500, sessionId: null }, 'a request with no limit asks for a sensible page');

  await ctx.api.list({ limit: 10 });
  assert.equal(ctx.reads.at(-1).limit, 10);

  /* A limit this module would not survive rendering is clamped, not passed on. */
  await ctx.api.list({ limit: 100000 });
  assert.equal(ctx.reads.at(-1).limit, 2000);
  await ctx.api.list({ limit: 0 });
  assert.equal(ctx.reads.at(-1).limit, 500);
  await ctx.api.list({ limit: -5 });
  assert.equal(ctx.reads.at(-1).limit, 1);
  await ctx.api.list({ limit: 'nonsense' });
  assert.equal(ctx.reads.at(-1).limit, 500);
});

test('one session can be singled out, and the module never invents entries of its own', async (t) => {
  const entries = Array.from({ length: 6 }, (_, i) => entry(i));
  const ctx = await setup(t, { entries });

  const narrowed = await ctx.api.list({ sessionId: 'session-a' });
  assert.equal(ctx.reads.at(-1).sessionId, 'session-a');
  assert.equal(narrowed.entries.length, 3);
  assert.equal(narrowed.entries.every((e) => e.sessionId === 'session-a'), true);

  const all = await ctx.api.list();
  assert.equal(all.entries.length, 6);
  assert.deepEqual(all.entries, entries, 'what the host recorded is what is shown');
});

test('the timeline downloads as JSON lines, with a filename that cannot escape', async (t) => {
  const entries = [entry(1), entry(2)];
  const ctx = await setup(t, { entries });

  const plain = await ctx.api.download();
  assert.equal(plain.__raw, true);
  assert.equal(plain.type, 'application/x-ndjson');
  assert.equal(plain.headers['Content-Disposition'], 'attachment; filename="audit.log"');
  assert.deepEqual(plain.body.trimEnd().split('\n').map((line) => JSON.parse(line)), entries);
  assert.equal(plain.body.endsWith('\n'), true);
  assert.equal(ctx.reads.at(-1).raw, true, 'the download asks for the recorded lines, not the rendered ones');

  const named = await ctx.api.download({ sessionId: '../../etc/passwd' });
  assert.equal(named.headers['Content-Disposition'], 'attachment; filename="audit-.._.._etc_passwd.log"');

  const empty = await setup(t, { entries: [] });
  assert.equal((await empty.api.download()).body, '', 'an empty timeline downloads as an empty file, not a stray newline');
});

test('the assistant can search the timeline only while this module is installed', async (t) => {
  const entries = [entry(1, 'deploy'), entry(2, 'connector-add'), entry(3, 'deploy'), entry(4, 'login')];
  const ctx = await setup(t, { entries });
  const tool = ctx.instance.assistantTools.history_search;

  assert.match(tool.description, /Read-only/);
  const found = await tool.run({ query: 'deploy' });
  assert.equal(found.total, 2);
  assert.equal(found.entries.every((e) => e.action === 'deploy'), true);

  const everything = await tool.run({});
  assert.equal(everything.total, 4, 'no query means the whole timeline');

  const capped = await setup(t, { entries: Array.from({ length: 300 }, (_, i) => entry(i)) });
  const many = await capped.instance.assistantTools.history_search.run({ limit: 1000 });
  assert.equal(many.entries.length, 100, 'a tool result is capped so it cannot flood the conversation');
  assert.equal(many.total, 300, 'while still reporting how much there was');
});

test('reading history never blocks removal', async (t) => {
  const ctx = await setup(t);
  assert.equal(ctx.instance.busy(), false);
  await ctx.instance.deactivate();
  assert.match(ctx.logs.at(-1).message, /stopped/);
});
