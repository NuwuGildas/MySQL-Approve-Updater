/* Application shell: one persistent navigation, hash routes, one active page.
   The router owns no list of pages. Everything it renders and resolves comes
   from the host page registry (public/host/host.js), which the core fills with
   its own pages at startup and which modules add to and remove from at runtime.
   Adding a module therefore adds a sidebar entry, a launcher tile and a route
   with no reload and no navigation. See layout-guide.md §2–§5 and §21. */
'use strict';

/* ---------- icons the core pages use ---------- */
const NAV_ICON = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  connections: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8 7.5l3 8M16 7.5l-3 8M8.5 6h7"/></svg>',
  help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01"/></svg>',
  modules: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M17.5 14.5v6M14.5 17.5h6"/></svg>',
  collapse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 6l-6 6 6 6"/><path d="M20 6v12"/></svg>',
};

/* Sidebar groups in the order they are drawn. A module names one of these. */
const NAV_GROUPS = ['Start', 'Database', 'Infrastructure', 'Workspace'];

const pageRegistry = HostSDK.pages;
const navRegistry = HostSDK.navItems;
/* Registry entries carry both the page and its sidebar presentation; the
   sidebar list is pages + any extra entries a module registered on its own. */
const allNavEntries = () => [...pageRegistry.values().filter((p) => p.label), ...navRegistry.values()];
const navItem = (id) => allNavEntries().find((i) => i.id === id) || pageRegistry.get(id) || null;
const pageDef = (id) => pageRegistry.get(id);

const PAGE_DIALOGS = { schema: 'schemaModal', settings: 'settingsModal', connections: 'connModal' }; // dialogs shown non-modally as pages

/* ---------- routes ---------- */
const ROUTE_HOME = '#/home';
let currentRoute = null;      // e.g. '/deployments/targets/abc'
let currentPageId = null;
let previousPageRoute = null; // last non-utility page, where Settings / Connections return to
let resolving = false;        // guards against re-entrant hashchange while we apply a route
let lastSettingsSection = 'appearance';

