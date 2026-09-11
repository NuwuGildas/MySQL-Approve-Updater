'use strict';
/* The module marketplace.
 *
 * Adding a module here downloads it, verifies it, starts its backend and
 * activates its frontend in this page. Nothing reloads: no location change, no
 * document replacement, no server restart. The assistant conversation, the
 * draft in its composer, the selected database, open forms and live terminals
 * are all still there afterwards, because none of them are touched.
 *
 * Installed state is server-owned. This view renders what /api/modules says
 * and never grants a module from local storage. */

let marketplaceState = null;
let marketplaceBusy = new Set();

function moduleMarketplaceView() {
  let view = document.getElementById('moduleMarketplace');
  if (view) return view;
  view = document.createElement('section');
  view.id = 'moduleMarketplace';
  view.hidden = true;
  view.setAttribute('role', 'main');
  view.setAttribute('aria-labelledby', 'moduleMarketplaceTitle');
  view.innerHTML = `
    <div class="module-market-head">
      <div><h1 id="moduleMarketplaceTitle" tabindex="-1">Modules</h1><p>Add tools to your workspace and manage the modules you already use.</p></div>
    </div>
    <label class="sr-only" for="moduleSearch">Search modules</label>
    <input id="moduleSearch" type="search" placeholder="Search modules…" autocomplete="off">
    <p id="moduleMarketStatus" role="status"></p>
    <div id="moduleCatalog" class="module-catalog"></div>
    <p class="module-market-foot">Removing a module keeps its saved data and history. Add it again to pick up where you left off.</p>`;
  document.body.appendChild(view);
  view.querySelector('input').addEventListener('input', () => paintModuleCatalog());
  return view;
}

function openModuleMarketplace() {
  navigate('#/modules');
}

function showModuleMarketplace() {
  moduleMarketplaceView().hidden = false;
  renderModuleCatalog();
}

/** Fetch the catalog (metadata only) and paint. */
async function renderModuleCatalog(snapshot) {
  const status = document.getElementById('moduleMarketStatus');
  if (!document.getElementById('moduleCatalog')) return;
  try {
    marketplaceState = snapshot || await api('/api/modules?refresh=1');
    HostSDK.setSnapshot(marketplaceState);
    if (status && !marketplaceBusy.size) {
      const failures = marketplaceState.registryFailures || [];
      status.textContent = failures.length ? `Registry unavailable: ${failures.map((f) => f.error).join('; ')}` : '';
    }
    paintModuleCatalog();
  } catch (error) {
    if (status) status.textContent = error.message;
  }
}

function paintModuleCatalog() {
  const host = document.getElementById('moduleCatalog');
  if (!host || !marketplaceState) return;
  const query = (document.getElementById('moduleSearch')?.value || '').trim().toLowerCase();
  const modules = marketplaceState.modules.filter((m) => `${m.name} ${m.description} ${m.publisher}`.toLowerCase().includes(query));
  host.replaceChildren();
  for (const module of modules) host.appendChild(moduleCard(module));
  if (!host.children.length) host.textContent = query ? 'No modules match your search.' : 'No modules are offered by the configured registries.';
}

function moduleCard(module) {
  const busy = marketplaceBusy.has(module.id);
  const card = document.createElement('article');
  card.className = 'module-card';
  card.dataset.module = module.id;
  card.dataset.status = busy ? 'installing' : module.status;
  const dependencies = module.dependencies.filter((d) => !d.installed);
  const badge = busy ? 'Adding…'
    : module.status === 'active' ? 'Added'
    : module.status === 'failed' || module.status === 'crashed' ? 'Failed'
    : module.installed ? 'Inactive'
    : module.compatible ? 'Available' : 'Not compatible';
  card.innerHTML = `
    <div class="module-card-info">
      <div class="module-card-title"><h3>${esc(module.name)}</h3><span class="badge${module.status === 'failed' || module.status === 'crashed' ? ' failed' : module.status === 'active' ? ' approved' : ''}">${esc(badge)}</span></div>
      <p>${esc(module.description)}</p>
      <small>${esc(module.publisher)} &middot; v${esc(module.installedVersion || module.availableVersion || '?')}${module.signed ? ' &middot; Signed package' : ''}</small>
      ${dependencies.length ? `<small>Also adds ${esc(dependencies.map((d) => d.id).join(', '))}</small>` : ''}
      ${module.requiredBy.length ? `<small>Required by ${esc(module.requiredBy.map((d) => d.name).join(', '))}</small>` : ''}
    </div>
    <div class="module-actions"></div>
    <details class="module-caps"><summary>Permissions &amp; details <span>${module.capabilities.length} permissions</span></summary>
      ${module.capabilities.length ? `<ul>${module.capabilities.map((c) => `<li>${esc(c.label)}</li>`).join('')}</ul>` : ''}
      <div class="module-package-info">
        ${module.hostSdk ? `<small>Host SDK ${esc(module.hostSdk)}</small>` : ''}
        ${module.source?.commit ? `<small class="mono">${esc(module.source.branch || '')}@${esc(String(module.source.commit).slice(0, 10))}</small>` : ''}
      </div>
    </details>
    ${module.error ? `<p class="module-error" role="alert">${esc(module.error)}</p>` : ''}
    <progress class="module-progress" hidden max="1" value="0"></progress>`;


  const actions = card.querySelector('.module-actions');
  const button = (label, className, handler) => {
    const el = document.createElement('button');
    el.type = 'button'; el.textContent = label; if (className) el.className = className;
    el.disabled = busy;
    el.addEventListener('click', () => handler(card, module));
    actions.appendChild(el);
    return el;
  };

  if (!module.installed) {
    if (module.compatible) button('+ Add module', 'primary', addModule);
    else actions.innerHTML = '<span class="hint">This version needs a newer application.</span>';
  } else {
    if (module.status === 'active' && module.pages?.length) button('Open', '', () => navigate('#/' + module.pages[0]));
    if (module.status === 'failed' || module.status === 'crashed') button('Retry', 'primary', retryModule);
    if (module.updateAvailable) button(`Update to ${module.availableVersion}`, 'primary', updateModule);
    const remove = button('Remove', '', removeModule);
    if (module.requiredBy.length) { remove.disabled = true; remove.title = `Remove ${module.requiredBy.map((d) => d.name).join(', ')} first.`; }
  }
  return card;
}

