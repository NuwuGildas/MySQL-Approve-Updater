'use strict';
/* Projects - backend.
 *
 * The project store itself is host infrastructure: the assistant needs a
 * conversation to belong to whether or not this module is installed, so the
 * base application always reads projects.json and always serves the switcher.
 * What lives here is MANAGEMENT - creating, renaming, deleting and linking -
 * which is why removing this module leaves every project and every link exactly
 * where it was. */

const crypto = require('node:crypto');

const fail = (status, message) => Object.assign(new Error(message), { status });

/* The kinds a project can group. The host owns the list; it is repeated here so a tool description
   can name them, and asserted against what the host actually accepts on every call. */
const RESOURCE_KINDS = ['connections', 'servers', 'connectors', 'repos', 'targets'];
const RESOURCE_LABELS = { connections: 'connection', servers: 'server', connectors: 'connector', repos: 'repository', targets: 'target' };
const ACTIONS = ['create', 'rename', 'delete', 'attach', 'detach'];

const assertKind = (kind) => { if (!RESOURCE_KINDS.includes(kind)) throw fail(400, `kind must be one of ${RESOURCE_KINDS.join(', ')}`); };

/** How a proposed change reads on its card, in the log, and in the audit trail. */
function describeChange(p) {
  const what = `${RESOURCE_LABELS[p.kind] || p.kind} ${p.resourceName || p.resourceId}`;
  switch (p.change) {
    case 'create': return `create the project "${p.name}"`;
    case 'rename': return `rename "${p.projectName}" to "${p.name}"`;
    case 'delete': return `delete the project "${p.projectName}"`;
    case 'attach': return `move ${what} into "${p.projectName}" only`;
    case 'detach': return `return ${what} from "${p.projectName}" to every project`;
    default: return `change "${p.projectName || p.name || ''}"`;
  }
}

