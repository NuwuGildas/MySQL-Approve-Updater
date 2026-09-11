/* Global search (Ctrl/⌘ K): one field over pages, actions, projects and every deploy resource.
   Typing "<prefix>:" scopes the search to a single kind — projects:, targets:, repos:, servers:,
   connectors:, secrets:, connections:, runs:, tables:, settings: — the way the Cloudflare dashboard
   search works. Sources are fetched lazily, cached for a few seconds and searched in the browser. */
'use strict';

const CMDK_RECENTS_KEY = 'st-search-recents';
const CMDK_TTL_MS = 20000;
const CMDK_MAX_PER_GROUP = 7;
const cmdk = { scope: null, q: '', rows: [], active: 0, cache: new Map(), pending: 0, seq: 0, lastOpener: null };

const CMDK_SVG = {
  page: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>',
  repo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="6" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/><circle cx="18" cy="9" r="2.4"/><path d="M6 8.4v7.2M18 11.4c0 4-6 2.6-9.6 5.4"/></svg>',
  key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="8" cy="12" r="4"/><path d="M12 12h9M17 12v3.5M20 12v2.5"/></svg>',
  table: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9.5h18M9 9.5V20"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M13 3L5 13h6l-1 8 8-10h-6z"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M13 6.5l6 5.5-6 5.5"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>',
};
const cmdkIcon = (name) => (typeof CC_ICON !== 'undefined' && CC_ICON[name]) || (typeof NAV_ICON !== 'undefined' && NAV_ICON[name]) || CMDK_SVG[name] || CMDK_SVG.page;

/* ---------- sources: one per searchable kind ----------
   Only the core's own sources live here. A module adds its searchable kinds
   through host.registerSearchSource() and they leave with the module, cache
   included. */
const CMDK_CORE_SOURCES = [
  {
    key: 'connections', prefixes: ['connections', 'connection', 'db'], label: 'Database connections', icon: 'db',
    tip: 'Search database connection profiles',
    fetch: () => api('/api/connections').then((d) => (d.profiles || []).map((p) => ({ ...p, _active: p.id === d.activeId }))),
    map: (p) => ({ title: p.name, sub: `${p.db?.user || ''}@${p.db?.host || ''}${p.db?.database ? ' · ' + p.db.database : ''}${p._active ? ' · active' : ''}`, action: { k: 'route', to: '#/connections' } }),
  },
  {
    key: 'tables', prefixes: ['tables', 'table', 'schema'], label: 'Database tables', icon: 'schema',
    tip: 'Search tables in the active database',
    fetch: () => api('/api/schema').then((d) => d.tables || []),
    map: (t) => ({ title: t.name || t.table || String(t), sub: t.rows != null ? `${t.rows} row(s)` : 'table', action: { k: 'table', name: t.name || t.table || String(t) } }),
  },
  {
    key: 'settings', prefixes: ['settings', 'setting', 'prefs'], label: 'Settings', icon: 'settings',
    tip: 'Jump to a settings section',
    local: true,
    fetch: async () => Object.entries({ ...CORE_SETTINGS_SECTIONS, ...Object.fromEntries(HostSDK.settingsSections.values().map((s) => [s.id, s.label])) }).map(([sec, label]) => ({ sec, label })),
    map: (s) => ({ title: s.label, sub: `settings · ${s.sec}`, action: { k: 'route', to: `#/settings/${s.sec}` } }),
  },
];
/** Core sources plus every source registered by an installed module. */
const cmdkSources = () => [...CMDK_CORE_SOURCES, ...HostSDK.searchSources.values()];
const cmdkSource = (key) => cmdkSources().find((s) => s.key === key);
/* A remembered result stays in Recents but is only offered while whatever owns
   it is still installed. */
const cmdkActionAvailable = (a) => {
  if (!a) return false;
  if (a.src) return !!cmdkSource(a.src);
  if (a.k === 'route') return !!parseRoute(a.to);
  if (a.k === 'cmd') return !!cmdkCommandDef(a.id);
  return true;
};

