/* Application shell: one persistent navigation, hash routes, one active page.
   Loaded after app.js and deploy.js; it wires the existing module openers
   (showCompass, revealWorkspace, openDeploy, openServers, openAudit...) to
   routes instead of duplicating them. See layout-guide.md §2–§5 and §21. */
'use strict';

/* ---------- registry: the single source for sidebar, home cards and routes ---------- */
const NAV_ICON = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  connections: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8 7.5l3 8M16 7.5l-3 8M8.5 6h7"/></svg>',
  help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01"/></svg>',
  collapse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 6l-6 6 6 6"/><path d="M20 6v12"/></svg>',
};
const NAV = [
  { group: 'Start', items: [
    { id: 'home', label: 'Home', route: '#/home', icon: NAV_ICON.home, title: 'Compass', desc: 'Your DevOps toolbox: pick a tool to get started.' },
  ] },
  { group: 'Database', items: [
    { id: 'mysql', label: 'Updates', route: '#/database/updates', icon: CC_ICON.db, title: 'MySQL Update Tool', context: 'db', desc: 'Rule-based batch updates with preview, per-row human approval and backups.' },
    { id: 'sql', label: 'SQL console', route: '#/database/sql', icon: CC_ICON.console, title: 'SQL Console', context: 'db', desc: 'Query editor and results workspace with schema autocomplete, export and AI query generation.' },
    { id: 'schema', label: 'Schema map', route: '#/database/schema', icon: CC_ICON.schema, title: 'Schema Map', context: 'db', desc: 'Visualize tables and relations; inspect columns, row counts and CREATE TABLE.' },
  ] },
  { group: 'Infrastructure', items: [
    { id: 'deploy', label: 'Deployments', route: '#/deployments', icon: CC_ICON.rocket, title: 'Deployments · The Ascension', desc: 'Build → deploy → ship: connect a repo, detect its stack, review the plan and ship to a VPS, shared host or platform.' },
    { id: 'servers', label: 'Servers', route: '#/servers', icon: CC_ICON.server, title: 'Servers', desc: 'SSH server profiles, live VM stats and terminals.' },
    { id: 'connectors', label: 'Connectors', route: '#/connectors', icon: CC_ICON.connectors, title: 'Connectors', desc: 'GitHub and GitLab accounts: verify a token once, browse repositories and connect them.' },
  ] },
  { group: 'Workspace', items: [
    { id: 'connections', label: 'Connections', route: '#/connections', icon: NAV_ICON.connections, title: 'Connections', desc: 'Database and SSH connection profiles; choose the active database.' },
    { id: 'history', label: 'History', route: '#/history', icon: CC_ICON.history, title: 'History', desc: 'Searchable timeline of every decision, edit, SSH session, deploy and AI action.' },
  ] },
];
const NAV_FOOT = [
  { id: 'settings', label: 'Settings', route: '#/settings/appearance', icon: CC_ICON.settings, title: 'Settings', desc: 'Preferences, tool limits, AI assistant and deploy options.' },
  { id: 'help', label: 'Guided tour', action: 'tour', icon: NAV_ICON.help, title: 'Guided tour' },
];
const NAV_ITEMS = [...NAV.flatMap((g) => g.items), ...NAV_FOOT];
const navItem = (id) => NAV_ITEMS.find((i) => i.id === id);
const PAGE_DIALOGS = { schema: 'schemaModal', settings: 'settingsModal', connections: 'connModal' }; // dialogs shown non-modally as pages

/* ---------- routes ---------- */
const ROUTE_HOME = '#/home';
let currentRoute = null;      // e.g. '/deployments/targets/abc'
let previousPageRoute = null; // last non-utility page, where Settings / Connections return to
let resolving = false;        // guards against re-entrant hashchange while we apply a route
let lastSettingsSection = 'appearance';

