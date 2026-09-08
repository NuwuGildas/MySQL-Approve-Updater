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

**Navigation shell.** One persistent navigation column (Home; Database: Updates, SQL console,
Schema map; Infrastructure: Deployments, Servers; Workspace: Connections, History; Settings and the
guided tour at the bottom) with hash routes such as `#/database/updates`, `#/deployments/targets/<id>`
and `#/servers`. Browser Back/Forward and direct links work; the current page is marked with
`aria-current`; the sidebar collapses to icons under 1100px and becomes an off-canvas menu behind the
header button under 768px. The Ascension, Servers and History fill the content area next to the
sidebar. The header keeps the app identity, the assistant, the theme switch and Settings; the approval
session controls (Pause, Resume, Abort) moved into a session bar on the Updates page. The green dot in
the header means the browser is connected to Server Tools, not that a database or server is healthy.

**Pages.** SQL console, Schema map, Connections and Settings are full pages inside the shell (`#/database/sql`,
`#/database/schema`, `#/connections`, `#/settings/<section>`); Escape returns to the previous page. The schema
inspector lists tables for keyboard navigation and becomes a bottom sheet on phones. History has search,
time and outcome filters that persist. In Deployments, **New deployment** starts the five-step wizard, a
resource switcher shows Targets, Repositories, Secrets or Cloud servers, and tabs are labelled Run vs Target.
A terminal opened from a server card gets its own address (`#/servers/<id>/terminal`). The assistant can
dock beside the workspace on wide screens from its ⋯ menu.

**Connectors.** The Connectors page (`#/connectors`) holds GitHub and GitLab accounts. Paste a personal
access token once (or point at a vault secret): it is stored in the encrypted vault under a
`GITHUB_TOKEN_*` / `GITLAB_TOKEN_*` name, verified against the provider (`/user`), and the card shows the
account, its scopes and the verification state. "Browse repositories" opens the connector's repositories view (`#/connectors/<id>/repos`), listing what the token can see;
**Connect** prefills the repository form with the clone URL, default branch and the token reference.
GitHub Enterprise and self-managed GitLab work through the base URL. API: `/api/connectors`
(list, create, update, verify, repos, delete). Tokens never leave the vault.

