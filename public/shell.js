/* ---------- init ---------- */
/* ================= Compass (orchestrator hub) =================
   A registry-driven launcher. Each tool declares how it opens; adding a future
   tool is just another entry here. "Workspace" tools reveal <main> (the MySQL
   tool); "panel" tools slide their drawer over the hub. */
const CC_ICON = {
  projects: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 11h18"/></svg>',
  connectors: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 7H6a3 3 0 0 0 0 6h3M15 7h3a3 3 0 0 1 0 6h-3"/><path d="M8 10h8"/><path d="M12 13v4M9 21h6M12 17l-2 4M12 17l2 4"/></svg>',
  db: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>',
  console: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/></svg>',
  schema: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="7" height="6" rx="1"/><rect x="14" y="15" width="7" height="6" rx="1"/><rect x="3" y="15" width="7" height="6" rx="1"/><path d="M6.5 9v3h11v3M6.5 15v-3"/></svg>',
  server: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/></svg>',
  history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>',
  rocket: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 4c3-1 6-1 6-1s0 3-1 6c-1.5 4-5 7-8 9l-4-4c2-3 5-6.5 9-8z"/><path d="M9 15l-3 6 6-3"/><circle cx="14.5" cy="9.5" r="1.5"/><path d="M5 12l-2 1 3 3M12 19l1 2 3-3"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
};
const NAV_TILE_MODULES = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M17.5 14.5v6M14.5 17.5h6"/></svg>';
/* Core launcher tiles. Modules add their own through host.registerLauncherTile()
   and those disappear again the moment the module is removed. */