/** Resolve a hash against the registered pages. Unknown or uninstalled → null. */
function parseRoute(hash) {
  const h = String(hash || '').replace(/^#/, '');
  const parts = (h.startsWith('/') ? h : '/' + h).split('/').filter(Boolean);
  if (!parts.length) return { id: 'home', parts: [] };
  const candidates = pageRegistry.values().filter((p) => p.segment === parts[0]);
  if (!candidates.length) return null;
  const exact = candidates.find((p) => p.sub && p.sub === parts[1]);
  if (exact) return { id: exact.id, parts: parts.slice(2) };
  const fallback = candidates.find((p) => !p.sub) || candidates.find((p) => p.default);
  if (!fallback) return null;
  return { id: fallback.id, parts: parts.slice(fallback.sub ? 2 : 1) };
}

/** The one navigation entry point. options: { replace, focus, fromHistory } */
function navigate(route, options = {}) {
  const r = route.startsWith('#') ? route : '#' + route;
  const resolved = parseRoute(r);
  if (!resolved) { toast('Unknown page: ' + r, 'warning'); return navigate(ROUTE_HOME, { replace: true }); }
  const target = r.slice(1);
  if (location.hash !== r) {
    resolving = true;
    if (options.replace || options.fromHistory) history.replaceState(null, '', r); else location.hash = r; // pushes one history entry
    resolving = false;
  }
  applyRoute(resolved, target, options);
}

function applyRoute(resolved, path, options = {}) {
  const item = pageDef(resolved.id);
  if (!item) { toast('Add this tool from Modules to open it.', 'info'); return navigate('#/modules', { replace: true }); }
  const prev = currentRoute;
  if (prev && !['settings', 'connections'].includes(parseRoute('#' + prev)?.id)) previousPageRoute = '#' + prev;
  currentRoute = path;
  try { localStorage.setItem('st-last-route', '#' + path); } catch {}
  document.body.classList.remove(...[...document.body.classList].filter((c) => c.startsWith('page-')));
  document.body.classList.add('page-' + resolved.id);
  // Leave the page that was showing. Every page declares its own leave().
  if (currentPageId && currentPageId !== resolved.id) { try { pageDef(currentPageId)?.leave?.(); } catch (e) { console.error(e); } }
  for (const [id, dlg] of Object.entries(PAGE_DIALOGS)) if (resolved.id !== id && $(dlg)?.open && !$(dlg).dataset.stModal) $(dlg).close();
  currentPageId = resolved.id;
  try { item.enter?.(resolved.parts, options); } catch (error) { console.error(error); toast(`Could not open ${item.title || item.label}: ${error.message}`, 'error'); }
  renderNavActive(resolved.id);
  renderPageHead(resolved.id, item);
  updateAgentContext(item);
  document.title = resolved.id === 'home' ? 'Server Tools' : `${item?.title || 'Server Tools'} · Server Tools`;
  closeMobileNav();
  if (options.focus !== false && prev !== null && !options.fromHistory) focusPageHeading(resolved.id);
}

/** Rewrite the address for a page that stays open (target selection, session id…). */
function replaceRoute(route) {
  if (location.hash === route) return;
  resolving = true;
  history.replaceState(null, '', route);
  resolving = false;
  currentRoute = route.slice(1);
  try { localStorage.setItem('st-last-route', route); } catch {}
}
/** A module page that opened itself outside the router (a terminal, say) syncs the shell. */
function adoptPage(id, route) {
  const item = pageDef(id); if (!item) return;
  if (route) replaceRoute(route);
  document.body.classList.remove(...[...document.body.classList].filter((c) => c.startsWith('page-')));
  document.body.classList.add('page-' + id);
  currentPageId = id;
  renderNavActive(id);
  renderPageHead(id, item);
  updateAgentContext(item);
  document.title = `${item.title || item.label} · Server Tools`;
}

function focusPageHeading(id) {
  const item = pageDef(id);
  const h = (typeof item?.focus === 'function' ? item.focus() : null)
    || (item?.focusSelector ? document.querySelector(item.focusSelector) : null)
    || $('pageTitle');
  if (!h) return;
  if (!h.hasAttribute('tabindex')) h.setAttribute('tabindex', '-1');
  try { h.focus({ preventScroll: true }); } catch {}
}

window.addEventListener('hashchange', () => {
  if (resolving) return;
  const resolved = parseRoute(location.hash);
  if (!resolved) return navigate(ROUTE_HOME, { replace: true });
  applyRoute(resolved, location.hash.slice(1), { fromHistory: true });
});

/** A page-like view closed by its own ✕ or Escape sends the address home. */
function watchPageContainer(el, pageId) {
  const observer = new MutationObserver(() => {
    if (el.classList.contains('open')) return;
    const r = parseRoute(location.hash);
    if (r && r.id === pageId) navigate(ROUTE_HOME, { replace: true, focus: false }); // the view's own close restores focus to its opener
  });
  observer.observe(el, { attributes: true, attributeFilter: ['class'] });
  return observer;
}

$('schemaModal').addEventListener('close', () => { const r = parseRoute(location.hash); if (r && r.id === 'schema') navigate('#/database/updates', { replace: true, focus: false }); });
$('settingsModal').addEventListener('close', () => { const r = parseRoute(location.hash); if (r && r.id === 'settings') navigate(previousPageRoute || ROUTE_HOME, { replace: true, focus: false }); });
$('connModal').addEventListener('close', () => { const r = parseRoute(location.hash); if (r && r.id === 'connections') navigate(previousPageRoute || ROUTE_HOME, { replace: true, focus: false }); });

/* Settings / Connections openers used across app.js now go through the router */
showSettings = function () { navigate('#/settings/' + lastSettingsSection); };
function openConnectionsPage() { navigate('#/connections'); }

/* ---------- the core's own pages ---------- */
function registerCorePages() {
  const add = (definition) => pageRegistry.add('core', definition.id, { ...definition, moduleId: 'core', core: true });
  add({ id: 'home', segment: 'home', label: 'Home', group: 'Start', order: 0, icon: NAV_ICON.home, title: 'Compass', desc: 'Your DevOps toolbox: pick a tool to get started.',
    enter: () => showCompass(), focus: () => $('compass').querySelector('h2') });
  add({ id: 'mysql', segment: 'database', sub: 'updates', default: true, label: 'Updates', group: 'Database', order: 10, icon: CC_ICON.db, title: 'MySQL Update Tool', context: 'db',
    desc: 'Rule-based batch updates with preview, per-row human approval and backups.',
    enter: () => { revealWorkspace('MySQL Update Tool'); if ($('sqlConsole').classList.contains('open')) toggleSqlConsole(); } });
  add({ id: 'sql', segment: 'database', sub: 'sql', label: 'SQL console', group: 'Database', order: 11, icon: CC_ICON.console, title: 'SQL Console', context: 'db',
    desc: 'Query editor and results workspace with schema autocomplete, export and AI query generation.',
    enter: () => { revealWorkspace('SQL Console'); if (!$('sqlConsole').classList.contains('open')) toggleSqlConsole(); else { sqlTableRedraw(); if (typeof sqlEditor !== 'undefined' && sqlEditor) sqlEditor.refresh(); } },
    focus: () => $('sqlBar').querySelector('b') });
  add({ id: 'schema', segment: 'database', sub: 'schema', label: 'Schema map', group: 'Database', order: 12, icon: CC_ICON.schema, title: 'Schema Map', context: 'db',
    desc: 'Visualize tables and relations; inspect columns, row counts and CREATE TABLE.',
    enter: () => { revealWorkspace('Schema Map'); const d = $('schemaModal'); if (!d.open) { d.show(); loadSchemaMap($('schemaFilter').value.trim()); } },
    focus: () => $('schemaModal').querySelector('h2') });
  add({ id: 'connections', segment: 'connections', label: 'Connections', group: 'Workspace', order: 30, icon: NAV_ICON.connections, title: 'Connections',
    desc: 'Database and SSH connection profiles; choose the active database.',
    enter: () => { $('connForm').hidden = true; loadConns().catch((e) => toast(e.message, 'error')); const d = $('connModal'); if (!d.open) d.show(); },
    focus: () => $('connModal').querySelector('h2') });
  add({ id: 'modules', segment: 'modules', foot: true, label: '+ Add module', icon: NAV_ICON.modules, title: 'Modules', desc: 'Add optional tools to your workspace.',
    enter: () => { showCompass(); openModuleMarketplace(); } });
  add({ id: 'settings', segment: 'settings', foot: true, label: 'Settings', icon: CC_ICON.settings, title: 'Settings', desc: 'Preferences, tool limits, AI assistant and module options.',
    enter: (parts) => { const sec = parts[0] || lastSettingsSection; lastSettingsSection = sec; renderSettings(); const d = $('settingsModal'); if (!d.open) d.show(); showSettingsSection(sec); },
    focus: () => $('settingsModal').querySelector('.settings-titlebar b') });
  navRegistry.add('core', 'help', { id: 'help', label: 'Guided tour', action: 'tour', icon: NAV_ICON.help, title: 'Guided tour', foot: true });
}

/* ---------- sidebar ---------- */
function renderNav() {
  const nav = $('appNav');
  const entries = allNavEntries();
  const link = (i) => i.route || i.segment
    ? `<a class="nav-link" href="${i.route || '#/' + i.segment + (i.sub ? '/' + i.sub : '')}" data-nav="${i.id}"><span class="nav-ico">${i.icon}</span><span class="nav-label">${esc(i.label)}</span></a>`
    : `<button type="button" class="nav-link" data-nav="${i.id}" data-action="${i.action}"><span class="nav-ico">${i.icon}</span><span class="nav-label">${esc(i.label)}</span></button>`;
  const groups = [...new Set([...NAV_GROUPS, ...entries.map((i) => i.group).filter(Boolean)])];
  const body = groups.map((group) => {
    const items = entries.filter((i) => !i.foot && i.group === group).sort((a, b) => (a.order || 0) - (b.order || 0));
    return items.length ? `<div class="nav-group"><div class="nav-group-label">${esc(group)}</div>${items.map(link).join('')}</div>` : '';
  }).join('');
  const foot = entries.filter((i) => i.foot).sort((a, b) => (a.order || 0) - (b.order || 0));
  nav.innerHTML = `<div class="nav-scroll">${body}</div>
    <div class="nav-foot">${foot.map(link).join('')}<button type="button" class="nav-link nav-collapse" id="btnNavCollapse" title="Collapse navigation" aria-pressed="false"><span class="nav-ico">${NAV_ICON.collapse}</span><span class="nav-label">Collapse</span></button></div>`;
  nav.querySelectorAll('a[data-nav]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); navigate(a.getAttribute('href')); }));
  nav.querySelectorAll('button[data-action]').forEach((b) => b.addEventListener('click', () => { runNavAction(b.dataset.action); closeMobileNav(); }));
  $('btnNavCollapse').addEventListener('click', () => setNavCollapsed(!document.body.classList.contains('nav-collapsed')));
  entries.filter((i) => i.liveOnly).forEach((i) => { const el = nav.querySelector(`[data-nav="${i.id}"]`); if (el) el.hidden = true; });
  for (const entry of entries) if (typeof entry.afterRender === 'function') { try { entry.afterRender(nav); } catch (e) { console.error(e); } }
  if (currentPageId) renderNavActive(currentPageId);
  if (document.body.classList.contains('nav-collapsed')) setNavCollapsed(true);
}
function runNavAction(action) { if (action === 'tour') startTour(); }
function renderNavActive(id) {
  $('appNav').querySelectorAll('[data-nav]').forEach((el) => {
    const on = el.dataset.nav === id;
    el.classList.toggle('on', on);
    if (on) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
  });
}
function setNavCollapsed(on) {
  document.body.classList.toggle('nav-collapsed', on);
  const b = $('btnNavCollapse'); if (b) { b.setAttribute('aria-pressed', String(on)); b.title = on ? 'Expand navigation' : 'Collapse navigation'; }
  try { localStorage.setItem('st-nav-collapsed', on ? '1' : '0'); } catch {}
}
/* compact screens: the sidebar is an off-canvas drawer behind the header menu button */
function openMobileNav() { document.body.classList.add('nav-open'); $('btnNav').setAttribute('aria-expanded', 'true'); $('appNav').removeAttribute('inert'); const first = $('appNav').querySelector('[aria-current], .nav-link'); first?.focus(); }
function closeMobileNav() { if (!document.body.classList.contains('nav-open')) return; document.body.classList.remove('nav-open'); $('btnNav').setAttribute('aria-expanded', 'false'); syncNavInert(); }
function syncNavInert() { // off-canvas and closed → not focusable
  const offCanvas = matchMedia('(max-width: 767px)').matches;
  $('appNav').toggleAttribute('inert', offCanvas && !document.body.classList.contains('nav-open'));
}
$('btnNav').addEventListener('click', () => (document.body.classList.contains('nav-open') ? closeMobileNav() : openMobileNav()));
$('navScrim').addEventListener('click', closeMobileNav);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  if (document.body.classList.contains('nav-open')) { closeMobileNav(); $('btnNav').focus(); return; }
  // page dialogs (schema, settings, connections) close on Escape like other pages, unless a real dialog sits above or the assistant has focus
  if (document.querySelector('dialog[open][data-st-modal]') || $('agentDrawer').contains(document.activeElement)) return;
  for (const dlg of Object.values(PAGE_DIALOGS)) { const d = $(dlg); if (d.open && !d.dataset.stModal) { e.preventDefault(); d.close(); return; } }
});
matchMedia('(max-width: 767px)').addEventListener('change', syncNavInert);
/* the sidebar redraws itself whenever a module adds or removes an entry */
pageRegistry.onChange(() => { if (document.body.classList.contains('shell')) renderNav(); });
navRegistry.onChange(() => { if (document.body.classList.contains('shell')) renderNav(); });

