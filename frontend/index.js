/* Git Connectors - frontend.
 *
 * Independent of Deployments: everything here works on its own. When
 * Deployments happens to be installed, "Connect" hands a repository over to it
 * through the API that module publishes; when it is not, the repository's clone
 * URL is offered instead. Nothing reaches into another module's internals. */
'use strict';

const state = { list: [], providers: [], secrets: [], editing: null, reposFor: null, rows: [] };
let scope = null;

const LOGO = {
  github: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5A11.5 11.5 0 0 0 .5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.2.8-.6v-2.1c-3.2.7-3.9-1.4-3.9-1.4-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A11.5 11.5 0 0 0 23.5 12 11.5 11.5 0 0 0 12 .5z"/></svg>',
  gitlab: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M22.7 13.5 21.5 9.8l-2.4-7.4a.6.6 0 0 0-1.1 0L15.6 9.8H8.4L6 2.4a.6.6 0 0 0-1.1 0L2.5 9.8l-1.2 3.7a1.2 1.2 0 0 0 .4 1.3L12 22.3l10.3-7.5a1.2 1.2 0 0 0 .4-1.3z"/></svg>',
};
/* status as an icon-only badge: the label lives in title/aria-label */
const STATUS = {
  ok: { label: 'Verified', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>' },
  error: { label: 'Verification failed', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 6v7"/><circle cx="12" cy="17.5" r="1" fill="currentColor" stroke="none"/></svg>' },
  unverified: { label: 'Not verified yet', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 7v5l3 2"/><circle cx="12" cy="12" r="8"/></svg>' },
};

/** How long ago, in words. Deployments has its own copy; neither depends on the other. */
function ago(iso) {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso || 0)) / 1000);
  if (!Number.isFinite(seconds)) return '';
  const units = [[86400, 'd'], [3600, 'h'], [60, 'm']];
  for (const [size, label] of units) if (seconds >= size) return `${Math.floor(seconds / size)}${label} ago`;
  return 'just now';
}

function fillSelect(select, options, value, placeholder) {
  select.innerHTML = `<option value="">${placeholder}</option>` + options.map((o) => `<option value="${o.value.replace(/"/g, '&quot;')}">${o.label}</option>`).join('');
  select.value = value || '';
}

