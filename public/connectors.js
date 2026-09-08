/* Connectors: GitHub / GitLab accounts (personal access tokens in the vault). A connector is verified
   against the provider, lists the repositories it can see and hands one over to "connect a repository"
   with the matching token reference. Loaded after deploy.js (uses dp, dpOpenRepoModal, loadDeploy). */
'use strict';

const cn = { list: [], providers: [], editing: null, reposFor: null, rows: [] };
const CN_LOGO = {
  github: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5A11.5 11.5 0 0 0 .5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.2.8-.6v-2.1c-3.2.7-3.9-1.4-3.9-1.4-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A11.5 11.5 0 0 0 23.5 12 11.5 11.5 0 0 0 12 .5z"/></svg>',
  gitlab: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M22.7 13.5 21.5 9.8l-2.4-7.4a.6.6 0 0 0-1.1 0L15.6 9.8H8.4L6 2.4a.6.6 0 0 0-1.1 0L2.5 9.8l-1.2 3.7a1.2 1.2 0 0 0 .4 1.3L12 22.3l10.3-7.5a1.2 1.2 0 0 0 .4-1.3z"/></svg>',
};
const cnProvider = (kind) => cn.providers.find((p) => p.id === kind) || { label: kind };

function openConnectors() { $('connectorsDrawer').classList.add('open'); return loadConnectors(); }
const closeConnectors = () => $('connectorsDrawer').classList.remove('open');

