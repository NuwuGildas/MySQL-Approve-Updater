'use strict';
/* Shared REST helper for token-based providers. `deps.fetch` is injectable
   so provider request shapes can be unit-tested without network access. */
const deps = { fetch: (...a) => globalThis.fetch(...a) };

class ProviderError extends Error { constructor(m, status = 502, body) { super(m); this.name = 'ProviderError'; this.status = status; this.body = body; } }

async function call(method, url, { token, authHeader = 'Bearer', body, headers = {} } = {}) {
  const h = { accept: 'application/json', 'user-agent': 'server-tools-ascension/1.0', ...headers };
  if (token) h.authorization = `${authHeader} ${token}`;
  if (body !== undefined) h['content-type'] = 'application/json';
  let res;
  try { res = await deps.fetch(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch (e) { throw new ProviderError(`network error calling ${new URL(url).host}: ${e.message}`); }
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    const msg = json?.message || json?.error?.message || json?.error || json?.errors?.[0]?.message || text.slice(0, 200) || `HTTP ${res.status}`;
    throw new ProviderError(`${new URL(url).host} ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`, res.status >= 400 && res.status < 500 ? 400 : 502, json);
  }
  return json;
}

module.exports = { deps, call, ProviderError };
