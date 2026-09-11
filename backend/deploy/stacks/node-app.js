'use strict';
/* Server-side Node apps: Next, Nuxt, Astro (SSR), Express/Fastify/Koa/Hono/Nest, generic. */
const { pkgAt, hasDep, packageManager, installCmd, runCmd, pruneCmd, nodeVersion } = require('./_node');

const SERVER_FW = ['express', 'fastify', 'koa', '@koa/router', 'hono', '@nestjs/core', '@hapi/hapi', 'restify', 'polka', 'socket.io'];

module.exports = {
  id: 'node-app', type: 'node', framework: 'node', label: 'Node.js app',
  detect(tree, keyFiles, root = '.') {
    const pkg = pkgAt(keyFiles, root);
    if (!pkg) return null;
    const pm = packageManager(keyFiles, root, pkg);
    const rel = root === '.' ? 'package.json' : `${root}/package.json`;
    const evidence = [rel];
    const lock = { npm: 'package-lock.json', pnpm: 'pnpm-lock.yaml', yarn: 'yarn.lock', bun: 'bun.lockb' }[pm];
    if (keyFiles[root === '.' ? lock : `${root}/${lock}`] !== undefined) evidence.push(root === '.' ? lock : `${root}/${lock}`);
    const hasBuild = !!pkg.scripts?.build;
    const node = nodeVersion(keyFiles, root, pkg);
    const base = (framework, score, o) => ({
      score, evidence,
      fragment: {
        root,
        stack: { type: 'node', framework, packageManager: pm, node },
        build: { steps: [installCmd(pm), ...(hasBuild ? [runCmd(pm, 'build')] : [])], env: { NODE_ENV: 'production', CI: 'true' } },
        artifact: { exclude: ['.git/**', '.github/**', 'tests/**', 'test/**', '.env', '.env.*', '**/*.map', 'ship.json', ...(o.excludeSrc || [])] },
        shared: { files: ['.env'], dirs: o.sharedDirs || [] },
        runtime: { kind: 'node', start: o.start, port: o.port || 3000, docroot: '.' },
        health: { path: o.health || '/', expectStatus: [200, 399] },
      },
    });
    if (hasDep(pkg, 'next')) {
      const nextCfg = ['next.config.js', 'next.config.mjs', 'next.config.ts'].map((f) => keyFiles[root === '.' ? f : `${root}/${f}`]).find(Boolean) || '';
      const standalone = /output\s*:\s*['"]standalone['"]/.test(nextCfg);
      return base('next', 0.95, { start: standalone ? 'node .next/standalone/server.js' : `${pm === 'npm' ? 'npx' : pm} next start -p $PORT`, sharedDirs: ['.next/cache'] });
    }
    if (hasDep(pkg, 'nuxt')) return base('nuxt', 0.95, { start: 'node .output/server/index.mjs', health: '/' });
    if (hasDep(pkg, 'astro')) {
      const cfg = keyFiles[root === '.' ? 'astro.config.mjs' : `${root}/astro.config.mjs`] || '';
      if (!/output\s*:\s*['"](server|hybrid)['"]/.test(cfg)) return null; // static astro → static-site
      return base('astro', 0.9, { start: 'node ./dist/server/entry.mjs' });
    }
    if (hasDep(pkg, 'remix', '@remix-run/node', '@remix-run/serve')) return base('remix', 0.9, { start: pkg.scripts?.start || 'npx remix-serve ./build/server/index.js' });
    if (hasDep(pkg, '@sveltejs/kit')) return base('sveltekit', 0.85, { start: 'node build/index.js' });
    if (hasDep(pkg, ...SERVER_FW)) {
      const fw = SERVER_FW.find((f) => hasDep(pkg, f)).replace(/^@|\/core$/g, '').replace('nestjs', 'nest');
      const start = pkg.scripts?.start ? runCmd(pm, 'start') : pkg.main ? `node ${pkg.main}` : 'node server.js';
      return base(fw, 0.85, { start, health: '/health' });
    }
    if (pkg.scripts?.start && !hasDep(pkg, 'vite', 'react-scripts', '@angular/cli', 'parcel')) {
      return base('generic-node', 0.5, { start: runCmd(pm, 'start') });
    }
    return null;
  },
  remoteSteps(manifest) {
    const pm = manifest.stack.packageManager || 'npm';
    const prune = pruneCmd(pm);
    return { afterShip: [], beforeActivate: prune && manifest.build.steps.length ? [prune] : [], afterActivate: [], permissions: [] };
  },
  requiredTools: (m) => ['node', m.stack.packageManager || 'npm'],
};
