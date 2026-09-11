'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createTerminalSessions } = require('../backend/terminal');
const { createTestHost } = require('./host-fixture');
const { boundText, boundTerminalView, DEFAULTS } = require('../backend/model-output');

const LONE_SURROGATE = /[\uD800-\uDFFF]/;
const lonely = (text) => LONE_SURROGATE.test(text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''));

/* The real terminal registry behind the real assistant tools, so cursor bookkeeping is exercised
   end to end. The shell is the fake from test/ssh-terminal.test.js, with a settable reply. */
function setup(t, { limits = {}, modelLimits = {}, aiAssist = {} } = {}) {
  const shells = [];
  const profiles = { p1: { id: 'p1', name: 'STAGING', ssh: { enabled: true, host: 'staging.local', user: 'dev', port: 22 } } };
  const state = { reply: 'ok\r\n' };
  class Shell extends EventEmitter {
    constructor() { super(); this.stderr = new EventEmitter(); this.writes = []; }
    write(data) {
      this.writes.push(data);
      const token = /\\036([a-f0-9]{48}):%s\\037\\n/.exec(data)?.[1];
      if (!token) return true;
      const line = data.trimStart(); // a sacrificial leading space protects the first byte
      const evalAt = line.indexOf('eval ');
      if (evalAt < 0) { // no eval: this is the probe marker, sent after the interrupt settled
        setImmediate(() => this.emit('data', Buffer.from(`\x1e${token}:0\x1f\r\n$ `)));
        return true;
      }
      const quoted = line.slice(evalAt + 5, line.indexOf('; printf ', evalAt));
      this.lastCommand = quoted.slice(1, -1).replace(/'\\''/g, "'");
      setImmediate(() => {
        this.emit('data', Buffer.from(`\x1e${token}:S\x1f`)); // begin marker: the echo stops here
        this.emit('data', Buffer.from(state.reply));
        this.emit('data', Buffer.from(`\x1e${token}:${state.code ?? 0}\x1f`));
        this.emit('data', Buffer.from('\r\n$ '));
      });
      return true;
    }
    setWindow() {}
    close() { this.emit('close'); }
  }
  const terminals = createTerminalSessions({
    profileById: (id) => profiles[id],
    sshClientFor: async () => {
      const client = new EventEmitter();
      client.shell = (dimensions, done) => { const shell = new Shell(); shells.push(shell); done(null, shell); };
      return client;
    },
    ...limits,
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-bounds-'));
  const settings = { aiAssist: { sshRead: true, sshWrite: true, sshDestructive: true, sshMemory: true, ...aiAssist } };
  const fixture = createTestHost({ dataDir: dir, terminals, settings, profiles, modelLimits });
  t.after(async () => { await fixture.flush(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { api: fixture.agent, agent: { tools: fixture.agent.tools, proposals: fixture.proposals, kinds: {} }, fixture, terminals, shells, state };
}

const lines = (count, tag = 'x') => Array.from({ length: count }, (_, i) => `line ${i} ${tag.repeat(40)}`).join('\r\n') + '\r\n';

async function attach(api) {
  const s = await api.attach('p1');
  return s.sessionId;
}
const read = (api, agent, id, input) => agent.tools.ssh_terminal_read.run(input, { sessionId: id });

test('a long read keeps the tail, so an error at the very end still reaches the model', async (t) => {
  const { api, agent, shells } = setup(t);
  const id = await attach(api);
  shells[0].emit('data', Buffer.from(lines(4000)));
  shells[0].emit('data', Buffer.from('FATAL: nginx failed to start\r\n$ '));

  const view = await read(api, agent, id, {});
  assert.ok(view.output.includes('FATAL: nginx failed to start'), 'the end of the output is what survives');
  assert.ok(view.output.length <= DEFAULTS.terminalRead, `bounded before serialisation, got ${view.output.length}`);
  assert.ok(view.dropped > 100000, 'the payload says how much was dropped');
  assert.equal(view.truncated, true);
  assert.match(view.note, /read again from that cursor/);

  // The global net in the server tool loop must not undo the tool's work: it keeps the tail too.
  const serialised = boundText(JSON.stringify(view), { max: 12000, head: 2000 });
  assert.equal(serialised.dropped, 0, 'a bounded tool result already fits the loop ceiling');
  assert.ok(boundText(JSON.stringify({ ...view, output: lines(4000) + 'FATAL at the end' }), { max: 12000, head: 2000 })
    .text.includes('FATAL at the end'), 'even an unbounded result keeps its tail at the ceiling');
});

test('bounded cursor metadata describes what was returned and a follow-up read is contiguous', async (t) => {
  const { api, agent, terminals, shells } = setup(t);
  const id = await attach(api);
  shells[0].emit('data', Buffer.from(lines(4000)));
  shells[0].emit('data', Buffer.from('tail marker\r\n'));

  const first = await read(api, agent, id, {});
  assert.equal(first.baseCursor, first.cursor - first.output.length, 'baseCursor points at the first character returned');
  assert.equal(first.cursor, terminals.snapshot(id).cursor, 'cursor is still the resume point');
  // What we claimed to return is exactly what the terminal holds for that window: no invented bytes.
  assert.equal(terminals.snapshot(id, { cursor: first.baseCursor }).output, first.output);

  shells[0].emit('data', Buffer.from('after the read\r\n'));
  const second = await read(api, agent, id, { cursor: first.cursor });
  assert.equal(second.output, 'after the read\r\n', 'resuming from the returned cursor skips nothing and repeats nothing');
  assert.equal(second.baseCursor, first.cursor);
  assert.equal(second.dropped, undefined);
  assert.equal(terminals.snapshot(id, { cursor: first.baseCursor }).output, first.output + second.output);
});

test('bounding never splits a multi-byte character or an escape sequence', async (t) => {
  // An odd cap against a run of surrogate pairs forces the cut to land inside a character.
  const { api, agent, shells } = setup(t, { modelLimits: { terminalRead: 5001 } });
  const id = await attach(api);
  shells[0].emit('data', Buffer.from('\x1b[32mstart\x1b[0m' + '🚀'.repeat(10000)));

  const view = await read(api, agent, id, {});
  assert.ok(view.output.length <= 5001 + 24, 'still bounded');
  assert.ok(!lonely(view.output), 'no half of a surrogate pair survives the cut');
  assert.equal(view.output.length % 2, 0, 'the tail begins on a whole character');

  // Cutting straight through "ESC [ 3 1 m" must not leave "[31m" behind as if it were text.
  const bounded = boundText('a'.repeat(50) + '\x1b[31m' + 'b'.repeat(50), { max: 52 });
  assert.ok(bounded.text.includes('\x1b[31m'), 'the sequence is kept whole');
  assert.ok(!/(^|[^\x1b])\[31m/.test(bounded.text), 'no orphaned escape body is left as text');
  assert.ok(!lonely(boundText('x' + '🚀'.repeat(20), { max: 11 }).text));
  assert.ok(!lonely(boundText('🚀'.repeat(20) + 'x', { max: 11, head: 5 }).text));
});

test('the viewer replay is independent of the model-facing cap', async (t) => {
  const { api, agent, terminals, shells } = setup(t, { limits: { outputMax: 200000 }, modelLimits: { terminalRead: 500 } });
  const id = await attach(api);
  const body = lines(2000, 'v');
  shells[0].emit('data', Buffer.from(body));

  const viewer = terminals.snapshot(id);
  assert.ok(viewer.output.length > 90000, 'the replay buffer keeps its own, much larger budget');
  assert.ok(viewer.output.includes('line 0 '), 'a reconnecting viewer still gets the start of the session');
  assert.equal(viewer.truncated, false);
  assert.equal(viewer.baseCursor, 0);

  const model = await read(api, agent, id, {});
  assert.ok(model.output.length <= 500);
  assert.ok(!model.output.includes('line 0 '));
  // Reading for the model changed nothing about what the viewer sees.
  assert.deepEqual(terminals.snapshot(id), viewer);
});

test('an approved command with a huge stdout keeps its tail and reports what was dropped', async (t) => {
  const { api, agent, terminals, state, shells } = setup(t);
  const id = await attach(api);
  state.reply = 'HEAD-MARK header row\r\n' + lines(800, 'o') + 'ERR: permission denied\r\n';
  await terminals.setControl(id, 'assistant');

  const proposal = await agent.tools.ssh_exec.run({ cmd: 'cat /var/log/big.log', why: 'inspect' }, { sessionId: id });
  const pending = agent.proposals.find((p) => p.id === proposal.proposalId);
  const result = await api.approve(pending);

  assert.ok(result.stdout.endsWith('ERR: permission denied\r\n'), 'the failure at the end survives');
  assert.ok(result.stdout.startsWith('HEAD-MARK header row'), 'a small head survives too');
  assert.ok(result.stdout.length <= DEFAULTS.stdout + 100, `bounded stdout, got ${result.stdout.length}`);
  assert.ok(result.dropped.stdout > 30000, 'the payload says how much was dropped');
  assert.match(result.stdout, /characters dropped to fit/);
  assert.equal(result.dropped.stderr, 0);
  assert.equal(result.captureTruncated, undefined);
  assert.equal(result.exitCode, 0);
  assert.ok(shells[0].lastCommand.startsWith('cat /var/log/big.log'));
});

test('a command whose capture already overflowed says so alongside the model bound', async (t) => {
  const { api, agent, terminals, state } = setup(t, { limits: { captureMax: 20000 } });
  const id = await attach(api);
  state.reply = lines(800, 'c') + 'LAST LINE\r\n';
  await terminals.setControl(id, 'assistant');

  const proposal = await agent.tools.ssh_exec.run({ cmd: 'cat /var/log/big.log' }, { sessionId: id });
  const pending = agent.proposals.find((p) => p.id === proposal.proposalId);
  const result = await api.approve(pending);

  assert.equal(result.captureTruncated, true, 'the terminal capture cap is reported, not hidden');
  assert.ok(result.stdout.endsWith('LAST LINE\r\n'));
  assert.ok(result.dropped.stdout > 0);
});

test('short output passes through, with baseCursor still marking the first character returned', () => {
  assert.deepEqual(boundText('all of it', { max: 6000, head: 800 }), { text: 'all of it', dropped: 0 });
  assert.deepEqual(boundText('', { max: 10 }), { text: '', dropped: 0 });
  // The viewer's baseCursor is the oldest cursor the buffer can serve; the model's is where its
  // own window starts, so the two differ as soon as a cursor was passed.
  const view = { output: 'short', cursor: 500, baseCursor: 0, truncated: false, status: 'open' };
  assert.deepEqual(boundTerminalView(view, { max: 6000 }),
    { output: 'short', cursor: 500, baseCursor: 495, truncated: false, status: 'open' });
});
