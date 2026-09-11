'use strict';
/* Shared services the host offers to module workers, and the capability gate in
 * front of each one.
 *
 * A module can only reach what its manifest asked for and the user saw before
 * installing. Everything here is genuinely shared infrastructure that must keep
 * working when the module that uses it most is absent: the audit trail is
 * written whether or not Activity History is installed, database connections
 * keep their SSH tunnels whether or not Servers is installed, and the assistant
 * keeps its default conversation whether or not Projects is installed. */

const fail = (status, message, code) => Object.assign(new Error(message), { status, code });

/**
 * @param providers host-owned implementations. Every one is optional; a missing
 *                  provider makes its methods unavailable rather than crashing.
 */
function createServices(providers = {}) {
  const { audit, connections, projects, vault, assistant, settings, events, log = () => {} } = providers;

  /* method → [capability, implementation]. The capability string is exactly what
     the marketplace shows the user under "this module will be able to". */
  const table = {
    'log.write': ['*', (module, { level, message }) => { log(level || 'info', `[${module.id}] ${message}`); return true; }],

    'audit.record': ['audit:write', (module, entry) => audit?.record({ ...entry, module: module.id })],
    'audit.read': ['audit:read', (module, params) => audit?.read(params || {})],
    'audit.download': ['audit:read', (module, params) => audit?.download(params || {})],

    'connections.list': ['connections:read', (module, params) => connections?.list(params || {})],
    'connections.get': ['connections:read', (module, { id }) => connections?.get(id)],
    'connections.save': ['connections:write', (module, params) => connections?.save(params)],
    'connections.remove': ['connections:write', (module, { id }) => connections?.remove(id)],
    'connections.appKey': ['connections:read', () => connections?.appKey()],
    // Credentials leave the host only for a module that asked for it in its manifest.
    'connections.credentials': ['connections:secrets', (module, { id }) => connections?.credentials(id)],
    'connections.sshOptions': ['connections:secrets', (module, { id }) => connections?.sshOptions(id)],

    'projects.list': ['projects:read', () => projects?.list()],
    'projects.get': ['projects:read', (module, { id }) => projects?.get(id)],
    'projects.resourcesFor': ['projects:read', (module, { kind, resourceId }) => projects?.projectsFor(kind, resourceId)],
    /* Which of `ids` a project may see. A resource attached to a project exists
       only inside it; one attached to nothing is shared by every project. A
       module filters its own lists through this so no two surfaces disagree
       about what a project contains. */
    'projects.visible': ['projects:read', (module, { projectId, kind, ids }) => projects?.visible(projectId, kind, Array.isArray(ids) ? ids : [])],
    'projects.create': ['projects:write', (module, body) => projects?.create(body)],
    'projects.update': ['projects:write', (module, { id, ...body }) => projects?.update(id, body)],
    'projects.remove': ['projects:write', (module, { id }) => projects?.remove(id)],
    'projects.link': ['projects:write', (module, { id, kind, resourceId }) => projects?.link(id, kind, resourceId)],
    'projects.unlink': ['projects:write', (module, { id, kind, resourceId }) => projects?.unlink(id, kind, resourceId)],

    'vault.names': ['vault:read', () => vault?.names()],
    'vault.get': ['vault:read', (module, { name }) => vault?.get(name)],
    'vault.has': ['vault:read', (module, { name }) => vault?.has(name)],
    'vault.values': ['vault:read', () => vault?.values()],
    'vault.set': ['vault:write', (module, { name, value }) => vault?.set(name, value)],
    'vault.remove': ['vault:write', (module, { name }) => vault?.remove(name)],

    'assistant.isConnected': ['assistant:tools', () => !!assistant?.isConnected()],
    'assistant.run': ['assistant:tools', (module, { prompt }) => assistant?.run(prompt)],
    'assistant.note': ['assistant:tools', (module, note) => assistant?.note(note)],

    'settings.get': ['*', () => settings?.get()],
    'settings.patch': ['storage:module', (module, patch) => settings?.patch(module.id, patch)],

    'events.broadcast': ['*', (module, { name, payload }) => events?.broadcast(name, payload, module.id)],
  };

  async function call(moduleId, method, params, record) {
    const entry = table[method];
    if (!entry) throw fail(404, `Unknown host service: ${method}`, 'unknown_service');
    const [capability, implementation] = entry;
    const granted = record?.manifest?.capabilities || [];
    if (capability !== '*' && !granted.includes(capability)) {
      throw fail(403, `${record?.manifest?.name || moduleId} did not request the "${capability}" capability.`, 'capability_denied');
    }
    const result = await implementation({ id: moduleId, manifest: record?.manifest }, params || {});
    return result === undefined ? null : result;
  }

  /** The host adds services that only make sense with its own state in hand. */
  function extend(more) {
    for (const [name, entry] of Object.entries(more)) {
      if (table[name]) throw new Error(`Host service ${name} is already defined`);
      table[name] = entry;
    }
  }

  return { call, extend, methods: () => Object.keys(table), capabilityFor: (method) => table[method]?.[0] || null };
}

module.exports = { createServices };
