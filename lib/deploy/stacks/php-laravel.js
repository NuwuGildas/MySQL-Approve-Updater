'use strict';
const { json } = require('../detect/tree');
const { pkgAt, hasDep, packageManager, installCmd, runCmd } = require('./_node');

const COMPOSER_INSTALL = 'composer install --no-dev --prefer-dist --optimize-autoloader --no-interaction --no-progress';

function phpVersion(composer) {
  const req = composer?.require?.php || composer?.config?.platform?.php;
  const m = req && /(\d+\.\d+)/.exec(String(req));
  return m ? m[1] : null;
}

module.exports = {
  id: 'php-laravel', type: 'php', framework: 'laravel', label: 'Laravel',
  detect(tree, keyFiles, root = '.') {
    const rel = root === '.' ? 'composer.json' : `${root}/composer.json`;
    const composer = keyFiles[rel] ? json(keyFiles[rel]) : null;
    if (!composer?.require?.['laravel/framework']) return null;
    const evidence = [rel];
    const artisan = root === '.' ? 'artisan' : `${root}/artisan`;
    if (keyFiles[artisan] !== undefined || tree.includes(artisan)) evidence.push(artisan);
    const pkg = pkgAt(keyFiles, root);
    const steps = [COMPOSER_INSTALL];
    let pm = 'composer', node = null;
    if (pkg && (hasDep(pkg, 'vite', 'laravel-vite-plugin', 'laravel-mix') || pkg.scripts?.build)) {
      const jpm = packageManager(keyFiles, root, pkg);
      steps.push(installCmd(jpm), runCmd(jpm, 'build'));
      evidence.push(root === '.' ? 'package.json' : `${root}/package.json`);
      node = require('./_node').nodeVersion(keyFiles, root, pkg);
    }
    const health = /laravel\/framework"\s*:\s*"\^?(1[1-9]|[2-9]\d)/.test(keyFiles[rel]) ? '/up' : '/';
    return {
      score: evidence.length > 1 ? 0.98 : 0.9, evidence,
      fragment: {
        root,
        stack: { type: 'php', framework: 'laravel', packageManager: pm, php: phpVersion(composer), node },
        build: { steps, env: { APP_ENV: 'production', NODE_ENV: 'production' } },
        artifact: { exclude: ['.git/**', '.github/**', 'node_modules/**', 'tests/**', '.env', '.env.*', 'storage/logs/**', 'storage/framework/cache/**', 'storage/framework/sessions/**', 'storage/framework/views/**', '**/*.map', 'ship.json'] },
        shared: { files: ['.env'], dirs: ['storage/app', 'storage/framework', 'storage/logs'] },
        runtime: { kind: 'php-fpm', docroot: 'public' },
        health: { path: health, expectStatus: [200, 399] },
      },
    };
  },
  /** Framework hooks, merged before the user's own (user hooks run after). */
  remoteSteps(manifest) {
    const afterShip = [];
    if (manifest.migrate !== false) afterShip.push('php artisan migrate --force --no-interaction');
    return {
      afterShip,
      beforeActivate: ['php artisan storage:link 2>/dev/null || true', 'php artisan config:cache', 'php artisan route:cache', 'php artisan view:cache', 'php artisan event:cache 2>/dev/null || true'],
      afterActivate: ['php artisan queue:restart 2>/dev/null || true'],
      permissions: ['chmod -R ug+rwX storage bootstrap/cache 2>/dev/null || true'],
    };
  },
  requiredTools: (m) => ['php', 'composer', ...(m.build.steps.some((s) => /^(npm|pnpm|yarn|bun)\b/.test(s)) ? ['node', m.build.steps.find((s) => /^(npm|pnpm|yarn|bun)\b/.test(s)).split(' ')[0]] : [])],
};
