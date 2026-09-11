'use strict';
/* A local HTTP module registry: the same shape as a real one, on loopback.
 *
 *   node scripts/module-registry.js [--dir dist/modules] [--port 8788]
 *
 * Serves /catalog.json and /packages/<file>.tgz. Used by the development
 * workflow and by the installation tests, so nothing has to be published
 * anywhere to exercise a real download → verify → install → activate path. */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : fallback; };

function createRegistryServer({ dir, port = 0, host = '127.0.0.1' } = {}) {
  const root = path.resolve(dir);
  let origin = null;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${host}`);
    if (url.pathname === '/catalog.json') return sendCatalog(res);
    const match = /^\/packages\/([A-Za-z0-9._-]+\.tgz)$/.exec(url.pathname);
    if (match) return send(res, path.join(root, match[1]), 'application/gzip');
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  /* A registry serves its own package URLs, whatever port it happens to be on.
     Digests and signatures are untouched - only the location changes. */
  function sendCatalog(res) {
    let catalog;
    try { catalog = JSON.parse(fs.readFileSync(path.join(root, 'catalog.json'), 'utf8')); }
    catch { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('no catalog'); }
    for (const module of catalog.modules || []) {
      for (const version of module.versions || []) {
        const file = String(version.package?.url || '').split('/').pop();
        if (file) version.package.url = `${origin}/packages/${file}`;
      }
    }
    const body = JSON.stringify(catalog, null, 2);
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  function send(res, file, type) {
    fs.stat(file, (error, stat) => {
      if (error) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
      res.writeHead(200, { 'content-type': type, 'content-length': stat.size });
      fs.createReadStream(file).pipe(res);
    });
  }

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      origin = `http://${host}:${address.port}`;
      resolve({
        server,
        port: address.port,
        catalogUrl: `http://${host}:${address.port}/catalog.json`,
        packagesUrl: `http://${host}:${address.port}/packages`,
        close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(done); }),
      });
    });
  });
}

if (require.main === module) {
  createRegistryServer({ dir: path.resolve(ROOT, arg('dir', path.join('dist', 'modules'))), port: Number(arg('port', 8788)) })
    .then((registry) => {
      console.log(`module registry on ${registry.catalogUrl}`);
      console.log(`packages served from ${registry.packagesUrl}`);
      console.log('point the app at it with MODULE_REGISTRIES=' + registry.catalogUrl);
    })
    .catch((error) => { console.error(error.message); process.exit(1); });
}

module.exports = { createRegistryServer };
