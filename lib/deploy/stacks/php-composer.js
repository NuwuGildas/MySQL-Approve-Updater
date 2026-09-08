'use strict';
const { json, has } = require('../detect/tree');

module.exports = {
  id: 'php-composer', type: 'php', framework: 'composer', label: 'PHP (composer)',
  detect(tree, keyFiles, root = '.') {
    const rel = root === '.' ? 'composer.json' : `${root}/composer.json`;
    const composer = keyFiles[rel] ? json(keyFiles[rel]) : null;
    if (!composer) return null;
    if (composer.require?.['laravel/framework']) return null; // handled by php-laravel
    const pub = root === '.' ? 'public' : `${root}/public`;
    const hasPublic = has(tree, pub);
    const fw = composer.require?.['symfony/framework-bundle'] ? 'symfony' : composer.require?.['slim/slim'] ? 'slim' : composer.require?.['codeigniter4/framework'] ? 'codeigniter' : 'composer';
    const req = composer.require?.php; const m = req && /(\d+\.\d+)/.exec(String(req));
    const hasWeb = hasPublic || has(tree, root === '.' ? 'index.php' : `${root}/index.php`);
    return {
      score: hasWeb ? 0.75 : 0.6, evidence: [rel, ...(hasPublic ? [pub + '/'] : [])],
      fragment: {
        root,
        stack: { type: 'php', framework: fw, packageManager: 'composer', php: m ? m[1] : null },
        build: { steps: ['composer install --no-dev --prefer-dist --optimize-autoloader --no-interaction --no-progress'], env: { APP_ENV: 'prod' } },
        artifact: { exclude: ['.git/**', '.github/**', 'node_modules/**', 'tests/**', '.env', '.env.*', 'var/log/**', 'var/cache/**', '**/*.map', 'ship.json'] },
        shared: fw === 'symfony' ? { files: ['.env.local'], dirs: ['var/log', 'public/uploads'] } : { files: [], dirs: [] },
        runtime: { kind: 'php-fpm', docroot: hasPublic ? 'public' : '.' },
        health: { path: '/', expectStatus: [200, 399] },
      },
    };
  },
  remoteSteps(manifest) {
    if (manifest.stack.framework === 'symfony') {
      return { afterShip: manifest.migrate !== false ? ['php bin/console doctrine:migrations:migrate --no-interaction --allow-no-migration 2>/dev/null || true'] : [], beforeActivate: ['php bin/console cache:clear --no-warmup', 'php bin/console cache:warmup'], afterActivate: [], permissions: ['chmod -R ug+rwX var 2>/dev/null || true'] };
    }
    return { afterShip: [], beforeActivate: [], afterActivate: [], permissions: [] };
  },
  requiredTools: () => ['php', 'composer'],
};