/* ---------- page header: title + context (database pages show the active profile) ---------- */
function renderPageHead(id, item) {
  const head = $('pageHead');
  head.hidden = !(item?.pageHead ?? ['home', 'mysql', 'sql', 'schema'].includes(id));
  $('pageTitle').textContent = item?.title || 'Server Tools';
  $('pageDesc').textContent = item?.desc || '';
  $('pageContextWrap').hidden = item?.context !== 'db';
  setPageHeadVar();
}
const hdr = document.querySelector('body > header');
const setHdr = () => document.documentElement.style.setProperty('--hdr-h', hdr.getBoundingClientRect().height + 'px');
const setPageHeadVar = () => { const ph = $('pageHead'); document.documentElement.style.setProperty('--phead-h', (ph && !ph.hidden ? ph.getBoundingClientRect().height : 0) + 'px'); };
new ResizeObserver(setHdr).observe(hdr); setHdr();
new ResizeObserver(setPageHeadVar).observe($('pageHead'));

/* the SQL console bar on the Updates page opens the SQL page instead of expanding in place */
$('sqlBar').addEventListener('click', (e) => {
  if (!document.body.classList.contains('page-mysql')) return;
  if (e.target.closest('button') && e.target.id !== 'btnSqlToggle') return; // Load schema / Schema map keep working in place
  e.stopImmediatePropagation(); e.preventDefault();
  navigate('#/database/sql');
}, true);

