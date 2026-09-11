/* Projects page (#/projects): create, rename, describe, colour, delete and
   activate the projects that group this application's resources.

   Having projects is core - the assistant always needs a conversation to belong
   to - so the base application keeps a read-only project context. MANAGING them
   is this module, and removing it changes nothing in projects.json. */
'use strict';

export function createProjectsPage({ host, mount, openResources }) {
  const { esc, toast, confirm } = host.ui;
  const $ = (id) => mount.querySelector('#' + id);


  const pj = { list: [], kinds: [], readOnly: null, editing: null, q: '' };
  const PJ_KIND_LABEL = { connections: ['connection', 'connections'], servers: ['server', 'servers'], connectors: ['connector', 'connectors'], repos: ['repository', 'repositories'], targets: ['deployment', 'deployments'] };
  const PJ_PALETTE = ['#4f8ef7', '#22b07d', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#ec4899', '#84cc16'];
  const pjLabel = (kind, n) => { const l = PJ_KIND_LABEL[kind] || [kind, kind]; return n === 1 ? l[0] : l[1]; };
  const pjFmtDate = (iso) => { if (!iso) return ''; const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); };
  const pjAgo = (iso) => pjFmtDate(iso);

  function openProjects() { $('projectsDrawer').classList.add('open'); return loadProjectsPage(); }
  const closeProjects = () => { $('projectsDrawer').classList.remove('open'); };

  async function loadProjectsPage() {
    const listHost = $('projectsList');
    if (!pj.list.length) listHost.innerHTML = '<div class="empty" style="padding:1rem"><span class="spinner"></span> Loading projects…</div>';
    try {
      const d = await host.projects.load();
      pj.list = Array.isArray(d.projects) ? d.projects : [];
      pj.kinds = Array.isArray(d.kinds) ? d.kinds : Object.keys(PJ_KIND_LABEL);
      pj.readOnly = d.readOnly || null;
    } catch (e) {
      listHost.innerHTML = `<div class="empty" style="padding:1rem;color:var(--red)">${esc(e.message)}</div>`;
      return;
    }
    // keep the header switcher in step without a second request
    host.projects.publish(pj.list);
    pjRender();
  }

  function pjRender() {
    const listHost = $('projectsList');
    const ro = $('projectsReadOnly');
    ro.hidden = !pj.readOnly;
    if (pj.readOnly) ro.textContent = pj.readOnly;
    $('btnPjAdd').disabled = !!pj.readOnly;
    $('projectsCount').textContent = pj.list.length ? `- ${pj.list.length}` : '';
    const q = pj.q.toLowerCase();
    const rows = pj.list.filter((p) => !q || `${p.name} ${p.description || ''}`.toLowerCase().includes(q));
    if (!pj.list.length) {
      listHost.innerHTML = `<div class="pj-empty"><h3>No projects</h3><p>Each project owns its deployments and AI conversation. Connections, servers, connectors and repositories can be shared across projects.</p><button type="button" class="primary" id="btnPjEmptyAdd" ${pj.readOnly ? 'disabled' : ''}>+ New project</button></div>`;
      $('btnPjEmptyAdd')?.addEventListener('click', () => pjOpenModal(null));
      return;
    }
    if (!rows.length) {
      listHost.innerHTML = `<div class="empty" style="padding:1rem">No project matches "${esc(pj.q)}". <button type="button" id="btnPjClearFilter">Clear search</button></div>`;
      host.on($('btnPjClearFilter'), 'click', () => { $('projectsFilter').value = ''; pj.q = ''; pjRender(); });
      return;
    }
    const activeId = host.projects.activeId();
    const onlyGeneral = pj.list.length === 1 && pj.list[0].id === 'general';
    const generalEmpty = onlyGeneral && !Object.values(pj.list[0].resources || {}).some((arr) => arr?.length);
    const intro = generalEmpty ? `<section class="pj-welcome"><div class="pj-welcome-icon" aria-hidden="true">✦</div><div><p class="eyebrow">Your workspace is ready</p><h3>Create a project to keep work together</h3><p>Each project owns its deployments and assistant conversation. Reuse connections, servers, connectors and repositories across projects.</p><button type="button" class="primary" id="btnPjWelcomeAdd" ${pj.readOnly ? 'disabled' : ''}>+ Create your first project</button></div></section>` : '';
    listHost.innerHTML = intro + rows.map((p) => {
      const active = p.id === activeId;
      const kinds = pj.kinds.length ? pj.kinds : Object.keys(p.resources || {});
      const total = kinds.reduce((n, k) => n + (p.resources?.[k]?.length || 0), 0);
      const missing = kinds.reduce((n, k) => n + (p.resources?.[k] || []).filter((r) => r.missing).length, 0);
      const chips = kinds.map((k) => {
        const list = p.resources?.[k] || [];
        const names = list.map((r) => (r.missing ? `${r.id} (missing)` : r.name)).join('\n');
        return `<span class="pj-chip ${list.length ? '' : 'zero'}" title="${esc(names || `No ${pjLabel(k, 2)} linked`)}"><b>${list.length}</b> ${esc(pjLabel(k, list.length))}</span>`;
      }).join('');
      return `
      <article class="pj-card ${active ? 'active' : ''}" data-id="${esc(p.id)}" style="--proj-color:${esc(p.color || 'var(--accent)')}">
        <div class="pj-card-head">
          <span class="pj-swatch" aria-hidden="true"></span>
          <div class="pj-id">
            <div class="pj-name">${esc(p.name)}${active ? ' <span class="badge pj-active" title="The header switcher and the assistant use this project">Active</span>' : ''}</div>
            <div class="pj-sub">${p.id === 'general' ? 'Default project · ' : ''}created ${esc(pjFmtDate(p.createdAt))}${p.updatedAt && p.updatedAt !== p.createdAt ? ` · updated ${esc(pjAgo(p.updatedAt))}` : ''}</div>
          </div>
        </div>
        ${p.description ? `<p class="pj-desc">${esc(p.description)}</p>` : '<p class="pj-desc hint">No description.</p>'}
        <div class="pj-chips" aria-label="Linked resources">${chips}</div>
        ${missing ? `<div class="pj-warn">${missing} linked ${missing === 1 ? 'resource' : 'resources'} no longer exist${missing === 1 ? 's' : ''}.</div>` : ''}
        <div class="pj-actions">
          <button type="button" class="primary" data-act="activate" ${active ? 'disabled' : ''} title="Use this project in the header switcher and the assistant">${active ? 'Active' : 'Set active'}</button>
          <button type="button" data-act="edit" ${pj.readOnly ? 'disabled' : ''} title="Rename, describe or recolour">Edit</button>
          <button type="button" data-act="resources" title="View deployments and manage shared resources">Resources</button>
          <button type="button" class="iconbtn danger" data-act="remove" ${pj.readOnly || pj.list.length === 1 || p.resources?.targets?.length ? 'disabled' : ''} title="${pj.list.length === 1 ? 'The last project cannot be deleted' : p.resources?.targets?.length ? 'Move or delete this project’s deployments first' : `Delete project (its ${total} linked ${total === 1 ? 'resource is' : 'resources are'} kept)`}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg></button>
        </div>
      </article>`;
    }).join('');
    $('btnPjWelcomeAdd')?.addEventListener('click', () => pjOpenModal(null));
    listHost.querySelectorAll('.pj-card [data-act]').forEach((b) => b.addEventListener('click', () => pjAction(b.closest('.pj-card').dataset.id, b.dataset.act, b)));
  }

  async function pjAction(id, act, btn) {
    const p = pj.list.find((x) => x.id === id); if (!p) return;
    try {
      if (act === 'activate') { host.projects.set(id); pjRender(); }
      else if (act === 'edit') pjOpenModal(p);
      else if (act === 'resources') openResources(id);
      else if (act === 'remove') {
        if (p.resources?.targets?.length) return toast('Move or delete this project’s deployments before deleting the project. Projects with deployment history must be kept.', 'warning');
        const total = Object.values(p.resources || {}).reduce((n, l) => n + (l?.length || 0), 0);
        const wasActive = host.projects.activeId() === id;
        const ok = await confirm({
          title: `Delete ${p.name}`,
          message: `Delete the project <b>${esc(p.name)}</b>? ${total ? `Its ${total} linked ${total === 1 ? 'resource keeps' : 'resources keep'} working: only the grouping is removed.` : 'It has no linked resources.'} Projects with deployment history or pending deployment provisioning cannot be deleted. The assistant conversation for this project is no longer reachable.${wasActive ? ' It is the <b>active</b> project: the header will fall back to General.' : ''}`,
          okLabel: 'Delete', okClass: 'reject',
        });
        if (!ok) return;
        btn.disabled = true;
        await host.rpc('remove', { id });
        toast(`Project "${p.name}" deleted`, 'success');
        await pjAfterChange();
      }
    } catch (e) { toast(e.message, 'error'); if (btn) btn.disabled = false; }
  }

  /** After a create / update / delete: refresh this page and the header switcher (which also resolves a stale active id). */
  async function pjAfterChange() {
    await host.projects.reload();
    await loadProjectsPage();
  }

  /* ---- create / edit dialog ---- */
  function pjOpenModal(p) {
    pj.editing = p || null;
    $('pjModalTitle').textContent = p ? `Edit ${p.name}` : 'New project';
    $('pjName').value = p?.name || '';
    $('pjDesc').value = p?.description || '';
    pjSetColor(p?.color || '');
    $('pjErr').hidden = true;
    $('btnPjSave').textContent = p ? 'Save' : 'Create project';
    pjCountDesc();
    $('pjModal').showModal();
    setTimeout(() => $('pjName').focus(), 30);
  }
  function pjSetColor(c) {
    const v = /^#[0-9a-fA-F]{6}$/.test(c) ? c.toLowerCase() : '';
    $('pjColor').value = v;
    $('pjColorPick').value = v || '#4f8ef7';
    $('pjColorNone').setAttribute('aria-checked', String(!v));
    $('pjColorNone').classList.toggle('on', !v);
    $('pjSwatches').querySelectorAll('[data-color]').forEach((b) => { const on = b.dataset.color === v; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
    $('pjPreviewDot').style.setProperty('--proj-color', v || 'var(--accent)');
  }
  function pjCountDesc() { $('pjDescCount').textContent = `${$('pjDesc').value.length}/500`; }
  function pjWireModal() {
    $('pjSwatches').innerHTML = PJ_PALETTE.map((c) => `<button type="button" role="radio" aria-checked="false" data-color="${c}" style="--sw:${c}" title="${c}"><span class="sr-only">${c}</span></button>`).join('');
    host.on($('pjSwatches'), 'click', (e) => { const b = e.target.closest('[data-color]'); if (b) pjSetColor(b.dataset.color); });
    host.on($('pjColorNone'), 'click', () => pjSetColor(''));
    host.on($('pjColorPick'), 'input', () => pjSetColor($('pjColorPick').value));
    host.on($('pjDesc'), 'input', pjCountDesc);
    host.on($('btnPjCancel'), 'click', () => $('pjModal').close());
    host.on($('pjForm'), 'submit', async (e) => {
      e.preventDefault();
      const name = $('pjName').value.trim();
      if (!name) { $('pjErr').textContent = 'Give the project a name.'; $('pjErr').hidden = false; $('pjName').focus(); return; }
      const body = { name, description: $('pjDesc').value, color: $('pjColor').value || null };
      $('pjErr').hidden = true; $('btnPjSave').disabled = true;
      try {
        const r = await host.rpc('save', { id: pj.editing?.id || null, ...body });
        $('pjModal').close();
        toast(pj.editing ? `Project "${r.name}" saved` : `Project "${r.name}" created`, 'success');
        await pjAfterChange(); // creating a project never switches the active one silently: "Set active" does
      } catch (err) { $('pjErr').textContent = err.message; $('pjErr').hidden = false; }
      finally { $('btnPjSave').disabled = false; }
    });
    host.on($('btnPjAdd'), 'click', () => pjOpenModal(null));
    host.on($('btnPjRefresh'), 'click', loadProjectsPage);
    let t = 0;
    host.on($('projectsFilter'), 'input', () => { clearTimeout(t); t = setTimeout(() => { pj.q = $('projectsFilter').value.trim(); pjRender(); }, 150); });
    // the active badge follows the header switcher
    host.on(document, 'st:project', () => { if ($('projectsDrawer').classList.contains('open')) pjRender(); });
  }

  pjWireModal();
  return { open: openProjects, close: closeProjects, load: loadProjectsPage, render: pjRender, state: pj };
}