**Deployment targets.** The target dialog is organised by intent: **Source** (repository, its branch,
"Deploy automatically when `main` changes") and **Server** (destination, connection method, host or server
profile, username, vault secret with an inline "+ Secret", deployment directory, **Test connection**), then
collapsible **Environment**, **Health checks**, **Release settings**, **Automation details** and **Advanced
overrides**, each with a one-line summary. New targets get a prefilled name, default ports (21 / 990 / the
profile's SSH port), a derived releases folder and the build strategy implied by the destination; existing
targets keep every explicit value. **Test & create / Test & save** connects and probes the draft first
(`POST /api/deploy/targets/test`), with "Save without testing" as the fallback. The webhook secret is
shown for saved targets and rotated with an explicit, confirmed action.

**Adding a server.** The Add server dialog offers three ways to authenticate: the **Server Tools key**
(recommended: one ed25519 key pair generated on first use under `deploy-keys/server-tools.key`; the dialog
shows the one-line command that appends its public half to the server's `authorized_keys`, and the same
key works for every server), **My own key** (paste a private key, stored owner-only under `deploy-keys/`,
or point to a key file on this machine) or a **Password**. Private keys are never returned by the API.
Ticking **Auto-install Claude CLI** connects right after saving and installs the CLI with the official script
when it is missing; you then run `claude` once in the server's terminal to log in.

**Views, modals and type.** The Ascension, Servers and History render as in-flow views next to the
sidebar (no sliding drawers). The connection profile form and the Add server form open as modal dialogs.
The UI uses a 16px base size and the Manrope typeface in both themes (loaded from Google Fonts with a
local fallback); consoles, code and logs stay monospace.

**Theme.** Dark by default; switch to light (or follow the OS) under *Settings → Appearance* or with
the sun/moon button in the header and in The Ascension; the choice is remembered per browser.

**Deploy assistance (opt-in).** Under *Settings → AI assistant → Deploy assistance* you can grant
the assistant extra, read-only capabilities for The Ascension. Each one is off by default:

- *Read-only repo file access*: a whitelisted view of key files (ship.json, Dockerfile, compose,
  package.json, composer.json, .env.example, requirements.txt, pyproject.toml, Procfile, README) with
  secret-looking values masked.
- *Plan-run diffs*: every Plan records what would change versus the last successful ship (commits,
  manifest keys, commands, build location) and whether the server still serves that baseline. Shown
  in the Plan tab.
- *Post-ship health checks*: the health URL and the stored server probe (current release, releases on
  disk, lock) become a read-only tool, so a ship can be verified rather than inferred.
- *Full log search*: regex search over a run's whole redacted log, plus a filter box in the Log tab.
- *Manifest templates with guardrails*: per-framework starter manifests that already satisfy the
  safety rules (database backup in a `before_ship` hook ahead of migrations, shared `.env` and
  storage, start command and port for services, health path). AI manifest proposals must pass the
  guardrail check before they reach you.
- *Pre-ship checklist*: Ship becomes *Review & Ship*: the assistant reviews the manifest, latest plan
  and last run first and its verdict is shown in the confirmation. Advisory only; you decide.

- *Propose fixes when a run fails*: a failed plan, ship or rollback is analysed automatically and, when a
  deploy action would help, it is proposed in the chat.

**Actions with confirmation.** The assistant can propose deploy actions (Plan, Ship, Rollback to a
release, force-unlock, cancel) with `propose_deploy_action`, on its own initiative or after analysing a
failure. Each proposal is a card in the AI chat with *Approve* and *Reject*; nothing runs until you
approve, and an approved action goes through the same engine path as the UI buttons (a Ship reuses the
latest reviewed plan hash). Approvals are audited as `deploy-agent-action`.

**Send to AI chat.** Every run has a "Send to AI chat" button (Log tab, and each row of Recent
activity) that posts the run summary and its redacted log tail into the conversation as a card, so you
can ask about it or let the assistant propose the fix. Loopback and private hosts are classified as
local test targets by the pre-ship review, so they are never "blocked" for production-only reasons.

`before_ship` hooks now run on the new release after shared paths are linked and before the stack's
own after-ship steps (Laravel migrations), which is where a backup belongs.

**AI agent window.** The assistant floats above every module and dialog and stays open while
you navigate. Replies are typed out live as the model writes them (Claude Code CLI and the
Messages API stream; Codex answers arrive whole), the send button turns into *Stop* while the
agent works, and a stopped reply leaves a note in the conversation and the History timeline.

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

## The Ascension (build → deploy → ship)

The **Ascension** tile connects a repository, detects its stack, and builds and deploys
it to a server with one click (or one CLI command). Nothing is changed on a server
until you confirm a **Ship**; **Plan** is always a read-only dry run that lists every
command that would run.

**Repos** — a git URL (HTTPS token or SSH key, both via your normal git setup) or a
local folder. The stack is detected from the checkout: Laravel / generic composer,
Node servers (Next, Nuxt, Express, Fastify, Nest…), static builds (Vite, CRA, Astro,
Angular, Eleventy…) and plain HTML. A `ship.json` in the repo root, a manifest saved
in the app, and per-target overrides are merged on top of the detected defaults
(build steps, shared files/dirs, hooks, runtime, health check). When detection is not
confident the AI assistant can suggest a manifest — never saved without your approval.

**Targets** decide *where* and *how*:

- **VPS over SSH** (reuses your SSH profiles). Release layout
  `<root>/releases/<ts>`, `current` symlink swapped atomically, `shared/` for `.env`,
  storage and build caches, per-target lock, N releases kept, one-click rollback.
  Build **remote** on the box (default when it has the toolchain) or **local** with the
  artifact uploaded as a tar.gz. Reload commands (nginx, PHP-FPM, systemd, pm2) are
  yours to set; the **Setup** tab renders the matching nginx/apache/systemd/pm2/sudoers
  snippets.
- **Shared hosting** (SFTP or FTP/FTPS, cPanel/Plesk style). Always builds locally.
  With a shell: same release layout under your home and the docroot is bound by a
  symlink or an `.htaccess` rewrite. FTP-only: upload to a sibling folder and swap with
  two renames (fallback: maintenance page + overwrite), previous copies kept for
  rollback.

**Ship** runs connect → fetch → detect → plan → build → package → ship → activate →
verify → cleanup, streaming the log live. A failing health check rolls back
automatically. Every run is kept under `deploy-runs/`, and History shows all
`deploy-*` events. Secrets (FTP passwords, git tokens, `.env` contents) live in
`deploy-secrets.enc` (AES-256-GCM; master key from `DEPLOY_MASTER_KEY` in `.env`, or a
generated `deploy-master.key`) and are referenced as `${vault:NAME}`; they are never
sent to the browser and are redacted from logs.

**CLI** (same binary, same data files, no port opened):

```bash
node server.js plan <target>              # dry run
node server.js ship <target> --yes        # or CI=true in a pipeline; --ref <branch|tag|sha>, --build local|remote, --json
node server.js rollback <target> [--to <release>] --yes
node server.js releases <target>
node server.js detect [<path>] [--ai]
node server.js targets | runs | secrets list|set NAME|rm NAME
```

Exit codes: 0 ok · 2 confirmation missing (the plan is printed) · 3 not found ·
4 connect/fetch · 5 build · 6 ship (target untouched) · 7 rolled back · 8 rollback
failed · 10 detection ambiguous · 130 cancelled. See `test/e2e/README.md` for a
Docker "VPS" and a local FTP server to try it safely.

**More stacks.** Docker (compose projects or a single Dockerfile) and Python (Django,
Flask, FastAPI; pip / uv / poetry / pipenv) are detected too. Both are always built on
the server: the release dir is the compose project dir (`docker compose up -d` in
`current`), Python gets a `.venv` per release with gunicorn/uvicorn under systemd or
pm2, and pip/uv/poetry caches live in `shared/cache`.

**Auto-ship.** Per target, deploy automatically when the followed branch changes:

- **Webhook** — a small separate listener (`DEPLOY_HOOK_BIND`:`DEPLOY_HOOK_PORT`,
  default `127.0.0.1:3001`) accepts GitHub (`X-Hub-Signature-256`), GitLab
  (`X-Gitlab-Token`), Gitea and Bitbucket pushes, or a generic `?token=` / bearer
  token, verified against a per-target secret shown in the target's Auto-ship card.
  Pushes to other branches, pings and deletions are ignored; a push while a run is
  active gets 409. Expose the port with a tunnel (`cloudflared tunnel --url
  http://127.0.0.1:3001`) or a reverse proxy — the app itself stays on localhost.
- **Poll** — `git ls-remote` every N minutes; a new head on the branch ships.

**Repository browsing.** Store a GitHub / GitLab / Bitbucket personal access token in
the vault and pick it in the repo dialog to list your repositories and pre-fill the URL,
default branch and token auth.

**Cloud servers.** *Add → Cloud server* provisions a VM and hands it straight to the
pipeline: DigitalOcean and Hetzner through their REST APIs (API token in the vault;
regions, sizes and images are listed live), AWS EC2, Google Compute Engine and Azure
through the `aws` / `gcloud` / `az` CLIs already logged in on this machine. A
cloud-init **recipe** (base, PHP 8.3, Node 22 + pm2, Python 3, Docker) creates a
`deploy` user with a freshly generated ed25519 key (kept 0600 under `deploy-keys/`) or
one you point at, passwordless sudo limited to service reloads, the stack packages,
nginx, `ufw` for 22/80/443 and `/var/www/<app>`. The job waits for the VM, for SSH and
for cloud-init to finish, then registers an SSH-only connection profile and,
optionally, a ready-to-ship target. Servers are listed in the sidebar and can be
destroyed at the provider from there; `deploy-servers.json` remembers them.

**Guided setup and saved configurations.** *Add → Guided setup* walks through three
screens — source (git URL, local folder or a connected repo), destination (your server,
shared hosting, a platform, or a new cloud server), access (only the credentials that
setup actually needs, stored in the vault) — then creates everything in one step and
offers to run a Plan. Names, app folders and reload commands are suggested from the
repository and environment. The target dialog keeps rarely-used options under
*Advanced settings*. Any target can be saved as a **template** and used to pre-fill the
next one, **duplicated** as another environment (`⧉`, auto-ship stays off on the copy),
and the whole setup can be **exported / imported** as JSON (repos, targets, templates and
secret *names* — never values; SSH servers are matched by host and user on import).

**Framework picker and build configuration.** The wizard's *Framework* step shows a
catalog (Next.js, Nuxt, SvelteKit, Remix, Astro, Laravel, Symfony, Django, Express,
NestJS, FastAPI, Flask, PHP, Docker Compose, Dockerfile, Vite, CRA, Angular, Eleventy,
plain HTML) grouped as Frontend / Backend / Fullstack / Static. For local folders the
stack is detected on the spot and offered as *Use detected*; for git URLs detection
runs on the first Plan unless you pick one. Install, build and start commands, port,
output directory, web root and health path are editable and saved as the repo's
manifest, so redeploys and rollbacks re-run exactly what was configured.

**Domains and TLS (VPS targets).** Give a target a domain and, after each activation,
The Ascension writes the nginx vhost for it (pointing at `current`), enables it,
reloads nginx and, if requested, obtains a Let's Encrypt certificate with certbot
(HTTP-01, with HTTPS redirect). Routing runs *after* the app is up and only through
`sudo -n` on an allow-list (`tee` into `sites-available`, `ln`, `nginx -t`, `certbot`,
`systemctl reload`), which the cloud recipes grant and the Setup tab's sudoers snippet
shows for existing servers. A DNS or certificate hiccup never fails the deploy: it is
shown as **action required** under the pipeline and clears on the next Ship.

**Platform targets (PaaS).** A target of type *Platform* deploys through the provider's
own CLI installed on this machine: **Vercel** (`vercel deploy --prod`), **Netlify**
(local build, `netlify deploy --prod --dir`), **Cloudflare Pages** (local build,
`wrangler pages deploy`) and **Workers** (`wrangler deploy`), **Fly.io** (`flyctl deploy
--remote-only`) and **Render** (`render deploys create`). The token is stored in the
vault and injected as the CLI's environment variable, never on the command line; Plan
shows the exact command with `<token>` in its place. Ship records the deployment URL
and id, verifies it (or your health URL), and rolls back on failure where the platform
supports it (Vercel, Netlify, Workers, Fly.io via the previous image; Render by
redeploying the previous commit). Cloudflare Pages has no rollback command.

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
- `public/index.html` + `public/style.css` + `public/app.js` — the whole UI (no build step);
  `public/deploy.js` — the Deploy module UI.
- `lib/deploy/` — Build → Deploy → Ship: `engine.js` (runs, locks, logs), `pipeline.js`
  (stages), `detect/` + `stacks/` (stack detection and per-stack build steps),
  `targets/` (VPS over SSH, shared hosting), `transports/` (SSH/SFTP, FTP), `manifest.js`,
  `vault.js`, `routes.js`, `cli.js`. Runtime data: `deploy-repos.json`,
  `deploy-targets.json`, `deploy-runs.json` + `deploy-runs/`, `deploy-secrets.enc`,
  `deploy-work/` (clones and build artifacts).
- `rules.json` — your rules (created on first save).
- `connections.json` — saved connection profiles (seeded from `.env` on first run).
- `audit.log` — JSON-lines audit trail (created on first preview/decision).
- `backups/` — auto-saved restore scripts, one per preview (created on first preview).