/* ---------- assistant: module context in its header, optional docking beside the workspace (§16) ---------- */
function updateAgentContext(item) { const el = $('agentCtx'); if (el) el.textContent = item ? `· ${item.label === 'Home' ? 'Compass' : String(item.title || '').replace(' · The Ascension', '')}` : ''; }
const prefAgentDock = () => { try { return localStorage.getItem('st-agent-dock') === '1'; } catch { return false; } };
function setAgentDock(on) {
  try { localStorage.setItem('st-agent-dock', on ? '1' : '0'); } catch {}
  document.body.classList.toggle('agent-dock-pref', on);
  const b = $('btnAgentDock'); if (b) { b.querySelector('b').textContent = on ? 'Float the window' : 'Dock beside the workspace'; b.querySelector('span').textContent = on ? 'Back to a free-floating window' : 'Wide screens only: the page makes room for the assistant'; }
}
$('btnAgentDock')?.addEventListener('click', () => setAgentDock(!prefAgentDock()));
new MutationObserver(() => document.body.classList.toggle('agent-open', $('agentDrawer').classList.contains('open'))).observe($('agentDrawer'), { attributes: true, attributeFilter: ['class'] });

/* ---------- Schema map: searchable table list as a keyboard alternative to the graph (§9) ---------- */
function renderSchemaTableList() {
  const g = schemaView.graph; const drawer = $('schemaDrawer'); if (!drawer || !g) return;
  if (schemaView.selected) return;
  drawer.hidden = false;
  $('drawerTitle').textContent = `${g.tables.length} table${g.tables.length === 1 ? '' : 's'}`;
  $('btnDrawerDdl').hidden = true; $('btnDrawerClose').hidden = true;
  $('drawerBody').innerHTML = `<label for="schemaTableSearch" class="hint" style="margin:0 0 .3rem;display:block">Find a table</label><input id="schemaTableSearch" type="search" placeholder="type to filter…" autocomplete="off">
    <div class="schema-tlist" id="schemaTableList" role="listbox" aria-label="Tables"></div>`;
  const list = $('schemaTableList');
  const draw = (q) => { const names = g.tables.map((t) => t.name).filter((n) => !q || n.toLowerCase().includes(q)).sort(); list.innerHTML = names.map((n) => `<button type="button" role="option" data-t="${esc(n)}"><span class="mono">${esc(n)}</span></button>`).join('') || '<div class="hint" style="margin:.3rem 0">No table matches.</div>'; };
  draw('');
  $('schemaTableSearch').addEventListener('input', (e) => draw(e.target.value.trim().toLowerCase()));
  list.addEventListener('click', (e) => { const b = e.target.closest('[data-t]'); if (b) selectSchemaTable(b.dataset.t); });
}
if (typeof selectSchemaTable === 'function') {
  const _sel = selectSchemaTable;
  selectSchemaTable = function (name) { _sel(name); if (name) { $('btnDrawerDdl').hidden = false; $('btnDrawerClose').hidden = false; } else renderSchemaTableList(); };
}
if (typeof renderSchemaMap === 'function') {
  const _rsm = renderSchemaMap;
  renderSchemaMap = function (g) { _rsm(g); if (!schemaView.selected) renderSchemaTableList(); };
}
$('btnSchemaRefresh')?.addEventListener('click', () => loadSchemaMap($('schemaFilter').value.trim()));
$('btnSchemaFit')?.addEventListener('click', () => { if (schemaView.graph) { schemaView.selected = null; renderSchemaMap(schemaView.graph); } });

