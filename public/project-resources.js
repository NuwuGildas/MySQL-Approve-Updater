/* Project resources: link reusable connections, servers, connectors and repositories.
   Deployment targets belong to one project; their owner can only change through target settings.

   Backend contract (server.js, lib/projects):
     GET    /api/projects                              → { readOnly, kinds, projects: [{ id, name, color, resources: { kind: [{ id, name, detail, missing? }] } }] }
     POST   /api/projects/:id/links  { kind, resourceId }  → updated project
     DELETE /api/projects/:id/links/:kind/:resourceId      → updated project
   Catalogs (what can be assigned): /api/connections, /api/ssh/sessions, /api/connectors,
   /api/deploy/repos, /api/deploy/targets. They are already masked by the server; this module still
   only ever renders a name and one non-secret detail (host, database, user, provider, type, URL).

   Entry points: openProjectResources(projectId?) — from the header button next to the project switcher,
   or from any other UI (window.openProjectResources). Loaded after app.js (uses $, api, esc, toast,
   currentProjectId, projects, renderProjectContext). Standalone otherwise: no other module is touched. */
'use strict';

const PR_KINDS = [
  { kind: 'connections', label: 'Connections', one: 'connection', hint: 'MySQL connection profiles (host, database, user).' },
  { kind: 'servers', label: 'Servers', one: 'server', hint: 'SSH-only server profiles. A database connection that tunnels over SSH is assigned as a connection.' },
  { kind: 'connectors', label: 'Connectors', one: 'connector', hint: 'GitHub and GitLab accounts.' },
  { kind: 'repos', label: 'Repositories', one: 'repository', hint: 'Deploy repositories (git or local folder).' },
  { kind: 'targets', label: 'Deployments', one: 'deployment', hint: 'Each deployment belongs to one project. Edit its Project setting to move it. Its server and repository remain reusable.' },
];
const PR_KIND_CLASS = { connections: 'db', servers: 'ssh', connectors: 'git', repos: 'repo', targets: 'target' };

const pr = {
  projectId: null, projects: [], readOnly: null,
  catalog: null,        // { kind: [{ id, name, detail }] } or null until loaded
  catalogErrors: {},    // kind → error message when that catalog could not be loaded
  tab: 'all', query: '',
  busy: new Set(),      // `${kind}/${id}` while a link/unlink call is in flight
  opened: false,
};

