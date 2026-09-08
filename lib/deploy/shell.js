'use strict';
/* POSIX shell helpers for building remote scripts. Every dynamic value that
   ends up in a remote command goes through q(); user hook commands are the
   only free-form strings and are always run inside `set -e; cd <release>`. */

/** Single-quote a value for POSIX sh. */
function q(v) {
  const s = String(v);
  if (s === '') return "''";
  if (/^[A-Za-z0-9_\/.:=+@%,-]+$/.test(s)) return s; // safe as-is
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Render `export K=v` statements for an env map (values quoted). */
function exportEnv(env) {
  return Object.entries(env || {})
    .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
    .map(([k, v]) => `export ${k}=${q(v)}`)
    .join('; ');
}

/** Build a remote script: fail fast, cd into cwd, export env, run cmds in order. */
function script({ cwd, env, cmds }) {
  const parts = ['set -e'];
  const ex = exportEnv(env);
  if (ex) parts.push(ex);
  if (cwd) parts.push(`cd ${q(cwd)}`);
  for (const c of cmds || []) if (c && String(c).trim()) parts.push(String(c).trim());
  return parts.join('; ');
}

/** Quote for the LOCAL shell (cmd.exe on Windows, sh elsewhere). */
function qLocal(v) {
  const s = String(v);
  if (process.platform !== 'win32') return q(s);
  if (s === '') return '""';
  if (/^[A-Za-z0-9_/.:=+@%,\\\-]+$/.test(s)) return s;
  return '"' + s.replace(/"/g, '\\"') + '"';
}

/** Join several already-safe commands with `&&`. */
function and(...cmds) { return cmds.filter(Boolean).join(' && '); }

module.exports = { q, qLocal, exportEnv, script, and };
