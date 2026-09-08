'use strict';
/* Stack registry. Order matters for tie-breaking: more specific first.
   Static requires only, so pkg bundles every module. */
const STACKS = [
  require('./php-laravel'),
  require('./php-composer'),
  require('./node-app'),
  require('./static-site'),
  require('./docker'),
  require('./python'),
];

const byId = Object.fromEntries(STACKS.map((s) => [s.id, s]));

/** Pick the stack module for a resolved manifest. */
function stackFor(manifest) {
  const { type, framework } = manifest.stack || {};
  if (type === 'php') return framework === 'laravel' ? byId['php-laravel'] : byId['php-composer'];
  if (type === 'node') return byId['node-app'];
  if (type === 'static') return byId['static-site'];
  if (type === 'docker') return byId['docker'];
  if (type === 'python') return byId['python'];
  return byId[Object.keys(byId).find((k) => byId[k].type === type)] || null;
}

module.exports = { STACKS, byId, stackFor };
