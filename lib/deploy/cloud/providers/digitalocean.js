'use strict';
/* DigitalOcean Droplets via the v2 REST API (personal access token). */
const { call } = require('./rest');
const API = 'https://api.digitalocean.com/v2';

module.exports = {
  id: 'digitalocean', label: 'DigitalOcean', auth: 'token', tokenHint: 'Personal access token with read + write (API → Tokens)',
  defaults: { region: 'fra1', size: 's-1vcpu-1gb', image: 'ubuntu-24-04-x64' },
  async options(token) {
    const [r, s, i] = await Promise.all([call('GET', `${API}/regions?per_page=200`, { token }), call('GET', `${API}/sizes?per_page=200`, { token }), call('GET', `${API}/images?type=distribution&per_page=200`, { token })]);
    return {
      regions: (r.regions || []).filter((x) => x.available).map((x) => ({ id: x.slug, label: `${x.name} (${x.slug})` })),
      sizes: (s.sizes || []).filter((x) => x.available && /^s-/.test(x.slug)).map((x) => ({ id: x.slug, label: `${x.slug} · ${x.vcpus} vCPU · ${x.memory / 1024} GB · $${x.price_monthly}/mo`, regions: x.regions })),
      images: (i.images || []).filter((x) => /ubuntu|debian/i.test(x.distribution) && x.status === 'available').map((x) => ({ id: x.slug, label: `${x.distribution} ${x.name}` })),
    };
  },
  async ensureKey(token, publicKey, name) {
    const fp = require('./keys').fingerprintMd5(publicKey);
    const list = await call('GET', `${API}/account/keys?per_page=200`, { token });
    const hit = (list.ssh_keys || []).find((k) => k.fingerprint === fp || k.public_key?.trim() === publicKey.trim());
    if (hit) return hit.id;
    const created = await call('POST', `${API}/account/keys`, { token, body: { name: `ascension-${name}`, public_key: publicKey } });
    return created.ssh_key.id;
  },
  async create(token, spec) {
    const keyId = await this.ensureKey(token, spec.publicKey, spec.name);
    const d = await call('POST', `${API}/droplets`, { token, body: { name: spec.name, region: spec.region, size: spec.size, image: spec.image, ssh_keys: [keyId], user_data: spec.userData, tags: ['ascension'], monitoring: true } });
    return { id: String(d.droplet.id), name: d.droplet.name };
  },
  async status(token, id) {
    const d = await call('GET', `${API}/droplets/${id}`, { token });
    const dr = d.droplet;
    const ip = (dr.networks?.v4 || []).find((n) => n.type === 'public')?.ip_address || null;
    return { status: dr.status === 'active' && ip ? 'ready' : dr.status === 'new' ? 'creating' : dr.status, ip, raw: dr.status };
  },
  async destroy(token, id) { await call('DELETE', `${API}/droplets/${id}`, { token }); },
  console: (id) => `https://cloud.digitalocean.com/droplets/${id}`,
};
