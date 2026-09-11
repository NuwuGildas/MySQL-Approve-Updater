# Modules

Server Tools is a small base application plus optional modules the user adds
from inside it. This document is the contract between the two.

- [What the base application is](#what-the-base-application-is)
- [The host SDK](#the-host-sdk)
- [The package format](#the-package-format)
- [The marketplace catalog](#the-marketplace-catalog)
- [Installing](#installing)
- [Running a module: frontend](#running-a-module-frontend)
- [Running a module: backend](#running-a-module-backend)
- [Shared infrastructure, and where the line is](#shared-infrastructure-and-where-the-line-is)
- [Trust](#trust)
- [Repository layout and branches](#repository-layout-and-branches)
- [Building and publishing](#building-and-publishing)
- [Writing a new module](#writing-a-new-module)
- [Running it all locally](#running-it-all-locally)

---

## What the base application is

The base application contains, and only contains:

- the shell: header, navigation, routing, command palette, settings, the
  marketplace;
- the **AI assistant**, with its conversations and approval cards;
- the **database tools**: connections, SQL console, schema map, rule-based batch
  updates with per-row approval and backups;
- the **module host**, and the shared services modules are allowed to use.

Everything else is a module: Servers & Terminals, Deployments (The Ascension),
Git Connectors, Projects, Activity History. None of their code — frontend,
backend, HTML, CSS, assets or exclusive dependencies — is in the base
distribution. `npm run verify:base` is the check, and it runs in CI.

The base application works with every module removed. It also keeps every
module's **data**: `connectors.json`, `deploy-*.json`, `projects.json`,
`ssh-session-chats.json` and the encrypted vault are untouched by removal, so
adding a module again brings its work back.

---

## The host SDK

Version **1.0.0** (`lib/host/sdk.js` → `HOST_SDK_VERSION`). A module declares the
range it was built against in its manifest (`"hostSdk": "^1.0.0"`), and the
installer refuses a package this host cannot run.

### Browser (`public/host/host.js`)

A module's `activate(host)` receives a scope. Every `register*` call returns a
disposable, and the host keeps all of them, so `deactivate()` is mostly
bookkeeping the host does for you.

| Group | What it gives you |
|---|---|
| `host.registerPage(def)` | a route, a sidebar entry and a view (`enter`/`leave`) |
| `host.registerNavItem`, `host.registerLauncherTile` | sidebar and Compass entries |
| `host.registerCommand`, `host.registerSearchSource` | command palette and search |
| `host.registerSettingsSection`, `host.registerSettingsGroup` | settings |
| `host.assistant.registerProposalCard(kind, render)` | how an approval card is drawn |
| `host.assistant.dock(impl)` | park the assistant window inside your workspace |
| `host.rpc(method, params)`, `host.get(method, params)` | your backend's named methods |
| `host.http(path, init)` | your backend's own HTTP surface |
| `host.socket(path, params)` | a WebSocket to your backend |
| `host.events.on(name, fn)`, `host.events.onModule(fn)` | host events, your own events |
| `host.storage`, `host.settings` | per-module browser storage and server settings |
| `host.resources.*` | approved access to connections, projects, the audit trail |
| `host.ui`, `host.shell`, `host.assistantUi`, `host.session`, `host.projects` | the shell's own helpers |
| `host.styles.add/link`, `host.mount(key)` | your styles and your DOM, both removed with you |
| `host.on`, `host.setTimeout`, `host.setInterval`, `host.observe` | listeners, timers and observers the host can take back |
| `host.provide(api)`, `host.consume(otherId)` | a deliberate contract between two modules |

Rules the SDK enforces:

- a module never reads a global from `app.js` and never touches another module's
  state; the only way across is `provide`/`consume`;
- registering during import is impossible — everything happens in `activate`;
- a capability the manifest did not request throws;
- `host.api()` only reaches core endpoints; anything else goes through `rpc`,
  `http` or `socket`.

### Backend (`lib/host/worker-entry.js`)

```js
module.exports = {
  async activate(host) {
    return {
      methods: { … },          // named RPC calls
      http: expressApp,        // optional: your own routes and upgrades
      assistantTools: { … },   // tools the assistant may call
      proposalKinds: { … },    // how your approval cards are applied
      busy: () => false,       // true while work must not be interrupted
      async deactivate() { },
    };
  },
};
```

`host` gives you `call(service, params)` (capability-gated), `audit`, `emit`,
`log`, `settings()`, `dataDir` (your data, kept on removal), `appDataDir` (the
application's data directory, for files a user already had) and
`shared(name)` for the libraries the host guarantees.

---

## The package format

Package format **1**. A `.tgz` whose root is the package:

```
module.json          the manifest
frontend/index.js    ES module: export activate(host) / deactivate()
frontend/*.css       styles, loaded by the module, scoped to its own views
frontend/*.html      templates, fetched and mounted when the page is opened
frontend/vendor/*    libraries only this module needs (xterm, say)
backend/index.js     CommonJS: module.exports = { activate }
node_modules/        prebuilt dependencies, if the module needs any of its own
```

The manifest:

```jsonc
{
  "packageFormat": 1,
  "id": "history",                 // stable, lowercase, 3–40 chars
  "name": "Activity History",
  "description": "…",              // shown in the marketplace
  "version": "1.0.0",              // semantic
  "publisher": "Server Tools",
  "hostSdk": "^1.0.0",             // host versions this was built for
  "frontend": "frontend/index.js", // either or both
  "backend": "backend/index.js",
  "dependencies": { "servers": "^1.0.0" },   // other modules, by version range
  "sharedDependencies": ["ssh2", "ws"],      // libraries the host provides
  "capabilities": ["ui:pages", "audit:read"],
  "pages": ["history"]
}
```

`lib/host/manifest.js` validates every field before anything is unpacked. An
unknown capability, a path that climbs out of the package, a version that is not
semantic or a dependency on itself are all refusals, not warnings.

**Capabilities** are the promise the host makes and the line the user is shown
before installing. The full list is in `lib/host/sdk.js`; the marketplace prints
the human description of each one on the card.

**Shared dependencies** are libraries the host guarantees (`ssh2`, `ws`, `tar`,
`express`, `picomatch`, `basic-ftp`). A module declares what it uses and gets the
host's copy — which is also what makes it work inside the packaged Windows
executable, where a package's own `node_modules` could not be resolved.

Nothing in a package is executed during installation. There are no lifecycle
scripts and no `npm install`: a package ships with what it needs.

---

## The marketplace catalog

Metadata only. Fetching it is the sole network request the base application makes
for modules before the user asks for one.

```jsonc
{
  "catalogVersion": 1,
  "name": "Server Tools modules",
  "modules": [{
    "id": "history",
    "name": "Activity History",
    "description": "…",
    "publisher": "Server Tools",
    "versions": [{
      "version": "1.0.0",
      "hostSdk": "^1.0.0",
      "dependencies": {},
      "capabilities": ["ui:pages", "audit:read"],
      "source": { "branch": "modules/history", "commit": "<40-hex>", "repository": "…" },
      "releasedAt": "2026-09-10T16:42:08.526Z",
      "package": {
        "url": "https://…/history-1.0.0.tgz",
        "size": 8876,
        "sha256": "<64-hex>",
        "signature": "<base64 ed25519 over id+version+digest>",
        "keyId": "st-2026",
        "algorithm": "ed25519"
      }
    }]
  }]
}
```

A catalog entry resolves to an **immutable** thing: a version, a digest, a
signature and a commit. A branch name is only a label saying where the source
lives; nothing is ever installed by running the current contents of a branch.

Point the application at one or more catalogs with
`MODULE_REGISTRIES=<url>[,<url>]`. A local path or a `file:` URL works too, which
is how the offline and test registries run. With nothing configured, the app
looks for `<data dir>/registry/catalog.json`.

---

## Installing

`POST /api/modules/<id>/install`, in this order, and any step may fail without
leaving a trace:

1. **plan** — resolve dependencies (depth first, cycles detected), pick versions
   this host SDK can run, refuse a range nothing satisfies;
2. **download** — to a staging directory, bounded by the size the catalog
   promised and a hard ceiling, cancellable, with progress;
3. **verify** — sha256 against the catalog's digest, then an ed25519 signature
   over `id + version + digest` against a key in the local trust store;
4. **unpack** — every entry inspected first: only regular files and directories,
   only relative paths inside the package, no links, no traversal, bounded entry
   and total size;
5. **re-validate** — the manifest inside the package must agree with the catalog
   entry that was verified;
6. **activate** — start the backend worker, then hand the frontend to the
   browser;
7. **record** — the state document is replaced atomically. Only now is the module
   installed.

Installation, removal and updates are serialised behind one lock, so two browser
tabs cannot interleave. Success is reported only after both backend and frontend
activation succeeded.

Where things live, under the writable data directory (never inside the
executable):

```
module-data/
  state.json              what is installed, and at which version
  installed/<id>/<ver>/   the code
  data/<id>/              the module's own user data — kept when it is removed
  staging/, cache/        transient; swept at startup
```

**Removal** stops the worker, disposes everything the frontend registered, and
deletes the code — not the data. It is refused when another installed module
depends on it, or when the module says it is busy (a live terminal, a running
deploy). Nothing is silently terminated.

**Updates** stage and verify the new version first, and are refused while the
module is busy.

---

## Running a module: frontend

The browser imports `frontend/index.js` with dynamic `import()`, from a URL that
contains the **activation id** the installer generated. That is what makes
"remove and add again in the same tab" work: a reinstall is a different URL, so
the engine cannot hand back the copy it already evaluated. Code from an older
copy may still exist in the module cache, which is exactly why teardown is driven
by the host's disposables rather than by dropping a script tag.

A module's markup is mounted into a container the host creates
(`#modulePages [data-module=<id>]`) and removes; the base `index.html` carries no
optional module markup. Styles are added by the module and removed with it.

---

## Running a module: backend

Each active backend module runs in its own child process:

- **development** — `child_process.fork` of `lib/host/worker-entry.js`;
- **packaged executable** — the same executable re-entered with the snapshot path
  of `worker-entry.js`, because there is no `node` on the end user's machine.
  `lib/**/*.js` is listed under `pkg.scripts` in `package.json` for exactly this
  reason.

Both give the child an IPC channel, which is all the protocol needs. A module may
answer through named RPC methods, or serve its own Node request listener on a
loopback port that the host proxies (`/api/m/<id>/http/...`, and `/api/m/<id>/ws/...`
for upgrades), guarded by a per-activation token. That keeps the host's routing
table fixed: removing a module removes the only route that could reach it.

The host handles startup and readiness, activation failure, crashes (only the
owning module is affected — the host and other modules keep running), shutdown,
in-flight requests (they fail cleanly rather than hanging), capability
registration and removal, restart recovery and updates.

> A worker process is an **isolation and lifecycle** boundary, not a security
> sandbox. It runs with the application's own privileges. That is why only
> packages signed by a publisher in the local trust store are installed, and why
> the initial model is explicitly trusted publishers.

---

## Shared infrastructure, and where the line is

Some things are genuinely shared and stay in the host, because the base
application needs them with every module removed:

| Shared | Why it is the host's | What the module owns |
|---|---|---|
| Connection profiles, and the SSH tunnel for a database | a database connection may tunnel over SSH with no Servers module installed | Servers owns server management, terminals and the shells |
| The audit trail | events are recorded whether or not anything reads them | Activity History owns the timeline and its viewer |
| Projects, and the default conversation | the assistant always needs a conversation to belong to | Projects owns creating, editing, deleting and linking |
| Session conversations (`ssh-session-chats.json`) | transcripts and notes are the user's data and outlive the module | Servers owns the terminal, classification and approvals |
| The encrypted vault | the host reads it to redact secrets out of anything printed | Deployments writes it; Connectors stores tokens in it |

Consequences worth stating plainly:

- **Git Connectors does not require Deployments.** They share the vault, which is
  host infrastructure, not each other. Connectors works on its own; with
  Deployments installed, "Connect" hands a repository over through the API that
  module publishes.
- **Deployment targets keep their single-project ownership.** The project store
  is the host's and refuses to orphan a deployment; Deployments publishes which
  targets it owns while it is installed.
- **Removing Servers does not lose a conversation.** The transcript stays
  readable; only working in it stops.

---

## Trust

`config/trusted-publishers.json` ships **with the base application** and is the
only trust anchor. A catalog may name a publisher and hand over a signature, but
only a key already in that file can make the signature verify. A checksum that
travels beside an archive proves nothing, so the digest used is always the one in
catalog metadata.

Generate a publisher key:

```bash
npm run modules:keys -- --publisher server-tools --name "Server Tools" --key-id st-2026
# → keys/st-2026.private.pem      (git-ignored; never distribute)
# → config/trusted-publishers.json (public half; ships with the app)
```

`MODULES_ALLOW_UNSIGNED=1` relaxes the signature requirement. It is a development
switch: the digest is still checked, but anyone who can serve the catalog can
then serve the code.

---

## Repository layout and branches

One repository, one branch per module:

```
master               the base application, the host SDK, the build tooling
modules/servers      one standalone package, nothing else
modules/deployments
modules/connectors
modules/projects
modules/history
```

A module branch holds **only** its package — `module.json`, `frontend/`,
`backend/`, `test/`, its README and its CI workflow. No copy of the application,
no other module.

Branches are prepared with git plumbing against a temporary index, so nothing
checks out and nothing you have staged is touched:

```bash
node scripts/publish-module-branch.js --all --dry-run
node scripts/publish-module-branch.js --all
```

It refuses to overwrite a branch that moved underneath it, and it verifies
afterwards that every file in the package directory is on the branch.

To work on a module branch locally:

```bash
node scripts/module-worktrees.js --all     # .worktrees/<id>, linked as modules/<id>
node scripts/module-worktrees.js --list
node scripts/module-worktrees.js --remove servers
```

---

## Building and publishing

```bash
npm run modules:build          # every package + the catalog, signed if a key exists
node scripts/build-module.js history --sign keys/st-2026.private.pem --key-id st-2026
npm run modules:catalog -- --base-url https://example.com/packages
npm run verify:base            # the base ships nothing optional
npm run build                  # the packaged Windows executable
```

Builds are reproducible: entries are sorted and timestamps fixed, so the same
source produces the same digest. Each build also writes a sidecar
`<id>-<version>.json` describing the artifact — size, digest, signature, and the
commit it was built from — and the catalog is assembled from those.

The publishing flow:

```
module branch  →  CI build (.github/workflows/module.yml on that branch)
               →  versioned, signed release archive  (tag: <id>-v<version>)
               →  catalog entry pointing at that archive's URL, digest and commit
```

To publish a new version of a module:

1. bump `version` in its `module.json` on its branch;
2. push the branch, let CI build and test the package;
3. tag `<id>-v<version>`; CI attaches the archive **and its sidecar** to a
   GitHub release;
4. the same workflow then rebuilds the catalog from every released module
   and publishes it;
5. users see the new version in **Modules** with an **Update** action. A module
   that is busy is never updated silently.

Rolling back is publishing a catalog that offers the previous version; installed
copies are untouched until the user acts.

### Releases on GitHub

The catalog is published as an asset of a release on the fixed `catalog` tag, so
it has one URL that never changes:

```
https://github.com/<owner>/<repo>/releases/download/catalog/catalog.json
```

That URL is the application's default registry (`PUBLISHED_REGISTRY` in
server.js), so a fresh installation finds modules with no configuration and
downloads each package straight from its release asset:

```
https://github.com/<owner>/<repo>/releases/download/<id>-v<version>/<id>-<version>.tgz
```

Every one of those URLs is pinned to a single version, and the digest and
signature in the catalog are checked against `config/trusted-publishers.json`
before a byte is executed — GitHub is a place to put bytes, not something the
installer trusts. A `MODULE_REGISTRIES` value overrides the default; a locally
built catalog (`npm run modules:local`) takes precedence over both; and
`MODULE_REGISTRIES=none` makes the application look nowhere at all.

**CI must be able to sign, or nothing is installable.** The module workflow
builds an unsigned package when no key is configured, and `catalog.yml` then
refuses to publish rather than offering versions the application will reject.
One-time setup on the repository:

| | |
|---|---|
| Secret `MODULE_SIGNING_KEY` | the private PEM of a key whose **public** half is in `config/trusted-publishers.json` |
| Variable `MODULE_SIGNING_KEY_ID` | that key's id, e.g. `st-ci-2026` |

Generate one with `npm run modules:keys -- --key-id st-ci-2026`; commit the
changed trust anchor, put the private half in the secret, and keep it out of
`keys/` so local builds keep using the development key.

`test/e2e/release-install.e2e.js` runs this whole shape against a local server
that answers the same paths GitHub does — catalog fetch, release-asset download,
signature check, activation, and the refusal of a tampered asset.

---

## Writing a new module

```bash
node scripts/scaffold-module.js new reports --name "Reports" --description "…"
npm run modules:build
node scripts/publish-module-branch.js reports
```

The scaffold gives you a manifest, a frontend that registers one page, a backend
with one method, a test, a README and a CI workflow. From there:

1. add capabilities to `module.json` as you need them — the host refuses what is
   not declared, and the user sees the list before installing;
2. register everything in `activate(host)`; never at import time;
3. put anything that must not be interrupted behind `busy()`;
4. keep your styles under your own selectors and your markup in your own mount;
5. `npm run test:modules reports`.

---

## Running it all locally

```bash
npm ci
npm run modules:local     # sign the packages and put a catalog where the app looks
npm start
```

Open <http://localhost:3000>, then **+ Add module** in the sidebar.

`modules:local` does three things, which are the three things a marketplace
needs:

1. finds the publisher key in `keys/` — generating a development one if there is
   none — and checks its public half is in `config/trusted-publishers.json`,
   because the installer refuses a package no trusted key signed;
2. builds and signs every package from `modules/<id>` into `dist/modules`;
3. writes `<dataDir>/registry/catalog.json`, whose package URLs are `file:` URLs
   into `dist/modules`.

That last path is what `server.js` reads when `MODULE_REGISTRIES` is not set, so
there is no environment variable to remember and no registry process to keep
running. It is still a real download → verify signature → stage → activate
install; only the transport is local. Catalogs are written for `npm start` (the
repository root) and, when `dist/server-tools.exe` exists, for the packaged
executable, which keeps its data beside itself.

Re-run it after changing a module. Installed code and module-owned data live
under `<dataDir>/module-data/` and are never committed.

To exercise the HTTP path instead:

```bash
npm run modules:build
npm run modules:registry                  # serves them on http://127.0.0.1:8788
MODULE_REGISTRIES=http://127.0.0.1:8788/catalog.json npm start
```

Tests:

```bash
npm test              # the base application
npm run test:modules  # every module's own suite
npm run verify:base   # nothing optional in the base distribution
npm run test:e2e      # a real browser: add a module with no reload
node test/e2e/module-lifecycle.e2e.js   # every module, added and removed in one session
```

The end-to-end tests use a disposable data directory
(`SERVER_TOOLS_DATA_DIR`), a disposable browser profile and the local registry.
They never touch a real server, database or account.