/* ---------- one-off actions ---------- */
const CMDK_CORE_COMMANDS = [
  { id: 'ai', title: 'Open the AI assistant', sub: 'Chat about the current project', action: { k: 'cmd', id: 'ai' } },
  { id: 'tour', title: 'Guided tour', sub: 'Walk through the app', action: { k: 'cmd', id: 'tour' } },
  { id: 'theme', title: 'Toggle light / dark theme', sub: 'Appearance', action: { k: 'cmd', id: 'theme' } },
];
const cmdkCommands = () => [...CMDK_CORE_COMMANDS, ...HostSDK.commands.values().map((c) => ({ ...c, action: { k: 'cmd', id: c.id } }))];
const cmdkCommandDef = (id) => cmdkCommands().find((c) => c.id === id) || null;

/* ---------- loading + cache ---------- */
async function cmdkLoad(src, { force = false } = {}) {
  const hit = cmdk.cache.get(src.key);
  if (!force && hit && Date.now() - hit.at < CMDK_TTL_MS) return hit.rows;
  if (hit?.inflight) return hit.inflight;
  const inflight = Promise.resolve()
    .then(() => src.fetch())
    .then((rows) => { cmdk.cache.set(src.key, { at: Date.now(), rows: Array.isArray(rows) ? rows : [] }); return cmdk.cache.get(src.key).rows; })
    .catch((e) => { cmdk.cache.set(src.key, { at: Date.now(), rows: [], err: e.message }); return []; });
  cmdk.cache.set(src.key, { ...(hit || { at: 0, rows: [] }), inflight });
  cmdk.pending++;
  const mySeq = cmdk.seq;
  inflight.finally(() => { cmdk.pending--; if (cmdk.seq === mySeq && cmdkIsOpen()) cmdkRender(); });
  return inflight;
}
/** Warm every source (or just one when scoped) without blocking the first paint. */
function cmdkWarm(only) {
  for (const s of cmdkSources()) { if (only && s.key !== only.key) continue; cmdkLoad(s); }
}
const cmdkRows = (src) => cmdk.cache.get(src.key)?.rows || [];

/* ---------- matching ---------- */
/** 4 = title prefix, 3 = inside the title, 2 = inside the description, 1 = fuzzy on the title, 0 = no match. */
function cmdkScore(item, q) {
  if (!q) return 1;
  const needle = q.toLowerCase();
  const t = String(item.title || '').toLowerCase();
  const s = `${item.sub || ''} ${item.hay || ''}`.toLowerCase();
  if (t.startsWith(needle)) return 4;
  const i = t.indexOf(needle);
  if (i > 0) return /[\s\-_/.:@]/.test(t[i - 1]) ? 3.5 : 3;
  if (s.includes(needle)) return 2;
  if (needle.length >= 3) { let k = 0; for (const ch of t) { if (ch === needle[k]) k++; if (k === needle.length) return 1; } }
  return 0;
}
function cmdkMark(text, q) {
  const s = String(text ?? '');
  if (!q) return esc(s);
  const i = s.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return esc(s);
  return `${esc(s.slice(0, i))}<mark>${esc(s.slice(i, i + q.length))}</mark>${esc(s.slice(i + q.length))}`;
}

/** Parse "prefix:rest" into a scope + query. The prefix stays visible in the field. */
function cmdkParse(value) {
  const m = /^\s*([A-Za-z]+):\s*([\s\S]*)$/.exec(value || '');
  if (m) { const src = cmdkSources().find((s) => s.prefixes.includes(m[1].toLowerCase())); if (src) return { scope: src, q: m[2].trim() }; }
  return { scope: null, q: String(value || '').trim() };
}

/* ---------- recents ---------- */
function cmdkRecents() { try { const r = JSON.parse(localStorage.getItem(CMDK_RECENTS_KEY) || '[]'); return Array.isArray(r) ? r.slice(0, 6) : []; } catch { return []; } }
function cmdkRemember(item) {
  if (!item?.action) return;
  const rec = { title: item.title, sub: item.sub || '', group: item.group || '', icon: item.icon || 'page', action: item.action };
  const key = JSON.stringify(rec.action);
  const list = [rec, ...cmdkRecents().filter((r) => JSON.stringify(r.action) !== key)].slice(0, 6);
  try { localStorage.setItem(CMDK_RECENTS_KEY, JSON.stringify(list)); } catch {}
}

