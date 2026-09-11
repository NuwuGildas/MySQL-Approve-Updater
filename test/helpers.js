'use strict';
/* A shared shell that answers like the real one without touching a server. */

function fakeTerminals(state) {
  const { live, ran } = state;
  let counter = 0;
  return {
    async open(profileId) {
      const s = { sessionId: `session-${++counter}`, profileId, status: 'open', control: 'user', revision: 0, output: 'shell ready\n', cursor: 12, busy: false };
      live.set(s.sessionId, s); return { ...s };
    },
    snapshot(id, { cursor = 0 } = {}) {
      if (!live.has(id)) throw httpError(404, 'Terminal not found');
      const s = live.get(id); return { ...s, output: s.output.slice(cursor) };
    },
    get: (id) => live.get(id),
    subscribe: (id, fn) => { (state.subs[id] ||= []).push(fn); return () => {}; },
    resize() {},
    writeUser(id, data) { state.typed.push({ id, data }); return { ...live.get(id) }; },
    async sendCommand(id, cmd, { expectedRevision }) {
      const s = live.get(id);
      if (s.revision !== expectedRevision) throw httpError(409, 'Terminal moved on');
      if (state.commandFails) throw httpError(500, 'shell write failed');
      s.revision++; ran.push({ id, cmd });
      await new Promise((r) => setImmediate(r));
      return { stdout: `output of ${cmd}\n`, stderr: '', code: 0, revision: s.revision };
    },
    async setControl(id, control) { const s = live.get(id); s.control = control; s.revision++; return { ...s }; },
    close(id) { const s = live.get(id); s.status = 'closed'; s.revision++; return { ...s }; },
    sessions: live,
  };
}

/* A scripted model. Each entry is the raw text of one model step, in order. */

module.exports = { fakeTerminals };
