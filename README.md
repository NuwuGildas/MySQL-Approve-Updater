# Servers & Terminals

SSH server profiles with live VM stats, shared terminals you and the assistant work in together, and approval-gated assistant commands.

An optional module for Server Tools. It is **not** part of the base
application: the base ships without a byte of this package, and a user adds it
from **Modules** in the app, which downloads this package, verifies its
publisher signature and activates it in place.

| | |
|---|---|
| Module id | `servers` |
| Version | 1.0.0 |
| Host SDK | `^1.0.0` |
| Branch | `modules/servers` |

## What it may do

- `ui:pages`
- `ui:commands`
- `ui:settings`
- `assistant:tools`
- `assistant:proposals`
- `projects:read`
- `storage:module`
- `events:subscribe`
- `audit:write`
- `connections:read`
- `connections:write`
- `connections:secrets`
- `sockets`
- `net:outbound`

Capabilities are declared here and shown to the user before installing. The host
refuses anything this list does not name.

## Layout

```
module.json        the manifest: identity, version, entry points, capabilities
frontend/index.js  activate(host) / deactivate(): registers pages, commands, views
backend/index.js   activate(host): RPC methods, an HTTP surface, assistant tools
test/              this package's own tests (`node --test "test/**/*.test.js"`)
```

## Working on it

From a checkout of the application's default branch:

```bash
node scripts/module-worktrees.js servers   # check this branch out into modules/servers
npm run modules:build                            # build + sign every package
npm run modules:registry                         # serve them on http://127.0.0.1:8788
MODULE_REGISTRIES=http://127.0.0.1:8788/catalog.json npm start
```

Then open **Modules** in the app and add it.
