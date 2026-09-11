'use strict';
/* Docker stacks: compose projects and single-Dockerfile apps. Always built
   on the server (the image must exist where it runs); the release dir is
   the compose project dir, so `docker compose up -d` in `current` swaps
   containers with the release. */
const { has } = require('../detect/tree');

const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'];
const composeFile = (keyFiles, root) => COMPOSE_FILES.find((f) => Object.prototype.hasOwnProperty.call(keyFiles, root === '.' ? f : `${root}/${f}`)) || null;
const slug = (s) => String(s || 'app').toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'app';

module.exports = {
  id: 'docker', type: 'docker', framework: 'docker', label: 'Docker',
  detect(tree, keyFiles, root = '.') {
    const cf = composeFile(keyFiles, root);
    const df = root === '.' ? 'Dockerfile' : `${root}/Dockerfile`;
    const hasDockerfile = Object.prototype.hasOwnProperty.call(keyFiles, df) || has(tree, df);
    if (!cf && !hasDockerfile) return null;
    const composeText = cf ? keyFiles[root === '.' ? cf : `${root}/${cf}`] || '' : '';
    const port = (() => { const m = /ports:\s*\n\s*-\s*["']?(\d{2,5}):\d{2,5}/.exec(composeText) || /EXPOSE\s+(\d{2,5})/.exec(keyFiles[df] || ''); return m ? Number(m[1]) : 8080; })();
    const framework = cf ? 'compose' : 'dockerfile';
    return {
      score: cf ? 0.9 : 0.8, evidence: [cf ? (root === '.' ? cf : `${root}/${cf}`) : df],
      fragment: {
        root,
        stack: { type: 'docker', framework, packageManager: null },
        build: { steps: cf ? [`docker compose -f ${cf} build --pull`] : ['docker build --pull -t ${name}:${ts} .'], env: { DOCKER_BUILDKIT: '1', COMPOSE_DOCKER_CLI_BUILD: '1' } },
        artifact: { exclude: ['.git/**', '.github/**', 'node_modules/**', '.env', '.env.*', 'ship.json'] },
        shared: { files: ['.env'], dirs: [] },
        runtime: { kind: 'docker', start: null, port, docroot: '.' },
        health: { path: '/', expectStatus: [200, 399], timeoutSec: 120 },
      },
    };
  },
  /** compose: (re)create containers from the new release; dockerfile: replace the single container */
  remoteSteps(manifest) {
    const cf = manifest.build.steps.map((s) => (/-f (\S+)/.exec(s) || [])[1]).find(Boolean) || 'compose.yaml';
    const name = slug(manifest.name);
    if (manifest.stack.framework === 'compose') {
      return { afterShip: [], beforeActivate: [], afterActivate: [`docker compose -f ${cf} up -d --remove-orphans`, `docker image prune -f >/dev/null 2>&1 || true`], permissions: [] };
    }
    const port = manifest.runtime.port || 8080;
    return {
      afterShip: [], beforeActivate: [],
      afterActivate: [
        `docker rm -f ${name} >/dev/null 2>&1 || true`,
        `docker run -d --name ${name} --restart unless-stopped -p 127.0.0.1:${port}:${port} $( [ -f .env ] && printf -- '--env-file .env' ) ${name}:\${TS}`,
        'docker image prune -f >/dev/null 2>&1 || true',
      ],
      permissions: [],
    };
  },
  requiredTools: () => ['docker'],
  remoteOnly: true,
  slug,
};
