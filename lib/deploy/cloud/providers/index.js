'use strict';
const { aws, gcp, azure } = require('./cli');
const PROVIDERS = {
  digitalocean: require('./digitalocean'),
  hetzner: require('./hetzner'),
  aws, gcp, azure,
};
function providerFor(id) {
  const p = PROVIDERS[id];
  if (!p) { const e = new Error(`unknown cloud provider "${id}"`); e.status = 400; throw e; }
  return p;
}
module.exports = { PROVIDERS, providerFor };
