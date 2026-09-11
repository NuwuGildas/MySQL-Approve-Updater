'use strict';
/* The terminal viewer socket: an unknown session id is refused outright instead
   of quietly becoming a brand new shell on the box, and the upgrade serves
   nothing but this module's own path, only from loopback.

   Moved with the code it tests, out of the base application's test suite. */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { createTerminalViewer, attachTerminalUpgrade, REFUSED_CODE } = require('../backend/terminal-ws');
const { fakeTerminals } = require('./helpers');

/* ---------- 1. the upgrade refuses an id it does not know ---------- */

test('an unknown or missing terminal id is refused at upgrade, never given a new shell', async (t) => {
  const state = { live: new Map(), ran: [], typed: [], subs: {} };
  const terminals = fakeTerminals(state);
  const known = await terminals.open('p1');
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', createTerminalViewer(terminals));
  const server = http.createServer((req, res) => res.end('ok'));
  attachTerminalUpgrade(server, { wss, terminals });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  t.after(() => { server.close(); wss.close(); });

  const dial = (query) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ssh-term${query}`);
    const seen = [];
    ws.on('message', (raw, isBinary) => seen.push(isBinary ? { binary: raw.toString('utf8') } : JSON.parse(raw.toString('utf8'))));
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString(), seen }));
    ws.on('error', () => {});
  });

  for (const query of ['?sessionId=session-does-not-exist', '?sessionId=', '']) {
    const out = await dial(query);
    assert.equal(out.code, REFUSED_CODE, query);
    assert.equal(out.seen[0].type, 'error');
    assert.equal(out.seen[0].code, 'unknown-terminal-session');
    assert.match(out.seen[0].message, /terminal session/i);
  }
  // no shell was created for any refusal: only the one session that existed before
  assert.equal(state.live.size, 1);

  const good = new WebSocket(`ws://127.0.0.1:${port}/api/ssh-term?sessionId=${known.sessionId}`);
  const first = await new Promise((resolve) => { good.on('message', (raw, isBinary) => resolve(isBinary ? 'output' : JSON.parse(raw.toString('utf8')))); });
  assert.equal(first, 'output'); // the replay of what is already on screen
  good.close();
});

test('the upgrade serves nothing but the terminal path, and nothing from off-box', async (t) => {
  const state = { live: new Map(), ran: [], typed: [], subs: {} };
  const terminals = fakeTerminals(state);
  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer((req, res) => res.end('ok'));
  let allowLocal = true;
  attachTerminalUpgrade(server, { wss, terminals, local: () => allowLocal });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  t.after(() => { server.close(); wss.close(); });
  const dies = (url) => new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.on('error', () => resolve('error'));
    ws.on('open', () => { ws.close(); resolve('open'); });
  });
  assert.equal(await dies(`ws://127.0.0.1:${port}/api/other`), 'error');
  allowLocal = false;
  assert.equal(await dies(`ws://127.0.0.1:${port}/api/ssh-term?sessionId=x`), 'error');
});