/* strip any user:token@ part from a URL before showing it (repos never store one, but never trust that) */
const prSafeUrl = (u) => String(u || '').replace(/^(\w+:\/\/)[^/@]+@/, '$1');
const prShortUrl = (u) => prSafeUrl(u).replace(/^https?:\/\//, '').replace(/\.git$/, '');

/* one catalog per kind, reduced to display fields only. Anything secret-like never leaves this function. */
const PR_CATALOGS = {
  connections: async () => (await api('/api/connections')).profiles.map((p) => ({
    id: p.id, name: p.name,
    detail: `${p.db?.database || ''} @ ${p.db?.host || ''}${p.db?.port ? ':' + p.db.port : ''}${p.db?.user ? ' · ' + p.db.user : ''}${p.ssh?.enabled ? ' · via SSH' : ''}`.trim(),
  })),
  // the server only lets SSH-only profiles be linked as "servers"; DB connections with a tunnel are connections
  servers: async () => (await api('/api/ssh/sessions')).sessions.filter((s) => s.sshOnly).map((s) => ({
    id: s.id, name: s.name, detail: `${s.user ? s.user + '@' : ''}${s.host || ''}${s.port && s.port !== 22 ? ':' + s.port : ''}`, live: s.connected,
  })),
  connectors: async () => { const d = await api('/api/connectors'); const label = (k) => d.providers?.find((p) => p.id === k)?.label || k; return d.connectors.map((c) => ({
    id: c.id, name: c.name, detail: `${label(c.kind)}${c.account?.login ? ' · @' + c.account.login : ''}${c.status && c.status !== 'ok' ? ' · ' + (c.status === 'error' ? 'verification failed' : 'not verified') : ''}`,
  })); },
  repos: async () => (await api('/api/deploy/repos')).repos.map((r) => ({
    id: r.id, name: r.name, detail: r.source?.kind === 'local' ? `local · ${r.source.path || ''}` : `git · ${prShortUrl(r.source?.url)}${r.source?.branch ? ' #' + r.source.branch : ''}`,
  })),
  targets: async () => (await api('/api/deploy/targets')).targets.map((t) => ({
    id: t.id, name: t.name, projectId: t.projectId, detail: `${t.type || ''}${t.transport?.host ? ' · ' + t.transport.host : t.host ? ' · ' + t.host : ''}${t.domain?.name ? ' · ' + t.domain.name : ''}`,
  })),
};

const prProject = () => pr.projects.find((p) => p.id === pr.projectId) || null;
const prModal = () => $('prjResModal');

/** Open the dialog for a project (defaults to the active project of the header switcher). */
async function openProjectResources(projectId) {
  const d = prModal(); if (!d) return;
  pr.projectId = projectId || (typeof currentProjectId === 'string' ? currentProjectId : null);
  pr.query = ''; $('prSearch').value = '';
  if (!d.open) d.showModal();
  pr.opened = true;
  prRenderLoading();
  await prLoad();
}
function closeProjectResources() { const d = prModal(); if (d?.open) d.close(); }

function prRenderLoading() {
  $('prList').innerHTML = '<div class="empty">Loading resources…</div>';
  $('prTabs').innerHTML = '';
  $('prSummary').textContent = '';
}

/** Fetch the project list (with readOnly) and every catalog. A failing catalog only disables its own kind. */
async function prLoad() {
  try {
    const d = await api('/api/projects');
    pr.projects = Array.isArray(d.projects) ? d.projects : [];
    pr.readOnly = d.readOnly || null;
  } catch (e) {
    $('prList').innerHTML = `<div class="empty" style="color:var(--red)">Could not load projects: ${esc(e.message)}</div>`;
    return;
  }
  if (!pr.projects.length) { $('prList').innerHTML = '<div class="empty">No projects yet.</div>'; prRenderHead(); return; }
  if (!prProject()) pr.projectId = pr.projects.some((p) => p.id === 'general') ? 'general' : pr.projects[0].id;
  const catalog = {}; pr.catalogErrors = {};
  await Promise.all(PR_KINDS.map(async ({ kind }) => {
    try { catalog[kind] = await PR_CATALOGS[kind](); }
    catch (e) { catalog[kind] = []; pr.catalogErrors[kind] = e.message; }
  }));
  pr.catalog = catalog;
  prRender();
}

/* rows for the current project: every catalog entry (assigned or not) plus linked IDs whose resource is gone */
function prRows() {
  const p = prProject(); if (!p || !pr.catalog) return [];
  const rows = [];
  for (const { kind, one } of PR_KINDS) {
    const linked = new Map((p.resources?.[kind] || []).map((r) => [r.id, r]));
    for (const item of pr.catalog[kind]) rows.push({ kind, one, ...item, assigned: kind === 'targets' ? item.projectId === p.id : linked.has(item.id) });
    for (const r of linked.values()) if (!pr.catalog[kind].some((x) => x.id === r.id)) rows.push({ kind, one, id: r.id, name: r.name || r.id, detail: pr.catalogErrors[kind] ? 'catalog unavailable' : `this ${one} no longer exists`, assigned: true, missing: !pr.catalogErrors[kind] });
  }
  return rows;
}

function prRenderHead() {
  const p = prProject();
  const sel = $('prProject');
  sel.innerHTML = pr.projects.map((x) => `<option value="${esc(x.id)}"${x.id === pr.projectId ? ' selected' : ''}>${esc(x.name)}</option>`).join('');
  sel.disabled = pr.projects.length < 2;
  $('prDot').style.setProperty('--proj-color', p?.color || 'var(--accent)');
  $('prDesc').textContent = p?.description || '';
  $('prDesc').hidden = !p?.description;
  const ro = $('prReadOnly');
  ro.hidden = !pr.readOnly;
  ro.textContent = pr.readOnly ? `Read-only: ${pr.readOnly}` : '';
}

function prRender() {
  prRenderHead();
  const rows = prRows();
  const q = pr.query.trim().toLowerCase();
  const matches = (r) => !q || `${r.name} ${r.detail}`.toLowerCase().includes(q);

  // tabs: All + one per kind, each with assigned/total (totals ignore the search box on purpose)
  const tabs = [{ kind: 'all', label: 'All' }, ...PR_KINDS].map((t) => {
    const of = t.kind === 'all' ? rows : rows.filter((r) => r.kind === t.kind);
    const n = of.filter((r) => r.assigned).length;
    return `<button type="button" role="tab" aria-selected="${pr.tab === t.kind}" class="${pr.tab === t.kind ? 'on' : ''}" data-tab="${t.kind}">${esc(t.label)} <span class="pr-n" title="${n} of ${of.length} assigned">${n}/${of.length}</span></button>`;
  }).join('');
  $('prTabs').innerHTML = tabs;
  $('prTabs').querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { pr.tab = b.dataset.tab; prRender(); }));

  const assignedTotal = rows.filter((r) => r.assigned).length;
  $('prSummary').textContent = `${assignedTotal} resource${assignedTotal === 1 ? '' : 's'} assigned`;

  const shown = rows.filter((r) => (pr.tab === 'all' || r.kind === pr.tab) && matches(r));
  const host = $('prList');
  const kindErr = pr.tab !== 'all' && pr.catalogErrors[pr.tab] ? `<div class="pr-warn">Could not load ${esc(PR_KINDS.find((k) => k.kind === pr.tab).label.toLowerCase())}: ${esc(pr.catalogErrors[pr.tab])}</div>` : '';
  const hint = `<p class="hint pr-hint">${esc(pr.tab !== 'all' ? PR_KINDS.find((k) => k.kind === pr.tab).hint : 'Connections, servers, connectors and repositories can be shared. Each deployment belongs to one project; edit it to change its project.')}</p>`;
  if (!shown.length) {
    const why = q ? `Nothing matches “${esc(pr.query.trim())}”.` : pr.tab === 'targets' ? 'Create a deployment and choose the project it belongs to.' : pr.tab === 'all' ? 'There is nothing to assign yet: create a connection, server, connector, repository or deployment first.' : `No ${esc(PR_KINDS.find((k) => k.kind === pr.tab).label.toLowerCase())} to assign yet.`;
    host.innerHTML = `${hint}${kindErr}<div class="empty-block"><b>${q ? 'No match' : 'Nothing here'}</b>${why}${q ? '<br><button type="button" id="prClearSearch">Clear search</button>' : ''}</div>`;
    $('prClearSearch')?.addEventListener('click', () => { pr.query = ''; $('prSearch').value = ''; prRender(); $('prSearch').focus(); });
    return;
  }
  // assigned rows first within each kind, then by name
  shown.sort((a, b) => PR_KINDS.findIndex((k) => k.kind === a.kind) - PR_KINDS.findIndex((k) => k.kind === b.kind) || Number(b.assigned) - Number(a.assigned) || a.name.localeCompare(b.name));
  const locked = !!pr.readOnly;
  host.innerHTML = hint + kindErr + `<ul class="pr-rows" role="list">` + shown.map((r) => {
    const key = `${r.kind}/${r.id}`;
    const busy = pr.busy.has(key);
    const owned = r.kind === 'targets';
    const owner = owned ? pr.projects.find((p) => p.id === r.projectId)?.name || r.projectId || prProject()?.name : '';
    const action = r.assigned ? 'Remove' : 'Assign';
    const label = `${action} ${r.one} “${r.name}”${r.assigned ? ' from' : ' to'} project ${prProject()?.name || ''}`;
    return `<li class="pr-row${r.assigned ? ' assigned' : ''}${r.missing ? ' missing' : ''}" data-kind="${esc(r.kind)}" data-id="${esc(r.id)}">
      <span class="chip ${esc(PR_KIND_CLASS[r.kind] || '')}" title="${esc(r.one)}">${esc(r.one)}</span>
      <div class="pr-id">
        <div class="pr-name">${esc(r.name)}${r.live ? ' <span class="pr-live" title="SSH session connected"></span>' : ''}${r.missing ? ' <span class="badge failed" title="Linked, but the resource was deleted">missing</span>' : ''}</div>
        <div class="pr-detail">${esc(r.detail || '')}</div>
        ${owned ? `<div class="hint">Project: ${esc(owner)}</div>` : ''}
      </div>
      ${owned ? `<button type="button" data-act="edit-deployment" aria-label="Edit deployment ${esc(r.name)}" ${r.missing ? 'disabled' : ''}>Edit deployment</button>` : `<button type="button" class="${r.assigned ? 'pr-remove' : 'primary pr-assign'}" data-act="${r.assigned ? 'unlink' : 'link'}" aria-pressed="${r.assigned}" aria-label="${esc(label)}" title="${esc(label)}" ${busy || locked ? 'disabled' : ''}>${busy ? '…' : r.assigned ? '✓ Assigned' : '+ Assign'}</button>`}
    </li>`;
  }).join('') + '</ul>';
  host.querySelectorAll('.pr-row [data-act]').forEach((b) => b.addEventListener('click', async () => {
    const li = b.closest('.pr-row');
    if (b.dataset.act === 'edit-deployment') {
      closeProjectResources();
      if (typeof navigate === 'function') navigate(`#/deployments/targets/${encodeURIComponent(li.dataset.id)}`);
      await openDeploy(li.dataset.id);
      const target = dp.targets.find((t) => t.id === li.dataset.id);
      if (target) dpOpenTargetModal(target);
      return;
    }
    prToggle(li.dataset.kind, li.dataset.id, b.dataset.act === 'link');
  }));
}