/* ---------- build the visible rows ---------- */
function cmdkBuild() {
  const { scope, q } = cmdk;
  const rows = [];
  const push = (label, items, extra) => { if (!items.length) return; rows.push({ type: 'head', label, extra }); for (const it of items) rows.push({ type: 'item', ...it }); };
  const rank = (list) => {
    const scored = list.map((x) => ({ x, s: cmdkScore(x, q) })).filter((r) => r.s > 0);
    const floor = scored.some((r) => r.s >= 2) ? 2 : 1; // fuzzy hits only stand in when nothing matches properly
    if (!q) return scored.map((r) => r.x); // no query: keep the source's own order
    return scored.filter((r) => r.s >= floor).sort((a, b) => b.s - a.s || String(a.x.title).length - String(b.x.title).length).map((r) => r.x);
  };

  if (scope) {
    const all = cmdkRows(scope).map((raw) => ({ ...scope.map(raw), group: scope.label, icon: scope.icon }));
    const hits = rank(all);
    const err = cmdk.cache.get(scope.key)?.err;
    push(scope.label, hits.slice(0, 60), hits.length > 60 ? `${hits.length} matches` : `${hits.length}`);
    if (!hits.length) rows.push({ type: 'empty', label: err ? `${scope.label} could not be loaded: ${err}` : cmdk.pending ? `Loading ${scope.label.toLowerCase()}…` : `No ${scope.label.toLowerCase()} match “${q}”.` });
    return rows;
  }

  if (!q) {
    const rec = cmdkRecents().filter(r => cmdkActionAvailable(r.action)).map((r) => ({ ...r, recent: true }));
    push('Recents', rec);
    push('Search tips', cmdkSources().map((s) => ({ title: `${s.prefixes[0]}:`, sub: s.tip, icon: s.icon, group: 'Search tips', tipFor: s.key, action: { k: 'tip', prefix: s.prefixes[0] } })));
    return rows;
  }

  // pages first: they are local, and the registry only holds installed ones
  const pages = (typeof cmdkPages === 'function' ? cmdkPages() : []).map((n) => ({
    title: n.title || n.label, sub: [n.group, n.label !== (n.title || n.label) ? n.label : ''].filter(Boolean).join(' › '), icon: null, iconHtml: n.icon, group: 'Go to',
    hay: `${n.label} ${n.title || ''} ${n.desc || ''}`, action: n.route ? { k: 'route', to: n.route } : { k: 'cmd', id: n.action || 'tour' },
  }));
  push('Go to', rank(pages).slice(0, CMDK_MAX_PER_GROUP));
  push('Actions', rank(cmdkCommands().map((c) => ({ ...c, icon: 'bolt', group: 'Actions' }))).slice(0, 4));

  for (const src of cmdkSources()) {
    const all = cmdkRows(src).map((raw) => { const row = src.map(raw); return { ...row, action: { ...row.action, src: src.key }, group: src.label, icon: src.icon }; });
    const hits = rank(all);
    push(src.label, hits.slice(0, CMDK_MAX_PER_GROUP), hits.length > CMDK_MAX_PER_GROUP ? `${hits.length} matches · type “${src.prefixes[0]}:” for all` : '');
  }

  const tips = cmdkSources().filter((s) => s.prefixes.some((p) => p.startsWith(q.toLowerCase())) || s.label.toLowerCase().includes(q.toLowerCase()))
    .map((s) => ({ title: `${s.prefixes[0]}:`, sub: s.tip, icon: s.icon, group: 'Search tips', action: { k: 'tip', prefix: s.prefixes[0] } }));
  push('Search tips', tips);

  if (!rows.some((r) => r.type === 'item')) rows.push({ type: 'empty', label: cmdk.pending ? 'Searching…' : `Nothing matches “${q}”.` });
  return rows;
}