async function loadConnectors() {
  const host = $('connectorsList');
  try { const d = await api('/api/connectors'); cn.list = d.connectors; cn.providers = d.providers; }
  catch (e) { host.innerHTML = `<div class="empty" style="padding:1rem;color:var(--red)">${esc(e.message)}</div>`; return; }
  $('connectorsCount').textContent = cn.list.length ? `- ${cn.list.filter((c) => c.status === 'ok').length}/${cn.list.length} verified` : '';
  if (!cn.list.length) {
    host.innerHTML = `<div class="cn-empty"><h3>No connectors yet</h3><p>Connect your GitHub or GitLab account once with a personal access token. Server Tools keeps the token in the encrypted vault, verifies it, and lets you pick repositories to deploy without pasting URLs.</p><div class="cn-empty-actions">${cn.providers.map((p) => `<button type="button" class="primary" data-cn-add="${esc(p.id)}"><span class="cn-logo">${CN_LOGO[p.id] || ''}</span> Connect ${esc(p.label)}</button>`).join('')}</div></div>`;
    host.querySelectorAll('[data-cn-add]').forEach((b) => b.addEventListener('click', () => cnOpenModal(null, b.dataset.cnAdd)));
    return;
  }
  host.innerHTML = cn.list.map((c) => `
    <article class="cn-card ${esc(c.status)}" data-id="${esc(c.id)}">
      <div class="cn-card-head">
        <span class="cn-logo ${esc(c.kind)}">${CN_LOGO[c.kind] || ''}</span>
        <div class="cn-id"><div class="cn-name">${esc(c.name)}</div><div class="cn-sub">${esc(cnProvider(c.kind).label)}${c.baseUrl && !/api\.github\.com|gitlab\.com$/.test(c.baseUrl) ? ` · ${esc(c.baseUrl.replace(/^https?:\/\//, ''))}` : ''}</div></div>
        <span class="badge ${c.status === 'ok' ? 'approved' : c.status === 'error' ? 'failed' : 'plan'}">${c.status === 'ok' ? 'verified' : c.status === 'error' ? 'error' : 'unverified'}</span>
      </div>
      ${c.status === 'ok' && c.account ? `<div class="cn-account">${c.account.avatar ? `<img src="${esc(c.account.avatar)}" alt="" width="28" height="28">` : ''}<div><b>${esc(c.account.name || c.account.login)}</b> <span class="hint">@${esc(c.account.login)}</span>${c.account.scopes?.length ? `<div class="cn-scopes">${c.account.scopes.map((s) => `<span class="chip">${esc(s)}</span>`).join('')}</div>` : ''}</div></div>` : c.status === 'error' ? `<div class="cn-error">${esc(c.error || 'verification failed')}</div>` : ''}
      <div class="cn-meta"><span class="hint">secret <code>${esc(c.secretName)}</code></span>${c.verifiedAt ? `<span class="hint">checked ${esc(dpFmtAgo(c.verifiedAt))}</span>` : ''}</div>
      <div class="cn-actions">
        <button type="button" class="primary" data-act="repos" ${c.status === 'ok' ? '' : 'disabled'}>Browse repositories</button>
        <button type="button" data-act="verify">Verify</button>
        <button type="button" data-act="edit" title="Rename, change the base URL or replace the token">Edit</button>
        <button type="button" class="iconbtn danger" data-act="remove" title="Remove connector"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg></button>
      </div>
    </article>`).join('');
  host.querySelectorAll('.cn-card [data-act]').forEach((b) => b.addEventListener('click', () => cnAction(b.closest('.cn-card').dataset.id, b.dataset.act, b)));
}
async function cnAction(id, act, btn) {
  const c = cn.list.find((x) => x.id === id); if (!c) return;
  try {
    if (act === 'verify') { btn.disabled = true; const r = await api(`/api/connectors/${id}/verify`, { method: 'POST' }); toast(r.status === 'ok' ? `Verified as @${r.account.login}` : r.error, r.status === 'ok' ? 'success' : 'error'); await loadConnectors(); }
    else if (act === 'edit') cnOpenModal(c);
    else if (act === 'repos') await cnOpenRepos(c);
    else if (act === 'remove') {
      const ok = await confirmDialog({ title: `Remove ${c.name}`, message: `Remove the <b>${esc(c.name)}</b> connector? Repositories already connected keep working: they reference the vault secret <code>${esc(c.secretName)}</code>, which stays in the vault.`, okLabel: 'Remove', okClass: 'reject' });
      if (!ok) return;
      await api(`/api/connectors/${id}`, { method: 'DELETE' }); toast('Connector removed', 'success'); await loadConnectors();
    }
  } catch (e) { toast(e.message, 'error'); if (btn) btn.disabled = false; }
}

/* ---- add / edit ---- */
function cnOpenModal(c, kind) {
  cn.editing = c || null;
  const k = c?.kind || kind || 'github';
  $('cnModalTitle').textContent = c ? `Edit ${c.name}` : 'Connect an account';
  $('cnKindChoice').querySelectorAll('[data-kind]').forEach((b) => { const on = b.dataset.kind === k; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); b.disabled = !!c; });
  $('cnName').value = c?.name || ''; $('cnBase').value = c && !/api\.github\.com|^https:\/\/gitlab\.com$/.test(c.baseUrl) ? c.baseUrl.replace(/\/api\/v3$/, '') : ''; $('cnToken').value = '';
  const secretOpts = (dp.secrets || []).map((s) => ({ value: `\${vault:${s.name}}`, label: s.name }));
  dpFillSelect($('cnTokenRef'), secretOpts, c?.tokenRef || '', secretOpts.length ? 'Use an existing vault secret…' : 'no secrets in the vault yet');
  $('cnTokenHelp').textContent = c ? 'Leave the token empty to keep the current one.' : '';
  cnSyncModal();
  $('cnModal').showModal();
  setTimeout(() => $(c ? 'cnName' : 'cnToken').focus(), 30);
}
function cnSyncModal() {
  const k = $('cnKindChoice').querySelector('[aria-checked="true"]')?.dataset.kind || 'github';
  const p = cnProvider(k);
  $('cnBaseWrap').hidden = k !== 'gitlab' && k !== 'github';
  $('cnBase').placeholder = k === 'gitlab' ? 'https://gitlab.com (or your self-managed instance)' : 'https://api.github.com (or GitHub Enterprise: https://ghe.example.com)';
  $('cnScopeHint').textContent = p.tokenHint || '';
  if (!cn.editing && !$('cnName').dataset.touched) $('cnName').value = p.label || '';
}
$('cnKindChoice').addEventListener('click', (e) => { const b = e.target.closest('[data-kind]'); if (!b || b.disabled) return; $('cnKindChoice').querySelectorAll('[data-kind]').forEach((x) => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-checked', String(on)); }); cnSyncModal(); });
$('cnName').addEventListener('input', () => { $('cnName').dataset.touched = '1'; });
$('btnCnCancel').addEventListener('click', () => $('cnModal').close());
$('cnModal').addEventListener('close', () => { delete $('cnName').dataset.touched; });
$('cnForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const kind = $('cnKindChoice').querySelector('[aria-checked="true"]')?.dataset.kind;
  const body = { kind, name: $('cnName').value.trim(), baseUrl: $('cnBase').value.trim() || undefined, token: $('cnToken').value.trim() || undefined, tokenRef: !$('cnToken').value.trim() && $('cnTokenRef').value ? $('cnTokenRef').value : undefined };
  if (!cn.editing && !body.token && !body.tokenRef) { $('cnErr').textContent = 'Paste a personal access token, or pick a secret that already holds one.'; $('cnErr').hidden = false; $('cnToken').focus(); return; }
  $('cnErr').hidden = true; $('btnCnSave').disabled = true; $('btnCnSave').textContent = 'Verifying…';
  try {
    const r = await api(cn.editing ? `/api/connectors/${cn.editing.id}` : '/api/connectors', { method: cn.editing ? 'PUT' : 'POST', body: JSON.stringify(body) });
    $('cnModal').close();
    toast(r.status === 'ok' ? `${r.name}: verified as @${r.account.login}` : `${r.name} saved, but verification failed: ${r.error}`, r.status === 'ok' ? 'success' : 'warning');
    await loadConnectors();
    if (typeof loadDeploy === 'function') loadDeploy().catch(() => {}); // the new vault secret becomes selectable in deploy forms
  } catch (err) { $('cnErr').textContent = err.message; $('cnErr').hidden = false; }
  finally { $('btnCnSave').disabled = false; $('btnCnSave').textContent = 'Save & verify'; }
});

/* ---- repositories of a connector → connect one ---- */
async function cnOpenRepos(c) {
  cn.reposFor = c; cn.rows = [];
  $('cnReposTitle').textContent = `${c.name} · repositories`;
  $('cnReposList').innerHTML = '<div class="empty" style="padding:1rem"><span class="spinner"></span> Loading repositories…</div>';
  $('cnReposFilter').value = '';
  $('cnReposModal').showModal();
  try { const r = await api(`/api/connectors/${c.id}/repos`); cn.rows = r.repos; cnRenderRepos(); }
  catch (e) { $('cnReposList').innerHTML = `<div class="empty" style="padding:1rem;color:var(--red)">${esc(e.message)}</div>`; }
}
function cnRenderRepos() {
  const q = $('cnReposFilter').value.trim().toLowerCase();
  const connected = new Set((dp.repos || []).map((r) => (r.source.url || '').replace(/\.git$/, '').toLowerCase()));
  const rows = cn.rows.filter((r) => !q || r.name.toLowerCase().includes(q) || (r.description || '').toLowerCase().includes(q)).slice(0, 120);
  $('cnReposCount').textContent = `${rows.length} of ${cn.rows.length}`;
  $('cnReposList').innerHTML = rows.length ? rows.map((r, i) => `<div class="cn-repo"><div class="cn-repo-main"><b>${esc(r.name)}</b>${r.private ? '<span class="badge">private</span>' : ''}<span class="hint">${esc(r.defaultBranch || '')}${r.language ? ' · ' + esc(r.language) : ''}${r.pushedAt ? ' · ' + esc(dpFmtAgo(r.pushedAt)) : ''}</span>${r.description ? `<div class="cn-repo-desc">${esc(r.description)}</div>` : ''}</div>${connected.has((r.url || '').replace(/\.git$/, '').toLowerCase()) ? '<span class="badge approved">connected</span>' : `<button type="button" class="primary" data-i="${cn.rows.indexOf(r)}">Connect</button>`}</div>`).join('') : '<div class="empty" style="padding:1rem">No repository matches.</div>';
  $('cnReposList').querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => cnConnectRepo(cn.rows[Number(b.dataset.i)])));
}
$('cnReposFilter').addEventListener('input', cnRenderRepos);
$('btnCnReposClose').addEventListener('click', () => $('cnReposModal').close());
async function cnConnectRepo(r) {
  const c = cn.reposFor; if (!c) return;
  $('cnReposModal').close();
  if (typeof loadDeploy === 'function' && !dp.loaded) await loadDeploy();
  dpOpenRepoModal(null);
  $('drName').value = r.name.split('/').pop(); $('drKind').value = 'git'; $('drUrl').value = r.url || r.sshUrl || ''; $('drBranch').value = r.defaultBranch || '';
  $('drAuth').value = r.private ? 'https-token' : 'https-token'; // the connector's token also raises API rate limits for public repos
  if (![...$('drTokenRef').options].some((o) => o.value === c.tokenRef)) $('drTokenRef').add(new Option(c.secretName, c.tokenRef));
  $('drTokenRef').value = c.tokenRef;
  dpRepoSync();
  toast(`Prefilled from ${c.name}: review and save`, 'success');
}

$('btnCnAdd').addEventListener('click', () => cnOpenModal(null));
$('btnCnRefresh').addEventListener('click', loadConnectors);