const CORE_TOOLS = [
  { id: 'mysql', name: 'Updates', route: '#/database/updates', tag: 'Database', accent: '--accent', icon: CC_ICON.db, order: 10,
    desc: 'Rule-based batch updates with preview, per-row human approval and backups.',
    launch: () => revealWorkspace('MySQL Update Tool') },
  { id: 'sql', name: 'SQL console', route: '#/database/sql', tag: 'Database', accent: '--green', icon: CC_ICON.console, order: 11,
    desc: 'Read-only SQL console with schema autocomplete, export, and AI query generation.',
    launch: () => { revealWorkspace('SQL Console'); if (!$('sqlConsole').classList.contains('open')) toggleSqlConsole(); } },
  { id: 'schema', name: 'Schema map', route: '#/database/schema', tag: 'Database', accent: '--purple', icon: CC_ICON.schema, order: 12,
    desc: 'Visualize tables and relations; inspect columns, row counts and CREATE TABLE.',
    launch: () => { revealWorkspace('Schema Map'); $('btnSchemaMap').click(); } },
  { id: 'settings', name: 'Settings', tag: 'Configure', accent: '--muted', icon: CC_ICON.settings, order: 90,
    desc: 'View preferences, database & SSH connections, and MySQL tool limits.',
    launch: () => showSettings() },
  { id: 'modules', name: 'Modules', route: '#/modules', tag: 'Configure', accent: '--purple', icon: NAV_TILE_MODULES, order: 95,
    desc: 'Add optional tools — servers and terminals, deployments, connectors, projects, history — to this workspace.',
    launch: () => openModuleMarketplace() },
];
function registerCoreTools() { for (const tool of CORE_TOOLS) if (!HostSDK.launcherTiles.has(tool.id)) HostSDK.launcherTiles.add('core', tool.id, tool); }
/** Every tile on the Compass: the core's, plus whatever modules registered. */
const launcherTools = () => HostSDK.launcherTiles.values().slice().sort((a, b) => (a.order || 50) - (b.order || 50));
// The AI assistant is intentionally NOT a tile: it lives in the navbar with a
// global role and can intervene across every module (see the header button).
function toolStatus() { return null; }
function renderCompass() {
  const focusedTool = document.activeElement?.closest?.('#compassGrid [data-tool]')?.dataset.tool || null;
  const q = ($('compassSearch')?.value || '').toLowerCase().trim();
  const list = launcherTools().filter((t) => !q || `${t.name} ${t.desc} ${t.tag}`.toLowerCase().includes(q));
  $('compassGrid').innerHTML = list.map((t) => {
    const st = toolStatus(t);
    return `<button class="compass-card" data-tool="${t.id}" style="--tool-accent:var(${t.accent})">
      <span class="cc-icon">${t.icon}</span>
      <span class="cc-name">${esc(t.name)}</span>
      <span class="cc-desc">${esc(t.desc)}</span>
      <span class="cc-foot"><span class="cc-tag">${esc(t.tag)}</span>${st ? `<span class="cc-status ${st.on ? 'on' : ''}">${esc(st.text)}</span>` : ''}<span class="cc-open">Open →</span></span>
    </button>`;
  }).join('') || `<div class="empty" style="padding:1rem">No tools match "${esc(q)}".</div>`;
  $('compassGrid').querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => { const t = launcherTools().find((x) => x.id === b.dataset.tool); if (!t) return; if (typeof navigate === 'function' && t.route) navigate(t.route); else t.launch(); }));
  // re-rendering must not drop keyboard focus: keep it on the card that had it
  if (focusedTool) $('compassGrid').querySelector(`[data-tool="${focusedTool}"]`)?.focus({ preventScroll: true });
}
/* ---------- quick access: floating compass listing every module (visible everywhere) ---------- */
function renderQuickFab() {
  if (!$('qfabMenu')) return;
  const compassIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/></svg>';
  const items = launcherTools().map((t) => `<button class="qfab-item" role="menuitem" data-qf="${t.id}" style="--tool-accent:var(${t.accent})"><span class="qi">${t.icon}</span><span><b>${esc(t.name)}</b><span class="qd">${esc(t.tag)}</span></span></button>`).join('');
  $('qfabMenu').innerHTML = `<div class="qfab-head">Modules</div><button class="qfab-item" role="menuitem" data-qf="__compass"><span class="qi">${compassIcon}</span><span><b>Compass</b><span class="qd">Home</span></span></button>${items}<div class="qfab-head">Assistant</div><button class="qfab-item" role="menuitem" data-qf="__agent" style="--tool-accent:var(--accent)"><span class="qi"><img class="ai-mini" src="/assets/robot-logo-animated_1.svg" alt="" aria-hidden="true" style="height:18px"></span><span><b>AI agent</b><span class="qd">Works across every module</span></span></button>`;
}
if ($('quickFab')) $('quickFab').addEventListener('click', (e) => {
  const b = e.target.closest('[data-qf]');
  if (!b) { if (e.target.closest('.qfab-btn')) $('quickFab').classList.toggle('open'); return; }
  $('quickFab').classList.remove('open');
  const id = b.dataset.qf;
  if (id === '__compass') { navigate('#/home'); return; }
  if (id === '__agent') { openAgent(); return; }
  const t = launcherTools().find((x) => x.id === id); if (!t) return;
  if (t.route && typeof navigate === 'function') navigate(t.route); else t.launch();
});
if ($('quickFab')) { document.addEventListener('click', (e) => { if (!e.target.closest('#quickFab')) $('quickFab').classList.remove('open'); }); renderQuickFab(); raiseQuickFab(); }

const compassVisible = () => document.body.classList.contains('view-compass');
// which module the user is looking at: sent with each AI chat so replies are contextual
function currentModuleLabel() {
  // Whichever page is showing names itself; module pages come from the page registry.
  const page = typeof currentPageId === 'string' && currentPageId ? HostSDK.pages.get(currentPageId) : null;
  if (page && !['home', 'mysql', 'sql', 'schema'].includes(page.id)) return page.title || page.label || page.id;
  if ($('settingsModal').open) return 'Settings';
  if ($('schemaModal').open) return 'Schema Map';
  if (compassVisible()) return 'Compass (home)';
  if ($('sqlConsole').classList.contains('open')) return 'SQL Console';
  return $('toolCrumb').textContent || 'MySQL Update Tool';
}
/* Leaving for another view: every registered page closes itself. The AI agent
   window is deliberately excluded - it floats above every view and survives navigation. */
