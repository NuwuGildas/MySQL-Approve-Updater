# End-to-end tests

These drive the real application in a real browser, or the packaged executable,
against a local module registry. They use a disposable data directory
(`SERVER_TOOLS_DATA_DIR`), a disposable browser profile and packages built from
this checkout: no real server, database, account or deployment is touched.

Build the packages once, then run whichever you need:

```bash
npm run modules:build

node test/e2e/module-install.e2e.js     # adding a module does not reload the page
node test/e2e/module-lifecycle.e2e.js   # every module added, opened and removed in one session
npm run build && node test/e2e/packaged-exe.e2e.js   # module workers inside the packaged .exe
```

Chrome is found at `C:/Program Files/Google/Chrome/Application/chrome.exe`;
override with `CHROME_PATH`. The browser runs headless with `--no-sandbox
--disable-gpu`, which is what this development environment allows.

| Script | What it proves |
|---|---|
| `module-install.e2e.js` | one document throughout, an in-memory sentinel and the assistant draft survive, the new route/search/settings/tools appear at once, remove + re-add registers exactly once |
| `module-lifecycle.e2e.js` | all five modules install, their pages open with no console errors, removal leaves no route, entry, mount, style or search source behind, a second tab reconciles, and installation survives a restart |
| `packaged-exe.e2e.js` | in the packaged `.exe` a module's worker starts by re-entering the executable, host-shared and package-bundled libraries both resolve, and a module's own HTTP surface is proxied |

Each module's own end-to-end scripts live with it, in
`modules/<id>/test/e2e/` — those are the ones that need real servers.
