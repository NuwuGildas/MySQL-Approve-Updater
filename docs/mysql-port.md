# MySQL persistence port

Runtime integration is implemented. `APP_STORAGE=files` remains the default; `APP_STORAGE=mysql` makes MySQL authoritative for application documents, encrypted vaults, logs, backups and browser preferences. Existing local data is not automatically imported or deleted. This workspace has not been switched to MySQL and live database validation remains required before production cutover.

## Design

Use a dedicated application database, separate from every database this tool edits through approved rules. Existing `mysql2` is reused; no new dependency is needed. Target MySQL 8.4 with InnoDB.

`lib/persistence/mysql.js` provides asynchronous `get`, `put`, `readJson`, `writeJson`, `keys` and `transaction`. `st_documents` stores documents by stable relative path, with binary content and an integer revision. Binary storage preserves JSON formatting, SQL backups, logs and encrypted vault bytes exactly. This first stage keeps existing versioned document shapes; later migrations can split high-volume conversations, deployment events and audit entries into indexed tables without losing unknown module fields.

Create-only writes use revision 0. Updates require the revision returned by the read. Conflicts reject with `storage_conflict`: reload and reapply the user's mutation; never blindly retry the old snapshot. Transactions use one pooled connection. New features should use this asynchronous API, with acknowledged writes awaited before returning success.

The existing synchronous store APIs use `lib/persistence/runtime.js`, an explicit file-shaped adapter backed by a dedicated database worker thread. Node's global filesystem API is not patched. Synchronous calls wait for DB acknowledgement; asynchronous calls return promises. Atomic replacement uses a database transaction. Log append uses a SQL append, not a filesystem mirror. A database error or timeout latches the process unhealthy (HTTP 503) until restart, preventing later saves of stale in-memory state. No automatic fallback to local files occurs.

This compatibility bridge can block the host event loop during legacy synchronous operations (up to 15 seconds on timeout). Use a nearby database and one host process per database. Advisory locks prevent duplicate host/module-role writers; revision checks guard conflicting document updates between processes. This is not a horizontally scalable cache-coherence design. Database-backed logs are still whole binary documents, so indexed event tables and streamed/chunked large-object storage remain future scalability improvements.

## Rehearse the migration

1. Stop the app and any deployment/CLI writers. Copy DATA_DIR to a protected offline backup. Run the following against that copy using `SERVER_TOOLS_DATA_DIR`; importing from a live directory is unsupported.
2. Create a dedicated empty database (for example `server_tools`) and scoped credentials. Configure `APP_DB_HOST`, `APP_DB_PORT`, `APP_DB_NAME`, `APP_DB_USER`, `APP_DB_PASSWORD`, and optionally `APP_DB_SSL_CA` in its `.env` or the process environment. Keep `APP_STORAGE=files` during preparation. The tooling does not use saved target connection profiles. Keep credentials outside source control.
3. Run `npm run storage -- plan`. This is read-only and needs no database. It lists file names, sizes and hashes, never content. Review the manifest in `lib/persistence/transfer.js` for any custom stores.
4. Run `npm run storage -- init` to create the table. DDL is a separate step because it is not part of the import transaction. Use a migration account with CREATE permission; runtime needs SELECT, INSERT, UPDATE and DELETE on the application schema.
5. Run `npm run storage -- import`, then `npm run storage -- verify`. Import is transactional, accepts identical existing records, and refuses differing records. A failed import rolls back its inserts. It never deletes or modifies source files. Database commands acquire the runtime host lock and refuse to run against an active host.
6. Run `npm run storage -- export C:\\path\\to\\new-restore-directory` to rehearse recovery. The destination must not exist and its parent must exist. Export refuses existing paths. Stop writers during export for a coherent snapshot. On failure, the new directory can contain a partial export and must not be used as a restore.

