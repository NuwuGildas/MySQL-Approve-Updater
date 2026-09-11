'use strict';
/* Turning "installed" into "running", in this page, without leaving it.
 *
 * A module's frontend is an ES module fetched with dynamic import(). The URL
 * carries the activation id the installer produced, so a reinstalled module is
 * a different URL and therefore a freshly evaluated module - the browser's
 * module cache can never hand back the previous copy. Evaluated code from an
 * older copy may still exist in that cache, which is exactly why removal is
 * driven by the host's disposables and not by dropping a script tag. */

window.ModuleLoader = (() => {
  const active = new Map();          // id → { scope, instance, entryUrl }
  const failures = new Map();        // id → message
  const inflight = new Map();

  const listeners = new Set();
  const changed = () => { for (const fn of listeners) { try { fn(); } catch (error) { console.error(error); } } };

  async function activate(descriptor) {
    if (active.has(descriptor.id)) return active.get(descriptor.id);
    if (inflight.has(descriptor.id)) return inflight.get(descriptor.id);
    const run = (async () => {
      failures.delete(descriptor.id);
      const scope = HostSDK.createScope(descriptor);
      let instance;
      try {
        const namespace = await import(/* webpackIgnore: true */ descriptor.entryUrl);
        const activateFn = namespace.activate || namespace.default?.activate;
        if (typeof activateFn !== 'function') throw new Error('the module does not export activate(host)');
        instance = { namespace, deactivate: namespace.deactivate || namespace.default?.deactivate || null };
        await activateFn(scope);
      } catch (error) {
        // A module that fails to start must leave nothing behind and must not
        // take the page with it.
        await scope.dispose().catch(() => {});
        failures.set(descriptor.id, error.message || String(error));
        changed();
        throw error;
      }
      const entry = { scope, instance, entryUrl: descriptor.entryUrl, id: descriptor.id };
      active.set(descriptor.id, entry);
      changed();
      return entry;
    })();
    inflight.set(descriptor.id, run);
    try { return await run; } finally { inflight.delete(descriptor.id); }
  }

  async function deactivate(id) {
    const entry = active.get(id);
    if (!entry) return false;
    active.delete(id);
    try { if (typeof entry.instance.deactivate === 'function') await entry.instance.deactivate(); }
    catch (error) { console.error(`${id}: deactivate() failed`, error); }
    await entry.scope.dispose();
    changed();
    return true;
  }

  /**
   * Reconcile what is running in this tab with what the server says is
   * installed. Called at startup, after every install/remove in this tab, and
   * when another tab changes something (the host announces it over SSE).
   */
  async function sync(snapshot, { onError = () => {} } = {}) {
    HostSDK.setSnapshot(snapshot);
    const shouldRun = new Map(
      snapshot.modules.filter((m) => m.installed && m.hasFrontend && m.entryUrl && m.status === 'active').map((m) => [m.id, m]),
    );
    for (const id of [...active.keys()]) {
      const wanted = shouldRun.get(id);
      if (!wanted || wanted.entryUrl !== active.get(id).entryUrl) await deactivate(id);
    }
    // Dependencies first, so a module can consume() what it declared.
    const ordered = [...shouldRun.values()].sort((a, b) => (a.dependencies?.length || 0) - (b.dependencies?.length || 0));
    for (const descriptor of ordered) {
      if (active.has(descriptor.id)) continue;
      try { await activate(descriptor); }
      catch (error) { onError(descriptor, error); }
    }
    changed();
  }

  return {
    activate, deactivate, sync,
    running: () => [...active.keys()],
    isRunning: (id) => active.has(id),
    failure: (id) => failures.get(id) || null,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
})();
