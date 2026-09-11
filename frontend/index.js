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

  host.registerCommand({
    id: 'new-project', title: 'New project', sub: 'Group resources and give the assistant its own conversation',
    run: () => { host.navigate('#/projects'); setTimeout(() => mount.querySelector('#btnPjAdd')?.click(), 320); },
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

  host.observe(host.shell.watchPage(drawer, 'projects'));

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
