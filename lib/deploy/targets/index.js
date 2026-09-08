'use strict';
/* Target adapter registry (static requires so pkg bundles them). */
const TARGETS = {
  'vps-ssh': require('./vps-ssh'),
  'shared-hosting': require('./shared-hosting'),
  paas: require('./paas'),
};

function adapterFor(target) {
  const a = TARGETS[target?.type];
  if (!a) { const e = new Error(`unknown target type "${target?.type}"`); e.status = 400; throw e; }
  return a;
}

module.exports = { TARGETS, adapterFor };