function closeAllDrawers() {
  for (const page of HostSDK.pages.values()) { try { page.leave?.(); } catch (error) { console.error(error); } }
  ['schemaModal', 'ddlModal'].forEach((id) => { const d = $(id); if (d && d.open) d.close(); });
}
function setView(v) { // 'compass' | 'mysql' | 'settings'
  document.body.classList.remove('view-compass', 'view-mysql', 'view-settings');
  document.body.classList.add('view-' + v);
  try { if (v !== 'settings') localStorage.setItem('st-last-view', v); } catch {}
}
function showCompass() {
  closeAllDrawers();
  if ($('sqlConsole').classList.contains('open')) toggleSqlConsole();
  setView('compass');
  $('toolCrumb').textContent = '';
  renderCompass();
  const s = $('compassSearch'); if (s) s.value = ''; // focus is handled by the router (page heading / opener)
}
let tourOffered = false;
function offerTourOnce() { if (tourOffered) return; tourOffered = true; if (!localStorage.getItem('mau-tour-seen')) setTimeout(startTour, 600); }
function revealWorkspace(crumb) { // leave the hub, show the MySQL workspace
  setView('mysql');
  $('toolCrumb').textContent = crumb || '';
  if (sqlEditor) sqlEditor.refresh();
  sqlTableRedraw();
  offerTourOnce();
}
function showSettings() { // Settings is a modal over the current view
  renderSettings();
  if (!$('settingsModal').open) $('settingsModal').showModal();
}
$('btnSettings').addEventListener('click', showSettings);
$('compassSearch').addEventListener('input', renderCompass);

/* ---------- Settings (modal) ---------- */
const prefStartup = () => { try { return localStorage.getItem('st-startup') || 'compass'; } catch { return 'compass'; } };
const prefAiSchema = () => { try { return localStorage.getItem('st-ai-schema') || 'ask'; } catch { return 'ask'; } };
const prefConfirmDestructive = () => { try { return localStorage.getItem('st-confirm-destructive') !== '0'; } catch { return true; } }; // default ON
// persist one server setting and reflect it locally
async function putSetting(patch) {
  try {
    const s = await api('/api/settings', { method: 'PUT', body: JSON.stringify(patch) });
    SQL_PAGE = s.sqlConsoleMaxRows;
    state.allowWrites = s.allowWrites;
    updateSqlModeHint();
    toast('Setting saved', 'success');
    return s;
  } catch (e) { toast('Save failed: ' + e.message, 'error'); throw e; }
}
async function renderSettings() {
  const horiz = document.body.classList.contains('drawers-h');
  $('setOrient').querySelectorAll('[data-orient]').forEach((b) => b.classList.toggle('on', (b.dataset.orient === 'horizontal') === horiz));
  $('setStartup').value = prefStartup();
  $('setAiSchema').value = prefAiSchema();
  $('setConfirmDestructive').checked = prefConfirmDestructive();
  try {
    const s = await api('/api/settings');
    $('setPreview').value = s.maxPreviewRows;
    $('setSqlPage').value = s.sqlConsoleMaxRows;
    $('setReqBackup').checked = !!s.requireBackupBeforeApprove;
    $('setAllowWrites').checked = !!s.allowWrites;
    document.querySelectorAll('#settingsModal [data-assist]').forEach((cb) => { cb.checked = !!s.aiAssist?.[cb.dataset.assist]; });
    $('setPreviewCeil').textContent = `(max ${s.ceilings.maxPreviewRows})`;
    $('setSqlPageCeil').textContent = `(max ${s.ceilings.sqlConsoleMaxRows})`;
    $('setDbName').textContent = state.config?.database || 'the database';
  } catch (e) { toast('Settings load failed: ' + e.message, 'error'); }
  try {
    const d = await api(projectUrl('/api/connections'));
    $('setConnCount').textContent = `${d.profiles.length}`;
    $('setConnList').innerHTML = d.profiles.length ? d.profiles.map((p) => `
      <div class="settings-row">
        <span class="sr-name">${esc(p.name)}</span>
        ${p.id === d.activeId ? '<span class="badge approved">active</span>' : ''}
        <span class="spacer"></span>
        <span class="sr-sub">${esc(p.db.user || '')}@${esc(p.db.host || '')}/${esc(p.db.database || '')}${p.ssh.enabled ? ' · ssh' : ''}</span>
      </div>`).join('') : '<div class="empty">No database connections.</div>';
  } catch (e) { $('setConnList').innerHTML = `<div class="empty" style="color:var(--red)">${esc(e.message)}</div>`; }
  renderModuleSettings();
}

/* ---------- settings contributed by modules ----------
   A module's section is its own container, moved into the settings body while
   it is installed and taken back with the module when it is removed. */