function parseRoute(hash) {
  const h = String(hash || '').replace(/^#/, '');
  const path = h.startsWith('/') ? h : '/' + h;
  const parts = path.split('/').filter(Boolean);
  if (!parts.length || parts[0] === 'home') return { id: 'home', parts: [] };
  if (parts[0] === 'database') return { id: parts[1] === 'sql' ? 'sql' : parts[1] === 'schema' ? 'schema' : 'mysql', parts: parts.slice(2) };
  if (parts[0] === 'deployments') return { id: 'deploy', parts: parts.slice(1) };
  if (parts[0] === 'servers') return { id: 'servers', parts: parts.slice(1) };
  if (parts[0] === 'history') return { id: 'history', parts: parts.slice(1) };
  if (parts[0] === 'connectors') return { id: 'connectors', parts: parts.slice(1) };
  if (parts[0] === 'settings') return { id: 'settings', parts: parts.slice(1) };
  if (parts[0] === 'connections') return { id: 'connections', parts: [] };
  return null;
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
  const item = navItem(resolved.id);
  const prev = currentRoute;
  if (prev && !['settings', 'connections'].includes(parseRoute('#' + prev)?.id)) previousPageRoute = '#' + prev;
  currentRoute = path;
  try { localStorage.setItem('st-last-route', '#' + path); } catch {}
  document.body.classList.remove(...[...document.body.classList].filter((c) => c.startsWith('page-')));
  document.body.classList.add('page-' + resolved.id);
  // leave whatever page was active (drawers acting as pages, the deploy page, the page dialogs)
  const leaving = (id) => resolved.id !== id;
  if (leaving('servers') && $('serversDrawer').classList.contains('open')) closeServers();
  if (leaving('servers') && $('sshDrawer').classList.contains('open') && $('sshDrawer').classList.contains('as-page')) hideSshDrawer();
  if (leaving('history') && $('auditDrawer').classList.contains('open')) closeAudit();
  if (leaving('connectors') && $('connectorsDrawer').classList.contains('open')) closeConnectors();
  if (leaving('deploy') && $('deployDrawer').classList.contains('open')) closeDeploy();
  for (const [id, dlg] of Object.entries(PAGE_DIALOGS)) if (leaving(id) && $(dlg).open && !$(dlg).dataset.stModal) $(dlg).close();
  switch (resolved.id) {
    case 'home': showCompass(); break;
    case 'mysql': revealWorkspace('MySQL Update Tool'); if ($('sqlConsole').classList.contains('open')) toggleSqlConsole(); break;
    case 'sql': revealWorkspace('SQL Console'); if (!$('sqlConsole').classList.contains('open')) toggleSqlConsole(); else { sqlTableRedraw(); if (typeof sqlEditor !== 'undefined' && sqlEditor) sqlEditor.refresh(); } break;
    case 'schema': { // a non-modal dialog filling the content area, so the sidebar stays usable
      revealWorkspace('Schema Map');
      const d = $('schemaModal');
      if (!d.open) { d.show(); loadSchemaMap($('schemaFilter').value.trim()); }
      break; }
    case 'deploy': { const targetId = resolved.parts[0] === 'targets' ? resolved.parts[1] : undefined; openDeploy(targetId).then(() => { if (targetId && !dp.targets.some((t) => t.id === targetId)) { toast('That deploy target no longer exists', 'warning'); navigate('#/deployments', { replace: true }); } }); break; }
    case 'servers': openServers(); if (resolved.parts[1] === 'terminal' && resolved.parts[0]) openServerTerminal(resolved.parts[0]); break;
    case 'history': openAudit(); break;
    case 'connectors': openConnectors(resolved.parts[1] === 'repos' ? resolved.parts[0] : undefined); break;
    case 'settings': { const sec = resolved.parts[0] || lastSettingsSection; lastSettingsSection = sec; renderSettings(); const d = $('settingsModal'); if (!d.open) d.show(); showSettingsSection(sec); break; }
    case 'connections': { $('connForm').hidden = true; loadConns().catch((e) => toast(e.message, 'error')); const d = $('connModal'); if (!d.open) d.show(); break; }
  }
  for (const id of ['serversDrawer', 'auditDrawer']) $(id).classList.toggle('as-page', resolved.id === (id === 'serversDrawer' ? 'servers' : 'history'));
  $('sshDrawer').classList.toggle('as-page', resolved.id === 'servers' && resolved.parts[1] === 'terminal');
  renderNavActive(resolved.id);
  renderPageHead(resolved.id, item);
  updateAgentContext(item);
  document.title = resolved.id === 'home' ? 'Server Tools' : `${item?.title || 'Server Tools'} · Server Tools`;
  closeMobileNav();
  if (options.focus !== false && prev !== null && !options.fromHistory) focusPageHeading(resolved.id);
}

function focusPageHeading(id) {
  const h = id === 'deploy' ? $('deployDrawer').querySelector('.asc-title h2')
    : id === 'servers' ? $('serversDrawer').querySelector('h2')
    : id === 'history' ? $('auditDrawer').querySelector('h2')
    : id === 'connectors' ? ($('cnReposView').hidden ? $('cnMain') : $('cnReposView')).querySelector('h2')
    : id === 'home' ? $('compass').querySelector('h2')
    : id === 'schema' ? $('schemaModal').querySelector('h2')
    : id === 'settings' ? $('settingsModal').querySelector('.settings-titlebar b')
    : id === 'connections' ? $('connModal').querySelector('h2')
    : id === 'sql' ? $('sqlBar').querySelector('b')
    : $('pageTitle');
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

/* when a page-like drawer or page dialog is closed by its own ✕ / Escape, the address follows */
for (const [id, routeId] of [['serversDrawer', 'servers'], ['auditDrawer', 'history'], ['deployDrawer', 'deploy'], ['connectorsDrawer', 'connectors']]) {
  new MutationObserver(() => {
    if ($(id).classList.contains('open')) return;
    const r = parseRoute(location.hash);
    if (r && r.id === routeId) navigate(ROUTE_HOME, { replace: true, focus: false }); // the drawer's own close restores focus to its opener
  }).observe($(id), { attributes: true, attributeFilter: ['class'] });
}
new MutationObserver(() => { // closing the terminal panel returns to the server list
  if ($('sshDrawer').classList.contains('open')) return;
  const r = parseRoute(location.hash);
  if (r && r.id === 'servers' && r.parts[1] === 'terminal') navigate('#/servers', { replace: true, focus: false });
}).observe($('sshDrawer'), { attributes: true, attributeFilter: ['class'] });
$('schemaModal').addEventListener('close', () => { const r = parseRoute(location.hash); if (r && r.id === 'schema') navigate('#/database/updates', { replace: true, focus: false }); });
$('settingsModal').addEventListener('close', () => { const r = parseRoute(location.hash); if (r && r.id === 'settings') navigate(previousPageRoute || ROUTE_HOME, { replace: true, focus: false }); });
$('connModal').addEventListener('close', () => { const r = parseRoute(location.hash); if (r && r.id === 'connections') navigate(previousPageRoute || ROUTE_HOME, { replace: true, focus: false }); });

/* deployments: keep the selected target in the address (no new history entry) */
if (typeof dpSelect === 'function') {
  const _dpSelect = dpSelect;
  dpSelect = function (id) { _dpSelect(id); if (parseRoute(location.hash)?.id === 'deploy' && id) { const r = `#/deployments/targets/${id}`; if (location.hash !== r) { resolving = true; history.replaceState(null, '', r); resolving = false; currentRoute = r.slice(1); try { localStorage.setItem('st-last-route', r); } catch {} } } };
}
/* servers: a terminal opened from a server card gets its own address */
if (typeof openSsh === 'function') {
  const _openSsh = openSsh;
  openSsh = async function (profileId, opts = {}) {
    await _openSsh(profileId, opts);
    if (typeof profileId === 'string' && parseRoute(location.hash)?.id === 'servers') {
      $('sshDrawer').classList.add('as-page');
      const r = `#/servers/${profileId}/terminal`;
      if (location.hash !== r) { resolving = true; history.replaceState(null, '', r); resolving = false; currentRoute = r.slice(1); }
    }
  };
}
async function openServerTerminal(profileId) {
  const existing = [...consoles.values()].find((c) => c.profileId === profileId);
  if (existing) { showSshDrawer(); activateConsole(existing.id); $('sshDrawer').classList.add('as-page'); return; }
  let label = 'server';
  try { const d = await api('/api/ssh/sessions'); const s = d.sessions.find((x) => x.id === profileId); if (!s) { toast('That server profile no longer exists', 'warning'); return navigate('#/servers', { replace: true }); } label = s.name || label; } catch {}
  await openSsh(profileId, { label });
}
/* Settings / Connections openers used across app.js now go through the router */
showSettings = function () { navigate('#/settings/' + lastSettingsSection); };
function openConnectionsPage() { navigate('#/connections'); }

/* ---------- sidebar ---------- */
function renderNav() {
  const nav = $('appNav');
  const link = (i) => i.route
    ? `<a class="nav-link" href="${i.route}" data-nav="${i.id}"><span class="nav-ico">${i.icon}</span><span class="nav-label">${esc(i.label)}</span></a>`
    : `<button type="button" class="nav-link" data-nav="${i.id}" data-action="${i.action}"><span class="nav-ico">${i.icon}</span><span class="nav-label">${esc(i.label)}</span></button>`;
  nav.innerHTML = `<div class="nav-scroll">${NAV.map((g) => `<div class="nav-group"><div class="nav-group-label">${esc(g.group)}</div>${g.items.map(link).join('')}</div>`).join('')}</div>
    <div class="nav-foot">${NAV_FOOT.map(link).join('')}<button type="button" class="nav-link nav-collapse" id="btnNavCollapse" title="Collapse navigation" aria-pressed="false"><span class="nav-ico">${NAV_ICON.collapse}</span><span class="nav-label">Collapse</span></button></div>`;
  nav.querySelectorAll('a[data-nav]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); navigate(a.getAttribute('href')); }));
  nav.querySelectorAll('button[data-action]').forEach((b) => b.addEventListener('click', () => { runNavAction(b.dataset.action); closeMobileNav(); }));
  $('btnNavCollapse').addEventListener('click', () => setNavCollapsed(!document.body.classList.contains('nav-collapsed')));
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

/* ---------- page header: title + context (database pages show the active profile) ---------- */
function renderPageHead(id, item) {
  const head = $('pageHead');
  const showHead = ['home', 'mysql', 'sql', 'schema'].includes(id);
  head.hidden = !showHead;
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
function updateAgentContext(item) { const el = $('agentCtx'); if (el) el.textContent = item ? `· ${item.label === 'Home' ? 'Compass' : item.title.replace(' · The Ascension', '')}` : ''; }
const prefAgentDock = () => { try { return localStorage.getItem('st-agent-dock') === '1'; } catch { return false; } };
function setAgentDock(on) {
  try { localStorage.setItem('st-agent-dock', on ? '1' : '0'); } catch {}
  document.body.classList.toggle('agent-dock-pref', on);
  const b = $('btnAgentDock'); if (b) { b.querySelector('b').textContent = on ? 'Float the window' : 'Dock beside the workspace'; b.querySelector('span').textContent = on ? 'Back to a free-floating window' : 'Wide screens only: the page makes room for the assistant'; }
}
$('btnAgentDock')?.addEventListener('click', () => setAgentDock(!prefAgentDock()));
new MutationObserver(() => document.body.classList.toggle('agent-open', $('agentDrawer').classList.contains('open'))).observe($('agentDrawer'), { attributes: true, attributeFilter: ['class'] });

/* ---------- Deployments: resource switcher (Targets by default) and the New deployment action ---------- */
const DP_RES = [['targets', 'Targets'], ['repos', 'Repositories'], ['secrets', 'Secrets'], ['cloud', 'Cloud servers']];
function initDeployNavSwitcher() {
  const nav = $('deployNav'); if (!nav || nav.querySelector('.dp-switch')) return;
  const secs = [...nav.querySelectorAll(':scope > .dp-sec')];
  const order = ['repos', 'targets', 'secrets', 'cloud'];
  secs.forEach((s, i) => { s.dataset.res = order[i] || `x${i}`; });
  const sw = document.createElement('div'); sw.className = 'dp-switch'; sw.setAttribute('role', 'tablist'); sw.setAttribute('aria-label', 'Deployment resources');
  sw.innerHTML = DP_RES.map(([k, l]) => `<button type="button" role="tab" data-res="${k}">${l}</button>`).join('');
  nav.prepend(sw);
  let cur = 'targets'; try { cur = localStorage.getItem('st-dp-res') || 'targets'; } catch {}
  const apply = (k) => { cur = k; try { localStorage.setItem('st-dp-res', k); } catch {} sw.querySelectorAll('[data-res]').forEach((b) => { const on = b.dataset.res === k; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); }); secs.forEach((s) => s.classList.toggle('res-on', s.dataset.res === k)); nav.classList.add('switched'); };
  sw.addEventListener('click', (e) => { const b = e.target.closest('[data-res]'); if (b) apply(b.dataset.res); });
  apply(cur);
}

/* ---------- History: search, time and outcome filters kept across visits (§14) ---------- */
const AUDIT_FILTER_KEY = 'st-audit-filters';
let auditFilters = { q: '', time: 'all', outcome: 'all' };
try { auditFilters = { ...auditFilters, ...JSON.parse(localStorage.getItem(AUDIT_FILTER_KEY) || '{}') }; } catch {}
function auditOutcome(e) {
  const s = `${e.action || ''} ${e.status || ''} ${e.decision || ''} ${e.verdict || ''}`.toLowerCase();
  if (/fail|reject|rolled|error|cancel|block/.test(s)) return 'failed';
  if (/success|approv|succeeded|done|saved|added|ready/.test(s)) return 'succeeded';
  return 'other';
}
function auditPassesFilters(e) {
  if (auditFilters.time !== 'all') { const age = Date.now() - Date.parse(e.ts || 0); const max = auditFilters.time === 'today' ? 86400e3 : auditFilters.time === '7d' ? 7 * 86400e3 : 30 * 86400e3; if (!(age <= max)) return false; }
  if (auditFilters.outcome !== 'all' && auditOutcome(e) !== auditFilters.outcome) return false;
  if (auditFilters.q) { const hay = JSON.stringify(e).toLowerCase(); if (!hay.includes(auditFilters.q.toLowerCase())) return false; }
  return true;
}
if (typeof renderAudit === 'function') {
  const _renderAudit = renderAudit;
  renderAudit = function () {
    const all = auditData;
    auditData = all.filter(auditPassesFilters);
    try { _renderAudit(); } finally { auditData = all; }
    const active = auditFilters.q || auditFilters.time !== 'all' || auditFilters.outcome !== 'all';
    $('btnAuditClear').hidden = !active;
    if (active && !$('auditBody').querySelector('.tl-item, .tl-chat')) $('auditBody').innerHTML = `<div class="empty" style="padding:1rem">No events match these filters. <button type="button" onclick="clearAuditFilters()">Clear filters</button></div>`;
  };
}
function clearAuditFilters() { auditFilters = { q: '', time: 'all', outcome: 'all' }; syncAuditFilterUi(); persistAuditFilters(); renderAudit(); }
function persistAuditFilters() { try { localStorage.setItem(AUDIT_FILTER_KEY, JSON.stringify(auditFilters)); } catch {} }
function syncAuditFilterUi() { $('auditSearch').value = auditFilters.q; $('auditTime').value = auditFilters.time; $('auditOutcome').value = auditFilters.outcome; }
function initAuditFilters() {
  if (!$('auditSearch')) return;
  syncAuditFilterUi();
  let t = 0;
  $('auditSearch').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { auditFilters.q = $('auditSearch').value.trim(); persistAuditFilters(); renderAudit(); }, 200); });
  $('auditTime').addEventListener('change', () => { auditFilters.time = $('auditTime').value; persistAuditFilters(); renderAudit(); });
  $('auditOutcome').addEventListener('change', () => { auditFilters.outcome = $('auditOutcome').value; persistAuditFilters(); renderAudit(); });
  $('btnAuditClear').addEventListener('click', clearAuditFilters);
}

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
  const form = $(formId), dlg = $(dialogId), host = $(hostId); if (!form || !dlg || !host) return;
  host.appendChild(form);
  const sync = () => { if (!form.hidden) { if (!dlg.open) dlg.showModal(); } else if (dlg.open) dlg.close(); };
  new MutationObserver(sync).observe(form, { attributes: true, attributeFilter: ['hidden'] });
  dlg.addEventListener('close', () => { if (!form.hidden) form.hidden = true; });
  $(closeBtnId)?.addEventListener('click', () => { form.hidden = true; });
  sync();
}

/* ---------- startup: address wins, then the startup preference ---------- */
function navStartup() {
  document.body.classList.add('shell');
  renderNav();
  // the session controls belong to the Updates page, not the global header
  $('sessionBar').append($('sessStatus'), $('btnPause'), $('btnResume'), $('btnAbort'));
  try { if (localStorage.getItem('st-nav-collapsed') === '1') setNavCollapsed(true); } catch {}
  setAgentDock(prefAgentDock());
  formAsModal('connForm', 'connFormModal', 'connFormHost', 'btnConnFormClose');
  formAsModal('addServerForm', 'serverFormModal', 'serverFormHost', 'btnServerFormClose');
  initDeployNavSwitcher();
  initAuditFilters();
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
