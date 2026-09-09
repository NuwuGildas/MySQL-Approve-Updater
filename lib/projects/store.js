'use strict';
/* Project store: groups the reusable resources of this app (DB connections, SSH servers, git
   connectors, deploy repositories and targets) under named projects.

   Persistence: DATA_DIR/projects.json, a versioned JSON document written atomically
   (.tmp + rename, like connections.json and the lib/deploy stores). A project only ever
   holds resource IDs: profile bodies, passwords, tokens and keys stay in their own stores.

   Startup rules:
   - no projects.json           → seed one "General" project (the only time the store invents data);
   - readable, older version    → migrate in memory, keep a .bak of the original, write the new shape;
   - unreadable or newer version → load nothing and refuse writes (the file is never touched). */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const FILE_NAME = 'projects.json';
const VERSION = 1;
const RESOURCE_KINDS = Object.freeze(['connections', 'servers', 'connectors', 'repos', 'targets']);
const RESOURCE_LABELS = Object.freeze({ connections: 'connection', servers: 'server', connectors: 'connector', repos: 'repository', targets: 'target' });
const DEFAULT_PROJECT = Object.freeze({ id: 'general', name: 'General', description: 'Resources that are not assigned to a project yet.' });
const NAME_MAX = 80;
const DESCRIPTION_MAX = 500;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function fail(status, message) { const e = new Error(message); e.status = status; return e; }
const nowIso = () => new Date().toISOString();

function emptyResources() { return Object.fromEntries(RESOURCE_KINDS.map((k) => [k, []])); }

/** Coerce one stored record into a valid project. Unknown fields and unknown resource kinds are kept. */
function normalizeProject(raw, fallbackTime = nowIso()) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const resources = emptyResources();
  const rawRes = src.resources && typeof src.resources === 'object' ? src.resources : {};
  for (const [kind, ids] of Object.entries(rawRes)) {
    if (!Array.isArray(ids)) continue;
    resources[kind] = [...new Set(ids.filter((x) => typeof x === 'string' && ID_RE.test(x)))];
  }
  const id = typeof src.id === 'string' && ID_RE.test(src.id) ? src.id : crypto.randomUUID();
  const name = String(src.name ?? '').trim().slice(0, NAME_MAX) || `Project ${id.slice(0, 8)}`;
  return {
    ...src,
    id,
    name,
    description: String(src.description ?? '').slice(0, DESCRIPTION_MAX),
    color: typeof src.color === 'string' && COLOR_RE.test(src.color) ? src.color : null,
    createdAt: typeof src.createdAt === 'string' ? src.createdAt : fallbackTime,
    updatedAt: typeof src.updatedAt === 'string' ? src.updatedAt : fallbackTime,
    resources,
  };
}

/**
 * Bring a parsed document to the current VERSION. Pure: returns { data, from }.
 * Throws when the document is newer than this code understands (never downgrade someone's data).
 */
function migrate(input) {
  let doc = input;
  if (Array.isArray(doc)) doc = { version: 0, projects: doc }; // pre-versioned bare list
  if (!doc || typeof doc !== 'object') doc = { version: 0, projects: [] };
  const from = Number.isInteger(doc.version) ? doc.version : 0;
  if (from > VERSION) throw fail(500, `${FILE_NAME} is version ${from}, but this build only understands up to ${VERSION}`);
  const t = nowIso();
  const projects = (Array.isArray(doc.projects) ? doc.projects : []).map((p) => normalizeProject(p, t));
  // de-duplicate ids defensively (keeps the first record)
  const seen = new Set();
  const unique = projects.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
  return { data: { ...doc, version: VERSION, projects: unique }, from };
}

