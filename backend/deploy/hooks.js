'use strict';
/* Hook resolution: which user hook commands run at a given stage and place.
   `auto` follows the stage: build hooks run where the build runs, ship /
   activate hooks run on the target. */

const STAGE_HOME = { before_build: 'build', after_build: 'build', before_ship: 'remote', after_ship: 'remote', before_activate: 'remote', after_activate: 'remote', on_failure: 'remote', on_success: 'local' };

/**
 * @param {object} manifest validated+interpolated manifest
 * @param {string} hook hook name
 * @param {'local'|'remote'} where where the caller is about to run commands
 * @param {'local'|'remote'} buildWhere where the build runs (for build hooks)
 * @returns {string[]} commands
 */
function hooksFor(manifest, hook, where, buildWhere) {
  const home = STAGE_HOME[hook] === 'build' ? buildWhere : STAGE_HOME[hook];
  return (manifest.hooks?.[hook] || [])
    .filter((h) => (h.run === 'auto' ? home === where : h.run === where))
    .map((h) => h.cmd);
}

/** Hooks that would need a shell on a target that has none → warnings for the plan. */
function unsupportedRemoteHooks(manifest, buildWhere) {
  const out = [];
  for (const [hook, home] of Object.entries(STAGE_HOME)) {
    const h = home === 'build' ? buildWhere : home;
    for (const x of manifest.hooks?.[hook] || []) if (x.run === 'remote' || (x.run === 'auto' && h === 'remote')) out.push({ hook, cmd: x.cmd });
  }
  return out;
}

module.exports = { hooksFor, unsupportedRemoteHooks, STAGE_HOME };
