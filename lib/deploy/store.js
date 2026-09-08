'use strict';
/* Small JSON stores next to the other mutable files in DATA_DIR
   (deploy-repos.json, deploy-targets.json, deploy-runs.json).
   Writes are atomic (.tmp + rename) like saveConnections() in server.js. */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

function createStore(file, initial) {
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { data = typeof initial === 'function' ? initial() : JSON.parse(JSON.stringify(initial)); }
  let chain = Promise.resolve();
  const save = () => {
    const snapshot = JSON.stringify(data, null, 2);
    chain = chain.then(async () => {
      const tmp = file + '.tmp';
      await fsp.writeFile(tmp, snapshot, 'utf8');
      await fsp.rename(tmp, file);
    }).catch((e) => { console.error(`deploy: failed to save ${path.basename(file)}: ${e.message}`); });
    return chain;
  };
  return { get: () => data, set: (d) => { data = d; return save(); }, save, file };
}

function createStores(DATA_DIR) {
  const repos = createStore(path.join(DATA_DIR, 'deploy-repos.json'), { repos: [] });
  const targets = createStore(path.join(DATA_DIR, 'deploy-targets.json'), { targets: [] });
  const runs = createStore(path.join(DATA_DIR, 'deploy-runs.json'), { runs: [] });
  const servers = createStore(path.join(DATA_DIR, 'deploy-servers.json'), { servers: [] });
  const templates = createStore(path.join(DATA_DIR, 'deploy-templates.json'), { templates: [] });
  return {
    repos, targets, runs, servers, templates,
    workDir: path.join(DATA_DIR, 'deploy-work'),
    runsDir: path.join(DATA_DIR, 'deploy-runs'),
    findRepo: (id) => repos.get().repos.find((r) => r.id === id),
    findTarget: (idOrName) => {
      const list = targets.get().targets;
      return list.find((t) => t.id === idOrName) || list.find((t) => t.name === idOrName);
    },
  };
}

module.exports = { createStore, createStores };
