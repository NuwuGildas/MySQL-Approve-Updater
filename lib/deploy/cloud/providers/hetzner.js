'use strict';
/* Hetzner Cloud via the v1 REST API (project API token). */
const { call } = require('./rest');
const API = 'https://api.hetzner.cloud/v1';

module.exports = {
  id: 'hetzner', label: 'Hetzner Cloud', auth: 'token', tokenHint: 'Project API token with Read & Write (Security → API tokens)',
  defaults: { region: 'fsn1', size: 'cx22', image: 'ubuntu-24.04' },
  async options(token) {
    const [l, t, i] = await Promise.all([call('GET', `${API}/locations`, { token }), call('GET', `${API}/server_types?per_page=50`, { token }), call('GET', `${API}/images?type=system&per_page=50`, { token })]);
    return {
      regions: (l.locations || []).map((x) => ({ id: x.name, label: `${x.city}, ${x.country} (${x.name})` })),
      sizes: (t.server_types || []).filter((x) => !x.deprecated).map((x) => ({ id: x.name, label: `${x.name} · ${x.cores} vCPU · ${x.memory} GB · ${x.disk} GB` })),
      images: (i.images || []).filter((x) => /ubuntu|debian/i.test(x.os_flavor) && x.status === 'available').map((x) => ({ id: x.name, label: x.description })),
    };
  },
  async ensureKey(token, publicKey, name) {
    const fp = require('./keys').fingerprintMd5(publicKey);
    const list = await call('GET', `${API}/ssh_keys?fingerprint=${encodeURIComponent(fp)}`, { token });
    if (list.ssh_keys?.length) return list.ssh_keys[0].id;
    const created = await call('POST', `${API}/ssh_keys`, { token, body: { name: `ascension-${name}`, public_key: publicKey } });
    return created.ssh_key.id;
  },
  async create(token, spec) {
    const keyId = await this.ensureKey(token, spec.publicKey, spec.name);
    const s = await call('POST', `${API}/servers`, { token, body: { name: spec.name, location: spec.region, server_type: spec.size, image: spec.image, ssh_keys: [keyId], user_data: spec.userData, labels: { ascension: 'true' }, start_after_create: true } });
    return { id: String(s.server.id), name: s.server.name, ip: s.server.public_net?.ipv4?.ip || null };
  },
  async status(token, id) {
    const s = await call('GET', `${API}/servers/${id}`, { token });
    const sv = s.server;
    const ip = sv.public_net?.ipv4?.ip || null;
    return { status: sv.status === 'running' && ip ? 'ready' : ['initializing', 'starting'].includes(sv.status) ? 'creating' : sv.status, ip, raw: sv.status };
  },
  async destroy(token, id) { await call('DELETE', `${API}/servers/${id}`, { token }); },
  console: (id) => `https://console.hetzner.cloud/projects`,
};
