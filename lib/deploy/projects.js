'use strict';

const fs = require('fs');

const fail = (status, message) => Object.assign(new Error(message), { status });

/** A deployment has one owner. Shared repositories, servers and credentials do not. */
function requireProject(stores, id) {
  if (stores.projects.readOnly) throw fail(503, stores.projects.readOnly);
  if (typeof id !== 'string' || !id.trim()) throw fail(400, 'A project is required for every deployment');
  const project = stores.projects.get(id);
  if (!project) throw fail(400, 'projectId must reference an existing project');
  return project;
}

/** Upgrade legacy targets and run history before HTTP, CLI or auto-ship can use them.
 * Keep existing owners, otherwise prefer a legacy project link, then General/first project.
 * Back up each changed file once; never rewrite an unreadable project store.
 */
function migrateDeploymentProjects(stores, log = () => {}) {
  const projects = stores.projects;
  const fallback = projects.get('general') || projects.list()[0];
  if (projects.readOnly || !fallback) return;
  const legacyOwner = (id) => projects.list().find((p) => (p.resources.targets || []).includes(id));
  function migrateStore(store, key, ownerFor) {
    let changed = 0;
    const rows = store.get()[key].map((row) => {
      const owner = projects.get(row.projectId) || ownerFor(row) || fallback;
      if (row.projectId === owner.id && (key !== 'runs' || row.projectName)) return row;
      changed++;
      return { ...row, projectId: owner.id, ...(key === 'runs' ? { projectName: owner.name } : {}) };
    });
    if (!changed) return;
    const next = { ...store.get(), [key]: rows };
    const backup = `${store.file}.before-project-ownership.bak`;
    if (fs.existsSync(store.file) && !fs.existsSync(backup)) fs.copyFileSync(store.file, backup);
    store.setSync(next);
    log('info', `Assigned project ownership to ${changed} deployment ${key}`);
  }
  migrateStore(stores.targets, 'targets', (t) => legacyOwner(t.id));
  migrateStore(stores.runs, 'runs', (r) => {
    const target = stores.findTarget(r.targetId);
    return projects.get(target?.projectId) || legacyOwner(r.targetId);
  });
}

module.exports = { requireProject, migrateDeploymentProjects };
