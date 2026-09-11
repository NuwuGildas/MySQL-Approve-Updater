'use strict';
/* Prove that the base distribution carries no optional module implementation.
 *
 *   node scripts/verify-base.js [--exe dist/server-tools.exe]
 *
 * Checks three things:
 *   1. the source tree the base app ships from (server.js, lib/, public/) has no
 *      optional module code, no optional markup and no optional styles;
 *   2. the packaged assets listed in package.json cannot pull any in;
 *   3. if the executable has been built, its bytes contain none of the
 *      optional modules' distinctive strings.
 *
 * Module SOURCE living in the repository (or in git history) is fine. What must
 * not happen is optional code shipping in the base artifact. */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : fallback; };

/* Strings that only exist in an optional module's implementation. */
const FINGERPRINTS = [
  ['servers', ['createTerminalSessions', 'ssh_terminal_read', 'sshConsoleConnect', 'xterm.js', 'Hand terminal control']],
  // The vault FILE is host infrastructure (the host reads it to redact secrets);
  // what must not be here is the engine that writes and uses it.
  ['deployments', ['createAutoShip', 'dpOpenTargetModal', 'ascension-config', 'createEngine', 'deploy-runs.json']],
  ['connectors', ['x-github-api-version', 'path_with_namespace', 'cnShowRepos']],
  ['projects', ['openProjectResources', 'pjOpenModal', 'PR_KINDS']],
  ['history', ['auditDescribe', 'renderAuditChips', 'tl-chat']],
];
/* Files the base application is allowed to be: everything it ships. */
const BASE_FILES = [];
function collect(dir, filter) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (!['node_modules', 'vendor', 'assets'].includes(entry.name)) collect(full, filter); }
    else if (filter(full)) BASE_FILES.push(full);
  }
}

function checkSourceTree() {
  BASE_FILES.length = 0;
  BASE_FILES.push(path.join(ROOT, 'server.js'));
  collect(path.join(ROOT, 'lib'), (f) => f.endsWith('.js'));
  collect(path.join(ROOT, 'public'), (f) => /\.(js|css|html)$/.test(f));

  const problems = [];
  for (const file of BASE_FILES) {
    const text = fs.readFileSync(file, 'utf8');
    for (const [moduleId, strings] of FINGERPRINTS) {
      for (const needle of strings) {
        if (text.includes(needle)) problems.push(`${path.relative(ROOT, file)} contains "${needle}" (${moduleId})`);
      }
    }
  }
  /* The optional module directories must not be inside what the base ships. */
  for (const forbidden of ['public/modules', 'lib/deploy', 'lib/ssh-agent.js', 'lib/ssh-terminal.js', 'lib/ssh-terminal-ws.js']) {
    if (fs.existsSync(path.join(ROOT, forbidden))) problems.push(`${forbidden} is still part of the base application`);
  }
  return problems;
}

function checkPackagedAssets() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const patterns = [...(pkg.pkg?.assets || []), ...(pkg.pkg?.scripts || [])];
  return patterns
    .filter((pattern) => /(^|\/)modules(\/|$)/.test(pattern) || pattern.startsWith('modules'))
    .map((pattern) => `package.json pkg config would bundle "${pattern}"`);
}

function checkExecutable(exe) {
  if (!fs.existsSync(exe)) return { skipped: `${path.relative(ROOT, exe)} has not been built; run npm run build to check it too` };
  const bytes = fs.readFileSync(exe);
  const problems = [];
  for (const [moduleId, strings] of FINGERPRINTS) {
    for (const needle of strings) {
      if (bytes.includes(Buffer.from(needle, 'utf8'))) problems.push(`${path.basename(exe)} contains "${needle}" (${moduleId})`);
    }
  }
  return { problems, size: bytes.length };
}

function main() {
  const problems = [...checkSourceTree(), ...checkPackagedAssets()];
  const exe = path.resolve(ROOT, arg('exe', path.join('dist', 'server-tools.exe')));
  const executable = checkExecutable(exe);
  problems.push(...(executable.problems || []));

  console.log(`base source files checked: ${BASE_FILES.length}`);
  if (executable.skipped) console.log(`note: ${executable.skipped}`);
  else console.log(`executable checked: ${path.relative(ROOT, exe)} (${(executable.size / 1e6).toFixed(1)} MB)`);

  if (problems.length) {
    console.error('\noptional module code found in the base distribution:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log('\nno optional module implementation is present in the base distribution.');
}

if (require.main === module) main();
module.exports = { checkSourceTree, checkPackagedAssets, checkExecutable, FINGERPRINTS };
