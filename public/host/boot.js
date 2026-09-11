'use strict';
/* Startup.
 *
 * The base application is loaded first and is complete on its own: shell,
 * navigation, AI assistant and the database tools. Only after it is running do
 * we ask the host which optional modules are installed and activate them, so a
 * failing module can never stop the application from starting. */

(async () => {
  const load = (src) => new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Could not load ' + src));
    document.body.appendChild(script);
  });

  const CORE = [
    '/host/loader.js',
    '/app.js',
    '/core/database.js',
    '/core/assistant.js',
    '/shell.js',
    '/navigation.js',
    '/palette.js',
    '/host/core-bridge.js',
    '/host/marketplace.js',
  ];

  try {
    for (const src of CORE) await load(src);
    await startApplication();
  } catch (error) {
    const box = document.createElement('div');
    box.className = 'module-startup-error';
    box.setAttribute('role', 'alert');
    const message = document.createElement('p');
    message.textContent = 'Unable to start Server Tools: ' + error.message;
    const retry = document.createElement('button');
    retry.textContent = 'Retry';
    retry.onclick = () => location.reload();
    box.append(message, retry);
    document.body.prepend(box);
    return;
  }

  /* Installed modules, activated in this page. A module that fails to activate
     is reported and skipped; the application stays usable. */
  try {
    const snapshot = await api('/api/modules');
    await ModuleLoader.sync(snapshot, {
      onError: (descriptor, error) => {
        console.error(`module ${descriptor.id} failed to activate`, error);
        toast(`${descriptor.name} could not start: ${error.message}. Open Modules to retry.`, 'error');
      },
    });
    // The address may name a page a module has just registered.
    const resolved = parseRoute(location.hash);
    if (resolved && resolved.id !== (typeof currentPageId !== 'undefined' ? currentPageId : null)) navigate(location.hash, { replace: true, focus: false });
  } catch (error) {
    toast('Installed modules could not be loaded: ' + error.message, 'error');
  }
})();