let selectedSettingsSection = 'appearance';
function renderModuleSettings() {
  const nav = $('settingsNav');
  const body = document.querySelector('#settingsModal .settings-body');
  if (!nav || !body) return;
  const wanted = HostSDK.settingsSections.values().slice().sort((a, b) => (a.order || 50) - (b.order || 50));
  for (const el of nav.querySelectorAll('[data-module-sec]')) if (!wanted.some((s) => s.id === el.dataset.sec)) el.remove();
  for (const section of wanted) {
    if (!nav.querySelector(`[data-sec="${section.id}"]`)) {
      const button = document.createElement('button');
      button.className = 'nav-item';
      button.dataset.sec = section.id;
      button.dataset.moduleSec = section.moduleId;
      button.textContent = section.label;
      nav.appendChild(button);
    }
    const el = section.mount();
    el.hidden = false;
    el.classList.add('settings-section');
    el.dataset.sec = section.id;
    if (el.parentElement !== body) body.appendChild(el);
    try { section.render?.(el); } catch (error) { console.error(error); }
  }
  for (const group of HostSDK.settingsGroups.values().slice().sort((a, b) => (a.order || 50) - (b.order || 50))) {
    const host = document.querySelector(`#settingsModal [data-slot="${group.section}"]`) || document.querySelector(`#settingsModal .settings-section[data-sec="${group.section}"]`);
    if (!host) continue;
    const el = group.mount();
    el.hidden = false;
    if (el.parentElement !== host) host.appendChild(el);
    try { group.render?.(el); } catch (error) { console.error(error); }
  }
  showSettingsSection(selectedSettingsSection);
}
HostSDK.settingsSections.onChange(() => { if ($('settingsModal')?.open) renderModuleSettings(); });
HostSDK.settingsGroups.onChange(() => { if ($('settingsModal')?.open) renderModuleSettings(); });
/* ---------- theme (dark / light / system) ---------- */
const prefTheme = () => { try { return localStorage.getItem('st-theme') || 'dark'; } catch { return 'dark'; } };
/* terminal colours follow the app theme (light: paper background, dark: console black) */
function termTheme() {
  return document.documentElement.dataset.theme === 'light'
    ? { background: '#f0f3f7', foreground: '#1b2430', cursor: '#1e6fd9', cursorAccent: '#ffffff', selectionBackground: '#1e6fd933', black: '#1b2430', red: '#c9333a', green: '#1f8a4c', yellow: '#b8791d', blue: '#1e6fd9', magenta: '#6b4fd8', cyan: '#0e7490', white: '#5f6f82', brightBlack: '#5f6f82', brightRed: '#c9333a', brightGreen: '#1f8a4c', brightYellow: '#b8791d', brightBlue: '#1e6fd9', brightMagenta: '#6b4fd8', brightCyan: '#0e7490', brightWhite: '#1b2430' }
    : { background: '#0b0f13', foreground: '#dce3ea', cursor: '#4da3ff' };
}
function applyTheme(pref) {
  const t = pref === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : pref;
  document.documentElement.dataset.theme = t;
  HostSDK.bus.emit('theme:change', { theme: t, preference: pref, terminal: termTheme() }); // modules restyle their own views
  try { localStorage.setItem('st-theme', pref); } catch {}
  document.querySelectorAll('#setTheme [data-theme]').forEach((b) => b.classList.toggle('on', b.dataset.theme === pref));
}
applyTheme(prefTheme());
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (prefTheme() === 'system') applyTheme('system'); });
const toggleTheme = () => applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
$('btnTheme').addEventListener('click', toggleTheme);
$('setTheme').addEventListener('click', (e) => { const b = e.target.closest('[data-theme]'); if (b) applyTheme(b.dataset.theme); });