/** Link or unlink one resource, then refresh from the project the server returns. */
async function prToggle(kind, resourceId, link) {
  if (kind === 'targets') return toast('Edit the deployment to change its project.', 'warning');
  const p = prProject(); if (!p) return;
  const key = `${kind}/${resourceId}`;
  if (pr.busy.has(key)) return;
  const row = prRows().find((r) => r.kind === kind && r.id === resourceId);
  pr.busy.add(key); prRender();
  try {
    const updated = link
      ? await api(`/api/projects/${encodeURIComponent(p.id)}/links`, { method: 'POST', body: JSON.stringify({ kind, resourceId }) })
      : await api(`/api/projects/${encodeURIComponent(p.id)}/links/${encodeURIComponent(kind)}/${encodeURIComponent(resourceId)}`, { method: 'DELETE' });
    prApplyProject(updated);
    toast(`${row?.one ? row.one[0].toUpperCase() + row.one.slice(1) : 'Resource'} "${row?.name || resourceId}" ${link ? 'added to' : 'removed from'} ${updated.name}`, 'success');
  } catch (e) {
    toast(`Could not ${link ? 'assign' : 'remove'} ${row?.one || 'resource'}: ${e.message}`, 'error');
    // the resource may have been deleted meanwhile: reload the catalogs so the list is truthful
    if (/not found|no such|No \w+ with id/i.test(e.message)) { pr.busy.delete(key); await prLoad(); return; }
  }
  pr.busy.delete(key);
  prRender();
}

