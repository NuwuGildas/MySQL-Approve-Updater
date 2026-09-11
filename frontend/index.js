/* Deployments (The Ascension) - frontend entry point. */
'use strict';

import { createDeploymentsUI } from './deployments-ui.js';

let ui = null;

/* The resource switcher above the deploy sidebar (Targets / Repos / Secrets / Cloud). */
const RESOURCES = [['targets', 'Targets'], ['repos', 'Repos', 'Repositories'], ['secrets', 'Secrets'], ['cloud', 'Cloud', 'Cloud servers']];
function initResourceSwitcher(host, nav) {
  if (!nav || nav.querySelector('.dp-switch')) return;
  const sections = [...nav.querySelectorAll(':scope > .dp-sec')];
  const order = ['repos', 'targets', 'secrets', 'cloud'];
  sections.forEach((section, index) => { section.dataset.res = order[index] || `x${index}`; });
  const switcher = document.createElement('div');
  switcher.className = 'dp-switch';
  switcher.setAttribute('role', 'tablist');
  switcher.setAttribute('aria-label', 'Deployment resources');
  switcher.innerHTML = RESOURCES.map(([key, label, full]) => `<button type="button" role="tab" data-res="${key}" title="${full || label}">${label}</button>`).join('');
  nav.prepend(switcher);
  const apply = (key) => {
    host.storage.set('resource', key);
    switcher.querySelectorAll('[data-res]').forEach((b) => { const on = b.dataset.res === key; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
    sections.forEach((section) => section.classList.toggle('res-on', section.dataset.res === key));
    nav.classList.add('switched');
  };
  host.on(switcher, 'click', (event) => { const button = event.target.closest('[data-res]'); if (button) apply(button.dataset.res); });
  apply(host.storage.get('resource', 'targets'));
}

export async function activate(host) {
  host.styles.link(new URL('./deployments.css', import.meta.url).href);

  const mount = host.mount('deployments');
  mount.innerHTML = await fetch(new URL('./deployments.html', import.meta.url)).then((r) => r.text());
  mount.hidden = false;
  const drawer = mount.querySelector('#deployDrawer');

  ui = createDeploymentsUI({ host, mount });
  initResourceSwitcher(host, mount.querySelector('#deployNav'));

  host.registerPage({
    id: 'deploy', segment: 'deployments', label: 'Deployments', group: 'Infrastructure', order: 20,
    icon: host.ui.icons.rocket, title: 'Deployments · The Ascension',
    desc: 'Build → deploy → ship: connect a repo, detect its stack, review the plan and ship to a VPS, shared host or platform.',
    enter: async (parts) => {
      const targetId = parts[0] === 'targets' ? parts[1] : undefined;
      await ui.openDeploy(targetId);
      if (targetId && !ui.state.targets.some((t) => t.id === targetId)) {
        host.ui.toast('That deploy target no longer exists', 'warning');
        host.navigate('#/deployments', { replace: true });
      }
    },
    leave: () => ui.closeDeploy(),
    focus: () => drawer.querySelector('.asc-title h2'),
  });

  host.registerLauncherTile({
    id: 'deploy', name: 'Deployments', route: '#/deployments', tag: 'The Ascension', accent: '--green', order: 20,
    icon: host.ui.icons.rocket,
    desc: 'Build → deploy → ship: connect a repo, detect its stack, review the plan and the deploy map, then ship to a VPS or shared host with one click.',
    launch: () => host.navigate('#/deployments'),
  });

  host.registerCommand({
    id: 'new-deployment', title: 'New deployment', sub: 'Guided setup: repository → build → destination',
    run: () => { host.navigate('#/deployments'); setTimeout(() => mount.querySelector('#btnDpNew')?.click(), 320); },
  });

  host.registerTourStep({
    id: 'deployments', order: 10, element: '#deployDrawer .asc-head', route: '#/deployments', title: 'Deployments · The Ascension',
    intro: '<b>New deployment</b> starts the five-step guided setup: source, framework, destination, access, review. Then follow the pipeline: Test → Fetch → Detect → Plan → Ship → Verify. <b>Plan</b> is a read-only dry run listing every command; <b>Ship</b> executes the reviewed plan and rolls back when the health check fails. Secrets live in an encrypted vault and never appear in plans or logs.',
  });

  /* ---- search sources this module owns ---- */
  const flash = (element) => { if (!element) return; element.scrollIntoView({ block: 'center', behavior: 'smooth' }); element.classList.add('cmdk-flash'); setTimeout(() => element.classList.remove('cmdk-flash'), 1600); };
  const after = (fn, ms = 300) => setTimeout(() => { try { fn(); } catch {} }, ms);

  host.registerSearchSource({
    key: 'targets', prefixes: ['targets', 'target', 'deployments', 'deployment'], label: 'Deployments', icon: 'rocket',
    tip: 'Search deployment targets',
    fetch: () => host.http('/deploy/targets').then((d) => d.targets || []),
    map: (t) => ({ title: t.name, sub: [t.type === 'local' ? 'this computer' : t.type, t.paths?.root || t.paths?.docroot || '', t.projectName].filter(Boolean).join(' · '), action: { k: 'target', id: t.id } }),
    run: (action) => host.navigate(`#/deployments/targets/${action.id}`),
  });
  host.registerSearchSource({
    key: 'repos', prefixes: ['repos', 'repo', 'repositories'], label: 'Repositories', icon: 'repo',
    tip: 'Search connected repositories',
    fetch: () => host.http('/deploy/repos').then((d) => d.repos || []),
    map: (r) => ({ title: r.name, sub: r.source?.kind === 'git' ? String(r.source.url || '').replace(/^https?:\/\//, '') : r.source?.path || '', action: { k: 'repo', id: r.id } }),
    run: (action) => { host.navigate('#/deployments'); after(() => { mount.querySelector('.dp-switch [data-res="repos"]')?.click(); flash(mount.querySelector(`#deployNav [data-repo-id="${action.id}"]`)); }); },
  });
  host.registerSearchSource({
    key: 'secrets', prefixes: ['secrets', 'secret', 'vault'], label: 'Vault secrets', icon: 'key',
    tip: 'Search vault secret names',
    fetch: () => host.http('/deploy/secrets').then((d) => d.secrets || []),
    map: (s) => ({ title: s.name, sub: s.updatedAt ? `updated ${ui.dpFmtAgo(s.updatedAt)}` : 'vault secret', action: { k: 'secret', name: s.name } }),
    run: (action) => { host.navigate('#/deployments'); after(() => { mount.querySelector('.dp-switch [data-res="secrets"]')?.click(); flash([...mount.querySelectorAll('#deployNav .dp-secret, #deployNav .dp-item')].find((el) => el.textContent.includes(action.name))); }); },
  });
  host.registerSearchSource({
    key: 'runs', prefixes: ['runs', 'run', 'deploys'], label: 'Deploy runs', icon: 'history',
    tip: 'Search deploy and rollback runs',
    fetch: () => host.http('/deploy/runs?limit=60').then((d) => d.runs || []),
    map: (r) => ({ title: `${r.mode} ${r.status.replace('_', ' ')} · ${r.targetName || ''}`, sub: `${r.id}${r.release ? ' · release ' + r.release : ''}${r.error ? ' · ' + String(r.error).slice(0, 60) : ''}`, action: { k: 'run', id: r.id, targetId: r.targetId }, hay: `${r.mode} ${r.status} ${r.targetName || ''} ${r.id} ${r.release || ''} ${r.commit || ''}` }),
    run: (action) => {
      host.navigate(action.targetId ? `#/deployments/targets/${action.targetId}` : '#/deployments');
      after(() => { ui.state.logRun = action.id; ui.dpShowTab('log'); ui.dpLoadLog(action.id); }, 320);
    },
  });

  /* ---- settings ---- */
  host.registerSettingsSection({
    id: 'deploy', label: 'The Ascension', order: 70,
    render: (element) => {
      if (element.dataset.built) return;
      element.dataset.built = '1';
      element.innerHTML = `<div class="settings-group">
        <div class="sg-head">Deploy toolchain <span class="hint" id="setDpVault" style="margin:0"></span></div>
        <div id="setDpTools" class="settings-list"></div>
        <p class="sg-hint">Tools found on this machine for local builds. Remote builds use the server's toolchain instead. Secrets live in <code>deploy-secrets.enc</code>; set <code>DEPLOY_MASTER_KEY</code> in <code>.env</code> to control the master key.</p>
        <label class="chk"><input type="checkbox" id="setDpAi"> Ask the AI assistant when stack detection is not confident</label>
        <p class="sg-hint">Only used as a fallback; an AI-suggested manifest is never saved without your approval.</p>
        <div class="settings-actions"><button id="btnManageDeploy" class="primary">Open Deploy</button></div>
      </div>`;
      element.querySelector('#btnManageDeploy').onclick = () => { document.getElementById('settingsModal')?.close(); host.navigate('#/deployments'); };
      ui.renderDeploySettings();
    },
  });

  host.registerSettingsGroup({
    section: 'ai', id: 'deploy-assist', order: 10,
    render: async (element) => {
      if (element.dataset.built) return;
      element.dataset.built = '1';
      element.innerHTML = await fetch(new URL('./settings-ai.html', import.meta.url)).then((r) => r.text());
      const settings = await host.api('/api/settings');
      element.querySelectorAll('[data-assist]').forEach((box) => {
        box.checked = !!settings.aiAssist?.[box.dataset.assist];
        host.on(box, 'change', async () => {
          try {
            await host.api('/api/settings', { method: 'PUT', body: JSON.stringify({ aiAssist: { [box.dataset.assist]: box.checked } }) });
            await host.rpc('settingsChanged', {});
            ui.loadDeploy().catch(() => {});
          } catch { box.checked = !box.checked; }
        });
      });
    },
  });

  /* ---- the assistant's deploy cards ---- */
  host.assistant.registerProposalCard('deploy-manifest', (element, proposal, { wire, esc }) => {
    const manifest = proposal.manifest || {};
    element.innerHTML = `
      <div class="ap-head">Deploy manifest proposal for <b>${esc(proposal.targetName || '')}</b>${proposal.guardrails === 'passed' ? ' <span class="badge approved" title="Passed the manifest guardrail check">guardrails ✓</span>' : ''}</div>
      <div class="ap-meta">${esc(manifest.stack?.type || '?')}/${esc(manifest.stack?.framework || '?')} · ${(manifest.build?.steps || []).length} build step(s) · runtime ${esc(manifest.runtime?.kind || '?')}${manifest.runtime?.docroot && manifest.runtime.docroot !== '.' ? ` · docroot ${esc(manifest.runtime.docroot)}` : ''}</div>
      <details><summary>Full manifest</summary><pre>${esc(JSON.stringify(manifest, null, 2))}</pre></details>
      <div class="actions">
        <button class="approve" data-dec="approve">Approve and save</button>
        <button class="reject" data-dec="reject">Reject</button>
      </div>`;
    wire((result) => { if (result.status === 'approved' && drawer.classList.contains('open')) ui.loadDeploy().catch(() => {}); });
  });

  host.assistant.registerProposalCard('deploy-action', (element, proposal, { wire, esc, toast }) => {
    const labels = { plan: 'Run a Plan (read-only dry run)', ship: 'Ship', rollback: 'Roll back', unlock: 'Force-unlock the target', cancel: 'Cancel the running deploy' };
    element.innerHTML = `
      <div class="ap-head">Deploy action: <b>${esc(labels[proposal.action] || proposal.action)}</b> on <b>${esc(proposal.targetName || '')}</b></div>
      <div class="ap-meta">${proposal.release ? `release ${esc(proposal.release)} · ` : ''}${proposal.planHash ? `reviewed plan ${esc(proposal.planHash)} · ` : proposal.action === 'ship' ? 'no reviewed plan: computed and executed in one go · ' : ''}proposed ${proposal.source === 'explain' ? 'after analysing a failed run' : 'by the assistant'}</div>
      ${proposal.reason ? `<div class="txt" style="margin-top:.3rem">${esc(proposal.reason)}</div>` : ''}
      <div class="actions">
        <button class="${proposal.action === 'ship' || proposal.action === 'rollback' ? 'warn' : 'approve'}" data-dec="approve">Approve and ${esc((labels[proposal.action] || proposal.action).split(' ')[0].toLowerCase())}</button>
        <button class="reject" data-dec="reject">Reject</button>
      </div>`;
    wire((result) => {
      if (result.status !== 'approved') return;
      toast(`${labels[proposal.action] || proposal.action}: started`, 'success');
      if (drawer.classList.contains('open')) ui.loadDeploy().catch(() => {});
    });
  });

  /* ---- live deploy events, through the host bus ---- */
  host.events.onModule((message) => { if (message.name === 'deploy') ui.onDeployEvent(message.payload); });
  host.events.on('deploy', (payload) => ui.onDeployEvent(payload));

  host.observe(host.shell.watchPage(drawer, 'deploy'));

  /* Selecting a target keeps the address in step without a history entry. */
  const select = ui.dpSelect;
  ui.dpSelect = (id) => {
    select(id);
    if (host.shell.parseRoute(location.hash)?.id === 'deploy' && id) host.shell.replaceRoute(`#/deployments/targets/${id}`);
  };

  /* What other modules may use. Connectors hands a repository over here. */
  host.provide({
    repos: () => ui.state.repos || [],
    targets: () => ui.state.targets || [],
    reload: () => ui.loadDeploy(),
    fmtAgo: (iso) => ui.dpFmtAgo(iso),
    openTarget: (id) => host.navigate(`#/deployments/targets/${id}`),
    async prefillRepository({ name, url, branch, tokenRef, secretName }) {
      host.navigate('#/deployments');
      if (!ui.state.loaded) await ui.loadDeploy();
      ui.dpOpenRepoModal(null);
      const $ = (id) => mount.querySelector('#' + id);
      $('drName').value = name;
      $('drKind').value = 'git';
      $('drUrl').value = url;
      $('drBranch').value = branch || '';
      $('drAuth').value = 'https-token';
      if (![...$('drTokenRef').options].some((option) => option.value === tokenRef)) $('drTokenRef').add(new Option(secretName, tokenRef));
      $('drTokenRef').value = tokenRef;
      ui.dpRepoSync();
    },
  });
}

export async function deactivate() {
  ui = null;
}