/* ---------- inline forms → modal dialogs: the form keeps its id and listeners, the dialog follows its hidden state ---------- */
function formAsModal(formId, dialogId, hostId, closeBtnId) {
  const form = $(formId), dlg = $(dialogId), host = $(hostId); if (!form || !dlg || !host) return null;
  host.appendChild(form);
  const sync = () => { if (!form.hidden) { if (!dlg.open) dlg.showModal(); } else if (dlg.open) dlg.close(); };
  const observer = new MutationObserver(sync);
  observer.observe(form, { attributes: true, attributeFilter: ['hidden'] });
  dlg.addEventListener('close', () => { if (!form.hidden) form.hidden = true; });
  $(closeBtnId)?.addEventListener('click', () => { form.hidden = true; });
  sync();
  return observer;
}

/* ---------- startup: address wins, then the startup preference ---------- */
function navStartup() {
  document.body.classList.add('shell');
  registerCorePages();
  renderNav();
  // the session controls belong to the Updates page, not the global header
  $('sessionBar').append($('sessStatus'), $('btnPause'), $('btnResume'), $('btnAbort'));
  try { if (localStorage.getItem('st-nav-collapsed') === '1') setNavCollapsed(true); } catch {}
  setAgentDock(prefAgentDock());
  formAsModal('connForm', 'connFormModal', 'connFormHost', 'btnConnFormClose');
  syncNavInert();
  let route = parseRoute(location.hash) ? location.hash : null;
  if (!route) {
    const startup = prefStartup();
    let last = null; try { last = localStorage.getItem('st-last-route'); } catch {}
    route = startup === 'mysql' ? '#/database/updates' : startup === 'last' && last && parseRoute(last) ? last : ROUTE_HOME;
  }
  navigate(route, { replace: true, focus: false });
  if (typeof offerTourOnce === 'function') offerTourOnce(); // first visit: the tour starts on whatever page opened
}

/* Routes a module owns disappear with it: if the page showing is gone, go home. */
pageRegistry.onChange(() => {
  if (!currentPageId || pageRegistry.has(currentPageId)) return;
  currentPageId = null;
  navigate(ROUTE_HOME, { replace: true, focus: false });
});