// client preferences (auto-save)
$('setOrient').addEventListener('click', (e) => { const b = e.target.closest('[data-orient]'); if (!b) return; applyDrawerOrient(b.dataset.orient); renderSettings(); });
$('setStartup').addEventListener('change', () => { try { localStorage.setItem('st-startup', $('setStartup').value); } catch {} });
$('setAiSchema').addEventListener('change', () => { try { localStorage.setItem('st-ai-schema', $('setAiSchema').value); } catch {} });
$('setConfirmDestructive').addEventListener('change', () => { try { localStorage.setItem('st-confirm-destructive', $('setConfirmDestructive').checked ? '1' : '0'); } catch {} });
// server settings (auto-save on change)
$('setAllowWrites').addEventListener('change', async () => {
  const on = $('setAllowWrites').checked;
  if (on) { const ok = await confirmDialog({ title: 'Enable write statements?', message: 'The SQL console will run <b>INSERT / UPDATE / DELETE / CREATE / DROP</b> directly against the connected database, with no per-row approval.<br>Only enable this if you know what you are doing.', okLabel: 'Enable writes', okClass: 'reject' }); if (!ok) { $('setAllowWrites').checked = false; return; } }
  putSetting({ allowWrites: on });
});
$('setReqBackup').addEventListener('change', () => putSetting({ requireBackupBeforeApprove: $('setReqBackup').checked }));
$('setSqlPage').addEventListener('change', () => putSetting({ sqlConsoleMaxRows: Number($('setSqlPage').value) }).then((s) => { if (s) $('setSqlPage').value = s.sqlConsoleMaxRows; }));
$('setPreview').addEventListener('change', () => putSetting({ maxPreviewRows: Number($('setPreview').value) }).then((s) => { if (s) $('setPreview').value = s.maxPreviewRows; }));
$('btnSettingsClose').addEventListener('click', () => $('settingsModal').close());
// AI assistant: opt-in deploy capabilities (server-side, they gate the assistant's tools)
document.querySelectorAll('#settingsModal [data-assist]').forEach((cb) => cb.addEventListener('change', async () => {
  try { await putSetting({ aiAssist: { [cb.dataset.assist]: cb.checked } }); HostSDK.bus.emit('settings:change', { aiAssist: { [cb.dataset.assist]: cb.checked } }); }
  catch { cb.checked = !cb.checked; }
}));
$('btnManageConns').addEventListener('click', () => { $('settingsModal').close(); $('connForm').hidden = true; loadConns().catch((e) => toast(e.message)); $('connModal').showModal(); });
// nav sidebar: switch the visible section + breadcrumb. Core sections only; a
// module's section is added to this map for as long as the module is installed.
const CORE_SETTINGS_SECTIONS = { appearance: 'Appearance & view', sql: 'SQL console', rules: 'Rules & preview', ai: 'AI assistant', db: 'Database connections' };
const settingsSectionLabel = (sec) => CORE_SETTINGS_SECTIONS[sec] || HostSDK.settingsSections.get(sec)?.label || null;
function showSettingsSection(sec) {
  if (!settingsSectionLabel(sec)) sec = 'appearance';
  selectedSettingsSection = sec;
  document.querySelectorAll('#settingsNav .nav-item').forEach((b) => b.classList.toggle('active', b.dataset.sec === sec));
  document.querySelectorAll('.settings-section').forEach((s) => s.classList.toggle('active', s.dataset.sec === sec));
  $('settingsCrumb').textContent = settingsSectionLabel(sec);
}
$('settingsNav').addEventListener('click', (e) => { const b = e.target.closest('.nav-item'); if (b) showSettingsSection(b.dataset.sec); });
$('settingsSearch').addEventListener('input', () => {
  const q = $('settingsSearch').value.toLowerCase().trim();
  let first = null;
  document.querySelectorAll('#settingsNav .nav-item').forEach((b) => { const hit = !q || b.textContent.toLowerCase().includes(q); b.hidden = !hit; if (hit && !first) first = b; });
  if (q && first) showSettingsSection(first.dataset.sec);
});

/* ---------- drawer orientation (vertical/right or horizontal/bottom): docked drawers only ---------- */
const DRAWER_ORIENT_KEY = 'st-drawer-orient';
const DOCK_ICON = {
  vertical: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="18" height="16" rx="2"/><rect x="14" y="5" width="6.5" height="14" rx="1" fill="currentColor" stroke="none"/></svg>',
  horizontal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="18" height="16" rx="2"/><rect x="4" y="13.5" width="16" height="5.5" rx="1" fill="currentColor" stroke="none"/></svg>',
};
function applyDrawerOrient(o) {
  const horizontal = o === 'horizontal';
  document.body.classList.toggle('drawers-h', horizontal);
  document.querySelectorAll('.btn-dock').forEach((b) => {
    b.innerHTML = horizontal ? DOCK_ICON.horizontal : DOCK_ICON.vertical;
    b.title = horizontal ? 'Docked at the bottom (horizontal): click to dock right' : 'Docked at the right (vertical): click to dock at the bottom';
  });
  try { localStorage.setItem(DRAWER_ORIENT_KEY, horizontal ? 'horizontal' : 'vertical'); } catch {}
  HostSDK.bus.emit('layout:change', { orientation: horizontal ? 'horizontal' : 'vertical' }); // views that measure themselves refit
}
function toggleDrawerOrient() { applyDrawerOrient(document.body.classList.contains('drawers-h') ? 'vertical' : 'horizontal'); }
document.querySelectorAll('.btn-dock').forEach((b) => b.addEventListener('click', toggleDrawerOrient));
applyDrawerOrient(localStorage.getItem(DRAWER_ORIENT_KEY) || 'vertical'); // restore saved choice (no animation yet)
// enable slide transitions only after the initial orientation is painted
requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.add('drawers-ready')));

