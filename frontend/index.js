/* Activity History - frontend.
 *
 * An ES module. activate(host) registers a page, a launcher tile, a search
 * source and a settings-free view; deactivate() is not even needed because
 * every registration above returned a disposable the host holds. Its markup and
 * styles are fetched from the package, not from the base index.html.
 */
'use strict';

import { createTimeline } from './timeline.js';

let view = null;

export async function activate(host) {
  const { esc } = host.ui;

  host.styles.link(new URL('./history.css', import.meta.url).href);
  const markup = await fetch(new URL('./history.html', import.meta.url)).then((r) => {
    if (!r.ok) throw new Error('the History view could not be loaded');
    return r.text();
  });

  /* The page's DOM lives in a container the host owns and removes with us. */
  const mount = host.mount('history');
  mount.innerHTML = markup;
  mount.hidden = false;
  const drawer = mount.querySelector('#auditDrawer');
  const $ = (id) => mount.querySelector('#' + id);

  view = createTimeline({ host, root: mount, $, esc });

  host.registerPage({
    id: 'history',
    segment: 'history',
    label: 'History',
    group: 'Workspace',
    order: 40,
    icon: host.ui.icons.history,
    title: 'History',
    desc: 'Searchable timeline of every decision, edit, session, deployment and assistant action.',
    enter: () => { drawer.classList.add('open'); drawer.classList.add('as-page'); view.load(); },
    leave: () => drawer.classList.remove('open'),
    focus: () => drawer.querySelector('h2'),
  });

  host.registerLauncherTile({
    id: 'history', name: 'History', route: '#/history', tag: 'Audit', accent: '--red', order: 40,
    icon: host.ui.icons.history,
    desc: 'Timeline of every decision, edit, session and AI action.',
    launch: () => host.navigate('#/history'),
  });

  host.registerTourStep({
    id: 'history', order: 40, element: '#auditDrawer .audit-filters', route: '#/history', title: 'History',
    intro: 'Every decision, edit, session, deploy run and AI action, grouped by day. Filter by category chips, search text, time range and outcome; the filters are remembered between visits. The raw JSON-lines file downloads from the header.',
  });

  host.registerSearchSource({
    key: 'history', prefixes: ['history', 'events', 'audit'], label: 'History', icon: 'history',
    tip: 'Search recorded activity',
    fetch: () => host.get('list', { limit: 300 }).then((d) => d.entries || []),
    map: (entry) => ({
      title: view.describePlain(entry),
      sub: `${entry.action || 'event'} · ${(entry.ts || '').slice(0, 16).replace('T', ' ')}`,
      action: { k: 'entry', ts: entry.ts, n: entry._n },
      hay: JSON.stringify(entry),
    }),
    run: () => host.navigate('#/history'),
  });

  /* The address bar closing this view is the host's business, not ours. */
  host.observe(host.shell.watchPage(drawer, 'history'));
  host.on(drawer.querySelector('#btnAuditClose'), 'click', () => drawer.classList.remove('open'));
  host.on(document, 'keydown', (event) => {
    if (event.key === 'Escape' && drawer.classList.contains('open') && !document.querySelector('dialog[open]')) drawer.classList.remove('open');
  });

  /* New audit entries arrive on the host's log stream; refresh when the view is open. */
  host.events.on('log', () => { if (drawer.classList.contains('open')) view.loadSoon(); });
}

export async function deactivate() {
  // Everything registered above is disposed by the host. Only our own module
  // state needs clearing, so a re-add starts from nothing.
  view?.dispose();
  view = null;
}
