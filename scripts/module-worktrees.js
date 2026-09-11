'use strict';
/* Check module branches out for local work, without ever switching the branch
 * you are on.
 *
 *   node scripts/module-worktrees.js <id...>|--all      # add .worktrees/<id>
 *   node scripts/module-worktrees.js --list
 *   node scripts/module-worktrees.js --remove <id...>
 *
 * Each module's source lives on its own branch (modules/<id>). This puts one in
 * an isolated worktree under .worktrees/ and links modules/<id> to it, so the
 * build and the app see the package exactly where they expect it while git
 * still tracks it on its own branch.
 *
 * On Windows a directory junction is used when a symlink is not permitted, and
 * a plain copy is the last resort (with a warning, because edits then have to
 * be copied back). */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TREES = path.join(ROOT, '.worktrees');
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const has = (name) => process.argv.includes(`--${name}`);

const branches = () => git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/modules'])
  .split('\n').filter(Boolean).map((ref) => ref.replace(/^modules\//, ''));

function add(id) {
  const branch = `modules/${id}`;
  try { git(['rev-parse', '--verify', '--quiet', branch]); }
  catch { throw new Error(`there is no ${branch} branch; run scripts/publish-module-branch.js ${id} first`); }

  const tree = path.join(TREES, id);
  if (!fs.existsSync(tree)) {
    fs.mkdirSync(TREES, { recursive: true });
    git(['worktree', 'add', tree, branch]);
    console.log(`worktree: ${path.relative(ROOT, tree)} → ${branch}`);
  }

  const link = path.join(ROOT, 'modules', id);
  if (fs.existsSync(link)) {
    const stat = fs.lstatSync(link);
    if (stat.isSymbolicLink() || stat.isDirectory() && isJunction(link)) return console.log(`modules/${id} already points at the worktree`);
    return console.log(`modules/${id} exists as a plain directory; leaving it alone (remove it to link the worktree instead)`);
  }
  fs.mkdirSync(path.join(ROOT, 'modules'), { recursive: true });
  for (const type of ['junction', 'dir']) {
    try { fs.symlinkSync(tree, link, type); console.log(`modules/${id} → ${path.relative(ROOT, tree)} (${type})`); return; }
    catch { /* try the next kind */ }
  }
  fs.cpSync(tree, link, { recursive: true });
  console.warn(`modules/${id}: copied from the worktree (no link permitted here); copy edits back before committing`);
}

const isJunction = (target) => { try { return !!fs.readlinkSync(target); } catch { return false; } };

function remove(id) {
  const link = path.join(ROOT, 'modules', id);
  if (fs.existsSync(link) && (fs.lstatSync(link).isSymbolicLink() || isJunction(link))) fs.unlinkSync(link);
  const tree = path.join(TREES, id);
  if (fs.existsSync(tree)) { git(['worktree', 'remove', '--force', tree]); console.log(`removed worktree ${path.relative(ROOT, tree)}`); }
}

function main() {
  if (has('list')) {
    const known = branches();
    console.log(known.length ? `module branches: ${known.join(', ')}` : 'no modules/* branches yet');
    console.log(git(['worktree', 'list']));
    return;
  }
  const ids = has('all') ? branches() : process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!ids.length) {
    console.log('usage: node scripts/module-worktrees.js <id...>|--all|--list|--remove <id...>');
    process.exit(1);
  }
  for (const id of ids) (has('remove') ? remove : add)(id);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exit(1); }
}