/* ---------- render ---------- */
const cmdkIsOpen = () => $('cmdkModal')?.open;
function cmdkRender() {
  cmdk.rows = cmdkBuild();
  const items = cmdk.rows.filter((r) => r.type === 'item');
  if (cmdk.active >= items.length) cmdk.active = Math.max(0, items.length - 1);
  let i = -1;
  const html = cmdk.rows.map((r) => {
    if (r.type === 'head') return `<div class="cmdk-head">${esc(r.label)}${r.extra ? `<span>${esc(r.extra)}</span>` : ''}</div>`;
    if (r.type === 'empty') return `<div class="cmdk-empty">${esc(r.label)}</div>`;
    i++;
    const on = i === cmdk.active;
    const ic = r.iconHtml || (r.dot ? `<span class="cmdk-dot" style="--proj-color:${esc(r.dot)}"></span>` : cmdkIcon(r.icon || 'page'));
    return `<div class="cmdk-row${on ? ' on' : ''}" role="option" aria-selected="${on}" id="cmdk-o${i}" data-i="${i}">
      <span class="cmdk-ic" aria-hidden="true">${ic}</span>
      <span class="cmdk-title">${cmdkMark(r.title, cmdk.q)}</span>
      ${r.sub ? `<span class="cmdk-dash" aria-hidden="true">—</span><span class="cmdk-sub">${cmdkMark(r.sub, cmdk.q)}</span>` : ''}
      ${r.recent ? '<span class="cmdk-tag">recent</span>' : ''}
      <span class="cmdk-go" aria-hidden="true">${CMDK_SVG.arrow}</span>
    </div>`;
  }).join('');
  const list = $('cmdkList');
  list.innerHTML = html;
  list.querySelectorAll('.cmdk-row').forEach((el) => {
    el.addEventListener('mousemove', () => { const n = Number(el.dataset.i); if (n !== cmdk.active) { cmdk.active = n; cmdkPaint(); } });
    el.addEventListener('click', () => { cmdk.active = Number(el.dataset.i); cmdkSelect(); });
  });
  $('cmdkInput').setAttribute('aria-activedescendant', items.length ? `cmdk-o${cmdk.active}` : '');
  $('cmdkStatus').textContent = cmdk.pending ? 'loading…' : cmdk.scope ? `${cmdk.scope.label.toLowerCase()} scope` : '';
  $('cmdkScope').hidden = !cmdk.scope;
  if (cmdk.scope) $('cmdkScope').textContent = cmdk.scope.label;
  cmdkScrollIntoView();
}
/** Repaint only the active row (cheap: used by arrow keys and hover). */
function cmdkPaint() {
  const rows = $('cmdkList').querySelectorAll('.cmdk-row');
  rows.forEach((el) => { const on = Number(el.dataset.i) === cmdk.active; el.classList.toggle('on', on); el.setAttribute('aria-selected', String(on)); });
  $('cmdkInput').setAttribute('aria-activedescendant', rows.length ? `cmdk-o${cmdk.active}` : '');
  cmdkScrollIntoView();
}
function cmdkScrollIntoView() {
  const el = $('cmdkList').querySelector('.cmdk-row.on'); if (!el) return;
  const list = $('cmdkList'), r = el.getBoundingClientRect(), lr = list.getBoundingClientRect();
  if (r.top < lr.top + 28) list.scrollTop -= lr.top + 28 - r.top;
  else if (r.bottom > lr.bottom) list.scrollTop += r.bottom - lr.bottom;
}

/* ---------- selection ---------- */
function cmdkItems() { return cmdk.rows.filter((r) => r.type === 'item'); }
function cmdkMove(delta) {
  const n = cmdkItems().length; if (!n) return;
  cmdk.active = (cmdk.active + delta + n) % n;
  cmdkPaint();
}
function cmdkSelect() {
  const item = cmdkItems()[cmdk.active]; if (!item) return;
  if (item.action?.k === 'tip') { cmdkSetValue(`${item.action.prefix}:`); return; }
  cmdkRemember(item);
  cmdkClose();
  try { cmdkRun(item.action); } catch (e) { toast(e.message, 'error'); }
}
function cmdkSetValue(v) {
  const input = $('cmdkInput');
  input.value = v; input.focus();
  const p = cmdkParse(v); cmdk.scope = p.scope; cmdk.q = p.q; cmdk.active = 0;
  if (p.scope) cmdkWarm(p.scope); else cmdkWarm();
  cmdkRender();
}

