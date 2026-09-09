'use strict';
/* Projects: named groups of reusable resources (connections, servers, connectors, repos, targets).
   server.js creates one store with createProjectStore(DATA_DIR) and mounts the /api/projects routes.
   The per-project AI chat history lives next to it in ./chat (createChatStore). */
module.exports = { ...require('./store'), chat: require('./chat') };
