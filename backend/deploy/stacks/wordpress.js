'use strict';
/* WordPress.
 *
 * The odd one out among the stacks: the repository is not the application. What teams keep in git is
 * wp-content - a theme, some plugins, sometimes a composer.json - and core is downloaded. So this
 * stack does not build anything so much as assemble a release: wp.js fetches a verified copy of core
 * and writes wp-config.php, and the pipeline lays the repository's own files over the top, where
 * anything the repository provides wins.
 *
 * Two repository layouts are recognised, because both are common:
 *   wp-content/{themes,plugins,mu-plugins}   the project holds a wp-content directory
 *   {themes,plugins,mu-plugins}              the project IS the wp-content directory
 * and a third is tolerated: a full WordPress tree with core committed, where nothing is downloaded.
 */

const fs = require('fs');
const path = require('path');
const { has, json } = require('../detect/tree');
const wp = require('../wp');

const CONTENT_MARKERS = ['themes', 'plugins', 'mu-plugins'];
const at = (root, rel) => (root === '.' ? rel : `${root}/${rel}`);
const hasDir = (tree, p) => has(tree, `${p}/`) || tree.some((x) => x.startsWith(`${p}/`));

/** Does this look like a WordPress tree with core committed? */
const coreCommitted = (tree, keyFiles, root) =>
  has(tree, at(root, 'wp-settings.php')) || has(tree, at(root, 'wp-login.php')) || hasDir(tree, at(root, 'wp-includes'));

module.exports = {
  id: 'wordpress', type: 'php', framework: 'wordpress', label: 'WordPress',

  /* Core is assembled on this machine and shipped inside the artifact, so the release is identical
     whether it lands on a VPS, on FTP-only shared hosting, or in a folder on this computer. */
  localOnly: true,

  detect(tree, keyFiles, root = '.') {
    const contentAt = at(root, 'wp-content');
    const inContentDir = CONTENT_MARKERS.filter((m) => hasDir(tree, `${contentAt}/${m}`));
    const atRoot = CONTENT_MARKERS.filter((m) => hasDir(tree, at(root, m)));
    const core = coreCommitted(tree, keyFiles, root);

    let contentDir = null, evidence = [], score = 0;
    if (inContentDir.length || (core && hasDir(tree, contentAt))) {
      contentDir = 'wp-content';
      evidence = inContentDir.length ? inContentDir.map((m) => `${contentAt}/${m}/`) : [`${contentAt}/`];
      score = core ? 0.97 : 0.95;
    } else if (atRoot.includes('themes') && atRoot.length > 1) {
      // the repository IS wp-content: themes/ alone is too weak a signal to claim a whole stack
      contentDir = '.';
      evidence = atRoot.map((m) => `${at(root, m)}/`);
      score = 0.85;
    } else if (core) {
      contentDir = 'wp-content';
      evidence = [at(root, 'wp-settings.php')];
      score = 0.9;
    } else return null;

    if (core) evidence.push(at(root, 'wp-settings.php'));

    const composerRel = at(root, 'composer.json');
    const composer = keyFiles[composerRel] ? json(keyFiles[composerRel]) : null;
    const steps = [];
    if (composer) {
      steps.push('composer install --no-dev --prefer-dist --optimize-autoloader --no-interaction --no-progress');
      evidence.push(composerRel);
    }
    const phpReq = composer?.require?.php;
    const phpVersion = phpReq && /(\d+\.\d+)/.exec(String(phpReq));

    /* Content is staged under wp-content/ when the repository is wp-content itself; when it already
       has one, its paths are right as they are. Core lands underneath either way. */
    const intoDir = contentDir === '.' ? 'wp-content' : '';

    return {
      score,
      evidence,
      fragment: {
        root,
        stack: {
          type: 'php', framework: 'wordpress', packageManager: composer ? 'composer' : null, php: phpVersion ? phpVersion[1] : null,
          wordpress: {
            version: 'latest',              // pin this to redeploy the same core
            contentDir,                     // where the repository keeps wp-content, relative to root
            core: core ? 'repo' : 'download',
            intoDir,                        // subdirectory of the release the repository's files go into
            configFromVault: null,          // vault entry with WORDPRESS_DB_* settings
          },
        },
        build: { steps, env: {} },
        artifact: {
          include: ['**'],
          exclude: [
            '.git/**', '.github/**', 'node_modules/**', 'tests/**', 'test/**', '.env', '.env.*', '**/*.map', 'ship.json',
            // user uploads are shared storage on the server, never part of a release
            'wp-content/uploads/**', 'uploads/**',
            // caches plugins write into wp-content; shipping them poisons the next release
            'wp-content/cache/**', 'wp-content/upgrade/**', 'wp-content/backup*/**', 'wp-content/debug.log',
          ],
        },
        shared: { files: [], dirs: ['wp-content/uploads'] },
        runtime: { kind: 'php-fpm', docroot: '.' },
        health: { path: '/', expectStatus: [200, 399] },
      },
    };
  },

  /** What the plan shows for the assembly step, before anything has been downloaded. */
  planSteps(manifest) {
    const w = manifest.stack.wordpress || {};
    const core = w.core === 'repo' ? 'use the core committed in the repository' : `download WordPress ${w.version || 'latest'} from wordpress.org (checksum-verified, cached)`;
    const config = w.configFromVault ? `generate wp-config.php from vault ${w.configFromVault} (salts kept in the vault)` : 'no wp-config.php will be generated';
    const overlay = w.intoDir ? `lay the repository over it in ${w.intoDir}/` : 'lay the repository over it';
    return [`${core}; ${config}; ${overlay}`];
  },

  /**
   * Assemble everything the release needs that the repository does not provide.
   * Returns the overlay the packaging stage lays the repository's files on top of.
   */
  async prepare({ manifest, appDir, buildDir, cacheDir, target, vault, log, warn, signal, fetchImpl }) {
    const w = manifest.stack.wordpress || {};
    const baseDir = path.join(buildDir, 'wp-base');
    const result = await wp.scaffold({
      wp: { version: w.version || 'latest', core: w.core === 'repo' ? 'repo' : 'download', configFromVault: w.configFromVault || null },
      baseDir,
      cacheDir: path.join(cacheDir, 'wordpress'),
      targetName: target.name,
      // a repository that IS wp-content has nowhere to put one, so this only ever finds a real one
      hasOwnConfig: fs.existsSync(path.join(appDir, 'wp-config.php')),
      vault, fetchImpl, onLine: log, warn, signal,
    });
    return { baseDir, intoDir: w.intoDir || '', notes: result.notes, version: result.version };
  },

  remoteSteps() {
    return {
      afterShip: [],
      beforeActivate: [],
      afterActivate: [],
      // uploads is shared storage: the web server writes into it, the release directory it is linked from does not
      permissions: ['chmod -R ug+rwX wp-content/uploads 2>/dev/null || true'],
    };
  },

  requiredTools: (m) => (m.build.steps.some((s) => /^composer\b/.test(s)) ? ['php', 'composer'] : []),
};
