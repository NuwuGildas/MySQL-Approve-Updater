# Server Tools

Rule-based batch updates for MySQL/MariaDB with a hard guarantee: **no row is ever
written without your explicit, per-row approval in the web UI.**

You define rules (fetch + transform) in the browser, run a **preview** (read-only),
then walk through the proposed changes one by one. Each **Approve** executes exactly
one parameterized single-row `UPDATE`; **Reject**/**Skip** write nothing.

## Setup

Requirements: Node 20+, network access to your MySQL/MariaDB (directly or via SSH).

```bash
npm install
copy .env.example .env    # then edit .env
npm start                 # or: npm run dev (auto-restart on file changes)
```

Open <http://localhost:3000>. The server binds to **127.0.0.1 only** — there is no
login, so do not expose the port.

On first visit a **guided tour** (intro.js) walks through the interface; re-run it
anytime with the **❓ Tour** button in the header. Note: intro.js is AGPL-3.0 /
commercially dual-licensed — fine for internal use, but check the license before
distributing this tool.

### Connection profiles

Connections are managed in the UI: **⚙ Connections** in the header opens a modal
where you save multiple named profiles (DB settings + optional SSH tunnel each),
**Test** them, and pick which one is active. Profiles live in `connections.json`;
on first run your `.env` settings are migrated into it automatically, so `.env`
is just the seed. Switching profiles is blocked while a session has pending
changes (abort first), and clears the current session — previews belong to the
database they were made on. Passwords are stored in `connections.json` in plain
text (same trust level as `.env`) and are never sent to the browser; leaving a
password blank when editing keeps the stored one.

### Direct connection (.env seed)

```ini
DB_HOST=db.internal   DB_PORT=3306
DB_USER=...           DB_PASSWORD=...
DB_NAME=mydatabase
```

### Via SSH tunnel

Set `SSH_HOST` and the tunnel is used automatically; set `SSH_TUNNEL=false` to
switch it off without removing the SSH settings (DB_HOST must then be reachable
directly). `DB_HOST`/`DB_PORT` with the tunnel on mean
the MySQL address **as seen from the SSH server** (usually `127.0.0.1:3306`):

```ini
DB_HOST=127.0.0.1     DB_PORT=3306
DB_USER=...           DB_PASSWORD=...     DB_NAME=mydatabase

SSH_HOST=ssh.example.com
SSH_PORT=22
SSH_USER=deploy
SSH_PRIVATE_KEY_PATH=C:\Users\you\.ssh\id_ed25519   # or SSH_PASSWORD=...
SSH_PASSPHRASE=                                      # if the key is encrypted
```

The server opens one SSH connection and a local forwarder; every pooled MySQL
connection is multiplexed through it. If the SSH link drops, the pool is discarded
and rebuilt on the next request.

No database connection is opened at startup — only when you click **Load schema**
or **Run preview**.

## Standalone executable (no Node required)

`npm run build` produces `dist/mysql-approve-updater.exe` (~96 MB, Node runtime
included, built with @yao-pkg/pkg). Copy the exe anywhere, put a `.env` next to
it, and double-click: the server starts and your default browser opens the UI
(set `MAU_NO_OPEN=1` to suppress the auto-open). All mutable files — `.env`,
`rules.json`, `connections.json`, `audit.log`, `backups/` — live NEXT TO the
exe, so they survive replacing it with a newer build. The UI and vendor
libraries are baked into the binary.

## How rules work

A rule = *fetch* + *transform*, edited in the left panel and persisted to `rules.json`.

- **Fetch**: target table, free-form `WHERE` condition, optional `LIMIT`
  (server-capped at `MAX_PREVIEW_ROWS`, default 500), and the primary-key column.
  "Identifying columns" are extra columns shown on each card so you can recognize
  the row.
- **Transforms** (applied in order, later ones see earlier results), each targeting
  one column:
  - **Find / replace** — plain text or regex; regex supports capture groups
    (`$1`, `$2`, …) and flags (default `g`).
  - **Trim whitespace**
  - **Change case** — upper / lower / title
  - **Add prefix / Add suffix**
  - **Set fixed value** — a literal, or NULL

  Adding a new transform type is one entry in the `TRANSFORMS` registry in
  `server.js` (a `label`, `validate(params)`, `apply(value, params)`) plus a
  matching entry in `PARAM_FIELDS` in `public/index.html`.

**Run preview** fetches matching rows and computes new values **in memory**. Rows
where nothing would change are dropped. Then the approval queue shows one card per
row with a character-level before/after diff (red strikethrough = removed,
green = added). Decide with the buttons or keyboard: **A** approve, **R** reject,
**S** skip (acts on the highlighted first card).

**Backups**: every preview automatically saves a restore script to
`backups/backup-<table>-<timestamp>.sql` — one `UPDATE ... WHERE pk = ... LIMIT 1`
per proposed row, restoring the values captured at preview time — *before* any
approval is possible. The same snapshot is downloadable from the queue toolbar as
`.sql` or `.json`. To undo a batch, review the script and run it against the DB.

**Manual edits**: every changed column on a pending card has an **✎ Edit** button —
tweak the proposed value by hand before approving. The edit lives in memory only
(nothing is written until Approve), the diff re-renders against your version, the
column is marked "edited", and the audit log records both the rule's proposal and
your manual one (`manualEdit: true` on the approval). Stale protection is
unchanged — the update is still conditioned on the preview-time value.

**Batch decisions**: tick the checkbox on any cards (or **Select all pending**) and
use **Approve / Reject / Skip selected**. A batch is just the single-row path in a
loop: each row gets its own guarded `UPDATE`, stale check, and audit line — an
externally-modified row still comes back `stale`, and pausing the session stops the
batch between rows.

## Safety model

1. **Single write path.** The only SQL write in the codebase lives in
   `executeApprovedChange()` (`server.js`), reachable solely from
   `POST /api/session/decision` with `action: "approve"` — i.e. your click.
   Previews, schema loads, and re-reads are SELECTs.
2. **One row per approval.** The update is
   `UPDATE t SET col = ? WHERE pk = ? AND col <=> <preview value> LIMIT 1`,
   fully parameterized. The server verifies `affectedRows === 1` and re-reads the
   row to confirm.
3. **Stale detection is atomic.** The `UPDATE` is conditioned on the values
   captured at preview time (null-safe `<=>`). If someone changed the row in the
   meantime, the update matches nothing, the row is flagged **stale**, its current
   DB value is shown, and nothing is overwritten. Re-run the preview to act on it.
4. **Identifiers are schema-validated.** Table, PK, transform and display column
   names must exist in `information_schema` for the configured database before any
   query is built (and are backtick-quoted on top of that). All *values* travel as
   bound parameters.
5. **The `WHERE` clause is trusted operator input.** It is raw SQL by design (the
   UI labels it as such). It is only ever used inside a SELECT, wrapped in
   parentheses, with a server-enforced LIMIT; `;` is rejected and
   `multipleStatements` is disabled.
6. **Audit trail.** Every preview and decision is appended to `audit.log` as a JSON
   line (timestamp, rule, table, pk, old/new values, action, SQL result).
   Downloadable from the header. Rejects/skips log `sqlResult: null` — proof
   nothing ran.
7. **Session control.** Pause blocks approvals server-side (not just in the UI);
   Abort discards all pending changes. If the server restarts mid-session, pending
   changes are simply gone; approved ones were already committed row-by-row.

**SQL console**: the bottom drawer runs ad-hoc queries against the active
connection. It is deliberately **read-only** (single statement; SELECT / SHOW /
DESCRIBE / EXPLAIN only, results capped at 200 rows) so that the per-row approval
flow remains the only write path. Ctrl+Enter runs; the last 20 queries are kept
in browser history.

## Known limitations

- **One session at a time.** Starting a new preview requires the previous session
  to be finished or aborted. Single operator assumed (no login, localhost-only).
- Transforms operate on the **string form** of values (`dateStrings` is enabled, so
  dates round-trip as strings). Binary/BLOB columns are not supported. Setting a
  string into a numeric column relies on MySQL's normal coercion rules.
- The `WHERE` clause can call stored functions; a function with side effects could
  write during a preview. Don't do that — it is trusted operator input.
- A user-supplied catastrophic regex can hang the preview (ReDoS) — again, operator
  input on a local tool.
- Pending changes live in server memory only; a restart clears them (by design).
- No multi-column primary keys; pick a single unique column as the PK.

## Files

- `server.js` — Express app, SSH tunnel, schema validation, transforms, session +
  approval engine, SSE, audit.
- `public/index.html` + `public/style.css` + `public/app.js` — the whole UI (no build step).
- `rules.json` — your rules (created on first save).
- `connections.json` — saved connection profiles (seeded from `.env` on first run).
- `audit.log` — JSON-lines audit trail (created on first preview/decision).
- `backups/` — auto-saved restore scripts, one per preview (created on first preview).