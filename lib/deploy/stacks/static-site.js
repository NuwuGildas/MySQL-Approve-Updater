'use strict';
/* Static output: Vite/CRA/Astro(static)/Angular/Parcel/Eleventy builds and plain HTML folders. */
const { has } = require('../detect/tree');
const { pkgAt, hasDep, packageManager, installCmd, runCmd, nodeVersion, viteOutDir } = require('./_node');

module.exports = {
  id: 'static-site', type: 'static', framework: 'static', label: 'Static site',
  detect(tree, keyFiles, root = '.') {
    const pkg = pkgAt(keyFiles, root);
    const rel = root === '.' ? 'package.json' : `${root}/package.json`;
    const idx = root === '.' ? 'index.html' : `${root}/index.html`;
    const mk = (framework, outputDir, steps, score, evidence, pm, node) => ({
      score, evidence,
      fragment: {
        root,
        stack: { type: 'static', framework, packageManager: pm, node },
        build: { steps, env: steps.length ? { NODE_ENV: 'production', CI: 'true' } : {}, outputDir },
        artifact: { include: ['**'], exclude: ['**/*.map'] },
        runtime: { kind: 'static', docroot: '.' },
        health: { path: '/', expectStatus: [200, 399] },
      },
    });
    if (pkg) {
      if (hasDep(pkg, 'next', 'nuxt', 'express', 'fastify', 'koa', 'hono', '@nestjs/core', '@remix-run/node', '@sveltejs/kit')) return null; // server stacks
      const pm = packageManager(keyFiles, root, pkg);
      const node = nodeVersion(keyFiles, root, pkg);
      const steps = [installCmd(pm), runCmd(pm, 'build')];
      if (!pkg.scripts?.build) return has(tree, idx) && !pkg.scripts?.start ? mk('plain', '.', [], 0.6, [idx, rel], null, null) : null;
      if (hasDep(pkg, 'vite')) return mk('vite', viteOutDir(keyFiles, root), steps, 0.9, [rel], pm, node);
      if (hasDep(pkg, 'react-scripts')) return mk('cra', 'build', steps, 0.9, [rel], pm, node);
      if (hasDep(pkg, 'astro')) return mk('astro', 'dist', steps, 0.9, [rel], pm, node);
      if (hasDep(pkg, '@angular/cli')) return mk('angular', 'dist', steps, 0.8, [rel], pm, node);
      if (hasDep(pkg, 'parcel')) return mk('parcel', 'dist', steps, 0.8, [rel], pm, node);
      if (hasDep(pkg, '@11ty/eleventy')) return mk('eleventy', '_site', steps, 0.85, [rel], pm, node);
      if (hasDep(pkg, 'gatsby')) return mk('gatsby', 'public', steps, 0.85, [rel], pm, node);
      if (hasDep(pkg, 'vuepress', 'vitepress')) return mk('vitepress', 'docs/.vitepress/dist', steps, 0.8, [rel], pm, node);
      if (hasDep(pkg, 'webpack')) return mk('webpack', 'dist', steps, 0.5, [rel], pm, node);
      return null;
    }
    if (has(tree, idx) && !has(tree, root === '.' ? 'composer.json' : `${root}/composer.json`)) return mk('plain', '.', [], 0.8, [idx], null, null);
    return null;
  },
  remoteSteps() { return { afterShip: [], beforeActivate: [], afterActivate: [], permissions: [] }; },
  requiredTools: (m) => (m.build.steps.length ? ['node', m.stack.packageManager || 'npm'] : []),
};
