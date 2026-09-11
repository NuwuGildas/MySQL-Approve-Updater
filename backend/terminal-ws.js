'use strict';
/* WebSocket side of a shared terminal: a live view of ONE existing session, plus the upgrade guard
   that decides whether a socket may become such a view at all.
   An unknown or stale session id is refused outright. The previous behaviour fell through to a
   legacy per-socket PTY, so a viewer reconnecting to a session that had ended silently opened a
   brand new, unrelated shell on the box - the one thing a shared-terminal model must never do. */

const REFUSED_CODE = 4404; // WebSocket close code: the named terminal session does not exist (any more)
const TERMINAL_PATH = '/api/ssh-term';

const isLoopback = (req) => {
  const remote = req.socket?.remoteAddress || '';
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
};

function refuse(ws, sessionId) {
  const message = sessionId
    ? 'That terminal session no longer exists. Open a new terminal session for this server.'
    : 'No terminal session was named in the request.';
  try { ws.send(JSON.stringify({ type: 'error', code: 'unknown-terminal-session', sessionId: sessionId || null, message })); } catch {}
  try { ws.close(REFUSED_CODE, 'unknown terminal session'); } catch {}
}

/* Replay what is already on screen, then stream. Several viewers may watch the same session and
   closing a view never touches the shell. Output goes out as binary frames (straight into xterm),
   session state as JSON; keystrokes come back as binary, resizes as JSON. */
function createTerminalViewer(terminals) {
  return function onConnection(ws, req) {
    const url = new URL(req.url, 'http://localhost');
    const sessionId = url.searchParams.get('sessionId') || '';
    const sendJson = (msg) => { try { ws.send(JSON.stringify(msg)); } catch {} };
    const sendOut = (text) => { try { ws.send(Buffer.from(text, 'utf8')); } catch {} };
    const sessionMsg = (view) => ({ type: 'session', ...view, sessionId });
    let unsubscribe = null;
    // Re-checked here as well as at upgrade: the session can end between the handshake and this tick.
    if (!sessionId || !terminals.get(sessionId)) return void refuse(ws, sessionId);
    try {
      const cols = Number(url.searchParams.get('cols')), rows = Number(url.searchParams.get('rows'));
      if (Number.isFinite(cols) && Number.isFinite(rows)) { try { terminals.resize(sessionId, cols, rows); } catch {} }
      const snap = terminals.snapshot(sessionId, { cursor: 0 });
      const { output, ...view } = snap;
      if (output) sendOut(output);
      sendJson(sessionMsg(view));
      unsubscribe = terminals.subscribe(sessionId, (event) => {
        if (event.type === 'output') sendOut(event.data);
        else { const { output: _skip, data: _d, type, ...rest } = event; sendJson(sessionMsg({ ...rest, status: type === 'closed' ? 'closed' : rest.status })); }
      });
    } catch (e) { sendJson({ type: 'error', code: 'terminal-error', message: e.message }); ws.close(); return; }
    ws.on('message', (raw, isBinary) => {
      try {
        if (isBinary) return void terminals.writeUser(sessionId, raw.toString('utf8'));
        const m = JSON.parse(raw.toString('utf8'));
        if (m.type === 'resize') terminals.resize(sessionId, m.cols, m.rows);
        else if (m.type === 'input') terminals.writeUser(sessionId, String(m.data ?? ''));
      } catch (e) { sendJson({ type: 'error', code: 'terminal-error', message: e.message }); }
    });
    ws.on('close', () => { try { unsubscribe?.(); } catch {} });
  };
}

/* Upgrade only our terminal path, only from loopback (the whole app is localhost-only), and only
   for a terminal id that names a live shared session. There is no other terminal transport. */
function attachTerminalUpgrade(server, { wss, terminals, local = isLoopback, path = TERMINAL_PATH, enabled = () => true }) {
  server.on('upgrade', (req, socket, head) => {
    if (!local(req) || !enabled()) return void socket.destroy();
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return void socket.destroy(); }
    if (url.pathname !== path) return void socket.destroy();
    const sessionId = url.searchParams.get('sessionId') || '';
    const known = !!sessionId && !!terminals.get(sessionId);
    // The handshake completes even for a refusal so the browser gets a readable reason and close
    // code rather than an opaque failed upgrade.
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!known) return void refuse(ws, sessionId);
      wss.emit('connection', ws, req);
    });
  });
  return server;
}

module.exports = { createTerminalViewer, attachTerminalUpgrade, REFUSED_CODE, TERMINAL_PATH };