async function activate(host) {
  const write = (method, params) => host.call(method, params);
  const projectById = async (id) => {
    if (!id) throw fail(400, 'a project id is required: use list_projects to find it');
    const project = (await host.call('projects.list', {})).find((p) => p.id === id);
    if (!project) throw fail(404, `no project with id "${id}": use list_projects for the current ids`);
    return project;
  };

  /**
   * Turn what the assistant asked for into a card the user can judge: every id resolved to a name,
   * every obvious refusal raised HERE rather than after the user has approved something.
   */
  async function buildProjectProposal(input) {
    const change = String(input.action || '').toLowerCase();
    if (!ACTIONS.includes(change)) throw fail(400, `action must be one of ${ACTIONS.join(', ')}`);
    const reason = String(input.reason || '').slice(0, 300);
    const base = { id: crypto.randomUUID(), kind: 'project-change', change, reason, ts: new Date().toISOString() };

    if (change === 'create') {
      const name = String(input.name || '').trim();
      if (!name) throw fail(400, 'a name is required to create a project');
      const taken = (await host.call('projects.list', {})).find((p) => p.name.toLowerCase() === name.toLowerCase());
      if (taken) throw fail(409, `a project named "${taken.name}" already exists (id ${taken.id})`);
      return { ...base, name, description: String(input.description || '').slice(0, 500), color: input.color || null };
    }

    const project = await projectById(input.id);
    const common = { ...base, projectId: project.id, projectName: project.name };

    if (change === 'rename') {
      const name = String(input.name || '').trim();
      if (!name) throw fail(400, 'a new name is required to rename a project');
      if (name === project.name && input.description === undefined) throw fail(400, `"${project.name}" is already called that`);
      return { ...common, name, description: input.description === undefined ? undefined : String(input.description).slice(0, 500), color: input.color ?? undefined };
    }

    if (change === 'delete') {
      const holds = Object.entries(project.resources || {}).filter(([, ids]) => (ids || []).length);
      return {
        ...common,
        // what the user is about to lose the grouping of: the resources themselves are never deleted
        holds: holds.map(([kind, ids]) => ({ kind, count: ids.length })),
      };
    }

    assertKind(input.kind);
    const resourceId = String(input.resourceId || '');
    if (!resourceId) throw fail(400, 'resourceId is required');
    const attached = (project.resources?.[input.kind] || []).includes(resourceId);
    if (change === 'attach' && attached) throw fail(409, `that ${RESOURCE_LABELS[input.kind]} is already in "${project.name}"`);
    if (change === 'detach' && !attached) throw fail(409, `that ${RESOURCE_LABELS[input.kind]} is not in "${project.name}"`);
    const owners = await host.call('projects.resourcesFor', { kind: input.kind, resourceId }).catch(() => []);
    return {
      ...common, kind: input.kind, resourceId,
      // attaching something another project holds is legal but worth seeing on the card
      alsoIn: (owners || []).filter((p) => p.id !== project.id).map((p) => p.name),
    };
  }

  /** Carry out an approved change. Everything that made it safe is checked again. */
  async function applyProjectChange(p) {
    if (p.change === 'create') {
      const created = await write('projects.create', { name: p.name, description: p.description || '', color: p.color || null });
      host.emit('changed', { id: created.id });
      await host.audit({ action: 'projects-create', project: created.name, by: 'agent-proposal' });
      return { id: created.id, name: created.name };
    }
    const project = await projectById(p.projectId);
    if (p.change === 'rename') {
      const body = { id: project.id, name: p.name };
      if (p.description !== undefined) body.description = p.description;
      if (p.color !== undefined) body.color = p.color;
      const updated = await write('projects.update', body);
      host.emit('changed', { id: project.id });
      await host.audit({ action: 'projects-rename', from: project.name, to: updated.name, by: 'agent-proposal' });
      return { id: updated.id, name: updated.name };
    }
    if (p.change === 'delete') {
      await write('projects.remove', { id: project.id });
      host.emit('changed', { removed: project.id });
      await host.audit({ action: 'projects-remove', project: project.name, by: 'agent-proposal' });
      return { removed: project.id, name: project.name };
    }
    assertKind(p.kind);
    const method = p.change === 'attach' ? 'projects.link' : 'projects.unlink';
    const updated = await write(method, { id: project.id, kind: p.kind, resourceId: p.resourceId });
    host.emit('changed', { id: project.id });
    await host.audit({ action: `projects-${p.change}`, project: project.name, kind: p.kind, resourceId: p.resourceId, by: 'agent-proposal' });
    return { id: updated.id, kind: p.kind, resourceId: p.resourceId };
  }

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

    /* What the assistant may do with projects.
     *
     * Reading is direct; every CHANGE is a proposal the user approves in the chat, because a project
     * is how the workspace is partitioned - deleting one, or detaching a server from one, changes
     * what every other conversation can see. Same rule the rest of the application follows. */
    assistantTools: {
      list_projects: {
        description: 'List the projects in this workspace, with the id, name, description and the resources each one groups. Use it to resolve a project NAME the user said into the id every other tool needs. Input: none. Read-only.',
        run: async () => ({ projects: await host.call('projects.list', {}) }),
      },

      project_for_resource: {
        description: `Which projects a resource belongs to, so you can say whether it is shared or owned. A resource attached to no project is visible to every project; one attached to a project exists only inside it. Input: {"kind":"${RESOURCE_KINDS.join('|')}","resourceId":"..."}. Read-only.`,
        parameters: { kind: `one of ${RESOURCE_KINDS.join(', ')}`, resourceId: 'the resource id' },
        run: async ({ kind, resourceId } = {}) => {
          assertKind(kind);
          if (!resourceId) throw fail(400, 'resourceId is required');
          const projects = await host.call('projects.resourcesFor', { kind, resourceId: String(resourceId) });
          return {
            kind, resourceId,
            projects: (projects || []).map(({ id, name }) => ({ id, name })),
            shared: !projects || projects.length === 0,
          };
        },
      },

      propose_project_change: {
        description: 'PROPOSE a change to the projects of this workspace. The user must approve the card in the chat before anything happens; never say it is done until they have. '
          + 'Input: {"action":"create"|"rename"|"delete"|"attach"|"detach", "id":"<project id, every action but create>", "name":"<create and rename>", "description":"<optional>", "color":"<optional #rrggbb>", '
          + `"kind":"<${RESOURCE_KINDS.join('|')}>, attach and detach", "resourceId":"<attach and detach>", "reason":"<why, one sentence>"}. `
          + 'Attaching takes a resource OUT of the shared pool and into that project alone; detaching returns it to the pool. Use list_projects for ids.',
        parameters: {
          action: `create, rename, delete, attach or detach`,
          id: 'the project id (all but create)', name: 'the project name (create, rename)',
          description: 'optional', color: 'optional #rrggbb',
          kind: `one of ${RESOURCE_KINDS.join(', ')} (attach, detach)`, resourceId: 'the resource id (attach, detach)',
          reason: 'one sentence on why',
        },
        run: async (input = {}) => {
          const proposal = await buildProjectProposal(input);
          await host.call('assistant.propose', proposal);
          await host.audit({ action: 'projects-proposed', change: proposal.change, project: proposal.projectName || proposal.name || null });
          return {
            proposalId: proposal.id, status: 'pending_user_approval',
            note: `Nothing has changed. The user must approve "${describeChange(proposal)}" in the chat.`,
          };
        },
      },
    },

    proposalKinds: {
      /* Approving re-runs every check the proposal was built on: the workspace may have moved on
         between the card being raised and the user clicking it. */
      'project-change': {
        label: (p) => `proposal to ${describeChange(p)}`,
        approve: async (p) => applyProjectChange(p),
      },
    },

    /* Nothing runs in the background; removal never interrupts work. */
    busy: () => false,
    async deactivate() {},
  };
}

module.exports = { activate, storageVersion: 1 };
