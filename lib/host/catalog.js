'use strict';
/* The marketplace catalog: metadata only.
 *
 * Fetching this is the ONLY network traffic the base application makes for
 * modules before the user asks to add one. It carries no implementation code -
 * a catalog entry names a package URL, a digest and a signature, and nothing is
 * downloaded from it until an install is requested. */

const { fetchJson, toUrl } = require('./download');
const { validateCatalog } = require('./manifest');
const semver = require('./semver');

const DEFAULT_TTL_MS = 60_000;

function createCatalogClient({ registries = [], hostSdkVersion, ttlMs = DEFAULT_TTL_MS, log = () => {} } = {}) {
  const sources = registries.map((r) => (typeof r === 'string' ? { name: 'Modules', url: r } : r))
    .filter((r) => r && r.url).map((r) => ({ name: r.name || 'Modules', url: toUrl(r.url) }));
  let cache = null;

  async function loadOne(source) {
    const raw = await fetchJson(source.url);
    const catalog = validateCatalog(raw, { hostSdkVersion });
    return catalog.modules.map((m) => ({ ...m, registry: source.name, registryUrl: source.url }));
  }

  /** Every catalog merged, first registry wins on a duplicate id. */
  async function refresh() {
    const byId = new Map();
    const failures = [];
    for (const source of sources) {
      try {
        for (const module of await loadOne(source)) if (!byId.has(module.id)) byId.set(module.id, module);
      } catch (error) {
        failures.push({ registry: source.name, url: source.url, error: error.message });
        log('warn', `modules: registry ${source.name} unavailable — ${error.message}`);
      }
    }
    cache = { at: Date.now(), modules: [...byId.values()], failures };
    return cache;
  }

  async function load({ force = false } = {}) {
    if (!force && cache && Date.now() - cache.at < ttlMs) return cache;
    if (!sources.length) { cache = { at: Date.now(), modules: [], failures: [] }; return cache; }
    return refresh();
  }

  const entry = (catalog, id) => catalog.modules.find((m) => m.id === id) || null;

  /** Best version of `id` that this host can run and that satisfies `range`. */
  function pick(catalog, id, range = '*') {
    const module = entry(catalog, id);
    if (!module) return null;
    const usable = module.versions.filter((v) => v.compatible && semver.satisfies(v.version, range));
    const version = usable.sort((a, b) => semver.compare(a.version, b.version)).pop();
    return version ? { module, version } : null;
  }

  return { sources, load, refresh, entry, pick, cached: () => cache };
}

module.exports = { createCatalogClient };
