'use strict';
/* Git operations via the git CLI (inherits the user's ssh-agent, credential
   manager and .gitconfig). Work trees live in deploy-work/<repoId>/src.
   Tokens are never placed in the remote URL that is persisted; for HTTPS
   token auth we pass an ephemeral `http.extraHeader` per command. */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { localExec, capture, probeTool, ExecError } = require('./exec');
const { qLocal: q } = require('./shell');

let gitCache = null;
async function gitAvailable() {
  if (gitCache === null) gitCache = await probeTool('git');
  return gitCache;
}

function authArgs(source, token) {
  if (source?.auth?.kind === 'https-token' && token) {
    // GitHub/GitLab/Bitbucket all accept basic auth with a token as the password
    const user = source.auth.user || 'x-access-token';
    const b64 = Buffer.from(`${user}:${token}`).toString('base64');
    return `-c http.extraHeader="Authorization: Basic ${b64}"`;
  }
  return '';
}
function sshEnv(source) {
  if (source?.auth?.kind === 'ssh' && source.auth.keyPath) {
    return { GIT_SSH_COMMAND: `ssh -i ${q(source.auth.keyPath)} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new` };
  }
  return { GIT_SSH_COMMAND: 'ssh -o StrictHostKeyChecking=accept-new' };
}

/**
 * Ensure the work tree matches `ref` of the remote. Returns {commit, branch, shortCommit, subject}.
 * @param {{url, branch, auth}} source
 * @param {string} dir  work tree path
 * @param {{ref?:string, token?:string, onLine?:fn, signal?:AbortSignal}} o
 */
async function sync(source, dir, o = {}) {
  if (!(await gitAvailable())) throw new ExecError('git is not installed or not on PATH; install git or use a local-folder source', { code: 127 });
  const ref = o.ref || source.branch || 'HEAD';
  const auth = authArgs(source, o.token);
  const env = { ...sshEnv(source), GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '0' };
  const run = (cmd, cwd) => localExec(`git ${auth} ${cmd}`, { cwd, env, onLine: o.onLine, signal: o.signal, timeoutMs: 15 * 60000 });
  const cap = (cmd, cwd) => capture(`git ${auth} ${cmd}`, { cwd, env, signal: o.signal, timeoutMs: 60000 });

  await fsp.mkdir(path.dirname(dir), { recursive: true });
  const isRepo = fs.existsSync(path.join(dir, '.git'));
  if (!isRepo) {
    await fsp.rm(dir, { recursive: true, force: true });
    await run(`clone --no-checkout --filter=blob:none ${q(source.url)} ${q(dir)}`);
  } else {
    await run(`remote set-url origin ${q(source.url)}`, dir);
    await run('fetch --prune --tags --force origin', dir);
  }
  // resolve the ref: remote branch first, then tag, then raw sha
  let target = null;
  for (const cand of [`refs/remotes/origin/${ref}`, `refs/tags/${ref}`, ref]) {
    try { target = await cap(`rev-parse --verify --quiet ${q(cand + '^{commit}')}`, dir); if (target) break; } catch { target = null; }
  }
  if (!target) throw new ExecError(`ref "${ref}" not found in ${source.url}`, { code: 1 });
  await run(`checkout --force --detach ${target}`, dir);
  await run('submodule update --init --recursive --depth 1', dir).catch(() => {}); // optional
  const commit = await cap('rev-parse HEAD', dir);
  const subject = await cap('log -1 --pretty=%s', dir).catch(() => '');
  return { commit, shortCommit: commit.slice(0, 8), branch: ref, subject };
}

/** Remote branch list without cloning: [{name, commit}] */
async function listBranches(source, o = {}) {
  if (!(await gitAvailable())) throw new ExecError('git is not installed', { code: 127 });
  const out = await capture(`git ${authArgs(source, o.token)} ls-remote --heads --tags ${q(source.url)}`, { env: { ...sshEnv(source), GIT_TERMINAL_PROMPT: '0' }, timeoutMs: 60000 });
  return out.split('\n').filter(Boolean).map((l) => { const [commit, r] = l.split(/\s+/); return { commit, name: r.replace(/^refs\/(heads|tags)\//, ''), kind: r.startsWith('refs/tags/') ? 'tag' : 'branch' }; }).filter((b) => !b.name.endsWith('^{}'));
}

/** `git archive` of HEAD (respects export-ignore) to a tar.gz file. Prefix "" so files land at the archive root. */
async function archive(dir, outFile, o = {}) {
  await localExec(`git archive --format=tar.gz -o ${q(outFile)} HEAD`, { cwd: dir, onLine: o.onLine, signal: o.signal, timeoutMs: 10 * 60000 });
  return outFile;
}

/** For local-folder sources: {commit, dirty, branch} if it is a git repo, else nulls. */
async function inspectLocal(dir) {
  if (!fs.existsSync(path.join(dir, '.git')) || !(await gitAvailable())) return { commit: null, shortCommit: null, branch: null, dirty: null };
  try {
    const commit = await capture('git rev-parse HEAD', { cwd: dir, timeoutMs: 20000 });
    const branch = await capture('git rev-parse --abbrev-ref HEAD', { cwd: dir, timeoutMs: 20000 });
    const status = await capture('git status --porcelain', { cwd: dir, timeoutMs: 60000 });
    return { commit, shortCommit: commit.slice(0, 8), branch, dirty: status.length > 0 };
  } catch { return { commit: null, shortCommit: null, branch: null, dirty: null }; }
}

module.exports = { gitAvailable, sync, listBranches, archive, inspectLocal };
