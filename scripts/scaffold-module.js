'use strict';
/* Create a new module package, or refresh the files every package shares.
 *
 *   node scripts/scaffold-module.js new <id> --name "Human name" --description "..."
 *   node scripts/scaffold-module.js refresh            # rewrite CI + README for all
 *
 * The developer workflow this supports is in docs/modules.md. */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MODULES = path.join(ROOT, 'modules');
const arg = (name, fallback = null) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : fallback; };

/* The CI workflow every module branch carries. */
const workflow = require('./module-workflow');

const readme = (id, manifest) => `# ${manifest.name}

${manifest.description}

An optional module for Server Tools. It is **not** part of the base
application: the base ships without a byte of this package, and a user adds it
from **Modules** in the app, which downloads this package, verifies its
publisher signature and activates it in place.

| | |
|---|---|
| Module id | \`${manifest.id}\` |
| Version | ${manifest.version} |
| Host SDK | \`${manifest.hostSdk}\` |
| Branch | \`modules/${manifest.id}\` |
${Object.keys(manifest.dependencies || {}).length ? `| Requires | ${Object.entries(manifest.dependencies).map(([d, r]) => `\`${d}\` ${r}`).join(', ')} |\n` : ''}
## What it may do

${(manifest.capabilities || []).map((capability) => `- \`${capability}\``).join('\n') || '- nothing beyond its own storage'}

Capabilities are declared here and shown to the user before installing. The host
refuses anything this list does not name.

## Layout

\`\`\`
module.json        the manifest: identity, version, entry points, capabilities
frontend/index.js  activate(host) / deactivate(): registers pages, commands, views
backend/index.js   activate(host): RPC methods, an HTTP surface, assistant tools
test/              this package's own tests (\`node --test "test/**/*.test.js"\`)
\`\`\`

## Working on it

From a checkout of the application's default branch:

\`\`\`bash
node scripts/module-worktrees.js ${manifest.id}   # check this branch out into modules/${manifest.id}
npm run modules:build                            # build + sign every package
npm run modules:registry                         # serve them on http://127.0.0.1:8788
MODULE_REGISTRIES=http://127.0.0.1:8788/catalog.json npm start
\`\`\`

Then open **Modules** in the app and add it.
`;

function refresh() {
  const ids = fs.readdirSync(MODULES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(MODULES, entry.name, 'module.json')))
    .map((entry) => entry.name);
  for (const id of ids) {
    const manifest = JSON.parse(fs.readFileSync(path.join(MODULES, id, 'module.json'), 'utf8'));
    fs.mkdirSync(path.join(MODULES, id, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(MODULES, id, '.github', 'workflows', 'module.yml'), workflow(id));
    fs.writeFileSync(path.join(MODULES, id, 'README.md'), readme(id, manifest));
    console.log(`refreshed modules/${id}: README.md, .github/workflows/module.yml`);
  }
}

function create() {
  const id = process.argv[3];
  if (!id || !/^[a-z][a-z0-9-]{1,38}[a-z0-9]$/.test(id)) throw new Error('usage: scaffold-module.js new <id> --name "Name" --description "..."');
  const dir = path.join(MODULES, id);
  if (fs.existsSync(dir)) throw new Error(`modules/${id} already exists`);
  const manifest = {
    packageFormat: 1, id,
    name: arg('name', id),
    description: arg('description', `The ${id} module.`),
    version: '0.1.0',
    publisher: arg('publisher', 'Server Tools'),
    hostSdk: `^${require('../lib/host/sdk').HOST_SDK_VERSION.split('.')[0]}.0.0`,
    frontend: 'frontend/index.js',
    backend: 'backend/index.js',
    dependencies: {},
    capabilities: ['ui:pages', 'storage:module'],
    pages: [id],
  };
  fs.mkdirSync(path.join(dir, 'frontend'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'backend'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'module.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'frontend', 'index.js'), `/* ${manifest.name} - frontend. */
'use strict';

export async function activate(host) {
  const mount = host.mount('${id}');
  mount.innerHTML = '<section id="${id}Page" hidden><h2>${manifest.name}</h2><p></p></section>';
  mount.hidden = false;
  const view = mount.querySelector('#${id}Page');

  host.registerPage({
    id: '${id}', segment: '${id}', label: '${manifest.name}', group: 'Workspace', order: 50,
    icon: host.ui.icons.settings, title: '${manifest.name}',
    desc: ${JSON.stringify(manifest.description)},
    enter: async () => { view.hidden = false; view.querySelector('p').textContent = JSON.stringify(await host.get('status')); },
    leave: () => { view.hidden = true; },
  });
}

export async function deactivate() {
  // Everything registered above is disposed by the host.
}
`);
  fs.writeFileSync(path.join(dir, 'backend', 'index.js'), `'use strict';
/* ${manifest.name} - backend. Runs in its own process, started on activation. */

async function activate(host) {
  return {
    methods: {
      status: () => ({ module: host.id, version: host.version }),
    },
    /* Return true while work is in flight that a removal must not interrupt. */
    busy: () => false,
    async deactivate() {},
  };
}

module.exports = { activate };
`);
  fs.writeFileSync(path.join(dir, 'test', `${id}.test.js`), `'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { activate } = require('../backend/index');

test('the backend answers status', async () => {
  const instance = await activate({ id: '${id}', version: '0.1.0', log() {}, emit() {}, call: async () => null });
  assert.deepEqual(await instance.methods.status(), { module: '${id}', version: '0.1.0' });
  assert.equal(instance.busy(), false);
});
`);
  refresh();
  console.log(`\nmodules/${id} created. Next:\n  npm run modules:build\n  node scripts/publish-module-branch.js ${id}`);
}

const command = process.argv[2];
if (command === 'new') create();
else if (command === 'refresh') refresh();
else { console.log('usage: scaffold-module.js new <id> [--name ...] [--description ...] | refresh'); process.exit(1); }