/* keep this dialog, the header switcher and anyone listening in sync with the server's view of the project */
function prApplyProject(updated) {
  const i = pr.projects.findIndex((x) => x.id === updated.id);
  if (i >= 0) pr.projects[i] = updated; else pr.projects.push(updated);
  // app.js declares `projects` with let (a global binding, not a window property): reach it by name
  if (typeof projects !== 'undefined' && Array.isArray(projects)) {
    const j = projects.findIndex((x) => x.id === updated.id);
    if (j >= 0) projects[j] = updated;
    if (typeof renderProjectContext === 'function') renderProjectContext();
  }
  document.dispatchEvent(new CustomEvent('st:project-resources', { detail: { projectId: updated.id, project: updated } }));
}

(function wireProjectResources() {
  const d = prModal(); if (!d) return;
  $('btnProjResources')?.addEventListener('click', () => openProjectResources());
  $('prClose').addEventListener('click', closeProjectResources);
  $('prProject').addEventListener('change', (e) => { pr.projectId = e.target.value; pr.busy.clear(); prRender(); });
  let t;
  $('prSearch').addEventListener('input', (e) => { pr.query = e.target.value; clearTimeout(t); t = setTimeout(prRender, 80); });
  $('prRefresh').addEventListener('click', () => { prRenderLoading(); prLoad(); });
  d.addEventListener('close', () => { pr.opened = false; pr.busy.clear(); });
  // follow the header switcher while the dialog is closed, so the next open shows the active project
  document.addEventListener('st:project', (e) => { if (!pr.opened && e.detail?.id) pr.projectId = e.detail.id; });
  window.openProjectResources = openProjectResources;
})();
