'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createTerminalSessions } = require('../lib/ssh-terminal');

function setup(options = {}) {
  const shells = [], clients = [], audits = [];
  const profiles = new Map(['one', 'two'].map((id) => [id, { id, name: id, ssh: { enabled: true, host: `${id}.test`, user: 'test' } }]));
  let connections = 0;
  class Shell extends EventEmitter {
    constructor() { super(); this.stderr = new EventEmitter(); this.writes = []; this.cwd = '/home/test'; this.env = {}; }
    write(data) {
      this.writes.push(data);
      const token = /\\036([a-f0-9]{48}):%s\\037\\n/.exec(data)?.[1];
      if (!token) return true;
      const line = data.trimStart(); // a sacrificial leading space protects the first byte
      const evalAt = line.indexOf('eval ');
      if (evalAt < 0) { // no eval: this is the probe marker, sent after the interrupt settled
        if (options.probe !== false) setImmediate(() => this.emit('data', Buffer.from(`\x1e${token}:0\x1f\r\n$ `)));
        return true;
      }
      const quoted = line.slice(evalAt + 5, line.indexOf('; printf ', evalAt));
      const command = quoted.slice(1, -1).replace(/'\\''/g, "'");
      this.lastCommand = command;
      if (options.reply === false) return true;
      setImmediate(() => {
        this.emit('data', Buffer.from(`\x1e${token}:S\x1f`)); // begin marker: everything before it was echo
        let text = 'ok\r\n', code = 0;
        if (command.startsWith('cd ')) { this.cwd = command.slice(3); text = ''; }
        if (command === 'pwd') text = this.cwd + '\r\n';
        if (command.startsWith('export GREETING=')) { this.env.GREETING = command.slice(16); text = ''; }
        if (command === 'printf "$GREETING"') text = this.env.GREETING || '';
        if (command === 'false') { text = ''; code = 1; }
        if (options.reply) text = options.reply;
        this.emit('data', Buffer.from(text));
        const marker = `\x1e${token}:${code}\x1f`;
        // Completion must work across arbitrary SSH packet boundaries.
        this.emit('data', Buffer.from(marker.slice(0, 12)));
        this.emit('data', Buffer.from(marker.slice(12)));
        this.emit('data', Buffer.from('\r\n$ '));
      });
      return true;
    }
    setWindow(rows, cols) { this.window = { rows, cols }; }
    close() { this.closed = true; this.emit('close'); }
  }
  const pool = new Map();
  const api = createTerminalSessions({
    profileById: (id) => profiles.get(id), sshSessions: pool,
    sshClientFor: async () => {
      connections++;
      const client = new EventEmitter();
      client.shell = (dimensions, done) => {
        const shell = new Shell(); shell.dimensions = dimensions;
        shells.push(shell); done(null, shell);
      };
      clients.push(client);
      return client;
    },
    audit: (event) => audits.push(event), probeTimeoutMs: 100,
    ...options.limits,
  });
  return { api, shells, clients, audits, pool, connections: () => connections };
}

test('a shared terminal survives viewer detach and replays output without opening another shell', async () => {
  const { api, shells, connections } = setup();
  const first = await api.open('one', { cols: 120, rows: 40 });
  const events = [];
  const off = api.subscribe(first.sessionId, (event) => events.push(event));
  shells[0].emit('data', Buffer.from('before\n'));
  const cursor = api.snapshot(first.sessionId).cursor;
  off();
  shells[0].emit('data', Buffer.from('after\n'));
  const resumed = await api.open('one', { sessionId: first.sessionId });
  assert.equal(resumed.output, 'before\nafter\n');
  assert.equal(api.snapshot(first.sessionId, { cursor }).output, 'after\n');
  assert.equal(events.filter((event) => event.type === 'output').length, 1);
  assert.equal(shells.length, 1);
  assert.equal(connections(), 1);
  assert.equal(shells[0].dimensions.term, 'xterm-256color');
  api.resize(first.sessionId, 90, 20);
  assert.deepEqual(shells[0].window, { cols: 90, rows: 20 });
});

test('distinct terminal sessions have separate output and never attach to another server', async () => {
  const { api, shells, connections } = setup();
  const [a, b, c] = await Promise.all([api.open('one'), api.open('one'), api.open('two')]);
  assert.equal(new Set([a.sessionId, b.sessionId, c.sessionId]).size, 3);
  shells[0].emit('data', Buffer.from('private to terminal A'));
  assert.equal(api.snapshot(a.sessionId).output, 'private to terminal A');
  assert.equal(api.snapshot(b.sessionId).output, '');
  assert.equal(api.snapshot(c.sessionId).output, '');
  assert.equal(connections(), 2);
  await assert.rejects(api.open('two', { sessionId: a.sessionId }), { status: 404 });
  await assert.rejects(api.open('one', { sessionId: 'unknown' }), { status: 404 });
  await assert.rejects(api.open('missing'), { status: 400 });
});

test('AI commands use the handed-off persistent shell and preserve cwd and exported variables', async () => {
  const { api, shells } = setup();
  const { sessionId } = await api.open('one');
  await assert.rejects(api.sendCommand(sessionId, 'pwd', { expectedRevision: api.snapshot(sessionId).revision }), { status: 409 });
  api.writeUser(sessionId, 'a partial command');
  const handoff = await api.setControl(sessionId, 'assistant');
  assert.equal(handoff.control, 'assistant');
  assert.equal(shells[0].writes[1], '\x03\x15'); // the interrupt goes first, on its own
  assert.ok(shells[0].writes[2].startsWith(' printf '), 'the marker follows the interrupt, behind a sacrificial space');
  const run = (command) => api.sendCommand(sessionId, command, { expectedRevision: api.snapshot(sessionId).revision });
  await run('cd /var/www/app');
  assert.equal((await run('pwd')).stdout, '/var/www/app\r\n');
  await run('export GREETING=hello');
  assert.equal((await run('printf "$GREETING"')).stdout, 'hello');
  assert.equal((await run('false')).code, 1);
  assert.equal(shells.length, 1);
  assert.equal(api.snapshot(sessionId).busy, false);
  assert.ok(!api.snapshot(sessionId).output.includes('\x1e'));
});

test('ownership, busy state, and revision guards prevent stale approvals and interleaved input', async () => {
  const { api, shells } = setup({ reply: false });
  const { sessionId } = await api.open('one');
  await api.setControl(sessionId, 'assistant');
  const approvedRevision = api.snapshot(sessionId).revision;
  await api.setControl(sessionId, 'user');
  api.writeUser(sessionId, 'cd /different\r');
  await api.setControl(sessionId, 'assistant');
  const writeCount = shells[0].writes.length;
  await assert.rejects(api.sendCommand(sessionId, 'touch file', { expectedRevision: approvedRevision }), { status: 409 });
  await assert.rejects(api.sendCommand(sessionId, 'touch file'), { status: 409 });
  assert.equal(shells[0].writes.length, writeCount);
  const current = api.snapshot(sessionId).revision;
  const pending = api.sendCommand(sessionId, 'sleep 99', { expectedRevision: current });
  assert.equal(api.snapshot(sessionId).busy, true);
  assert.throws(() => api.writeUser(sessionId, 'do not inject\r'), { status: 409 });
  await assert.rejects(api.sendCommand(sessionId, 'pwd', { expectedRevision: current }), { status: 409 });
  await api.setControl(sessionId, 'user');
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(result.code, null);
  assert.equal(api.snapshot(sessionId).busy, false);
  assert.equal(api.snapshot(sessionId).control, 'user');
  assert.equal(shells[0].writes.at(-1), '\x03\x15');
  api.writeUser(sessionId, 'pwd\r');
});

test('timeout interrupts the command and requires a fresh explicit assistant handoff', async () => {
  const { api, shells } = setup({ reply: false });
  const { sessionId } = await api.open('one');
  await api.setControl(sessionId, 'assistant');
  const pending = api.sendCommand(sessionId, 'sleep 99', { expectedRevision: api.snapshot(sessionId).revision, timeoutMs: 100 });
  shells[0].emit('data', Buffer.from('progress so far\n'));
  const result = await pending;
  assert.equal(result.stdout, 'progress so far\n');
  assert.equal(result.timedOut, true);
  assert.equal(api.snapshot(sessionId).control, 'user');
  assert.equal(api.snapshot(sessionId).busy, false);
  await assert.rejects(api.sendCommand(sessionId, 'pwd', { expectedRevision: result.revision }), { status: 409 });
});

test('an unresponsive handoff never grants assistant control', async () => {
  const { api } = setup({ probe: false });
  const { sessionId } = await api.open('one');
  await assert.rejects(api.setControl(sessionId, 'assistant'), { status: 409 });
  assert.equal(api.snapshot(sessionId).control, 'user');
  assert.equal(api.snapshot(sessionId).busy, false);
});

test('closing or losing SSH finishes pending operations and never recreates that terminal ID', async () => {
  const { api, clients, pool } = setup({ reply: false });
  const a = await api.open('one');
  const b = await api.open('one');
  await api.setControl(a.sessionId, 'assistant');
  const pending = api.sendCommand(a.sessionId, 'sleep 99', { expectedRevision: api.snapshot(a.sessionId).revision });
  clients[0].emit('error', new Error('network lost'));
  const result = await pending;
  assert.equal(result.closed, true);
  assert.equal(api.snapshot(a.sessionId).status, 'closed');
  assert.equal(api.snapshot(b.sessionId).status, 'closed');
  assert.equal(pool.has('one'), false);
  assert.equal((await api.open('one', { sessionId: a.sessionId })).status, 'closed');
  assert.throws(() => api.writeUser(a.sessionId, 'pwd\r'), { status: 409 });
  await assert.rejects(api.sendCommand(a.sessionId, 'pwd', { expectedRevision: result.revision }), { status: 409 });
  const newTerminal = await api.open('one');
  assert.notEqual(newTerminal.sessionId, a.sessionId);
  api.close(newTerminal.sessionId);
  assert.equal(api.snapshot(newTerminal.sessionId).status, 'closed');
});

test('UTF-8 output spans packets and both replay and command capture are bounded', async () => {
  const { api, shells } = setup({ limits: { outputMax: 1024, captureMax: 1024 }, reply: 'x'.repeat(5000) });
  const { sessionId } = await api.open('one');
  const utf8 = Buffer.from('terminal 🌍 café');
  for (const byte of utf8) shells[0].emit('data', Buffer.from([byte]));
  assert.equal(api.snapshot(sessionId).output, 'terminal 🌍 café');
  await api.setControl(sessionId, 'assistant');
  const result = await api.sendCommand(sessionId, 'cat example', { expectedRevision: api.snapshot(sessionId).revision });
  assert.equal(result.stdout.length, 1024);
  assert.equal(result.truncated, true);
  const view = api.snapshot(sessionId, { cursor: 0 });
  assert.ok(view.output.length <= 1024);
  assert.ok(view.baseCursor > 0);
  assert.equal(view.truncated, true);
  assert.throws(() => api.snapshot(sessionId, { cursor: -1 }), { status: 400 });
  assert.throws(() => api.snapshot(sessionId, { cursor: view.cursor + 1 }), { status: 400 });
});

test('raw terminal controls cannot enter AI commands and open sessions are capped', async () => {
  const { api, shells } = setup({ limits: { maxSessions: 1 } });
  const { sessionId } = await api.open('one');
  await api.setControl(sessionId, 'assistant');
  const writes = shells[0].writes.length;
  for (const command of ['pwd\r', 'pwd\nrm file', '\x03pwd', '\x1b[A', 'x'.repeat(2001), '', 'ls\u0085rm file']) {
    await assert.rejects(api.sendCommand(sessionId, command, { expectedRevision: api.snapshot(sessionId).revision }), { status: 400 });
  }
  assert.equal(shells[0].writes.length, writes);
  await assert.rejects(api.open('two'), { status: 409 });
  api.close(sessionId);
  assert.equal((await api.open('two')).status, 'open');
});

test('a real shell echoes the line it was given; that echo is not reported as command output', async () => {
  // The harness above never echoes. A tty does, marker and all, so the echo must be stripped from stdout
  // while staying visible in the terminal the user is watching.
  const { EventEmitter } = require('node:events');
  const TOKEN = /\x1e([a-f0-9]{48}):/;
  class EchoShell extends EventEmitter {
    constructor() { super(); this.stderr = new EventEmitter(); }
    write(data) {
      const line = data.trimStart();
      const token = /\\036([a-f0-9]{48}):%s\\037/.exec(line)?.[1]; // the shell receives the escapes as text
      if (!token) return true;                                   // the bare interrupt
      const marker = `\x1e${token}:0\x1f`;
      const echo = data.replace(/\r$/, '') + '\r\n';             // the tty echoes what it received
      const isCommand = line.includes('eval ');
      const begin = isCommand ? `\x1e${token}:S\x1f` : '';       // a real shell prints this before the output
      const body = isCommand ? 'hello from the box\r\n' : '';
      setImmediate(() => this.emit('data', Buffer.from(echo + begin + body + marker + '\r\n$ ')));
      return true;
    }
    setWindow() {} close() { this.emit('close'); }
  }
  const api = createTerminalSessions({
    profileById: (id) => ({ id, name: id, ssh: { enabled: true, host: 'echo.test', user: 'test' } }),
    sshClientFor: async () => { const client = new EventEmitter(); client.shell = (dim, done) => done(null, new EchoShell()); return client; },
    probeTimeoutMs: 400,
  });
  const { sessionId } = await api.open('one');
  await api.setControl(sessionId, 'assistant');
  const result = await api.sendCommand(sessionId, 'echo hello', { expectedRevision: api.snapshot(sessionId).revision });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'hello from the box\r\n', 'stdout carries the output only');
  assert.ok(!result.stdout.includes('printf'), 'the echoed marker never reaches the assistant');
  const screen = api.snapshot(sessionId).output;
  assert.ok(screen.includes('echo hello'), 'the user still sees the command on screen');
  assert.ok(!TOKEN.test(screen), 'the marker itself is stripped from the screen');
});
