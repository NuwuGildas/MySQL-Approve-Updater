'use strict';
/* Projects - backend.
 *
 * The project store itself is host infrastructure: the assistant needs a
 * conversation to belong to whether or not this module is installed, so the
 * base application always reads projects.json and always serves the switcher.
 * What lives here is MANAGEMENT - creating, renaming, deleting and linking -
 * which is why removing this module leaves every project and every link exactly
 * where it was. */

const fail = (status, message) => Object.assign(new Error(message), { status });

async function activate(host) {
  const write = (method, params) => host.call(method, params);

  return {
    methods: {
      list: () => host.call('projects.list', {}),

      save: async ({ id, name, description, color }) => {
        const body = { name, description, color };
        return id ? write('projects.update', { id, ...body }) : write('projects.create', body);
      },

      remove: async ({ id }) => {
        if (!id) throw fail(400, 'A project id is required');
        await write('projects.remove', { id });
        host.emit('changed', { removed: id });
        return { ok: true };
      },

      /* Linking stores an ID and nothing else: no name, no secret, no copy. */
      link: async ({ id, kind, resourceId }) => {
        if (!id || !kind || !resourceId) throw fail(400, 'id, kind and resourceId are required');
        const project = await write('projects.link', { id, kind, resourceId });
        host.emit('changed', { id });
        return project;
      },
      unlink: async ({ id, kind, resourceId }) => {
        if (!id || !kind || !resourceId) throw fail(400, 'id, kind and resourceId are required');
        const project = await write('projects.unlink', { id, kind, resourceId });
        host.emit('changed', { id });
        return project;
      },

      /** Which projects reference one resource, for "this belongs to…" hints. */
      forResource: ({ kind, resourceId }) => host.call('projects.resourcesFor', { kind, resourceId }),
    },

    assistantTools: {
      list_projects: {
        description: 'List the projects in this workspace and what each one groups. Input: none. Read-only.',
        run: async () => ({ projects: await host.call('projects.list', {}) }),
      },
    },

    /* Nothing runs in the background; removal never interrupts work. */
    busy: () => false,
    async deactivate() {},
  };
}

module.exports = { activate };