/* ---------- Drawers: inert while closed, focus returns to the opener ----------
   The side drawers slide off-screen with a transform, which keeps their controls in the tab order.
   The inert attribute follows the .open class, and the element that opened a drawer gets focus back. */
function drawerA11y(el) {
  let opener = null;
  let wasOpen = el.classList.contains('open');
  el.toggleAttribute('inert', !wasOpen);
  return () => {
    const open = el.classList.contains('open');
    if (open === wasOpen) return;
    wasOpen = open;
    if (open) {
      el.removeAttribute('inert');
      const a = document.activeElement;
      if (a && a !== document.body && !el.contains(a)) {
        opener = { el: a, sel: a.dataset?.tool ? `#compassGrid [data-tool="${a.dataset.tool}"]` : a.dataset?.nav ? `#appNav [data-nav="${a.dataset.nav}"]` : a.id ? '#' + a.id : null };
      }
    } else {
      const inside = el.contains(document.activeElement);
      el.setAttribute('inert', '');
      // Home re-renders its cards, so look up a disconnected opener again.
      const back = opener ? (opener.el.isConnected ? opener.el : opener.sel ? document.querySelector(opener.sel) : null) : null;
      if (inside || document.activeElement === document.body) {
        if (back && !back.closest('[inert]')) back.focus();
        else $('appNav')?.querySelector('[aria-current]')?.focus();
      }
    }
  };
}

/* ---------- AI assistant: free-floating window (drag by header, resize from corner) ---------- */
const AI_GEOM_KEY = 'st-ai-geom';
let agentUserResized = false; // set once the corner grip is used; until then the window hugs its content

/* On a phone the assistant is an action sheet: it rises from the bottom edge,
   full width, and is dismissed rather than arranged. A saved window position
   means nothing there - and it is written as INLINE styles, which beat any
   stylesheet - so geometry is neither restored nor saved at this size. Same
   breakpoint as the rest of the shell. */
const AGENT_SHEET = window.matchMedia('(max-width: 767px)');
const agentIsSheet = () => AGENT_SHEET.matches && !$('agentDrawer')?.classList.contains('ag-docked');
/** Drop inline geometry, so the sheet is placed purely by CSS. */
function clearAgentGeom() {
  const el = $('agentDrawer'); if (!el) return;
  for (const property of ['left', 'top', 'right', 'bottom', 'width', 'height']) el.style.removeProperty(property);
}

