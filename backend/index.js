'use strict';
/* Activity History - backend.
 *
 * The audit trail itself is host infrastructure: the base application records
 * events whether or not this module is installed, and it keeps recording them
 * after it is removed. This module is the READER - it shapes the timeline the
 * viewer draws and nothing else, so removing it loses no history. */

const MAX_LIMIT = 2000;

async function activate(host) {
  const read = (params) => host.call('audit.read', params);

  return {
    methods: {
      /** The timeline, newest first, optionally narrowed to one session. */
      async list({ limit, sessionId } = {}) {
        const entries = await read({
          limit: Math.min(MAX_LIMIT, Math.max(1, Number(limit) || 500)),
          sessionId: sessionId || null,
        });
        return entries;
      },

      /** The same redacted timeline as a downloadable JSON-lines file. */
      async download({ sessionId } = {}) {
        const { entries } = await read({ sessionId: sessionId || null, raw: true });
        const name = `audit${sessionId ? `-${String(sessionId).replace(/[^A-Za-z0-9_.-]/g, '_')}` : ''}.log`;
        return {
          __raw: true,
          type: 'application/x-ndjson',
          headers: { 'Content-Disposition': `attachment; filename="${name}"` },
          body: entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : ''),
        };
      },
    },

    assistantTools: {
      /* The assistant can read the timeline only while this module is installed;
         the tool is registered by the host on activation and removed on exit. */
      history_search: {
        description: 'Search the recorded activity timeline. Input: {"query":"deploy","limit":30}. Read-only.',
        run: async (input) => {
          const query = String(input?.query || '').toLowerCase();
          const limit = Math.min(100, Math.max(1, Number(input?.limit) || 30));
          const { entries } = await read({ limit: 500 });
          const matched = query ? entries.filter((entry) => JSON.stringify(entry).toLowerCase().includes(query)) : entries;
          return { total: matched.length, entries: matched.slice(0, limit) };
        },
      },
    },

    /* Reading history never blocks removal: there is no work to lose. */
    busy: () => false,
    async deactivate() { host.log('info', 'Activity History stopped'); },
  };
}

module.exports = { activate };
