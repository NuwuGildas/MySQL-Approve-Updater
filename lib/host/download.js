'use strict';
/* Fetching a package archive. Everything about this is bounded: the size the
   catalog promised, a hard ceiling regardless of what the catalog says, a
   timeout, and an abort signal so an install can be cancelled mid-download. */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { pathToFileURL, fileURLToPath } = require('node:url');

const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;   // no module package may exceed this
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

const fail = (message, code = 'download_failed') => { throw Object.assign(new Error(message), { status: 502, code }); };
/** Something worth naming in an error: a URL without an origin still has an href. */
const origin = (parsed) => (parsed.origin && parsed.origin !== 'null' ? parsed.origin : parsed.href);

/**
 * Download `url` to `destination`. Returns { bytes }. `onProgress({received,total})`
 * is called as the body arrives; `signal` aborts and removes the partial file.
 */
async function downloadTo(url, destination, { expectedBytes = null, maxBytes = MAX_PACKAGE_BYTES, signal, onProgress = () => {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const limit = Math.min(maxBytes, expectedBytes ? expectedBytes + 1024 : maxBytes);
  const parsed = new URL(url);

  if (parsed.protocol === 'file:') {
    // A file: registry is how the offline / air-gapped install path is tested.
    const source = fileURLToPath(parsed);
    const { size } = await fsp.stat(source);
    if (size > limit) fail(`Package is larger than expected (${size} bytes)`, 'package_too_large');
    await fsp.copyFile(source, destination);
    onProgress({ received: size, total: size });
    return { bytes: size };
  }

  const timeout = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : null;
  const composed = signal && timeout && AbortSignal.any ? AbortSignal.any([signal, timeout]) : (signal || timeout || undefined);
  let response;
  try { response = await fetch(url, { signal: composed, redirect: 'follow' }); }
  catch (error) {
    if (signal?.aborted) fail('Download cancelled', 'cancelled');
    fail(`Could not reach ${origin(parsed)}: ${error.message}`);
  }
  if (!response.ok) fail(`${origin(parsed)} answered ${response.status} for the package`, 'package_unavailable');
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared && declared > limit) fail(`Package is larger than expected (${declared} bytes)`, 'package_too_large');

  const handle = await fsp.open(destination, 'w');
  let received = 0;
  try {
    for await (const chunk of response.body) {
      received += chunk.length;
      if (received > limit) fail(`Package exceeded its declared size after ${received} bytes`, 'package_too_large');
      await handle.write(chunk);
      onProgress({ received, total: expectedBytes || declared || null });
    }
  } finally { await handle.close(); }
  if (signal?.aborted) fail('Download cancelled', 'cancelled');
  if (expectedBytes && received !== expectedBytes) fail(`Package size ${received} does not match the catalog (${expectedBytes})`, 'package_mismatch');
  return { bytes: received };
}

/** Catalog metadata is JSON and is fetched with the same ceilings. */
async function fetchJson(url, { signal, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = MAX_CATALOG_BYTES } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol === 'file:') {
    const text = await fsp.readFile(fileURLToPath(parsed), 'utf8');
    if (Buffer.byteLength(text) > maxBytes) fail('Catalog is too large', 'catalog_too_large');
    return JSON.parse(text);
  }
  const timeout = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : null;
  const composed = signal && timeout && AbortSignal.any ? AbortSignal.any([signal, timeout]) : (signal || timeout || undefined);
  let response;
  try { response = await fetch(url, { signal: composed }); }
  catch (error) { fail(`Could not reach the module registry at ${origin(parsed)}: ${error.message}`, 'registry_unreachable'); }
  if (!response.ok) fail(`The module registry answered ${response.status}`, 'registry_unavailable');
  const text = await response.text();
  if (Buffer.byteLength(text) > maxBytes) fail('Catalog is too large', 'catalog_too_large');
  try { return JSON.parse(text); } catch (error) { fail(`The module registry returned invalid JSON: ${error.message}`, 'registry_invalid'); }
}

/** Local paths in configuration are accepted and normalised to file: URLs. */
function toUrl(value) {
  const s = String(value || '').trim();
  // A Windows drive letter looks exactly like a one-character scheme, so it is
  // ruled out first: C:\registry\catalog.json is a path, not a URL.
  const windowsPath = /^[a-z]:[\\/]/i.test(s);
  if (!windowsPath && /^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  return pathToFileURL(s).href;
}

module.exports = { downloadTo, fetchJson, toUrl, MAX_PACKAGE_BYTES, MAX_CATALOG_BYTES };
