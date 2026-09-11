'use strict';
/* The engine's view of projects.
 *
 * Projects are the HOST's: it owns projects.json and serves the switcher whether
 * or not this module is installed, so this module never writes them. What it
 * needs is a synchronous read model - "does this project exist", "what is the
 * fallback" - because a deployment has exactly one owner and that ownership is
 * checked on every write.
 *
 * The list is refreshed from the host; ownership of TARGETS is published back to
 * it, which is how a project shows its deployments while this module is
 * installed and stops showing them (without losing a thing) when it is not. */

const DEFAULT = { id: 'general', name: 'General', description: '', color: null, resources: {} };

function createProjectView({ load = async () => [], visible = null, log = () => {} } = {}) {
  let projects = [DEFAULT];
  let readOnly = null;
  let deployments = null;

  async function refresh() {
    try {
      const list = await load();
      if (Array.isArray(list) && list.length) projects = list;
      readOnly = null;
    } catch (error) {
      readOnly = `Projects could not be read: ${error.message}`;
      log('warn', readOnly);
    }
    return projects;
  }

  const view = {
    refresh,
    get readOnly() { return readOnly; },
    get version() { return 1; },
    list: () => projects,
    get: (id) => projects.find((p) => p.id === id) || null,
    projectsFor: (kind, resourceId) => projects.filter((project) => (view.resourcesFor(project)[kind] || []).some((value) => (value.id || value) === resourceId)),
    /* Which of `ids` a project may see. The rule - attached to a project means
       attached to that project ALONE, unattached means shared - belongs to the
       host, and this asks it rather than restating it, so the deployments list
       and every other list agree about what a project contains. Without a host
       to ask (an older host, or no project named) nothing is hidden. */
    async visible(projectId, kind, ids) {
      if (!projectId || !visible) return ids;
      try { return await visible(projectId, kind, ids); }
      catch (error) { log('warn', `project scope could not be read (${error.message}); showing everything`); return ids; }
    },
    /** Targets this module owns, merged into a project's resources for display. */
    bindDeployments: (access) => { deployments = access; },
    resourcesFor: (project) => ({
      ...project.resources,
      ...(deployments ? { targets: deployments.targets().filter((t) => t.projectId === project.id).map((t) => t.id) } : {}),
    }),
    /* Writing projects is not this module's business. */
    create: () => { throw Object.assign(new Error('Projects are managed by the Projects module.'), { status: 400 }); },
    update: () => { throw Object.assign(new Error('Projects are managed by the Projects module.'), { status: 400 }); },
    remove: () => { throw Object.assign(new Error('Projects are managed by the Projects module.'), { status: 400 }); },
    link: () => { throw Object.assign(new Error('Projects are managed by the Projects module.'), { status: 400 }); },
    unlink: () => { throw Object.assign(new Error('Projects are managed by the Projects module.'), { status: 400 }); },
    unlinkEverywhere: async () => 0,
    save: async () => {},
  };
  return view;
}

module.exports = { createProjectView, DEFAULT_PROJECT: DEFAULT };
