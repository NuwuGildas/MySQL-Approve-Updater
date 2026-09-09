'use strict';
/* Per-project AI chat store: one conversation ({ role: 'user'|'assistant'|'note', text, ... }[])
   per project, so switching projects switches the agent's memory.

   Persistence: DATA_DIR/project-chats.json, a versioned JSON document written atomically
   (.tmp + rename, like projects.json). One file rather than one per project because project ids
   may contain characters (":" for instance) that are not valid in file names on every OS.

     { "version": 1, "chats": { "<projectId>": { "messages": [...], "updatedAt": "..." } } }

   Startup rules (mirroring lib/projects/store.js):
   - no project-chats.json, legacy agent-chat.json present → import that history once into the
     default project, write the new file, then rename agent-chat.json to agent-chat.json.bak so the
     import never runs twice (the old file is kept as a backup, not deleted);
   - no project-chats.json, no legacy file → start empty (the file is created on first save);
   - readable, older version    → migrate in memory, keep a .bak of the original, write the new shape;
   - unreadable or newer version → load nothing and refuse writes (the file is never touched). */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const FILE_NAME = 'project-chats.json';
const LEGACY_FILE_NAME = 'agent-chat.json';
const VERSION = 1;
const DEFAULT_PROJECT_ID = 'general';
const MAX_MESSAGES = 200; // per project: a long resumable history, same cap the single chat had
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;
const ROLES = new Set(['user', 'assistant', 'note']);

function fail(status, message) { const e = new Error(message); e.status = status; return e; }
const nowIso = () => new Date().toISOString();

/** Keep only well-formed messages (objects with a known role); unknown fields survive. */
function normalizeMessages(list, max = MAX_MESSAGES) {
  const out = (Array.isArray(list) ? list : []).filter((m) => m && typeof m === 'object' && ROLES.has(m.role));
  return out.length > max ? out.slice(out.length - max) : out;
}

/**
 * Bring a parsed document to the current VERSION. Pure: returns { data, from }.
 * A bare array is the legacy single-conversation shape and lands in the default project.
 * Throws when the document is newer than this code understands (never downgrade someone's data).
 */
function migrate(input, { max = MAX_MESSAGES } = {}) {
  let doc = input;
  if (Array.isArray(doc)) doc = { version: 0, chats: { [DEFAULT_PROJECT_ID]: { messages: doc } } };
  if (!doc || typeof doc !== 'object') doc = { version: 0, chats: {} };
  const from = Number.isInteger(doc.version) ? doc.version : 0;
  if (from > VERSION) throw fail(500, `${FILE_NAME} is version ${from}, but this build only understands up to ${VERSION}`);
  const t = nowIso();
  const chats = {};
  const rawChats = doc.chats && typeof doc.chats === 'object' ? doc.chats : {};
  for (const [id, entry] of Object.entries(rawChats)) {
    if (!ID_RE.test(id)) continue;
    const src = Array.isArray(entry) ? { messages: entry } : (entry && typeof entry === 'object' ? entry : {});
    chats[id] = { ...src, messages: normalizeMessages(src.messages, max), updatedAt: typeof src.updatedAt === 'string' ? src.updatedAt : t };
  }
  return { data: { ...doc, version: VERSION, chats }, from };
}

