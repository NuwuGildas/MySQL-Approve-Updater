'use strict';
/* Run every module's own test suite.
 *
 *   node scripts/test-modules.js [id...]
 *
 * A module owns its tests the way it owns its code: they live in its package
 * directory and run against it, not against the base application. */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const MODULES = path.join(ROOT, 'modules');

function main() {
  const wanted = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const ids = fs.readdirSync(MODULES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(MODULES, entry.name, 'test')))
    .map((entry) => entry.name)
    .filter((id) => !wanted.length || wanted.includes(id))
    .sort();

  let failed = 0;
  for (const id of ids) {
    const cwd = path.join(MODULES, id);
    console.log(`\n──────── ${id} ────────`);
    const result = spawnSync(process.execPath, ['--test', 'test/**/*.test.js'], { cwd, stdio: 'inherit' });
    if (result.status !== 0) { failed++; console.error(`${id}: FAILED`); }
  }
  if (!ids.length) console.log('no module has its own tests yet');
  if (failed) { console.error(`\n${failed} module suite(s) failed`); process.exit(1); }
  console.log(`\n${ids.length} module suite(s) passed`);
}

if (require.main === module) main();
