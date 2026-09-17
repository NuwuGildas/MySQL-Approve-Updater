'use strict';
const path = require('node:path');
const files = [
  'settings.json', 'connections.json', 'rules.json', 'agent.json', 'agent-chat.json',
  'projects.json', 'project-chats.json', 'ssh-session-chats.json', 'ssh-agent-memory.json',
  'connectors.json', 'deploy-repos.json', 'deploy-targets.json', 'deploy-runs.json',
  'deploy-servers.json', 'deploy-templates.json', 'deploy-secrets.enc',
  'audit.log', 'crash.log', 'browser-state.json', 'module-data/state.json',
];
const directories = ['module-data/data', 'backups', 'deploy-runs'];
function managedKey(root, file) {
  if (typeof file !== 'string') return null;
  const key = path.relative(root, path.resolve(file)).split(path.sep).join('/');
  if (!key || key.startsWith('../') || path.isAbsolute(key)) return null;
  return files.some((name) => key === name || key.startsWith(name + '.')) ||
    directories.some((name) => key.startsWith(name + '/')) ? key : null;
}
module.exports = { files, directories, managedKey };
