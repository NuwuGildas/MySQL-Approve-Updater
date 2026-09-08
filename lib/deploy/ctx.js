'use strict';
/* Validates the context object server.js hands to the deploy module.
   Every helper the module relies on is listed here so a refactor of
   server.js fails loudly at startup instead of deep inside a deploy. */

const REQUIRED = {
  app: 'object', DATA_DIR: 'string', ROOT: 'string', IS_PACKAGED: 'boolean',
  httpError: 'function', wrap: 'function',
  audit: 'function', logEvent: 'function', sseBroadcast: 'function',
  connStore: 'object', profileById: 'function', sshConnectOptions: 'function', sshClientFor: 'function',
  sshSessions: 'object', settings: 'object', saveConnections: 'function',
};
const REQUIRED_AGENT = { isConnected: 'function', run: 'function', tools: 'object', proposals: 'object', kinds: 'object', chatNote: 'function' };

function validateCtx(ctx) {
  if (!ctx || typeof ctx !== 'object') throw new Error('deploy: ctx must be an object');
  for (const [k, t] of Object.entries(REQUIRED)) {
    const ok = k === 'app' ? (typeof ctx.app === 'function' || typeof ctx.app === 'object') && ctx.app && typeof ctx.app.use === 'function' : typeof ctx[k] === t && ctx[k] !== null;
    if (!ok) throw new Error(`deploy: ctx.${k} must be a ${k === 'app' ? 'n express app' : t}`);
  }
  if (!ctx.agent || typeof ctx.agent !== 'object') throw new Error('deploy: ctx.agent must be an object');
  for (const [k, t] of Object.entries(REQUIRED_AGENT)) {
    if (typeof ctx.agent[k] !== t || ctx.agent[k] === null) throw new Error(`deploy: ctx.agent.${k} must be a ${t}`);
  }
  return ctx;
}

module.exports = { validateCtx };
