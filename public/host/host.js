'use strict';
/* The host SDK, browser side.
 *
 * Version 1.0.0. Everything an optional module is allowed to touch is reachable
 * from the object its activate(host) receives, and nothing else: a module never
 * reads a global from app.js, never reaches into another module's state, and
 * never keeps a listener, timer or observer the host cannot take back.
 *
 * Every register* call returns a disposable, every disposable is remembered by
 * the module's scope, and deactivating a module runs all of them. That is what
 * makes "remove, then add again, in the same tab" produce one registration
 * rather than two.
 */

window.HostSDK = (() => {
  const SDK_VERSION = '1.0.0';

  /* ---------------- small registry with ordered entries and disposal ---------------- */
  function createRegistry(kind) {
    const entries = new Map();
    const listeners = new Set();
    const changed = () => { for (const fn of listeners) { try { fn(); } catch (error) { console.error(error); } } };
    return {
      kind,
      add(owner, key, value) {
        if (entries.has(key)) throw new Error(`${kind} "${key}" is already registered by ${entries.get(key).owner}`);
        entries.set(key, { owner, key, value });
        changed();
        return () => { if (entries.get(key)?.owner === owner) { entries.delete(key); changed(); } };
      },
      get: (key) => entries.get(key)?.value || null,
      owner: (key) => entries.get(key)?.owner || null,
      has: (key) => entries.has(key),
      keys: () => [...entries.keys()],
      values: () => [...entries.values()].map((e) => e.value),
      entries: () => [...entries.values()],
      byOwner: (owner) => [...entries.values()].filter((e) => e.owner === owner).map((e) => e.value),
      onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      removeOwner(owner) {
        let removed = 0;
        for (const [key, entry] of entries) if (entry.owner === owner) { entries.delete(key); removed++; }
        if (removed) changed();
        return removed;
      },
    };
  }

  const pages = createRegistry('page');
  const navItems = createRegistry('navigation entry');
  const commands = createRegistry('command');
  const searchSources = createRegistry('search source');
  const settingsSections = createRegistry('settings section');
  const settingsGroups = createRegistry('settings group');
  const proposalRenderers = createRegistry('assistant proposal card');
  const launcherTiles = createRegistry('home launcher tile');
  const tourSteps = createRegistry('guided tour step');
  const apis = createRegistry('module API');

  /* ---------------- host event bus ----------------
     One bus for SSE traffic and for host-emitted lifecycle events. Modules
     subscribe through their scope, so every subscription is disposable. */
  const bus = (() => {
    const handlers = new Map();
    return {
      on(name, fn) {
        if (!handlers.has(name)) handlers.set(name, new Set());
        handlers.get(name).add(fn);
        return () => handlers.get(name)?.delete(fn);
      },
      emit(name, payload) {
        for (const fn of handlers.get(name) || []) { try { fn(payload); } catch (error) { console.error(`host event ${name}:`, error); } }
        for (const fn of handlers.get('*') || []) { try { fn(name, payload); } catch (error) { console.error(error); } }
      },
    };
  })();

  /* ---------------- services the core publishes for modules ----------------
     Core code calls provide() once at startup. A module only sees the members
     its capabilities allow. */
  const core = {};
  const provide = (values) => Object.assign(core, values);

  /* ---------------- installed-module state (server owned) ---------------- */
  let snapshot = { modules: [], hostSdk: SDK_VERSION, capabilities: {} };
  const setSnapshot = (next) => { snapshot = next; bus.emit('modules:state', next); };
  const moduleState = (id) => snapshot.modules.find((m) => m.id === id) || null;
  const isInstalled = (id) => !!moduleState(id)?.installed;

  /* ---------------- one module's scope ---------------- */
  function createScope(descriptor) {
    const id = descriptor.id;
    // The host describes capabilities as {id,label} for the marketplace; the
    // grant check only cares about the ids.
    const capabilities = (descriptor.capabilities || []).map((c) => (typeof c === 'string' ? c : c.id));
    const disposables = [];
    const timers = new Set();
    const intervals = new Set();
    const observers = new Set();
    const containers = new Set();
    const styleNodes = new Set();
    const sockets = new Set();
    let disposed = false;

    const track = (fn) => { disposables.push(fn); return fn; };
    const guard = (capability) => {
      if (!capabilities.includes(capability)) throw new Error(`${id} did not request the "${capability}" capability.`);
    };
    const alive = () => { if (disposed) throw new Error(`${id} has been deactivated.`); };

    /* Module DOM lives in a container the host creates and the host removes.
       No optional module markup sits in index.html waiting to be used. */
    function mountPoint(key = 'root') {
      alive();
      const host = document.getElementById('modulePages') || (() => {
        const el = document.createElement('div');
        el.id = 'modulePages';
        document.body.appendChild(el);
        return el;
      })();
      const existing = host.querySelector(`[data-module="${id}"][data-mount="${key}"]`);
      if (existing) return existing;
      const el = document.createElement('div');
      el.dataset.module = id;
      el.dataset.mount = key;
      el.className = `module-mount module-${id}`;
      el.hidden = true;
      host.appendChild(el);
      containers.add(el);
      return el;
    }

    const scope = {
      id,
      version: descriptor.version,
      sdkVersion: SDK_VERSION,
      capabilities: capabilities.slice(),
      can: (capability) => capabilities.includes(capability),

      /* ---- shared UI helpers. A module uses these instead of app.js globals ---- */
      get ui() { return core.ui; },
      /* ---- the shell: routing and the page a module's view is showing on ---- */
      get shell() { return core.shell; },
      /* ---- the assistant window, which is part of the base application ---- */
      get assistantUi() { return core.assistant; },
      /* ---- the conversation the assistant is addressing right now ----
         Host-owned state: the base app keeps a default project conversation
         with no Servers module installed, and the Servers module points this at
         a terminal session while one is selected. */
      get session() { return core.session; },
      get projects() { return core.projects; },
      /* ---- the core database tool, for modules that extend it ---- */
      get database() { return core.database; },

      /* ---- the host's own REST API (core features only) ---- */
      api: (url, options) => {
        if (!/^\/api\/(state|settings|schema|connections|agent|projects|audit)/.test(url)) throw new Error(`${id} may not call ${url}; use rpc() for module endpoints.`);
        return core.api(url, options);
      },

      /* ---- this module's backend, through the host dispatcher ---- */
      async rpc(method, params, options = {}) {
        alive();
        const init = options.method === 'GET'
          ? undefined
          : { method: options.method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params || {}) };
        const url = options.method === 'GET'
          ? `/api/m/${id}/${method}?${new URLSearchParams(params || {})}`
          : `/api/m/${id}/${method}`;
        const response = await fetch(url, init);
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw Object.assign(new Error(body.error || response.statusText), { code: body.code, status: response.status });
        return body;
      },
      get: (method, params) => scope.rpc(method, params, { method: 'GET' }),

      /* ---- this module's own HTTP surface, proxied by the host ----
         A backend module keeps real routers; the host forwards to them and
         forgets them entirely when the module is removed. */
      async http(path, init) {
        alive();
        const response = await fetch(`/api/m/${id}/http${path.startsWith('/') ? path : '/' + path}`, init && init.body !== undefined && typeof init.body !== 'string'
          ? { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers || {}) }, body: JSON.stringify(init.body) }
          : init);
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw Object.assign(new Error(body.error || response.statusText), { code: body.code, status: response.status });
        return body;
      },

      /* ---- a live stream from this module's worker ---- */
      socket(path, params = {}) {
        alive();
        guard('sockets');
        const url = new URL(`/api/m/${encodeURIComponent(id)}/ws${path.startsWith('/') ? path : '/' + path}`, location.href);
        url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
        const ws = new WebSocket(url);
        sockets.add(ws);
        ws.addEventListener('close', () => sockets.delete(ws));
        return ws;
      },

      /* ---- pages, navigation and the home launcher ---- */
      registerPage(definition) {
        alive(); guard('ui:pages');
        const dispose = pages.add(id, definition.id, { ...definition, moduleId: id, mount: () => mountPoint(definition.id) });
        return track(dispose);
      },
      registerNavItem(definition) { alive(); guard('ui:pages'); return track(navItems.add(id, definition.id, { ...definition, moduleId: id })); },
      registerLauncherTile(definition) { alive(); guard('ui:pages'); return track(launcherTiles.add(id, definition.id, { ...definition, moduleId: id })); },
      /** One step in the guided tour, shown only while this module is installed. */
      registerTourStep(definition) { alive(); guard('ui:pages'); return track(tourSteps.add(id, definition.id, { ...definition, moduleId: id })); },

      /* ---- command palette and search ---- */
      registerCommand(definition) { alive(); guard('ui:commands'); return track(commands.add(id, definition.id, { ...definition, moduleId: id })); },
      registerSearchSource(definition) { alive(); guard('ui:commands'); return track(searchSources.add(id, definition.key, { ...definition, moduleId: id })); },

      /* ---- settings ---- */
      registerSettingsSection(definition) { alive(); guard('ui:settings'); return track(settingsSections.add(id, definition.id, { ...definition, moduleId: id, mount: () => mountPoint('settings:' + definition.id) })); },
      /* A group appended inside one of the host's own settings sections (the
         assistant's, say), so a module's options sit with the feature they change. */
      registerSettingsGroup(definition) { alive(); guard('ui:settings'); return track(settingsGroups.add(id, `${definition.section}:${definition.id}`, { ...definition, moduleId: id, mount: () => mountPoint('settings-group:' + definition.id) })); },

      /* ---- assistant contributions (backend tools are declared by the worker) ---- */
      assistant: {
        registerProposalCard(kind, render) { alive(); guard('assistant:proposals'); return track(proposalRenderers.add(id, kind, { kind, render, moduleId: id })); },
        open: (...args) => core.assistant?.open(...args),
        conversation: () => core.session?.id() ?? null,
        /** Park the assistant window inside this module's workspace. */
        dock(implementation) { alive(); core.assistant.setDock(implementation); return track(() => core.assistant.setDock(null)); },
      },

      /* ---- events ---- */
      events: {
        on(name, fn) { alive(); guard('events:subscribe'); return track(bus.on(name, fn)); },
        onModule(fn) { alive(); return track(bus.on(`module:${id}`, fn)); },
        emit: (name, payload) => bus.emit(`module:${id}:${name}`, payload),
      },

      /* ---- scoped browser storage: view preferences only ---- */
      storage: {
        key: (key) => `st-mod-${id}-${key}`,
        get(key, fallback = null) { try { const raw = localStorage.getItem(scope.storage.key(key)); return raw === null ? fallback : JSON.parse(raw); } catch { return fallback; } },
        set(key, value) { try { localStorage.setItem(scope.storage.key(key), JSON.stringify(value)); } catch {} },
        remove(key) { try { localStorage.removeItem(scope.storage.key(key)); } catch {} },
      },
      /* ---- scoped server-side settings, shared across tabs ---- */
      settings: {
        get: () => scope.rpc('settings.get', {}, { method: 'GET' }).catch(() => ({})),
        patch: (patch) => scope.rpc('settings.patch', patch),
      },

      /* ---- approved access to shared host resources ---- */
      resources: {
        connections: { list: () => { guard('connections:read'); return core.api('/api/connections'); } },
        projects: {
          list: () => { guard('projects:read'); return core.api('/api/projects'); },
        },
        audit: { read: (query) => { guard('audit:read'); return core.api('/api/audit' + (query ? '?' + new URLSearchParams(query) : '')); } },
      },

      /* ---- module styles, removed with the module ---- */
      styles: {
        add(css) {
          alive();
          const node = document.createElement('style');
          node.dataset.module = id;
          node.textContent = css;
          document.head.appendChild(node);
          styleNodes.add(node);
          return track(() => { node.remove(); styleNodes.delete(node); });
        },
        link(href) {
          alive();
          const node = document.createElement('link');
          node.rel = 'stylesheet'; node.href = href; node.dataset.module = id;
          document.head.appendChild(node);
          styleNodes.add(node);
          return track(() => { node.remove(); styleNodes.delete(node); });
        },
      },

      /* ---- DOM, timers and observers the host can take back ---- */
      mount: mountPoint,
      on(target, type, handler, options) {
        alive();
        target.addEventListener(type, handler, options);
        return track(() => target.removeEventListener(type, handler, options));
      },
      setTimeout(fn, ms, ...args) { alive(); const t = setTimeout(() => { timers.delete(t); fn(...args); }, ms); timers.add(t); return t; },
      setInterval(fn, ms, ...args) { alive(); const t = setInterval(fn, ms, ...args); intervals.add(t); return t; },
      clearTimer(t) { clearTimeout(t); clearInterval(t); timers.delete(t); intervals.delete(t); },
      observe(observer) { alive(); observers.add(observer); return track(() => { try { observer.disconnect(); } catch {} observers.delete(observer); }); },

      navigate: (route, options) => core.navigate(route, options),
      route: () => core.route(),

      /* ---- deliberate module-to-module contracts ---- */
      provide(api) { alive(); return track(apis.add(id, id, api)); },
      consume(otherId) { return isInstalled(otherId) ? apis.get(otherId) : null; },
      onModuleChange: (fn) => track(bus.on('modules:state', fn)),

      onDeactivate(fn) { alive(); return track(fn); },
      isInstalled,

      async dispose() {
        if (disposed) return;
        disposed = true;
        for (const ws of sockets) { try { ws.close(); } catch {} }
        for (const t of timers) clearTimeout(t);
        for (const t of intervals) clearInterval(t);
        for (const o of observers) { try { o.disconnect(); } catch {} }
        // Registrations and listeners come off in reverse order of registration.
        for (const fn of disposables.reverse()) { try { await fn(); } catch (error) { console.error(`${id} cleanup:`, error); } }
        disposables.length = 0;
        for (const node of styleNodes) node.remove();
        for (const el of containers) el.remove();
        pages.removeOwner(id); navItems.removeOwner(id); commands.removeOwner(id);
        searchSources.removeOwner(id); settingsSections.removeOwner(id);
        proposalRenderers.removeOwner(id); launcherTiles.removeOwner(id); apis.removeOwner(id);
        settingsGroups.removeOwner(id); tourSteps.removeOwner(id);
        sockets.clear(); timers.clear(); intervals.clear(); observers.clear(); containers.clear(); styleNodes.clear();
      },
    };
    return scope;
  }

  return {
    SDK_VERSION,
    pages, navItems, commands, searchSources, settingsSections, settingsGroups, proposalRenderers, launcherTiles, tourSteps, apis,
    bus, provide, core, createScope, createRegistry,
    state: () => snapshot, setSnapshot, moduleState, isInstalled,
  };
})();
