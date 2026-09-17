'use strict';
// Server-backed application preferences. localStorage is only a startup cache
// and the source of the one-time import; no global browser APIs are patched.
window.AppPreferences = (() => {
  let values = {}, pending = {}, flushing = null, ready = false;
  const valid = (key) => /^(st-|mau-|servertools-)[A-Za-z0-9_.:-]{1,180}$/.test(key);
  const cache = (key, value) => { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch {} };
  async function request(method, body) {
    const response = await fetch('/api/browser-state', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Preferences could not be saved');
    return result.values;
  }
  async function initialize() {
    const legacy = {};
    try { for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); if (valid(key)) legacy[key] = localStorage.getItem(key); } } catch {}
    values = await request('POST', { changes: legacy });
    for (const [key, value] of Object.entries(values)) cache(key, value);
    ready = true;
  }
  function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      while (Object.keys(pending).length) {
        const changes = pending;
        pending = {};
        try { await request('PUT', { changes }); }
        catch (error) { pending = { ...changes, ...pending }; throw error; }
      }
    })().finally(() => { flushing = null; });
    return flushing;
  }
  function save(key, value) {
    if (!ready || !valid(key)) throw new Error('Preferences are not ready or the key is invalid');
    values[key] = value; pending[key] = value; cache(key, value);
    flush().catch((error) => {
      if (typeof window.toast === 'function') window.toast(error.message + '. Keep this page open and retry after restoring storage.', 'error');
      else console.error(error.message);
    });
  }
  window.addEventListener('beforeunload', (event) => {
    if (flushing || Object.keys(pending).length) { event.preventDefault(); event.returnValue = ''; }
  });
  window.addEventListener('online', () => { flush().catch(() => {}); });
  return { initialize, flush, getItem: (key) => values[key] ?? null, setItem: (key, value) => save(key, String(value)), removeItem: (key) => save(key, null) };
})();