/* ---------- actions ---------- */
function cmdkFlash(el) { if (!el) return; el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.add('cmdk-flash'); setTimeout(() => el.classList.remove('cmdk-flash'), 1600); }
const cmdkGo = (route) => (typeof navigate === 'function' ? navigate(route) : (location.hash = route));
const cmdkAfter = (fn, ms = 260) => setTimeout(() => { try { fn(); } catch {} }, ms);

/** Pages the palette can jump to: whatever the page registry holds right now. */
function cmdkPages() {
  return HostSDK.pages.values().filter((p) => p.label).map((p) => ({
    id: p.id, label: p.label, title: p.title, desc: p.desc, icon: p.icon, group: p.group || '',
    route: p.route || '#/' + p.segment + (p.sub ? '/' + p.sub : ''),
  })).concat(HostSDK.navItems.values().filter((n) => n.label && n.action).map((n) => ({ ...n, route: null })));
}

function cmdkRun(a) {
  if (!a) return;
  // A result that came from a module's own source is run by that module.
  if (a.src) { const source = cmdkSource(a.src); if (source?.run) return source.run(a); }
  switch (a.k) {
    case 'route': cmdkGo(a.to); break;
    case 'table':
      cmdkGo('#/database/schema');
      cmdkAfter(() => { const f = $('schemaFilter'); if (f) { f.value = a.name; if (typeof loadSchemaMap === 'function') loadSchemaMap(a.name); } }, 320);
      break;
    case 'cmd': cmdkCommand(a.id); break;
    default: break;
  }
}
function cmdkCommand(id) {
  const registered = HostSDK.commands.get(id);
  if (registered?.run) return registered.run();
  if (id === 'ai') { if (typeof openAgent === 'function') openAgent(); }
  else if (id === 'tour') { if (typeof startTour === 'function') startTour(); }
  else if (id === 'theme') { const now = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light'; if (typeof applyTheme === 'function') applyTheme(now); else document.documentElement.setAttribute('data-theme', now); }
}

/* ---------- open / close ---------- */
function cmdkOpen(prefill = '') {
  const dlg = $('cmdkModal'); if (!dlg || dlg.open) return;
  cmdk.lastOpener = document.activeElement;
  cmdk.seq++; cmdk.active = 0;
  dlg.showModal();
  cmdkSetValue(prefill);
  $('cmdkInput').select();
  cmdkWarm(cmdk.scope || undefined);
}
function cmdkClose() { const dlg = $('cmdkModal'); if (dlg?.open) dlg.close(); }

(function wireCmdk() {
  const dlg = $('cmdkModal'); if (!dlg) return;
  const input = $('cmdkInput');
  input.addEventListener('input', () => cmdkSetValue(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); cmdkMove(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cmdkMove(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); cmdkSelect(); }
    else if (e.key === 'Tab' && cmdkItems()[cmdk.active]?.action?.k === 'tip') { e.preventDefault(); cmdkSetValue(`${cmdkItems()[cmdk.active].action.prefix}:`); }
    else if (e.key === 'Escape' && cmdk.scope) { e.preventDefault(); e.stopPropagation(); cmdkSetValue(''); } // first Escape leaves the scope
    else if (e.key === 'Backspace' && cmdk.scope && input.selectionStart === 0 && input.selectionEnd === 0) { e.preventDefault(); cmdkSetValue(''); }
  });
  dlg.addEventListener('close', () => { cmdk.seq++; const back = cmdk.lastOpener; if (back?.isConnected) { try { back.focus({ preventScroll: true }); } catch {} } });
  dlg.addEventListener('mousedown', (e) => { if (e.target === dlg) cmdkClose(); }); // click outside the cards
  $('btnSearch')?.addEventListener('click', () => cmdkOpen());
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); if (cmdkIsOpen()) cmdkClose(); else cmdkOpen(); }
  });
})();

/* A removed module takes its search results with it: drop any cached rows whose
   source is gone, and repaint if the palette happens to be open. */
HostSDK.searchSources.onChange(() => {
  for (const key of [...cmdk.cache.keys()]) if (!cmdkSource(key)) cmdk.cache.delete(key);
  if (cmdkIsOpen()) cmdkRender();
});
HostSDK.pages.onChange(() => { if (cmdkIsOpen()) cmdkRender(); });