function writeAtomicSync(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

/** Pick a backup name next to `file` that does not clobber an earlier backup. */
function backupName(file, tag) {
  let bak = tag ? `${file}.${tag}.bak` : `${file}.bak`;
  if (fs.existsSync(bak)) bak = tag ? `${file}.${tag}.${Date.now()}.bak` : `${file}.${Date.now()}.bak`;
  return bak;
}

function createChatStore(DATA_DIR, { log = () => {}, maxMessages = MAX_MESSAGES, defaultProjectId = DEFAULT_PROJECT_ID } = {}) {
  const file = path.join(DATA_DIR, FILE_NAME);
  const legacyFile = path.join(DATA_DIR, LEGACY_FILE_NAME);
  let data = { version: VERSION, chats: {} };
  let readOnly = null;        // string reason when the file must not be written
  let migratedFrom = null;    // previous document version, when an upgrade happened at start
  let importedLegacy = null;  // { count, backup } when agent-chat.json was imported at start

  if (!fs.existsSync(file)) {
    if (fs.existsSync(legacyFile)) {
      let legacy = null;
      try { legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf8')); }
      catch (e) { log('warn', `${LEGACY_FILE_NAME} could not be read (${e.message}); starting with an empty chat and leaving the file alone`); }
      if (Array.isArray(legacy)) {
        const messages = normalizeMessages(legacy, maxMessages);
        data = { version: VERSION, chats: { [defaultProjectId]: { messages, updatedAt: nowIso() } } };
        try {
          writeAtomicSync(file, JSON.stringify(data));
          const bak = backupName(legacyFile);
          fs.renameSync(legacyFile, bak);
          importedLegacy = { count: messages.length, backup: path.basename(bak) };
          log('info', `Imported ${messages.length} message(s) from ${LEGACY_FILE_NAME} into project "${defaultProjectId}" (backup: ${path.basename(bak)})`);
        } catch (e) { readOnly = `${FILE_NAME} could not be created: ${e.message}`; }
      }
    }
  } else {
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { readOnly = `${FILE_NAME} could not be read (${e.message}). Fix or move the file; the AI chat history is read-only until then.`; }
    if (!readOnly) {
      try {
        const m = migrate(parsed, { max: maxMessages });
        data = m.data;
        if (m.from !== VERSION) {
          migratedFrom = m.from;
          const bak = backupName(file, `v${m.from}`);
          fs.copyFileSync(file, bak);
          writeAtomicSync(file, JSON.stringify(data));
          log('info', `Migrated ${FILE_NAME} from version ${m.from} to ${VERSION} (backup: ${path.basename(bak)})`);
        }
      } catch (e) { readOnly = `${e.message}. The AI chat history is read-only until then.`; data = { version: VERSION, chats: {} }; }
    }
  }
  if (readOnly) log('warn', readOnly);

  let chain = Promise.resolve();
  /** Persist the whole document (atomic). Writes are serialized; a failure is logged, never thrown at callers. */
  function save() {
    if (readOnly) return Promise.resolve();
    const snapshot = JSON.stringify(data);
    const p = chain.then(async () => {
      const tmp = file + '.tmp';
      await fsp.writeFile(tmp, snapshot, 'utf8');
      await fsp.rename(tmp, file);
    });
    chain = p.catch((e) => { log('error', `failed to save ${FILE_NAME}: ${e.message}`); });
    return chain;
  }

  /** Map a raw request value to a project id: empty → default project; anything malformed → 400. */
  function resolveProjectId(raw) {
    if (raw === undefined || raw === null || raw === '') return defaultProjectId;
    const id = String(raw).trim();
    if (!id) return defaultProjectId;
    if (!ID_RE.test(id)) throw fail(400, 'projectId has invalid characters');
    return id;
  }

  function bucket(projectId, create) {
    const id = resolveProjectId(projectId);
    let b = data.chats[id];
    if (!b && create) { b = data.chats[id] = { messages: [], updatedAt: nowIso() }; }
    return b || null;
  }

  /** The live message array for a project (same reference across calls; empty for unknown projects). */
  function get(projectId) {
    const b = bucket(projectId, false);
    return b ? b.messages : [];
  }

  /** Append a message, trim to the cap, persist. Returns the stored message. */
  function push(projectId, message) {
    if (!message || typeof message !== 'object' || !ROLES.has(message.role)) throw fail(400, 'message must have a role of user, assistant or note');
    const b = bucket(projectId, true);
    b.messages.push(message);
    if (b.messages.length > maxMessages) b.messages.splice(0, b.messages.length - maxMessages);
    b.updatedAt = nowIso();
    save();
    return message;
  }

  /** Forget one project's conversation (the other projects are untouched). */
  function reset(projectId) {
    const id = resolveProjectId(projectId);
    const had = !!data.chats[id];
    if (had) { delete data.chats[id]; save(); }
    return had;
  }

  /** Forget every conversation (used when the agent is disconnected). */
  function resetAll() {
    const n = Object.keys(data.chats).length;
    data.chats = {};
    if (n) save();
    return n;
  }

  const projectIds = () => Object.keys(data.chats);

  return {
    file, legacyFile, VERSION, MAX_MESSAGES: maxMessages, DEFAULT_PROJECT_ID: defaultProjectId,
    get readOnly() { return readOnly; }, get migratedFrom() { return migratedFrom; }, get importedLegacy() { return importedLegacy; },
    get version() { return data.version; },
    resolveProjectId, get, push, reset, resetAll, projectIds, save,
    /** Resolves when every write issued so far has landed (tests and shutdown). */
    flush: () => chain,
  };
}

module.exports = { createChatStore, migrate, normalizeMessages, FILE_NAME, LEGACY_FILE_NAME, VERSION, DEFAULT_PROJECT_ID, MAX_MESSAGES };