function writeAtomicSync(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function createProjectStore(DATA_DIR, { log = () => {} } = {}) {
  const file = path.join(DATA_DIR, FILE_NAME);
  let data = { version: VERSION, projects: [] };
  let readOnly = null;   // string reason when the file must not be written
  let seeded = false;    // true when this start created projects.json
  let migratedFrom = null;

  if (!fs.existsSync(file)) {
    const t = nowIso();
    data = { version: VERSION, projects: [normalizeProject({ ...DEFAULT_PROJECT, createdAt: t, updatedAt: t }, t)] };
    try { writeAtomicSync(file, JSON.stringify(data, null, 2)); seeded = true; }
    catch (e) { readOnly = `${FILE_NAME} could not be created: ${e.message}`; }
  } else {
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { readOnly = `${FILE_NAME} could not be read (${e.message}). Fix or move the file; projects are read-only until then.`; }
    if (!readOnly) {
      try {
        const m = migrate(parsed);
        data = m.data;
        if (m.from !== VERSION) {
          migratedFrom = m.from;
          // keep the original next to the new file, never clobbering an earlier backup
          let bak = `${file}.v${m.from}.bak`;
          if (fs.existsSync(bak)) bak = `${file}.v${m.from}.${Date.now()}.bak`;
          fs.copyFileSync(file, bak);
          writeAtomicSync(file, JSON.stringify(data, null, 2));
          log('info', `Migrated ${FILE_NAME} from version ${m.from} to ${VERSION} (backup: ${path.basename(bak)})`);
        }
      } catch (e) { readOnly = `${e.message}. Projects are read-only until then.`; data = { version: VERSION, projects: [] }; }
    }
  }
  if (readOnly) log('warn', readOnly);

  const assertWritable = () => { if (readOnly) throw fail(503, readOnly); };
  let chain = Promise.resolve();
  function save() {
    if (readOnly) return Promise.reject(fail(503, readOnly));
    const snapshot = JSON.stringify(data, null, 2);
    const p = chain.then(async () => {
      const tmp = file + '.tmp';
      await fsp.writeFile(tmp, snapshot, 'utf8');
      await fsp.rename(tmp, file);
    });
    chain = p.catch((e) => { log('error', `failed to save ${FILE_NAME}: ${e.message}`); });
    return p;
  }

  const list = () => data.projects;
  const get = (id) => data.projects.find((p) => p.id === id) || null;
  const must = (id) => { const p = get(id); if (!p) throw fail(404, 'Project not found'); return p; };

  function cleanFields(body, existing) {
    const out = {};
    if (body.name !== undefined || !existing) {
      const name = String(body.name ?? '').trim();
      if (!name) throw fail(400, 'Project name is required');
      if (name.length > NAME_MAX) throw fail(400, `Project name is too long (max ${NAME_MAX} chars)`);
      const clash = data.projects.find((p) => p !== existing && p.name.toLowerCase() === name.toLowerCase());
      if (clash) throw fail(409, `A project named "${clash.name}" already exists`);
      out.name = name;
    }
    if (body.description !== undefined) {
      const d = String(body.description ?? '');
      if (d.length > DESCRIPTION_MAX) throw fail(400, `Description is too long (max ${DESCRIPTION_MAX} chars)`);
      out.description = d;
    }
    if (body.color !== undefined) {
      if (body.color !== null && body.color !== '' && !COLOR_RE.test(String(body.color))) throw fail(400, 'color must be a #rrggbb value');
      out.color = body.color ? String(body.color) : null;
    }
    return out;
  }

  async function create(body = {}) {
    assertWritable();
    const fields = cleanFields(body, null);
    if (body.id !== undefined) {
      if (typeof body.id !== 'string' || !ID_RE.test(body.id)) throw fail(400, 'Project id has invalid characters');
      if (get(body.id)) throw fail(409, 'A project with this id already exists');
    }
    const t = nowIso();
    const p = { id: body.id || crypto.randomUUID(), name: fields.name, description: fields.description || '', color: fields.color || null, createdAt: t, updatedAt: t, resources: emptyResources() };
    data.projects.push(p);
    await save();
    return p;
  }

  async function update(id, body = {}) {
    assertWritable();
    const p = must(id);
    Object.assign(p, cleanFields(body, p), { updatedAt: nowIso() });
    await save();
    return p;
  }

  async function remove(id) {
    assertWritable();
    const i = data.projects.findIndex((p) => p.id === id);
    if (i < 0) throw fail(404, 'Project not found');
    if (data.projects.length === 1) throw fail(400, 'The last project cannot be deleted: create another project first');
    const [removed] = data.projects.splice(i, 1);
    await save();
    return removed;
  }

  function assertKind(kind) {
    if (!RESOURCE_KINDS.includes(kind)) throw fail(400, `kind must be one of ${RESOURCE_KINDS.join(', ')}`);
  }
  function assertResourceId(rid) {
    if (typeof rid !== 'string' || !ID_RE.test(rid)) throw fail(400, 'resourceId is required');
  }

  /** Attach a resource ID to a project (idempotent). Whether the resource exists is the caller's job. */
  async function link(id, kind, resourceId) {
    assertWritable(); assertKind(kind); assertResourceId(resourceId);
    const p = must(id);
    if (!Array.isArray(p.resources[kind])) p.resources[kind] = [];
    if (!p.resources[kind].includes(resourceId)) {
      p.resources[kind].push(resourceId);
      p.updatedAt = nowIso();
      await save();
    }
    return p;
  }

  /** Detach a resource ID (idempotent: unlinking something not linked is a no-op). */
  async function unlink(id, kind, resourceId) {
    assertWritable(); assertKind(kind); assertResourceId(resourceId);
    const p = must(id);
    const arr = p.resources[kind] || [];
    const i = arr.indexOf(resourceId);
    if (i >= 0) {
      arr.splice(i, 1);
      p.updatedAt = nowIso();
      await save();
    }
    return p;
  }

  /** Projects that reference a resource. */
  function projectsFor(kind, resourceId) {
    assertKind(kind);
    return data.projects.filter((p) => (p.resources[kind] || []).includes(resourceId));
  }

  /** Drop a resource from every project (for callers that delete the resource itself). */
  async function unlinkEverywhere(kind, resourceId) {
    assertWritable(); assertKind(kind);
    const hit = projectsFor(kind, resourceId);
    if (!hit.length) return 0;
    const t = nowIso();
    for (const p of hit) { p.resources[kind] = p.resources[kind].filter((x) => x !== resourceId); p.updatedAt = t; }
    await save();
    return hit.length;
  }

  return {
    file, VERSION, RESOURCE_KINDS, RESOURCE_LABELS,
    get seeded() { return seeded; }, get readOnly() { return readOnly; }, get migratedFrom() { return migratedFrom; },
    get version() { return data.version; },
    list, get, create, update, remove, link, unlink, projectsFor, unlinkEverywhere, save,
  };
}

module.exports = { createProjectStore, migrate, normalizeProject, FILE_NAME, VERSION, RESOURCE_KINDS, RESOURCE_LABELS, DEFAULT_PROJECT };
