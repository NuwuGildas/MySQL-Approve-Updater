/* Projects - frontend entry point. */
'use strict';

import { createProjectsPage } from './projects-page.js';
import { createResourcesDialog } from './resources.js';

let page = null;
let resources = null;

export async function activate(host) {
  host.styles.link(new URL('./projects.css', import.meta.url).href);

  const mount = host.mount('projects');
  mount.innerHTML = await fetch(new URL('./projects.html', import.meta.url)).then((r) => r.text())
    + await fetch(new URL('./resources.html', import.meta.url)).then((r) => r.text());
  mount.hidden = false;
  const drawer = mount.querySelector('#projectsDrawer');

  resources = createResourcesDialog({ host, mount });
  page = createProjectsPage({ host, mount, openResources: (id) => resources.open(id) });

  host.registerPage({
    id: 'projects', segment: 'projects', label: 'Projects', group: 'Workspace', order: 29,
    icon: host.ui.icons.projects, title: 'Projects',
    desc: 'Group connections, servers, connectors, repositories and targets into projects; the active project scopes the assistant.',
    enter: () => page.open(),
    leave: () => page.close(),
    focus: () => drawer.querySelector('h2'),
  });

  host.registerLauncherTile({
    id: 'projects', name: 'Projects', route: '#/projects', tag: 'Workspace', accent: '--accent', order: 29,
    icon: host.ui.icons.projects,
    desc: 'Group connections, servers, connectors, repositories and targets into projects.',
    launch: () => host.navigate('#/projects'),
  });

  host.registerTourStep({
    id: 'projects', order: 30, element: '#projectsDrawer .view-head', route: '#/projects', title: 'Projects',
    intro: 'A project groups the connections, servers, connectors, repositories and deployments that belong together, and the assistant keeps one conversation per project. Create, rename, colour and delete projects here; <b>Set active</b> (or the header switcher) chooses the one the assistant works in.',
  });

  /* Open the page and start a new project on it: the command, the launcher and
     the header switcher's "New project" all mean this. */
  const newProject = () => { host.navigate('#/projects'); setTimeout(() => mount.querySelector('#btnPjAdd')?.click(), 320); };

  host.registerCommand({
    id: 'new-project', title: 'New project', sub: 'Group resources and give the assistant its own conversation',
    run: () => newProject(),
  });

  host.registerSearchSource({
    key: 'projects', prefixes: ['projects', 'project'], label: 'Projects', icon: 'projects',
    tip: 'Search projects and switch the active one',
    fetch: () => host.projects.load().then((d) => d.projects || []),
    map: (p) => ({ title: p.name, sub: p.description || 'Project', action: { k: 'project', id: p.id }, dot: p.color || 'var(--accent)' }),
    run: (action) => host.projects.set(action.id),
  });

  /* The header's "Manage projects" button belongs to the core switcher; while
     this module is installed it opens the management page. */
  const manage = document.getElementById('btnProjManage');
  if (manage) {
    manage.hidden = false;
    host.on(manage, 'click', () => host.navigate('#/projects'));
    host.onDeactivate(() => { manage.hidden = true; });
  }
  const assign = document.getElementById('btnProjResources');
  if (assign) {
    assign.hidden = false;
    host.on(assign, 'click', () => resources.open());
    host.onDeactivate(() => { assign.hidden = true; });
  }

  /* Managing projects IS this module. Declaring it is what reveals the header
     switcher; the host withdraws it when this module is removed, and everything
     is scoped back to the default project. */
  host.projects.manage({
    open: () => host.navigate('#/projects'),
    create: () => newProject(),
  });

  host.observe(host.shell.watchPage(drawer, 'projects'));

  /* The card the user judges an assistant's proposed project change on. The generic fallback prints
     the payload as JSON, which is no way to decide whether to delete a project. */
  host.assistant.registerProposalCard('project-change', (element, proposal, { wire, esc }) => {
    const p = proposal;
    const label = { create: 'Create project', rename: 'Rename project', delete: 'Delete project', attach: 'Move into project', detach: 'Return to every project' }[p.change] || 'Project change';
    const destructive = p.change === 'delete';
    const detail = {
      create: () => `<b>${esc(p.name)}</b>${p.description ? ' · ' + esc(p.description) : ''}`,
      rename: () => `<b>${esc(p.projectName)}</b> → <b>${esc(p.name)}</b>`,
      delete: () => `<b>${esc(p.projectName)}</b>`,
      attach: () => `${esc(p.kind)} <code>${esc(p.resourceId)}</code> → <b>${esc(p.projectName)}</b>`,
      detach: () => `${esc(p.kind)} <code>${esc(p.resourceId)}</code> ← <b>${esc(p.projectName)}</b>`,
    }[p.change];
    const holds = (p.holds || []).map((h) => `${h.count} ${esc(h.kind)}`).join(', ');
    const consequence = p.change === 'delete'
      ? `The ${holds ? holds + ' it groups are' : 'resources it groups are'} not deleted: they go back to being visible to every project.${p.holds?.length ? '' : ' It groups nothing.'}`
      : p.change === 'attach' ? `It stops being visible to other projects.${p.alsoIn?.length ? ` Also in: ${p.alsoIn.map(esc).join(', ')}.` : ''}`
      : p.change === 'detach' ? 'It becomes visible to every project again.'
      : '';
    element.innerHTML = `
      <div class="ap-head">${esc(label)} ${destructive ? '<span class="badge failed">destructive</span>' : ''}</div>
      <div class="ap-meta">${detail ? detail() : ''}${p.reason ? ' · ' + esc(p.reason) : ''}</div>
      ${consequence ? `<div class="hint">${consequence}</div>` : ''}
      <div class="actions">
        <button class="approve" data-dec="approve">${destructive ? 'Delete it' : 'Approve'}</button>
        <button class="reject" data-dec="reject">Reject</button>
      </div>`;
    wire(() => page?.load?.());
  });

  host.provide({
    open: (id) => (id ? resources.open(id) : host.navigate('#/projects')),
    list: () => page.state.list.slice(),
    reload: () => page.load(),
  });
}

export async function deactivate() {
  page = null;
  resources = null;
}