function setCardStatus(card, text, isError) {
  const status = document.getElementById('moduleMarketStatus');
  if (status) { status.textContent = text || ''; status.classList.toggle('error', !!isError); }
  card?.querySelectorAll('button').forEach((b) => { b.disabled = !!text && !isError; });
}

const PHASE_LABEL = { plan: 'Resolving', download: 'Downloading', verify: 'Verifying the publisher signature', extract: 'Unpacking', activate: 'Starting', installed: 'Installed' };

/** Show download and activation progress while the request is in flight. */
async function followProgress(moduleId, bar, done) {
  while (!done.finished) {
    let snapshot;
    try { snapshot = await api('/api/modules'); } catch { break; }
    const job = (snapshot.jobs || []).find((j) => j.status === 'running');
    if (job) {
      const card = document.querySelector(`#moduleCatalog [data-module="${moduleId}"]`);
      setCardStatus(card, `${PHASE_LABEL[job.phase] || 'Working'} ${job.moduleId}…`);
      if (bar && job.total) { bar.max = job.total; bar.value = job.received || 0; }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function moduleAction(card, module, path, body, workingText) {
  marketplaceBusy.add(module.id);
  setCardStatus(card, workingText);
  const bar = card.querySelector('.module-progress');
  if (bar) { bar.hidden = false; bar.removeAttribute('value'); }
  const done = { finished: false };
  try {
    const request = fetch(`/api/modules/${encodeURIComponent(module.id)}/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
    });
    followProgress(module.id, bar, done).catch(() => {});
    const response = await request;
    done.finished = true;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || response.statusText), { code: data.code });
    marketplaceBusy.delete(module.id);
    if (bar) bar.hidden = true;
    // The server reports success only after BOTH backend and frontend of the
    // module are ready to be used; this activates the frontend in place.
    /* The backend is up; now the frontend. Success is only reported once BOTH
       have activated, so a module whose interface fails to start is shown as a
       failure with a retry, not as "added". */
    await ModuleLoader.sync(data.state || await api('/api/modules'));
    const failure = ModuleLoader.failure(module.id);
    if (failure && path !== 'remove') throw Object.assign(new Error(`${module.name} started, but its interface did not: ${failure}`), { code: 'frontend_activation_failed' });
    await renderModuleCatalog(data.state);
    setCardStatus(null, '');
    return data;
  } catch (error) {
    done.finished = true;
    marketplaceBusy.delete(module.id);
    if (bar) bar.hidden = true;
    await renderModuleCatalog().catch(() => {});
    setCardStatus(document.querySelector(`#moduleCatalog [data-module="${module.id}"]`), error.message, true);
    throw error;
  }
}

async function addModule(card, module) {
  const dependencies = module.dependencies.filter((d) => !d.installed).map((d) => d.id);
  try {
    await moduleAction(card, module, 'install', {}, dependencies.length ? `Adding ${module.name} and ${dependencies.join(', ')}…` : `Adding ${module.name}…`);
    toast(`${module.name} added`, 'success');
  } catch { /* the card shows the reason and offers the action again */ }
}
async function updateModule(card, module) {
  try {
    const result = await moduleAction(card, module, 'update', {}, `Updating ${module.name}…`);
    toast(`${module.name} updated to ${result.version}`, 'success');
  } catch { /* reported on the card */ }
}
async function retryModule(card, module) {
  try { await moduleAction(card, module, 'retry', {}, `Starting ${module.name}…`); toast(`${module.name} started`, 'success'); }
  catch { /* reported on the card */ }
}
async function removeModule(card, module) {
  const ok = await confirmDialog({
    title: `Remove ${module.name}?`,
    message: 'Its pages and tools are removed from this workspace. <b>Saved configuration and history are kept</b>, so adding it again brings everything back.',
    okLabel: 'Remove module', okClass: 'reject',
  });
  if (!ok) return;
  try { await moduleAction(card, module, 'remove', {}, `Removing ${module.name}…`); toast(`${module.name} removed`, 'success'); }
  catch { /* reported on the card: active work and dependents block removal */ }
}