export async function activate(host) {
  scope = host;
  const { esc, toast, confirm } = host.ui;

  host.styles.link(new URL('./connectors.css', import.meta.url).href);
  const mount = host.mount('connectors');
  mount.innerHTML = await fetch(new URL('./connectors.html', import.meta.url)).then((r) => r.text());
  mount.innerHTML += await fetch(new URL('./connector-form.html', import.meta.url)).then((r) => r.text());
  mount.hidden = false;

  const $ = (id) => mount.querySelector('#' + id);
  const drawer = $('connectorsDrawer');
  const provider = (kind) => state.providers.find((p) => p.id === kind) || { label: kind };
  const deployments = () => host.consume('deployments');

  const showMain = () => { $('cnMain').hidden = false; $('cnReposView').hidden = true; state.reposFor = null; };

  async function load() {
    const list = $('connectorsList');
    try {
      const data = await host.get('list');
      state.list = data.connectors;
      state.providers = data.providers;
      state.secrets = (await host.get('secrets')).secrets || [];
    } catch (error) {
      list.innerHTML = `<div class="empty" style="padding:1rem;color:var(--red)">${esc(error.message)}</div>`;
      return;
    }
    $('connectorsCount').textContent = state.list.length ? `— ${state.list.filter((c) => c.status === 'ok').length}/${state.list.length} verified` : '';
    if (!state.list.length) {
      list.innerHTML = `<div class="cn-empty"><h3>No connectors yet</h3><p>Connect your GitHub or GitLab account once with a personal access token. Server Tools keeps the token in the encrypted vault, verifies it, and lets you pick repositories without pasting URLs.</p><div class="cn-empty-actions">${state.providers.map((p) => `<button type="button" class="primary" data-cn-add="${esc(p.id)}"><span class="cn-logo">${LOGO[p.id] || ''}</span> Connect ${esc(p.label)}</button>`).join('')}</div></div>`;
      list.querySelectorAll('[data-cn-add]').forEach((b) => b.addEventListener('click', () => openModal(null, b.dataset.cnAdd)));
      return;
    }
    list.innerHTML = state.list.map((c) => `
      <article class="cn-card ${esc(c.status)}" data-id="${esc(c.id)}">
        <div class="cn-card-head">
          <span class="cn-logo ${esc(c.kind)}">${LOGO[c.kind] || ''}</span>
          <div class="cn-id"><div class="cn-name">${esc(c.name)}</div><div class="cn-sub">${esc(provider(c.kind).label)}${c.baseUrl && !/api\.github\.com|gitlab\.com$/.test(c.baseUrl) ? ` · ${esc(c.baseUrl.replace(/^https?:\/\//, ''))}` : ''}</div></div>
          <span class="cn-status ${esc(c.status)}" role="img" data-status="${esc(c.status)}" aria-label="${STATUS[c.status]?.label || c.status}" title="${STATUS[c.status]?.label || c.status}">${STATUS[c.status]?.icon || ''}</span>
        </div>
        ${c.status === 'ok' && c.account ? `<div class="cn-account">${c.account.avatar ? `<img src="${esc(c.account.avatar)}" alt="" width="28" height="28">` : ''}<div><b>${esc(c.account.name || c.account.login)}</b> <span class="hint">@${esc(c.account.login)}</span>${c.account.scopes?.length ? `<div class="cn-scopes">${c.account.scopes.map((s) => `<span class="chip">${esc(s)}</span>`).join('')}</div>` : ''}</div></div>`
        : c.status === 'error' ? `<div class="cn-error">${esc(c.error || 'verification failed')}</div>` : ''}
        <div class="cn-meta"><span class="hint">secret <code>${esc(c.secretName)}</code></span>${c.verifiedAt ? `<span class="hint">checked ${esc(ago(c.verifiedAt))}</span>` : ''}</div>
        <div class="cn-actions">
          <button type="button" class="primary" data-act="repos" ${c.status === 'ok' ? '' : 'disabled'}>Browse repositories</button>
          <button type="button" data-act="verify">Verify</button>
          <button type="button" data-act="edit" title="Rename, change the base URL or replace the token">Edit</button>
          <button type="button" class="iconbtn danger" data-act="remove" title="Remove connector"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg></button>
        </div>
      </article>`).join('');
    list.querySelectorAll('.cn-card [data-act]').forEach((b) => b.addEventListener('click', () => action(b.closest('.cn-card').dataset.id, b.dataset.act, b)));
  }

  async function action(id, act, button) {
    const connector = state.list.find((c) => c.id === id);
    if (!connector) return;
    try {
      if (act === 'verify') {
        button.disabled = true;
        const result = await host.rpc('verify', { id });
        toast(result.status === 'ok' ? `Verified as @${result.account.login}` : result.error, result.status === 'ok' ? 'success' : 'error');
        await load();
      } else if (act === 'edit') openModal(connector);
      else if (act === 'repos') host.navigate(`#/connectors/${id}/repos`);
      else if (act === 'remove') {
        const ok = await confirm({
          title: `Remove ${connector.name}`,
          message: `Remove the <b>${esc(connector.name)}</b> connector? Repositories already connected keep working: they reference the vault secret <code>${esc(connector.secretName)}</code>, which stays in the vault.`,
          okLabel: 'Remove', okClass: 'reject',
        });
        if (!ok) return;
        await host.rpc('remove', { id });
        toast('Connector removed', 'success');
        await load();
      }
    } catch (error) { toast(error.message, 'error'); if (button) button.disabled = false; }
  }

  /* ---- add / edit ---- */
  function openModal(connector, kind) {
    state.editing = connector || null;
    const k = connector?.kind || kind || 'github';
    $('cnModalTitle').textContent = connector ? `Edit ${connector.name}` : 'Connect an account';
    $('cnKindChoice').querySelectorAll('[data-kind]').forEach((b) => {
      const on = b.dataset.kind === k;
      b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); b.disabled = !!connector;
    });
    $('cnName').value = connector?.name || '';
    $('cnBase').value = connector && !/api\.github\.com|^https:\/\/gitlab\.com$/.test(connector.baseUrl) ? connector.baseUrl.replace(/\/api\/v3$/, '') : '';
    $('cnToken').value = '';
    const options = state.secrets.map((s) => ({ value: `\${vault:${s.name}}`, label: s.name }));
    fillSelect($('cnTokenRef'), options, connector?.tokenRef || '', options.length ? 'Use an existing vault secret…' : 'no secrets in the vault yet');
    $('cnTokenHelp').textContent = connector ? 'Leave the token empty to keep the current one.' : '';
    syncModal();
    $('cnModal').showModal();
    setTimeout(() => $(connector ? 'cnName' : 'cnToken').focus(), 30);
  }
  function syncModal() {
    const k = $('cnKindChoice').querySelector('[aria-checked="true"]')?.dataset.kind || 'github';
    const p = provider(k);
    $('cnBaseWrap').hidden = false;
    $('cnBase').placeholder = k === 'gitlab' ? 'https://gitlab.com (or your self-managed instance)' : 'https://api.github.com (or GitHub Enterprise: https://ghe.example.com)';
    $('cnScopeHint').textContent = p.tokenHint || '';
    if (!state.editing && !$('cnName').dataset.touched) $('cnName').value = p.label || '';
  }

  /* ---- repositories of one connector ---- */
  async function showRepos(connector) {
    const same = state.reposFor && state.reposFor.id === connector.id && state.rows.length;
    state.reposFor = connector;
    $('cnMain').hidden = true;
    $('cnReposView').hidden = false;
    $('cnReposTitle').firstChild.textContent = `${connector.name} · repositories `;
    $('cnReposHint').textContent = `Repositories the ${provider(connector.kind).label} token of ${connector.name}${connector.account ? ' (@' + connector.account.login + ')' : ''} can see.`;
    if (same) return renderRepos();
    state.rows = [];
    $('cnReposFilter').value = '';
    $('cnReposCount').textContent = '';
    $('cnReposList').innerHTML = '<div class="empty" style="padding:1rem"><span class="spinner"></span> Loading repositories…</div>';
    try {
      const result = await host.get('repos', { id: connector.id });
      if (state.reposFor !== connector) return;
      state.rows = result.repos;
      renderRepos();
    } catch (error) {
      if (state.reposFor === connector) $('cnReposList').innerHTML = `<div class="empty" style="padding:1rem;color:var(--red)">${esc(error.message)}</div>`;
    }
  }

  function renderRepos() {
    const query = $('cnReposFilter').value.trim().toLowerCase();
    const deploy = deployments();
    const connected = new Set((deploy?.repos() || []).map((r) => (r.source?.url || '').replace(/\.git$/, '').toLowerCase()));
    const rows = state.rows.filter((r) => !query || r.name.toLowerCase().includes(query) || (r.description || '').toLowerCase().includes(query)).slice(0, 120);
    $('cnReposCount').textContent = `${rows.length} of ${state.rows.length}`;
    $('cnReposList').innerHTML = rows.length ? rows.map((r) => `
      <div class="cn-repo">
        <div class="cn-repo-main"><b>${esc(r.name)}</b>${r.private ? '<span class="badge">private</span>' : ''}
          <span class="hint">${esc(r.defaultBranch || '')}${r.language ? ' · ' + esc(r.language) : ''}${r.pushedAt ? ' · ' + esc(ago(r.pushedAt)) : ''}</span>
          ${r.description ? `<div class="cn-repo-desc">${esc(r.description)}</div>` : ''}</div>
        ${connected.has((r.url || '').replace(/\.git$/, '').toLowerCase())
          ? '<span class="badge approved">connected</span>'
          : `<button type="button" class="primary" data-i="${state.rows.indexOf(r)}">${deploy ? 'Connect' : 'Copy clone URL'}</button>`}
      </div>`).join('') : '<div class="empty" style="padding:1rem">No repository matches.</div>';
    $('cnReposList').querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => connectRepo(state.rows[Number(b.dataset.i)])));
  }

  /** With Deployments installed this prefills its "connect a repository" form.
      Without it, the clone URL goes to the clipboard: no dependency either way. */
  async function connectRepo(repo) {
    const connector = state.reposFor;
    if (!connector) return;
    const deploy = deployments();
    if (!deploy?.prefillRepository) {
      try { await navigator.clipboard.writeText(repo.url || repo.sshUrl || ''); toast('Clone URL copied. Add Deployments to connect it directly.', 'success'); }
      catch { toast(repo.url || repo.sshUrl || '', 'info'); }
      return;
    }
    await deploy.prefillRepository({
      name: repo.name.split('/').pop(), url: repo.url || repo.sshUrl || '',
      branch: repo.defaultBranch || '', tokenRef: connector.tokenRef, secretName: connector.secretName,
    });
    toast(`Prefilled from ${connector.name}: review and save`, 'success');
  }

  /* ---- page, launcher tile and search ---- */
  host.registerPage({
    id: 'connectors', segment: 'connectors', label: 'Connectors', group: 'Infrastructure', order: 23,
    icon: host.ui.icons.connectors, title: 'Connectors',
    desc: 'GitHub and GitLab accounts: verify a token once, browse repositories and connect them.',
    enter: async (parts) => {
      drawer.classList.add('open');
      if (parts[1] !== 'repos') { showMain(); return load(); }
      if (!state.list.length) await load();
      const connector = state.list.find((c) => c.id === parts[0]);
      if (!connector) { toast('That connector no longer exists', 'warning'); return host.navigate('#/connectors', { replace: true }); }
      return showRepos(connector);
    },
    leave: () => { drawer.classList.remove('open'); showMain(); },
    focus: () => ($('cnReposView').hidden ? $('cnMain') : $('cnReposView')).querySelector('h2'),
  });

  host.registerLauncherTile({
    id: 'connectors', name: 'Connectors', route: '#/connectors', tag: 'Infrastructure', accent: '--purple', order: 23,
    icon: host.ui.icons.connectors,
    desc: 'GitHub and GitLab accounts: verify a token once, browse repositories and connect them.',
    launch: () => host.navigate('#/connectors'),
  });

  host.registerTourStep({
    id: 'connectors', order: 25, element: '#connectorsDrawer .view-head', route: '#/connectors', title: 'Connectors',
    intro: 'Connect a GitHub or GitLab account once with a personal access token. The token goes into the encrypted vault and is verified against the provider; from then on you pick repositories from a list instead of pasting URLs.',
  });

  host.registerSearchSource({
    key: 'connectors', prefixes: ['connectors', 'connector', 'github', 'gitlab'], label: 'Connectors', icon: 'connectors',
    tip: 'Search GitHub and GitLab accounts',
    fetch: () => host.get('list').then((d) => d.connectors || []),
    map: (c) => ({ title: c.name, sub: `${c.kind}${c.account?.login ? ' · @' + c.account.login : ''} · ${c.status === 'ok' ? 'verified' : c.status}`, action: { k: 'connector', id: c.id, ok: c.status === 'ok' } }),
    run: (action) => host.navigate(action.ok ? `#/connectors/${action.id}/repos` : '#/connectors'),
  });

  /* ---- wiring ---- */
  host.observe(host.shell.watchPage(drawer, 'connectors'));
  host.on($('btnCnAdd'), 'click', () => openModal(null));
  host.on($('btnCnRefresh'), 'click', () => load());
  host.on($('btnCnClose'), 'click', () => drawer.classList.remove('open'));
  host.on($('cnReposFilter'), 'input', renderRepos);
  host.on($('btnCnReposBack'), 'click', () => host.navigate('#/connectors'));
  host.on($('btnCnReposRefresh'), 'click', () => { if (state.reposFor) { state.rows = []; showRepos(state.reposFor); } });
  host.on($('cnKindChoice'), 'click', (event) => {
    const button = event.target.closest('[data-kind]');
    if (!button || button.disabled) return;
    $('cnKindChoice').querySelectorAll('[data-kind]').forEach((x) => { const on = x === button; x.classList.toggle('on', on); x.setAttribute('aria-checked', String(on)); });
    syncModal();
  });
  host.on($('cnName'), 'input', () => { $('cnName').dataset.touched = '1'; });
  host.on($('btnCnCancel'), 'click', () => $('cnModal').close());
  host.on($('cnModal'), 'close', () => { delete $('cnName').dataset.touched; });
  host.on($('cnForm'), 'submit', async (event) => {
    event.preventDefault();
    const kind = $('cnKindChoice').querySelector('[aria-checked="true"]')?.dataset.kind;
    const body = {
      id: state.editing?.id, kind, name: $('cnName').value.trim(),
      baseUrl: $('cnBase').value.trim() || undefined,
      token: $('cnToken').value.trim() || undefined,
      tokenRef: !$('cnToken').value.trim() && $('cnTokenRef').value ? $('cnTokenRef').value : undefined,
    };
    if (!state.editing && !body.token && !body.tokenRef) {
      $('cnErr').textContent = 'Paste a personal access token, or pick a secret that already holds one.';
      $('cnErr').hidden = false; $('cnToken').focus();
      return;
    }
    $('cnErr').hidden = true;
    $('btnCnSave').disabled = true;
    $('btnCnSave').textContent = 'Verifying…';
    try {
      const result = await host.rpc('save', body);
      $('cnModal').close();
      toast(result.status === 'ok' ? `${result.name}: verified as @${result.account.login}` : `${result.name} saved, but verification failed: ${result.error}`, result.status === 'ok' ? 'success' : 'warning');
      await load();
      deployments()?.reload?.();   // the new vault secret becomes selectable there
    } catch (error) { $('cnErr').textContent = error.message; $('cnErr').hidden = false; }
    finally { $('btnCnSave').disabled = false; $('btnCnSave').textContent = 'Save & verify'; }
  });

  /* What other modules may use. Deployments consumes this; nothing else can. */
  host.provide({
    list: () => state.list.slice(),
    reload: () => load(),
    secretFor: (id) => state.list.find((c) => c.id === id)?.tokenRef || null,
  });
}

export async function deactivate() {
  state.list = []; state.rows = []; state.secrets = []; state.editing = null; state.reposFor = null;
  scope = null;
}