Large files are held in memory individually and sent as single parameters. Set a suitable server `max_allowed_packet` and allow space for the import transaction. Large production logs should move to an append-only event table before cutover. See the [MySQL packet limit documentation](https://dev.mysql.com/doc/refman/8.4/en/packet-too-large.html). The adapter uses the [mysql2 promise API](https://sidorares.github.io/node-mysql2/docs/documentation/promise-wrapper).

## What moves, and what needs separate handling

| Data | Preparation coverage / cutover work |
| --- | --- |
| Settings, connections, rules, agent configuration | Imported and read/written through the selected adapter. |
| Projects, project chats, SSH session history and memory | Imported and persisted through the selected adapter. |
| Connector profiles, deployment repositories/targets/runs/servers/templates | Imported and persisted by the updated module packages. |
| Module registry and module data | `module-data/state.json` and `module-data/data/**` imported. Registry persistence is wired; new modules must use `host.storage.fs` / `host.storage.promises` for managed data and declare `storageVersion: 1`. |
| Encrypted vaults | Raw ciphertext imported and DB-backed. Encryption and external master keys are unchanged. |
| Audit/crash logs, deploy logs, SQL backups | Imported and future writes persisted in DB. Database failures are reported on stderr; crash diagnostics cannot be written to an unavailable DB. |
| Encryption master keys, SSH keys, `.env` | Deliberately excluded. Transfer securely and preserve key-path settings. Keep master keys outside the DB; ciphertext is unusable without them. |
| Installed module code, working repositories, caches, executables | Remain filesystem artifacts. Reinstall matching module versions on the destination; imported registry state alone cannot restore executable code. |
| Browser preferences, SQL/AI history, module preferences | `AppPreferences` imports application-prefixed localStorage on first page load, preserving existing server values. Future edits use `/api/browser-state`; failed saves remain pending and warn before closing the page. Values are shared across browsers for this single-user app; localStorage is only a cache. |
| Active SSH connections, running child processes and in-memory jobs | Cannot be resumed by copying data; reconnect/reconcile after startup. |

Protect the DB and exported files as credentials: existing connection documents can contain passwords. The importer preserves existing encryption; it does not encrypt plaintext profiles. Inventory rejects invalid JSON, unsafe paths and symlinks. ASCII document keys are required; rename unsupported custom module file names before importing.

## Cutover and module updates

1. Update the host and module packages while still using file mode. The host SDK is now 1.1.0. Compatible packages are connectors 1.1.0, deployments 1.3.0, history 1.2.0, projects 1.2.0 and servers 1.4.0. They were built locally in `dist/modules`. Refresh the local catalog with `npm run modules:local -- --no-build`, then use Modules to update each installed package. Nothing has been installed into the running application automatically.
2. Module sources live outside the tracked base tree in this repository. Their edits are present under `modules/`; reviewable patches for just this change are also preserved under `docs/module-patches/`. Apply those patches from each corresponding module checkout if transferring the changes elsewhere. They assume the source state present when this port began; review conflicts against older module branches. Publish/build modules using the repository's normal module workflow.
3. Open the updated app once to import each browser's old preferences. Stop all writers, take a fresh backup, and import/verify into the destination as above. Runtime and migration tooling must not operate concurrently. The importer refuses changed destination documents; rehearse with a separate disposable database so the final destination can start empty.
4. Set `APP_STORAGE=mysql`, restore the same master key and SSH key files, and start the updated host. Startup validates the DB connection, schema and persisted JSON before serving. Old backend packages are refused in MySQL mode instead of writing to files; update them before cutover. Code-only third-party modules also need the compatibility declaration following a storage review.
5. Check `/api/state` for `storage.mode: "mysql"`, then exercise settings, project edits, chats, vault changes and module operations, and restart. Verify those changes survive with no new root application JSON files. Stop immediately on any storage error and resolve it before restarting; a timed-out operation has an unknown commit outcome.
6. For rollback, stop writers and export the CURRENT DB to a fresh directory. Restore key/config files and module code separately, set `APP_STORAGE=files`, and point `SERVER_TOOLS_DATA_DIR` at that directory. Old pre-cutover JSON files do not contain new database writes. A fresh destination is essential so deleted records do not reappear from old files.

Packaged `.exe` artifacts have not been rebuilt or verified with the worker-thread bridge. Use `node server.js` for the initial cutover and validate a new executable separately before distributing it.

## Validation

`npm run test:storage` covers transfer fidelity, repeat imports, conflicts, rollback, invalid JSON, changed sources, path validation, worker transport, binary data, fail-closed behavior and preference migration without MySQL. Two live tests are skipped by default. Set `APP_DB_TEST=1` and all APP_DB credentials in the process environment, pointing at an EMPTY disposable database, then run the same command to exercise SQL and real HTTP save/restart behavior. Tests create the schema and clean their test documents. `.github/workflows/mysql-storage.yml` runs these against a MySQL 8.4 service in CI; adding the workflow does not mean that CI has run yet.
