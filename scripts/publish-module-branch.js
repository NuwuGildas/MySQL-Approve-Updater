'use strict';
/* Put a module's source on its own branch, without touching the working tree.
 *
 *   node scripts/publish-module-branch.js <id...>|--all [--message "..."] [--dry-run]
 *
 * Each branch (modules/<id>) holds ONE standalone package - module.json, its
 * frontend, its backend, its tests, its CI workflow - and nothing else. No copy
 * of the application, no other module.
 *
 * It is written with git plumbing against a temporary index, so the branch is
 * created from the files on disk without checking anything out, without
 * switching branches, and without disturbing whatever the user has staged. It
 * NEVER pushes, never forces, and never touches a branch it did not create the
 * previous commit of. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const arg = (name, fallback = null) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : fallback; };
const has = (name) => process.argv.includes(`--${name}`);

const git = (args, options = {}) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', ...options }).trim();

/** Does this ref exist? */
function refExists(ref) {
  try { git(['rev-parse', '--verify', '--quiet', ref]); return true; } catch { return false; }
}

/** Everything the branch for `id` should contain, plus the files that make it standalone. */
function stagedTree(id, source, tempIndex) {
  const env = { ...process.env, GIT_INDEX_FILE: tempIndex };
  git(['read-tree', '--empty'], { env });
  // `git add` needs a work tree; point it at the package directory itself.
  execFileSync('git', ['--work-tree', source, 'add', '--all', '--force', '.'], { cwd: source, env, stdio: 'pipe' });
  return git(['write-tree'], { env });
}

function publish(id, { message, dryRun }) {
  const source = path.join(ROOT, 'modules', id);
  if (!fs.existsSync(path.join(source, 'module.json'))) throw new Error(`modules/${id} has no module.json`);
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'module.json'), 'utf8'));
  const branch = `modules/${id}`;
  const ref = `refs/heads/${branch}`;

  const tempIndex = path.join(os.tmpdir(), `st-module-index-${id}-${process.pid}`);
  let tree;
  try { tree = stagedTree(id, source, tempIndex); }
  finally { fs.rmSync(tempIndex, { force: true }); }

  const parent = refExists(ref) ? git(['rev-parse', ref]) : null;
  if (parent && git(['rev-parse', `${parent}^{tree}`]) === tree) {
    console.log(`${branch}: already up to date (${parent.slice(0, 10)})`);
    return { branch, commit: parent, changed: false, version: manifest.version };
  }

  const subject = message || [
    `${manifest.name} ${manifest.version}`,
    '',
    manifest.description,
    '',
    `Host SDK ${manifest.hostSdk}. This branch holds one standalone module package:`,
    'manifest, frontend, backend, tests and CI. It is not part of the base',
    'application, which ships without it and offers it through the marketplace.',
    '',
    'Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>',
  ].join('\n');
  if (dryRun) {
    console.log(`${branch}: would commit tree ${tree.slice(0, 10)}${parent ? ` on top of ${parent.slice(0, 10)}` : ' as the first commit'}`);
    return { branch, commit: null, changed: true, version: manifest.version };
  }

  const commit = git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', subject]);
  // update-ref with the expected old value: never overwrite a branch that moved.
  git(['update-ref', ref, commit, ...(parent ? [parent] : ['']), ]);
  console.log(`${branch}: ${parent ? 'updated' : 'created'} ${commit.slice(0, 10)} (${subject})`);
  return { branch, commit, changed: true, version: manifest.version };
}

/** Confirm the branch really holds every file that is in the package directory. */
function verify(id, commit) {
  const source = path.join(ROOT, 'modules', id);
  const listed = new Set(git(['ls-tree', '-r', '--name-only', commit]).split('\n').filter(Boolean));
  const missing = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name.endsWith('.tgz')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const relative = path.relative(source, full).split(path.sep).join('/');
        if (!listed.has(relative)) missing.push(relative);
      }
    }
  };
  walk(source);
  if (missing.length) throw new Error(`modules/${id}: ${missing.length} file(s) are not on the branch: ${missing.slice(0, 5).join(', ')}`);
  return listed.size;
}

function main() {
  const all = has('all');
  const ids = all
    ? fs.readdirSync(path.join(ROOT, 'modules'), { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(ROOT, 'modules', e.name, 'module.json'))).map((e) => e.name).sort()
    : process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!ids.length) {
    console.log('usage: node scripts/publish-module-branch.js <id...>|--all [--message "..."] [--dry-run]');
    process.exit(1);
  }
  const dryRun = has('dry-run');
  const results = [];
  for (const id of ids) {
    const result = publish(id, { message: arg('message'), dryRun });
    if (result.commit) {
      const files = verify(id, result.commit);
      console.log(`  verified ${files} file(s) on ${result.branch}`);
    }
    results.push(result);
  }
  console.log(`\n${results.length} branch(es) prepared locally. Nothing was pushed.`);
  console.log('Review with:  git log --oneline modules/<id>   /   git ls-tree -r --name-only modules/<id>');
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exit(1); }
}
module.exports = { publish, verify };