function saveAgentGeom() {
  const el = $('agentDrawer'); if (el.classList.contains('ag-docked')) return; // a pane has no window geometry
  if (agentIsSheet()) return;                                                  // and a sheet has none either
  const r = el.getBoundingClientRect();
  const h = agentUserResized || el.style.height ? r.height : null;
  try { localStorage.setItem(AI_GEOM_KEY, JSON.stringify({ left: r.left, top: r.top, w: r.width, h })); } catch {}
}
function restoreAgentGeom() { // called when the window opens
  const el = $('agentDrawer');
  if (el.classList.contains('ag-docked')) return; // sized by the workspace pane, not by the saved window
  if (agentIsSheet()) { clearAgentGeom(); return; } // a sheet is placed by the stylesheet, edge to edge
  let g = null; try { g = JSON.parse(localStorage.getItem(AI_GEOM_KEY)); } catch {}
  if (!g) return;
  el.style.width = Math.min(g.w, window.innerWidth * 0.96) + 'px';
  if (g.h) el.style.height = Math.min(g.h, window.innerHeight * 0.8) + 'px';
  el.style.left = Math.min(Math.max(0, g.left), window.innerWidth - 80) + 'px';
  el.style.top = Math.min(Math.max(0, g.top), window.innerHeight - 60) + 'px';
  el.style.right = 'auto';
}
(function initAgentFloat() {
  const el = $('agentDrawer'); if (!el) return;
  const header = el.querySelector(':scope > div'); // the title/controls row is the drag handle
  header.addEventListener('pointerdown', (e) => {
    if (el.classList.contains('ag-docked')) return; // docked in the workspace: the header is not a drag handle
    if (agentIsSheet()) return;                     // an action sheet is anchored to the bottom edge, not dragged
    if (e.target.closest('button, input, .ag-menu')) return; // controls and the options menu are not drag targets
    const r = el.getBoundingClientRect();
    const ox = e.clientX - r.left, oy = e.clientY - r.top;
    // pin current position as left/top before dropping the right anchor (avoids a jump)
    el.style.left = r.left + 'px'; el.style.top = r.top + 'px'; el.style.right = 'auto';
    const move = (ev) => {
      el.style.left = Math.min(Math.max(0, ev.clientX - ox), window.innerWidth - 60) + 'px';
      el.style.top = Math.min(Math.max(0, ev.clientY - oy), window.innerHeight - 40) + 'px';
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); saveAgentGeom(); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    e.preventDefault();
  });
  // the native corner grip: a pointerdown near the bottom-right corner marks a user resize (content growth is not one)
  el.addEventListener('pointerdown', (e) => {
    const r = el.getBoundingClientRect();
    if (r.right - e.clientX < 22 && r.bottom - e.clientY < 22) agentUserResized = true;
  });
  let roTimer = 0; // persist size after the native corner-resize settles
  new ResizeObserver(() => { if (el.classList.contains('open') && agentUserResized && !agentIsSheet()) { clearTimeout(roTimer); roTimer = setTimeout(saveAgentGeom, 200); } }).observe(el);

  /* Crossing the breakpoint in either direction: inline geometry left over from
     the window would pin the sheet somewhere mid-screen (it beats the
     stylesheet), and geometry the sheet never had would leave the window
     unplaced. Clear on the way in, restore on the way out. */
  AGENT_SHEET.addEventListener('change', () => {
    if (agentIsSheet()) clearAgentGeom();
    else if (el.classList.contains('open')) restoreAgentGeom();
  });

  /* Tap outside to dismiss, the way every action sheet closes. The scrim is a
     popover ::backdrop, which paints but does not take pointer events, so the
     tap lands on whatever is behind it - listen on the document instead. The
     button that summoned the sheet is excluded: its own handler toggles. */
  document.addEventListener('pointerdown', (e) => {
    if (!agentIsSheet() || !el.classList.contains('open')) return;
    if (el.contains(e.target) || e.target.closest('#btnAiAgent')) return;
    closeAgentDrawer();
  }, true);
})();

async function startApplication() {
  registerCoreTools();
  await loadProjects();
  /* The active connection is stored on the server and the active project in this
     browser, so a session can start with a connection the project cannot see.
     Settle that before anything reads the connection. */
  await scopeConnectionsToProject().catch(() => {});
  setView('compass'); // safe default until the startup preference is applied
  try {
    const st = await api('/api/state');
    state.transformTypes = st.transformTypes;
    state.session = st.session;
    state.config = st.config;
    state.maxPreviewRows = st.config.maxPreviewRows;
    state.allowWrites = !!st.config.allowWrites;
    if (st.config.sqlConsoleMaxRows) SQL_PAGE = st.config.sqlConsoleMaxRows; // sync console pagination
    updateSqlModeHint();
    $('maxRows').textContent = st.config.maxPreviewRows;
    $('dbInfo').textContent = `profile: ${st.config.profile} · db: ${st.config.database || '(unset)'}${st.config.sshTunnel ? ' · via SSH tunnel' : ''}`;
    (st.recentLog || []).forEach(appendLog);
  } catch (err) { toast('Init failed: ' + err.message); }
  fillForm(null);
  await loadRules().catch((e) => toast(e.message));
  renderQueue(); renderDashboard();
  connectSSE();
  // land on the preferred startup view
  if (typeof navStartup === 'function') navStartup();
  else {
    const startup = prefStartup();
    const last = (() => { try { return localStorage.getItem('st-last-view'); } catch { return null; } })();
    if (startup === 'mysql' || (startup === 'last' && last === 'mysql')) revealWorkspace('MySQL Update Tool');
    else showCompass();
  }
}
