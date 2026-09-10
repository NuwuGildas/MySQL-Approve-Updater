/* The Ascension (build → deploy → ship) module UI. Loaded after app.js and
   relies on its globals: $, esc, api, toast, confirmDialog, showSettings,
   showSettingsSection. Talks to /api/deploy/*. */
'use strict';

const dp = {
  status: null, repos: [], targets: [], secrets: [], profiles: [], projects: [],
  sel: null, tab: 'overview', runs: new Map(), logRun: null, logCursor: 0,
  det: null, detRepo: null, plan: null, probe: null, releases: null, setup: null, editingRepo: null, editingTarget: null, loaded: false,
  servers: [], cloudJob: null, cloudMeta: null, templates: [],
};
const dpPrefAi = () => { try { return localStorage.getItem('st-deploy-ai') !== '0'; } catch { return true; } };
const dpFmtAgo = (iso) => { if (!iso) return ''; const s = Math.round((Date.now() - Date.parse(iso)) / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; };
const dpFmtMs = (ms) => (ms == null ? '' : ms < 1000 ? `${ms} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);
const dpBadge = (status) => `<span class="badge ${esc(status)}">${esc(String(status).replace('_', ' '))}</span>`;
const dpTarget = () => dp.targets.find((t) => t.id === dp.sel) || null;
const dpProjects = () => typeof projects !== 'undefined' && projects.length ? projects : dp.projects;
const dpProjectName = (id) => dpProjects().find((p) => p.id === id)?.name || id || 'Project unavailable';
function dpFillProjectSelect(id, selected) {
  const fill = (list) => {
    const preferred = selected || (typeof currentProjectId === 'string' ? currentProjectId : 'general');
    dpFillSelect($(id), list.map((p) => ({ value: p.id, label: p.name })), preferred, list.some((p) => p.id === preferred) ? null : 'Choose a project');
  };
  const list = dpProjects();
  if (list.length) return fill(list);
  api(`/api/projects?picker=1&ts=${Date.now()}`).then((d) => { dp.projects = Array.isArray(d.projects) ? d.projects : []; fill(dp.projects); }).catch(() => {});
}
function dpValidProject(id) { return dpProjects().some((p) => p.id === id); }
const dpRepoOf = (t) => dp.repos.find((r) => r.id === t?.repoId) || null;
const dpRunsFor = (id) => [...dp.runs.values()].filter((r) => r.targetId === id).sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
const dpIsActive = (r) => r && ['queued', 'running'].includes(r.status);
const dpOpen = () => $('deployDrawer').classList.contains('open');
const dpEnvOf = (t) => { const n = (t.name || '').toLowerCase(); return /prod|live/.test(n) && !/pre.?prod/.test(n) ? 'production' : /pre.?prod|stag|uat|qa|test/.test(n) ? 'staging' : /dev|local|sandbox/.test(n) ? 'dev' : 'neutral'; };
const dpAssist = (k) => !!dp.status?.aiAssist?.[k];
// a pre-ship review is fresh when it saw the current plan (or, without a plan, the current commit)
const dpReviewFresh = (t) => { const r = t?.preShip; if (!r) return false; if (dp.plan?.hash) return r.planHash === dp.plan.hash; const c = dpRepoOf(t)?.lastFetch?.commit; return c ? r.commit === c : Date.now() - Date.parse(r.at) < 6 * 3600e3; };
const dpHostOf = (t) => (t.type === 'local' ? 'this computer' : t.type === 'paas' ? (dp.status?.paasProviders?.find((p) => p.id === t.paas?.provider)?.label || t.paas?.provider || 'platform') : (t.transport?.host || dp.profiles.find((p) => p.id === (t.ssh?.profileId || t.transport?.profileId))?.host || ''));
const dpTypeLabel = (t) => (t.type === 'vps-ssh' ? 'vps' : t.type === 'paas' ? 'platform' : t.type === 'local' ? 'local' : 'shared');
const dpInitials = (s) => (s || '?').replace(/[^A-Za-z0-9 _-]/g, '').split(/[\s_-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
const ICO = {
  test: '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 16 0 8 8 0 1 0-16 0z"/><path d="M9 12l2 2 4-4"/></svg>',
  fetch: '<svg viewBox="0 0 24 24"><circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="9" r="2.2"/><path d="M6 7.2v9.6M18 11.2c0 3.8-6 3-10 5.4"/></svg>',
  detect: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/></svg>',
  plan: '<svg viewBox="0 0 24 24"><path d="M5 4h14v16H5z"/><path d="M9 9h6M9 13h6M9 17h3"/></svg>',
  ship: '<svg viewBox="0 0 24 24"><path d="M12 20V6M6 12l6-6 6 6"/><path d="M5 20h14"/></svg>',
  verify: '<svg viewBox="0 0 24 24"><path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z"/><path d="M9 12l2 2 4-4"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
};

/* ---------- open / close / load ---------- */
async function openDeploy(targetId) {
  $('deployDrawer').classList.add('open');
  try { if (localStorage.getItem('st-deploy-compact') === '1') { $('deployDrawer').classList.add('compact'); $('btnDpCompact').textContent = '»'; } } catch {}
  await loadDeploy();
  if (targetId) dpSelect(targetId);
}
const closeDeploy = () => $('deployDrawer').classList.remove('open');

async function loadDeploy() {
  try {
    const [st, repos, targets, secrets, sessions, runs, servers, templates, projectData] = await Promise.all([
      api('/api/deploy/status'), api('/api/deploy/repos'), api('/api/deploy/targets'), api('/api/deploy/secrets'), api('/api/ssh/sessions').catch(() => ({ sessions: [] })), api('/api/deploy/runs?limit=100'), api('/api/deploy/cloud/servers').catch(() => ({ servers: [] })), api('/api/deploy/templates').catch(() => ({ templates: [] })), api('/api/projects'),
    ]);
    dp.status = st; dp.repos = repos.repos; dp.targets = targets.targets; dp.secrets = secrets.secrets; dp.profiles = sessions.sessions; dp.servers = servers.servers; dp.templates = templates.templates; dp.loaded = true;
    dp.projects = projectData.projects || [];
    if (typeof projects !== 'undefined') { projects = dp.projects; if (typeof renderProjectContext === 'function') renderProjectContext(); }
    for (const r of runs.runs) if (!dp.runs.has(r.id) || !dpIsActive(dp.runs.get(r.id))) dp.runs.set(r.id, r);
  } catch (e) { toast('Deploy load failed: ' + e.message, 'error'); return; }
  if (dp.sel && !dpTarget()) dp.sel = null;
  if (!dp.sel && dp.targets.length === 1) dp.sel = dp.targets[0].id;
  dpRenderHeader(); dpRenderNav(); dpRenderMain();
}

function dpRenderHeader() {
  const st = dp.status; if (!st) return;
  const active = [...dp.runs.values()].filter(dpIsActive).length;
  const tools = Object.entries(st.tools || {}).filter(([, v]) => v).map(([k]) => k);
  $('dpSysStatus').innerHTML = [
    active ? `<span class="asc-pill live"><span class="srv-dot" style="background:var(--accent)"></span>${active} run${active > 1 ? 's' : ''} in progress</span>` : '<span class="asc-pill"><span class="srv-dot ok"></span>idle</span>',
    `<span class="asc-pill" title="Encrypted vault · master key: ${esc(st.vault.keySource)}">${ICO.lock} vault · ${dp.secrets.length}</span>`,
    st.git.available ? '' : '<span class="asc-pill bad">git missing</span>',
    st.ai ? '<span class="asc-pill">AI linked</span>' : '',
  ].join('');
  $('dpStatus').innerHTML = `local toolchain: ${tools.length ? esc(tools.join(' · ')) : '<span style="color:var(--amber)">none found</span>'}`;
}

/* ---------- workspace navigator ---------- */
function dpRenderNav() {
  $('dpReposN').textContent = dp.repos.length || '';
  const selT = dpTarget();
  $('dpRepos').innerHTML = dp.repos.length ? dp.repos.map((r) => {
    const src = r.source.kind === 'git' ? r.source.url.replace(/^https?:\/\/|\.git$/g, '') : r.source.path;
    return `<div class="dp-item ${selT && selT.repoId === r.id ? 'on' : ''}" data-repo="${r.id}" title="${esc(src)}">
      <span class="dp-avatar">${esc(dpInitials(r.name))}</span>
      <div class="dp-item-body"><span class="dp-item-name">${esc(r.name)}</span><span class="dp-item-sub">${esc(src)}${r.lastFetch?.commit ? ' @ ' + esc(r.lastFetch.commit.slice(0, 7)) : ''}</span></div>
      ${r.manifest ? '<span class="badge" title="has a saved manifest">manifest</span>' : ''}
      <button class="dp-x dp-mini" data-repo-edit="${r.id}" title="Edit repository">✎</button></div>`;
  }).join('') : '<div class="dp-empty-sec"><b>No repository connected</b>Point The Ascension at a git URL or a local folder.<br><button class="primary" data-act="wizard">Guided setup</button> <button data-act="add-repo">Just connect</button></div>';
  $('dpTargetsN').textContent = dp.targets.length || '';
  $('dpTargets').innerHTML = dp.targets.length ? dp.targets.map((t) => {
    const last = dpRunsFor(t.id)[0] || t.lastRun;
    const dot = dpIsActive(last) ? 'on' : last?.status === 'succeeded' ? 'ok' : last && last.mode !== 'plan' ? 'bad' : '';
    const env = dpEnvOf(t);
    return `<div class="dp-item ${t.id === dp.sel ? 'on' : ''}" data-target="${t.id}" title="${esc(dpHostOf(t))}">
      <span class="srv-dot ${dot}" style="margin:0"></span>
      <div class="dp-item-body"><span class="dp-item-name">${esc(t.name)}</span><span class="dp-item-sub" title="Project: ${esc(dpProjectName(t.projectId))}">${esc(dpProjectName(t.projectId))} · ${esc(dpRepoOf(t)?.name || 'no repo')}</span><span class="dp-item-sub">${esc(dpHostOf(t) || t.type)}</span></div>
      ${t.autoShip?.enabled ? '<span class="dp-auto" title="auto-ship on ' + esc(t.autoShip.mode) + '">⚡</span>' : ''}<span class="env ${env}">${esc(env === 'neutral' ? dpTypeLabel(t) : env)}</span></div>`;
  }).join('') : `<div class="dp-empty-sec"><b>No deployment target</b>${dp.repos.length ? 'Choose where the code should land: a VPS over SSH or shared hosting.' : 'Connect a repository first, then add a VPS or shared-hosting target.'}<br><button ${dp.repos.length ? 'class="primary"' : 'disabled'} data-act="add-target">Add target</button></div>`;
  $('dpSecretsN').textContent = dp.secrets.length || '';
  $('dpSecrets').innerHTML = `<div class="dp-vault" title="deploy-secrets.enc · master key: ${esc(dp.status?.vault?.keySource || '?')}">${ICO.lock}<div class="dp-vault-body">Vault${dp.secrets.length ? '' : ' · empty'}<small>${dp.secrets.length ? `${dp.secrets.length} secret${dp.secrets.length > 1 ? 's' : ''} · AES-256-GCM` : 'tokens, FTP passwords, .env files'}</small></div></div>`
    + (dp.secrets.length ? dp.secrets.map((s) => `<div class="dp-secret" title="updated ${esc(s.updatedAt)}">\${vault:${esc(s.name)}}<button class="dp-x dp-mini" data-secret-rm="${esc(s.name)}" title="Delete secret">✕</button></div>`).join('')
      : '<div class="dp-empty-sec">Store credentials once and reference them as <code>${vault:NAME}</code>; they never reach the browser.<br><button data-act="add-secret">Add secret</button></div>');
  const live = dp.servers.filter((x) => x.status !== 'destroyed');
  $('dpServersN').textContent = live.length || '';
  $('dpServers').innerHTML = live.length ? live.map((x) => {
    const dot = x.status === 'ready' ? 'ok' : x.status === 'provisioning' ? 'on' : x.status === 'error' ? 'bad' : '';
    return `<div class="dp-item" data-server="${x.id}" title="${esc(x.provider)} · ${esc(x.region)} · ${esc(x.size)}${x.error ? ': ' + esc(x.error) : ''}">
      <span class="srv-dot ${dot}" style="margin:0"></span>
      <div class="dp-item-body"><span class="dp-item-name">${esc(x.name)}</span><span class="dp-item-sub">${esc(x.provider)} · ${esc(x.ip || x.status)}${x.targetId ? ' · target' : ''}</span></div>
      <button class="dp-x dp-mini" data-server-destroy="${x.id}" title="Destroy this server at the provider">✕</button></div>`;
  }).join('') : '<div class="dp-empty-sec">Provision a VM with a ready-made recipe (PHP, Node, Python, Docker) and deploy to it minutes later.<br><button data-act="add-cloud">Provision a server</button></div>';
}
$('deployNav').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'add-repo') return dpOpenRepoModal(null);
  if (act === 'add-target') return dpOpenTargetModal(null);
  if (act === 'add-secret') return dpOpenSecretModal();
  const edit = e.target.closest('[data-repo-edit]'); if (edit) { e.stopPropagation(); return dpOpenRepoModal(dp.repos.find((r) => r.id === edit.dataset.repoEdit)); }
  const rm = e.target.closest('[data-secret-rm]');
  if (rm) {
    const name = rm.dataset.secretRm;
    if (!(await confirmDialog({ title: 'Delete secret', message: `Delete <b>${esc(name)}</b> from the vault? Anything referencing it will fail to deploy.`, okLabel: 'Delete', okClass: 'reject' }))) return;
    try { await api(`/api/deploy/secrets/${encodeURIComponent(name)}`, { method: 'DELETE' }); toast('Secret deleted', 'success'); loadDeploy(); } catch (err) { toast(err.message, 'error'); }
    return;
  }
  if (act === 'add-cloud') return dpOpenCloudModal();
  if (act === 'wizard') return dpOpenWizard();
  const destroy = e.target.closest('[data-server-destroy]');
  if (destroy) {
    e.stopPropagation();
    const sv = dp.servers.find((x) => x.id === destroy.dataset.serverDestroy); if (!sv) return;
    if (!(await confirmDialog({ title: 'Destroy server', message: `Destroy <b>${esc(sv.name)}</b> (${esc(sv.provider)}, ${esc(sv.ip || 'no ip')}) at the provider? This deletes the VM and its data. The SSH profile and target stay and will fail until you remove them.`, okLabel: 'Destroy VM', okClass: 'reject' }))) return;
    try { await api(`/api/deploy/cloud/servers/${sv.id}`, { method: 'DELETE' }); toast('Server destroyed', 'success'); loadDeploy(); } catch (err) { toast(err.message, 'error'); }
    return;
  }
  const sv = e.target.closest('[data-server]');
  if (sv) { const x = dp.servers.find((y) => y.id === sv.dataset.server); if (x?.targetId && dp.targets.some((t) => t.id === x.targetId)) return dpSelect(x.targetId); return dpShowServer(x); }
  const t = e.target.closest('[data-target]'); if (t) return dpSelect(t.dataset.target);
  const r = e.target.closest('[data-repo]');
  if (r) { const first = dp.targets.find((x) => x.repoId === r.dataset.repo); if (first) dpSelect(first.id); else { dp.sel = null; dpRenderNav(); dpRenderMain(r.dataset.repo); } }
});
$('btnDpCompact').addEventListener('click', () => { const c = $('deployDrawer').classList.toggle('compact'); $('btnDpCompact').textContent = c ? '»' : '«'; try { localStorage.setItem('st-deploy-compact', c ? '1' : '0'); } catch {} });

/* ---------- main pane ---------- */
function dpSelect(id) {
  dp.sel = id; dp.det = null; dp.probe = null; dp.releases = null; dp.setup = null;
  const runs = dpRunsFor(id);
  dp.plan = runs.find((r) => r.plan && r.mode === 'plan' && r.status === 'succeeded')?.plan || null;
  dp.logRun = runs[0]?.id || null; dp.logCursor = 0;
  dpRenderNav(); dpRenderMain();
  if (dp.logRun) dpLoadLog(dp.logRun);
}
function dpShowTab(tab) {
  dp.tab = tab;
  $('dpTabs').querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  document.querySelectorAll('#dpTarget .dp-tab').forEach((s) => s.classList.toggle('on', s.dataset.tab === tab));
  dpRenderTab();
}
$('dpTabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) dpShowTab(b.dataset.tab); });

function dpRenderMain(repoFocus) {
  const t = dpTarget();
  $('dpEmpty').hidden = !!t; $('dpTarget').hidden = !t;
  if (!t) { dpRenderEmpty(repoFocus); return; }
  dpRenderContext(t); dpRenderPipeline(t); dpRenderCards(t);
  dpShowTab(dp.tab);
}

/* ---------- empty state: begin your ascension ---------- */
function dpRenderEmpty(repoFocus) {
  const hasRepo = dp.repos.length > 0, hasTarget = dp.targets.length > 0, hasSecret = dp.secrets.length > 0;
  const repo = repoFocus ? dp.repos.find((r) => r.id === repoFocus) : null;
  const steps = [
    ['test', 'Test', 'Connect to the server and probe its toolchain.'], ['fetch', 'Fetch', 'Check out the branch, tag or commit to deploy.'], ['detect', 'Detect', 'Recognise the stack and resolve the manifest.'],
    ['plan', 'Plan', 'Preview every command: a read-only dry run.'], ['ship', 'Ship', 'Build, upload, atomic release swap, reload.'], ['verify', 'Verify', 'Health check; automatic rollback on failure.'],
  ];
  const title = repo ? `${repo.name} is connected` : hasRepo && !hasTarget ? 'Choose a destination' : hasRepo ? 'Pick a target to continue' : 'Begin Your Ascension';
  const text = repo ? 'Add a deployment target for this repository: a VPS reached over SSH, or a shared host over SFTP/FTP.'
    : hasRepo && !hasTarget ? 'Your code is connected. Add a target so The Ascension knows where releases should land.'
    : hasRepo ? 'Select a target in the sidebar to see its pipeline, status and history.'
    : 'Connect a repository and choose a deployment target to begin the journey from code to production.';
  const cta = repo || (hasRepo && !hasTarget) ? '<button class="primary" data-act="wizard">Guided setup</button> <button data-act="add-target">Add target manually</button>' : hasRepo ? '<button data-act="wizard">Set up another deployment</button>' : '<button class="primary" data-act="wizard">Start guided setup</button> <button data-act="add-repo">Connect repository only</button>';
  $('dpEmpty').innerHTML = `
    <div class="asc-hero">
      <div class="asc-hero-kicker">${hasRepo ? 'The Ascension' : 'From code to production'}</div>
      <h3>${esc(title)}</h3>
      <p>${esc(text)}</p>
      <div class="cta">${cta}</div>
    </div>
    <div class="asc-journey">
      <div class="asc-journey-title">The journey</div>
      <div class="asc-steps">${steps.map(([k, n, d]) => `<div class="asc-step"><div class="asc-step-dot">${ICO[k]}</div><div class="asc-step-name">${n}</div><div class="asc-step-desc">${d}</div></div>`).join('')}</div>
    </div>
    <div class="asc-need">
      <div class="asc-need-card ${hasRepo ? 'done' : ''}"><span class="n">${hasRepo ? '✓' : '1'}</span><b>Repository</b><p>Git over HTTPS or SSH, or a local folder. The stack (Laravel, Node, static…) is detected from the checkout.</p>${hasRepo ? '' : '<button data-act="add-repo">Connect</button>'}</div>
      <div class="asc-need-card ${hasTarget ? 'done' : ''}"><span class="n">${hasTarget ? '✓' : '2'}</span><b>Target</b><p>VPS over SSH with atomic releases and rollback, or shared hosting over SFTP/FTP with an in-place swap.</p>${hasTarget || !hasRepo ? '' : '<button data-act="add-target">Add target</button>'}</div>
      <div class="asc-need-card ${hasSecret ? 'done' : ''}"><span class="n">${hasSecret ? '✓' : '3'}</span><b>Secrets</b><p>Optional. FTP passwords, git tokens and production .env files live encrypted in the vault.</p>${hasSecret ? '' : '<button data-act="add-secret">Add secret</button>'}</div>
    </div>`;
}
$('dpEmpty').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'add-repo') dpOpenRepoModal(null); else if (act === 'add-target') dpOpenTargetModal(null); else if (act === 'add-secret') dpOpenSecretModal(); else if (act === 'add-cloud') dpOpenCloudModal(); else if (act === 'wizard') dpOpenWizard();
});

/* ---------- guided setup wizard ---------- */
const wz = { step: 1, source: 'git', dest: 'vps-ssh', transport: 'ftps', pendingRepoId: null, fw: null, fwGroup: 'all', detected: null, build: 'auto', catalog: null, detCache: new Map() };
function dpOpenWizard(repoId) {
  dpFillProjectSelect('wzProject');
  wz.step = 1; wz.source = repoId ? 'existing' : 'git'; wz.dest = dp.profiles.length ? 'vps-ssh' : 'shared-hosting'; wz.transport = 'ftps'; wz.pendingRepoId = repoId || null;
  for (const id of ['wzUrl', 'wzBranch', 'wzToken', 'wzKeyPath', 'wzPath', 'wzRepoName', 'wzTargetName', 'wzHealth', 'wzRoot', 'wzFtpHost', 'wzFtpUser', 'wzHome', 'wzDocroot', 'wzLocalRoot', 'wzLocalReload']) $(id).value = '';
  $('wzLocalProc').value = 'none'; delete $('wzLocalRoot').dataset.touched;
  $('wzAuth').value = 'none'; $('wzEnv').value = 'production'; $('wzWeb').value = 'nginx'; $('wzTransport').value = 'ftps'; $('wzAuto').checked = false; $('wzPlanNow').checked = true;
  wz.fw = null; wz.detected = null; wz.build = 'auto'; wz.fwGroup = 'all'; wzAiButtonState(); for (const id of ['fwInstall', 'fwBuild', 'fwStart', 'fwPort', 'fwOut', 'fwDocroot', 'fwHealth', 'wzDomain', 'wzSslEmail']) $(id).value = ''; $('wzSsl').checked = true; $('btnFwDetected').hidden = true; $('fwDetectHint').textContent = '';
  $('wzBuildSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === 'auto'));
  delete $('wzTargetName').dataset.touched; delete $('wzRoot').dataset.touched;
  dpFillSelect($('wzRepo'), dp.repos.map((r) => ({ value: r.id, label: r.name })), repoId || dp.repos[0]?.id, dp.repos.length ? null : 'no repositories yet');
  const profs = dp.profiles.map((p) => ({ value: p.id, label: `${p.name} (${p.user}@${p.host})` }));
  dpFillSelect($('wzProfile'), profs, null, profs.length ? 'choose a server' : 'no SSH servers yet');
  dpFillSelect($('wzSftpProfile'), profs, null, profs.length ? 'choose a server' : 'no SSH servers yet');
  const provs = dp.status?.paasProviders || [];
  dpFillSelect($('wzPaas'), provs.map((p) => ({ value: p.id, label: p.label })), 'vercel');
  wzSync(); wzShow(1); $('dpWizard').showModal();
}
function wzSync() {
  $('wzSourceKind').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === wz.source));
  $('dpWizard').querySelectorAll('[data-wz]').forEach((d) => { d.hidden = d.dataset.wz !== wz.source; });
  $('dpWizard').querySelectorAll('[data-wzauth]').forEach((d) => { d.hidden = d.dataset.wzauth !== $('wzAuth').value; });
  $('wzDestKind').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === wz.dest));
  $('dpWizard').querySelectorAll('[data-wzd]').forEach((d) => { d.hidden = d.dataset.wzd !== wz.dest; });
  $('dpWizard').querySelectorAll('[data-wzt]').forEach((d) => { d.hidden = (d.dataset.wzt === 'sftp') !== ($('wzTransport').value === 'sftp'); });
  const p = (dp.status?.paasProviders || []).find((x) => x.id === $('wzPaas').value);
  $('wzPaasHint').textContent = p ? `${p.tokenHint}. Needs the ${p.cli} CLI on this machine.` : '';
  if (p && $('wzPaasFields').dataset.for !== p.id) { $('wzPaasFields').dataset.for = p.id; $('wzPaasFields').innerHTML = p.fields.map((f) => `<label for="wzPaas-${esc(f.key)}">${esc(f.label)}${f.required || /optional/i.test(f.label) ? '' : ' <span class="hint">(optional)</span>'}</label><input id="wzPaas-${esc(f.key)}" data-wz-paas="${esc(f.key)}" placeholder="${esc(f.placeholder || '')}">`).join(''); }
  // smart names
  const repoName = wzRepoName();
  if (repoName && !$('wzTargetName').dataset.touched) $('wzTargetName').value = `${repoName}-${$('wzEnv').value === 'staging' ? 'staging' : $('wzEnv').value === 'dev' ? 'dev' : 'prod'}`;
  if (!$('wzRoot').dataset.touched) $('wzRoot').value = `/var/www/${($('wzTargetName').value || repoName || 'app').toLowerCase().replace(/[^a-z0-9_.-]+/g, '-')}`;
  if (!$('wzLocalRoot').dataset.touched) $('wzLocalRoot').value = dpLocalDefaultRoot($('wzTargetName').value || repoName || 'app');
  $('wzHealth').placeholder = wz.dest === 'local' ? 'http://localhost:8080/' : 'https://shop.example.com/';
  if (!$('wzHome').value && $('wzTransport').value !== 'sftp') $('wzHome').value = '/';
  if (!$('wzDocroot').value) $('wzDocroot').value = $('wzTransport').value === 'sftp' ? '' : '/public_html';
}
/** Default folder for a "This computer" target: <home>/www/<slug> with the platform's separator. */
function dpLocalDefaultRoot(name) {
  const home = dp.status?.home || ''; const sep = dp.status?.sep || '/';
  const slug = String(name || 'app').toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-|-$/g, '') || 'app';
  return home ? [home, 'www', slug].join(sep) : '';
}
const isAbsLocal = (p) => /^([A-Za-z]:[\\/]|\/|~[\\/]|\\\\)/.test(p);
function wzRepoName() {
  if (wz.source === 'existing') return dp.repos.find((r) => r.id === $('wzRepo').value)?.name || '';
  if ($('wzRepoName').value.trim()) return $('wzRepoName').value.trim();
  const u = wz.source === 'git' ? $('wzUrl').value.trim() : $('wzPath').value.trim();
  const base = u.replace(/[\/\\]+$/, '').split(/[\/\\:]/).pop() || '';
  return base.replace(/\.git$/, '');
}
function wzShow(step) {
  wz.step = step;
  $('dpWizard').querySelectorAll('.wz-steps li').forEach((li) => { const n = Number(li.dataset.step); li.classList.toggle('on', n === step); li.classList.toggle('done', n < step); });
  $('dpWizard').querySelectorAll('.wz-step').forEach((sec) => sec.classList.toggle('on', Number(sec.dataset.step) === step));
  $('btnWzBack').hidden = step === 1; $('btnWzNext').hidden = step === 5; $('btnWzFinish').hidden = step !== 5;
  const cur = $('dpWizard').querySelector(`.wz-steps li[data-step="${step}"]`);
  $('wzStepNum').textContent = `Step ${step} of 5 · ${cur ? cur.textContent : ''}`;
  if (step === 2) wzEnterFramework();
  if (step === 4) wzRenderSecrets();
  if (step === 5) wzRenderReview();
}
/* ---- framework step ---- */
const FW_COLORS = { nextjs: '#111', nuxt: '#00dc82', sveltekit: '#ff3e00', remix: '#3992ff', 'astro-ssr': '#ff5d01', laravel: '#ff2d20', symfony: '#1a171b', django: '#0c4b33', express: '#3c873a', nestjs: '#e0234e', fastapi: '#009688', flask: '#3b3b3b', php: '#777bb3', 'docker-compose': '#2496ed', dockerfile: '#2496ed', vite: '#646cff', cra: '#61dafb', angular: '#dd0031', astro: '#ff5d01', eleventy: '#222', html: '#e34c26' };
const FW_MARK = { nextjs: 'N', nuxt: 'Nx', sveltekit: 'S', remix: 'R', 'astro-ssr': 'A', laravel: 'L', symfony: 'Sf', django: 'dj', express: 'ex', nestjs: 'Ne', fastapi: 'F', flask: 'Fl', php: 'php', 'docker-compose': '⧉', dockerfile: '🐳', vite: 'V', cra: '⚛', angular: 'A', astro: 'A', eleventy: '11', html: '<>' };
async function wzEnterFramework() {
  if (!wz.catalog) { try { wz.catalog = await api('/api/deploy/frameworks'); } catch (e) { toast(e.message, 'error'); return; } }
  // detection: local folders and connected repos with a checkout can be inspected now; git URLs are detected on the first Plan
  let dir = null;
  if (wz.source === 'local') dir = $('wzPath').value.trim();
  const existing = wz.source === 'existing' ? dp.repos.find((r) => r.id === $('wzRepo').value) : null;
  if (existing?.source.kind === 'local') dir = existing.source.path;
  if (dir && wz.detected?.dir !== dir) {
    $('fwDetectHint').textContent = 'detecting…';
    try {
      const det = await api('/api/deploy/detect-path', { method: 'POST', body: JSON.stringify({ path: dir }) });
      wz.detected = { dir, ...det };
      if (det.catalogId) { $('btnFwDetected').hidden = false; $('fwDetectHint').textContent = det.ambiguous ? `${det.reason}: pick a framework` : `${det.best?.label || ''} detected from ${(det.best?.evidence || []).join(', ')}`; if (!wz.fw) wzPickFramework(det.catalogId, det.form); }
      else $('fwDetectHint').textContent = det.reason || 'no framework detected: pick one';
    } catch (e) { $('fwDetectHint').textContent = e.message; }
  } else if (!dir && !wz.detected) $('fwDetectHint').textContent = wz.source === 'git' ? (dp.status?.ai ? 'pick the framework, or let AI detect it from the repository' : 'detection runs on the first Plan: pick the framework now or leave it to detection') : '';
  wzAiButtonState();
  wzRenderFw();
}
function wzAiButtonState(busy) {
  const btn = $('btnFwAi'); const on = !!dp.status?.ai;
  btn.disabled = busy || !on; btn.classList.toggle('busy', !!busy); if (busy) btn.setAttribute('aria-busy', 'true'); else btn.removeAttribute('aria-busy');
  btn.title = on ? 'Read the repository, detect the framework and fill in the deploy configuration' : 'Connect the AI assistant (Settings → AI assistant) to detect from the repository';
}
/** "AI detect": the server clones/reads the source, runs heuristics, asks the AI to confirm and refine, and the form is filled from the answer. */
/** Cache key of the wizard's current source (what "AI detect" would inspect). */
function wzSourceKey() {
  if (wz.source === 'existing') return $('wzRepo').value ? 'repo:' + $('wzRepo').value : null;
  if (wz.source === 'local') return $('wzPath').value.trim() ? 'local:' + $('wzPath').value.trim() : null;
  return $('wzUrl').value.trim() ? 'git:' + $('wzUrl').value.trim() + '#' + ($('wzBranch').value.trim() || '') : null;
}
function wzApplyDetection(det, note) {
  wz.detected = det;
  if (!det.catalogId) { $('fwDetectHint').textContent = det.reason || 'nothing recognised: pick a framework'; return; }
  wzPickFramework(det.catalogId, det.form); $('btnFwDetected').hidden = false;
  const lbl = wz.catalog?.frameworks.find((c) => c.id === det.catalogId)?.label || det.catalogId;
  $('fwDetectHint').textContent = (det.by === 'ai'
    ? `AI: ${lbl}${det.confidence != null ? ` (${Math.round(det.confidence * 100)}% confident)` : ''}${det.reasoning ? ' · ' + det.reasoning : ''} · deploy configuration filled in`
    : `${lbl} detected from ${(det.best?.evidence || []).join(', ')}${det.aiFailed ? ' · the AI gave no usable answer, heuristics applied' : ''}`) + (note ? ' · ' + note : '');
  $('fwDetectHint').title = det.reasoning || '';
  return lbl;
}
async function wzAiDetect(ev) {
  const body = { ai: true, force: !!(ev && ev.shiftKey) };
  const key = wzSourceKey();
  const reuse = key && !body.force && (wz.detected?.key === key && wz.detected.by ? wz.detected : wz.detCache.get(key));
  if (reuse) { const lbl = wzApplyDetection(reuse, 'reused from the earlier detection (shift-click to run it again)'); toast(lbl ? `${lbl}: earlier detection reused` : 'Earlier detection reused', 'success'); return; }
  if (wz.source === 'existing') { body.repoId = $('wzRepo').value; if (!body.repoId) return toast('Pick a repository first', 'warning'); }
  else if (wz.source === 'local') { const p = $('wzPath').value.trim(); if (!p) { wzShow(1); $('wzPath').focus(); return toast('Enter the folder path first', 'warning'); } body.source = { kind: 'local', path: p }; }
  else {
    const url = $('wzUrl').value.trim(); if (!url) { wzShow(1); $('wzUrl').focus(); return toast('Enter the repository URL first', 'warning'); }
    const a = $('wzAuth').value;
    body.source = { kind: 'git', url, branch: $('wzBranch').value.trim() || null, auth: a === 'token' ? { kind: 'https-token', token: $('wzToken').value } : a === 'ssh' ? { kind: 'ssh', keyPath: $('wzKeyPath').value.trim() || null } : null };
  }
  wzAiButtonState(true);
  $('fwDetectHint').title = ''; $('fwDetectHint').innerHTML = `<span class="spinner"></span> ${body.source?.kind === 'git' ? 'cloning the repository and asking the AI…' : 'reading the project and asking the AI…'}`;
  try {
    const det = await api('/api/deploy/detect-source', { method: 'POST', body: JSON.stringify(body) });
    const rec = { key, dir: 'ai:' + key, ...det };
    if (det.catalogId || det.by) wz.detCache.set(key, rec);
    const lbl = wzApplyDetection(rec, det.cached ? 'from the server cache' : '');
    if (lbl) toast(`${lbl} detected: deploy configuration applied`, 'success'); else toast('No framework recognised in this source', 'warning');
  } catch (e) { $('fwDetectHint').textContent = e.message; toast(e.message, 'error'); }
  finally { wzAiButtonState(false); }
}
$('btnFwAi').addEventListener('click', wzAiDetect);
function wzRenderFw() {
  const list = (wz.catalog?.frameworks || []).filter((c) => wz.fwGroup === 'all' || c.group === wz.fwGroup);
  $('fwTabs').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.g === wz.fwGroup));
  $('fwGrid').setAttribute('role', 'radiogroup'); $('fwGrid').setAttribute('aria-label', 'Framework');
  $('fwGrid').innerHTML = list.map((c) => `<button type="button" role="radio" aria-checked="${wz.fw === c.id}" class="fw-card ${wz.fw === c.id ? 'on' : ''} ${wz.detected?.catalogId === c.id ? 'detected' : ''}" data-fw="${c.id}" title="${esc(c.label)} · ${esc(c.stackType)}"><span class="fw-ico" aria-hidden="true" style="background:${FW_COLORS[c.id] || '#3a4756'}">${esc(FW_MARK[c.id] || c.label[0])}</span><span class="fw-name">${esc(c.label)}</span></button>`).join('');
  $('fwCfgHint').textContent = wz.fw ? `${wz.catalog.frameworks.find((c) => c.id === wz.fw)?.label} defaults applied: edit freely` : 'auto: detection decides on the first Plan; pick a framework to pre-fill and edit the commands';
}
/** Stack type chosen in the framework step (picked framework, else the detection result), null when left to detection. */
function wzStackType() {
  const fw = wz.fw ? wz.catalog?.frameworks.find((c) => c.id === wz.fw) : (wz.detected?.catalogId ? wz.catalog?.frameworks.find((c) => c.id === wz.detected.catalogId) : null);
  return fw?.stackType || null;
}
function wzPickFramework(id, form) {
  const c = wz.catalog?.frameworks.find((x) => x.id === id); if (!c) return;
  wz.fw = id;
  const v = form || { install: c.install, build: c.build, start: c.start, port: c.port, outputDir: c.outputDir, docroot: c.docroot, healthPath: c.health };
  $('fwInstall').value = v.install || ''; $('fwBuild').value = v.build || ''; $('fwStart').value = v.start || ''; $('fwPort').value = v.port || ''; $('fwOut').value = v.outputDir || ''; $('fwDocroot').value = v.docroot || '.'; $('fwHealth').value = v.healthPath || c.health || '/';
  wzRenderFw();
}
$('fwTabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { wz.fwGroup = b.dataset.g; wzRenderFw(); } });
$('fwGrid').addEventListener('click', (e) => { const c = e.target.closest('[data-fw]'); if (!c) return; if (wz.fw === c.dataset.fw) { wz.fw = null; wzRenderFw(); } else wzPickFramework(c.dataset.fw, wz.detected?.catalogId === c.dataset.fw ? wz.detected.form : null); });
$('btnFwDetected').addEventListener('click', () => { if (wz.detected?.catalogId) wzPickFramework(wz.detected.catalogId, wz.detected.form); });
$('wzBuildSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; wz.build = b.dataset.v; $('wzBuildSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); $('wzBuildHint').textContent = wz.build === 'remote' ? 'Build runs on the server inside the new release; the server needs the toolchain.' : wz.build === 'local' ? 'Build runs on this machine, then the artifact is uploaded.' : 'Auto builds on the server when it has the toolchain, otherwise here and uploads the artifact.'; });
/** Manifest fragment from the framework step (null = leave it to detection). */
async function wzManifest() {
  if (!wz.fw) return null;
  const over = { install: $('fwInstall').value.trim(), build: $('fwBuild').value.trim(), start: $('fwStart').value.trim() || null, port: $('fwPort').value.trim(), outputDir: $('fwOut').value.trim(), docroot: $('fwDocroot').value.trim() || '.', healthPath: $('fwHealth').value.trim() || '/' };
  if (wz.detected?.fragment && wz.detected.catalogId === wz.fw) over.base = wz.detected.fragment; // keep shared paths, hooks, env and root from the detection
  const r = await api(`/api/deploy/frameworks/${encodeURIComponent(wz.fw)}/fragment`, { method: 'POST', body: JSON.stringify(over) });
  return r.manifest;
}
function wzSecretsNeeded() {
  const out = [];
  const slug = (x) => String(x || 'app').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'APP';
  if (wz.source === 'git' && $('wzAuth').value === 'token') out.push({ key: 'gitToken', name: `GIT_TOKEN_${slug(wzRepoName())}`, label: 'Git access token', value: $('wzToken').value, hint: 'used for git fetch over HTTPS' });
  if (wz.dest === 'shared-hosting' && $('wzTransport').value !== 'sftp') out.push({ key: 'ftpPass', name: `FTP_${slug($('wzTargetName').value)}`, label: `${$('wzTransport').value.toUpperCase()} password`, value: '', hint: `for ${$('wzFtpUser').value || 'the FTP user'}@${$('wzFtpHost').value || 'host'}` });
  if (wz.dest === 'paas') { const p = (dp.status?.paasProviders || []).find((x) => x.id === $('wzPaas').value); out.push({ key: 'paasToken', name: `${slug(p?.id)}_TOKEN_${slug($('wzTargetName').value)}`, label: `${p?.label || 'Platform'} API token`, value: '', hint: p?.tokenHint || '' }); }
  return out;
}
function wzRenderSecrets() {
  const need = wzSecretsNeeded();
  const existing = new Set(dp.secrets.map((x) => x.name));
  $('wzAccessIntro').textContent = need.length ? 'Credentials go into the encrypted vault and are referenced by name; they never reach the browser again.' : 'Nothing to add: this setup relies on your existing git and SSH access.';
  $('wzSecrets').innerHTML = need.map((n) => `<div class="wz-secret" data-key="${n.key}"><div><label>${esc(n.label)} · name in the vault</label><input data-wz-sname value="${esc(n.name)}"><small>${esc(n.hint)}</small></div><div><label>Value${existing.has(n.name) ? ' <span class="hint">(exists: leave empty to keep)</span>' : ''}</label><input data-wz-svalue type="password" autocomplete="off" value="${esc(n.value || '')}"></div></div>`).join('');
}
function wzCollect() {
  const repoName = wzRepoName();
  const secrets = {};
  const refs = {};
  $('wzSecrets').querySelectorAll('.wz-secret').forEach((row) => { const name = row.querySelector('[data-wz-sname]').value.trim(); const val = row.querySelector('[data-wz-svalue]').value; refs[row.dataset.key] = name; if (val) secrets[name] = val; });
  let repo = null, repoId = null;
  if (wz.source === 'existing') repoId = $('wzRepo').value;
  else if (wz.source === 'local') repo = { name: repoName, source: { kind: 'local', path: $('wzPath').value.trim() } };
  else repo = { name: repoName, source: { kind: 'git', url: $('wzUrl').value.trim(), branch: $('wzBranch').value.trim() || null, auth: $('wzAuth').value === 'token' ? { kind: 'https-token', tokenRef: `\${vault:${refs.gitToken}}` } : $('wzAuth').value === 'ssh' ? { kind: 'ssh', keyPath: $('wzKeyPath').value.trim() || null } : null } };
  const env = $('wzEnv').value; const name = $('wzTargetName').value.trim(); const healthUrl = $('wzHealth').value.trim() || (wz.dest === 'vps-ssh' && $('wzDomain').value.trim() ? `http://${$('wzDomain').value.trim()}/` : '');
  const auto = $('wzAuto').checked ? { enabled: true, mode: wz.source === 'git' ? 'webhook' : 'poll' } : { enabled: false };
  let target = null;
  if (wz.dest === 'vps-ssh') { const web = $('wzWeb').value; const dom = $('wzDomain').value.trim(); target = { name, type: 'vps-ssh', buildMode: wz.build, domain: dom ? { name: dom, ssl: $('wzSsl').checked, email: $('wzSslEmail').value.trim() } : null, ssh: { profileId: $('wzProfile').value }, paths: { root: $('wzRoot').value.trim() }, web: { server: web, reloadCmd: web === 'nginx' ? 'sudo -n systemctl reload nginx' : web === 'apache' ? 'sudo -n systemctl reload apache2' : '', phpFpmReload: wzStackType() === 'php' ? 'sudo -n systemctl reload php8.3-fpm' : '' }, process: { manager: wzStackType() === 'node' || wzStackType() === 'python' ? 'systemd' : 'none', unit: wzStackType() === 'node' || wzStackType() === 'python' ? `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.service` : '' }, healthUrl, keepReleases: env === 'production' ? 5 : 3, autoShip: auto }; }
  else if (wz.dest === 'shared-hosting') { const tr = $('wzTransport').value; const [fh, fp] = $('wzFtpHost').value.trim().split(':'); target = { name, type: 'shared-hosting', transport: tr === 'sftp' ? { kind: 'sftp', profileId: $('wzSftpProfile').value } : { kind: tr, host: fh, port: Number(fp) || undefined, user: $('wzFtpUser').value.trim(), passwordRef: `\${vault:${refs.ftpPass}}`, secure: tr === 'ftps' }, paths: { home: $('wzHome').value.trim() || '/', docroot: $('wzDocroot').value.trim() }, docrootStrategy: 'auto', healthUrl, keepReleases: 2, autoShip: auto }; }
  else if (wz.dest === 'local') { const proc = $('wzLocalProc').value; target = { name, type: 'local', buildMode: 'local', paths: { root: $('wzLocalRoot').value.trim() }, web: { reloadCmd: $('wzLocalReload').value.trim() }, process: { manager: proc, name: proc === 'pm2' ? (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app') : '' }, healthUrl, keepReleases: 3, autoShip: auto }; }
  else if (wz.dest === 'paas') { const paas = { provider: $('wzPaas').value, tokenRef: `\${vault:${refs.paasToken}}`, prod: env === 'production' }; $('wzPaasFields').querySelectorAll('[data-wz-paas]').forEach((i) => { paas[i.dataset.wzPaas] = i.value.trim(); }); target = { name, type: 'paas', paas, healthUrl, autoShip: auto }; }
  if (target) target.projectId = $('wzProject').value;
  return { repo, repoId, target, secrets, env };
}
function wzValidate(step) {
  const err = (m) => { toast(m, 'warning'); return false; };
  if (step === 1) {
    if (!dpValidProject($('wzProject').value)) { $('wzProject').focus(); return err('Choose the project for this deployment'); }
    if (wz.source === 'git' && !/^(https?:\/\/|git@|ssh:\/\/)/.test($('wzUrl').value.trim())) return err('Enter the repository URL (https:// or git@…)');
    if (wz.source === 'local' && !$('wzPath').value.trim()) return err('Enter the folder path');
    if (wz.source === 'existing' && !$('wzRepo').value) return err('Pick a repository');
    if (wz.source === 'git' && $('wzAuth').value === 'token' && !$('wzToken').value) return err('Paste the access token');
    if (!wzRepoName()) return err('Give the repository a name');
  }
  if (step === 3) {
    if (!$('wzTargetName').value.trim()) return err('Give the target a name');
    if (wz.dest === 'vps-ssh' && $('wzDomain').value.trim() && $('wzSsl').checked && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test($('wzSslEmail').value.trim())) return err("Let's Encrypt needs an e-mail address (or untick the certificate)");
    if (wz.dest === 'vps-ssh' && !$('wzProfile').value) return err('Choose an SSH server (or add one under SSH servers first)');
    if (wz.dest === 'vps-ssh' && !/^\//.test($('wzRoot').value.trim())) return err('The app folder must be an absolute path');
    if (wz.dest === 'local' && !isAbsLocal($('wzLocalRoot').value.trim())) return err('The app folder must be an absolute path on this computer (e.g. C:\\www\\shop or /srv/www/shop)');
    if (wz.dest === 'shared-hosting') { if ($('wzTransport').value === 'sftp' && !$('wzSftpProfile').value) return err('Choose the SSH server'); if ($('wzTransport').value !== 'sftp' && (!$('wzFtpHost').value.trim() || !$('wzFtpUser').value.trim())) return err('Enter the FTP host and user'); if (!$('wzDocroot').value.trim()) return err('Enter the document root'); }
    if (wz.dest === 'paas') { const p = (dp.status?.paasProviders || []).find((x) => x.id === $('wzPaas').value); for (const fld of p?.fields || []) if (fld.required && !$('wzPaasFields').querySelector(`[data-wz-paas="${fld.key}"]`)?.value.trim()) return err(`${fld.label} is required`); }
  }
  if (step === 4) { for (const row of $('wzSecrets').querySelectorAll('.wz-secret')) { const name = row.querySelector('[data-wz-sname]').value.trim(); if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) return err(`Secret name ${name} must be UPPER_SNAKE_CASE`); const exists = dp.secrets.some((x) => x.name === name); if (!exists && !row.querySelector('[data-wz-svalue]').value) return err(`Enter a value for ${name}`); } }
  return true;
}
function wzRenderReview() {
  const c = wzCollect();
  const repoLine = c.repoId ? dp.repos.find((r) => r.id === c.repoId)?.name : `${c.repo.name} ← ${c.repo.source.kind === 'git' ? c.repo.source.url : c.repo.source.path}`;
  const t = c.target || {};
  const dest = wz.dest === 'cloud' ? 'a new cloud server (provisioned next)' : t.type === 'local' ? `this computer · ${t.paths.root}${t.web.reloadCmd ? ' · then ' + t.web.reloadCmd : ''}` : t.type === 'vps-ssh' ? `${dp.profiles.find((p) => p.id === t.ssh.profileId)?.host || 'ssh'}:${t.paths.root} · ${t.web.server}` : t.type === 'shared-hosting' ? `${t.transport.kind} ${t.transport.host || dp.profiles.find((p) => p.id === t.transport.profileId)?.host || ''} → ${t.paths.docroot}` : `${dpHostOf({ type: 'paas', paas: t.paas })} (${t.paas.prod ? 'production' : 'preview'})`;
  $('wzReview').innerHTML = `<div class="wz-review"><dl>
    <dt>project</dt><dd>${esc(dpProjectName($('wzProject').value))} <button type="button" id="btnWzProjectChange">Change</button></dd>
    <dt>repository</dt><dd>${esc(repoLine)}</dd>
    <dt>target</dt><dd>${esc(t.name || '')} <span class="env ${esc(c.env === 'staging' ? 'staging' : c.env === 'dev' ? 'dev' : 'production')}">${esc(c.env)}</span></dd>
    <dt>destination</dt><dd>${esc(dest)}</dd>
    <dt>framework</dt><dd>${esc(wz.fw ? (wz.catalog?.frameworks.find((c) => c.id === wz.fw)?.label || wz.fw) : 'auto-detected on the first Plan')}${wz.fw && wz.detected?.catalogId === wz.fw && wz.detected.by ? ` <span class="badge plan">${wz.detected.by === 'ai' ? 'AI detected' : 'detected'}</span>` : ''}${wz.fw && $('fwBuild').value.trim() ? ` <span class="hint">· ${esc($('fwBuild').value.trim())}</span>` : ''}</dd>
    ${wz.dest === 'vps-ssh' ? `<dt>build location</dt><dd>${esc(wz.build === 'remote' ? 'server' : wz.build === 'local' ? 'this machine' : 'auto')}</dd><dt>domain</dt><dd>${$('wzDomain').value.trim() ? esc($('wzDomain').value.trim()) + ($('wzSsl').checked ? " · Let's Encrypt" : '') : 'none (reachable by IP / existing vhost)'}</dd>` : ''}
    <dt>health check</dt><dd>${esc(t.healthUrl || 'none: add one later to enable automatic rollback')}</dd>
    <dt>secrets</dt><dd>${Object.keys(c.secrets).length ? Object.keys(c.secrets).map((k) => '${vault:' + esc(k) + '}').join(', ') : 'none'}</dd>
    <dt>auto-ship</dt><dd>${t.autoShip?.enabled ? esc(t.autoShip.mode) : 'off'}</dd>
  </dl><p class="hint" style="margin:.6rem 0 0">Nothing is deployed yet. After creation you can Test the connection, Plan (read-only) and Ship.</p></div>`;
  $('btnWzProjectChange').addEventListener('click', () => { wzShow(1); $('wzProject').focus(); });
}
$('wzSourceKind').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { wz.source = b.dataset.v; wzSync(); } });
$('wzDestKind').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { wz.dest = b.dataset.v; wzSync(); } });
for (const id of ['wzAuth', 'wzTransport', 'wzPaas', 'wzEnv', 'wzRepo']) $(id).addEventListener('change', wzSync);
for (const id of ['wzUrl', 'wzPath', 'wzRepoName']) $(id).addEventListener('input', wzSync);
$('wzTargetName').addEventListener('input', () => { $('wzTargetName').dataset.touched = '1'; wzSync(); });
$('wzRoot').addEventListener('input', () => { $('wzRoot').dataset.touched = '1'; });
$('wzLocalRoot').addEventListener('input', () => { $('wzLocalRoot').dataset.touched = '1'; });
$('dtLocalRoot').addEventListener('input', () => { tfState.localRootTouched = true; });
$('btnWzCancel').addEventListener('click', () => $('dpWizard').close());
$('btnWzBack').addEventListener('click', () => wzShow(Math.max(1, wz.step - 1)));
$('btnWzNext').addEventListener('click', () => {
  if (!wzValidate(wz.step)) return;
  if (wz.step === 3 && wz.dest === 'cloud') return wzFinishCloud();
  wzShow(Math.min(5, wz.step + 1));
});
async function wzFinishCloud() {
  const c = wzCollect();
  try {
    let repoId = c.repoId;
    if (!repoId) { const r = await api('/api/deploy/repos', { method: 'POST', body: JSON.stringify(c.repo) }); repoId = r.id; }
    $('dpWizard').close(); await loadDeploy(); await dpOpenCloudModal();
    $('dcMakeTarget').checked = true; dpCloudSync(false); $('dcProject').value = $('wzProject').value; $('dcRepo').value = repoId; $('dcTargetName').value = $('wzTargetName').value.trim(); $('dcHealth').value = $('wzHealth').value.trim(); $('dcName').value = $('wzTargetName').value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 40);
    toast('Repository connected: now provision the server', 'success');
  } catch (e) { toast(e.message, 'error'); }
}
$('wzForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!wzValidate(1) || !wzValidate(3) || !wzValidate(4)) return;
  const c = wzCollect();
  $('btnWzFinish').disabled = true;
  try {
    const manifest = await wzManifest();
    if (c.repo && manifest) c.repo.manifest = manifest;
    const r = await api('/api/deploy/setup', { method: 'POST', body: JSON.stringify({ repo: c.repo || undefined, repoId: c.repoId || undefined, target: c.target, secrets: c.secrets }) });
    if (c.repoId && manifest) await api(`/api/deploy/repos/${c.repoId}/manifest`, { method: 'PUT', body: JSON.stringify({ manifest }) });
    $('dpWizard').close(); toast(`${r.target ? 'Target "' + r.target.name + '" is ready' : 'Repository connected'}`, 'success');
    await loadDeploy();
    if (r.target) { dpSelect(r.target.id); if ($('wzPlanNow').checked) { const p = await api(`/api/deploy/targets/${r.target.id}/plan`, { method: 'POST', body: JSON.stringify({ ai: dpPrefAi() }) }); dp.runs.set(p.run.id, p.run); dp.logRun = p.run.id; dpRenderMain(); dpShowTab('log'); dpLoadLog(p.run.id); } }
  } catch (err) { toast(err.message, 'error'); }
  finally { $('btnWzFinish').disabled = false; }
});

/* ---------- templates / duplicate / export / import ---------- */
async function dpSaveTemplateFromForm() {
  const name = await dpAskText('Save as template', 'A template stores the destination settings (not the name or repository) so the next target starts pre-filled.', 'e.g. Hetzner PHP production');
  if (!name) return;
  const t = dp.editingTarget;
  try {
    if (t) await api('/api/deploy/templates', { method: 'POST', body: JSON.stringify({ name, fromTargetId: t.id }) });
    else { const body = dpTargetFormBody(); delete body.name; delete body.repoId; delete body.projectId; delete body.autoShip; await api('/api/deploy/templates', { method: 'POST', body: JSON.stringify({ name, data: body }) }); }
    toast(`Template "${name}" saved`, 'success'); dp.templates = (await api('/api/deploy/templates')).templates; dpFillTemplates(null);
  } catch (e) { toast(e.message, 'error'); }
}
function dpAskText(title, message, placeholder) {
  return new Promise((resolve) => {
    confirmDialog({ title, message: `<p>${message}</p><input id="dpAskInput" placeholder="${esc(placeholder || '')}" style="width:100%">`, okLabel: 'Save' }).then((ok) => resolve(ok ? ($('dpAskInput')?.value || '').trim() : null));
    setTimeout(() => $('dpAskInput')?.focus(), 50);
  });
}
function dpFillTemplates(t) {
  const sel = $('dtTemplate'); if (!sel) return;
  sel.innerHTML = '<option value="">Start from a template…</option>' + dp.templates.map((x) => `<option value="${esc(x.id)}">${esc(x.name)} · ${esc(x.type)}</option>`).join('') + (dp.templates.length ? '<option value="__manage">Manage templates…</option>' : '');
  sel.hidden = !!t; // editing an existing target: no template picker
}
async function dpApplyTemplate(id) {
  const tpl = dp.templates.find((x) => x.id === id); if (!tpl) return;
  const keepName = $('dtName').value, keepRepo = $('dtRepo').value;
  dpOpenTargetModal({ ...tpl.data, name: keepName, repoId: keepRepo, projectId: $('dtProject').value, id: undefined });
  dp.editingTarget = null; $('dpTargetTitle').textContent = `Add a deploy target: from "${tpl.name}"`; dpFillTemplates(null); $('dtTemplate').value = id;
  toast(`Template "${tpl.name}" applied: adjust and save`, 'success');
}
async function dpManageTemplates() {
  const list = dp.templates.map((x) => `<div class="act-row" style="grid-template-columns:1fr auto"><div><div class="act-title">${esc(x.name)}</div><div class="act-sub">${esc(x.type)} · updated ${esc(dpFmtAgo(x.updatedAt))}</div></div><button class="reject" data-tpl-del="${esc(x.id)}" style="padding:.15rem .5rem;font-size:.72rem">Delete</button></div>`).join('') || '<div class="hint">No templates yet.</div>';
  const p = confirmDialog({ title: 'Templates', message: `<div id="dpTplList">${list}</div>`, okLabel: 'Close', cancelLabel: ' ' });
  setTimeout(() => $('dpTplList')?.querySelectorAll('[data-tpl-del]').forEach((b) => b.addEventListener('click', async () => { try { await api(`/api/deploy/templates/${b.dataset.tplDel}`, { method: 'DELETE' }); b.closest('.act-row').remove(); dp.templates = dp.templates.filter((x) => x.id !== b.dataset.tplDel); dpFillTemplates(dp.editingTarget); } catch (e) { toast(e.message, 'error'); } })), 50);
  await p;
}
async function dpDuplicateTarget(t) {
  const name = await dpAskText(`Duplicate ${t.name}`, 'Creates another environment with the same destination settings (auto-ship stays off on the copy). Name of the new target:', `${t.name.replace(/-?(prod|production)$/, '')}-staging`);
  if (!name) return;
  try { const r = await api(`/api/deploy/targets/${t.id}/duplicate`, { method: 'POST', body: JSON.stringify({ name, env: /stag|pre|dev|test/i.test(name) ? name.split('-').pop() : undefined }) }); toast(`Target "${r.name}" created`, 'success'); await loadDeploy(); dpSelect(r.id); }
  catch (e) { toast(e.message, 'error'); }
}
async function dpExportConfig() {
  try {
    const doc = await api('/api/deploy/export');
    const text = JSON.stringify(doc, null, 2);
    try { await navigator.clipboard.writeText(text); } catch {}
    const a = document.createElement('a'); a.href = 'data:application/json;charset=utf-8,' + encodeURIComponent(text); a.download = `ascension-config-${new Date().toISOString().slice(0, 10)}.json`; document.body.appendChild(a); a.click(); a.remove();
    toast(`Exported ${doc.repos.length} repo(s), ${doc.targets.length} target(s), ${doc.templates.length} template(s): copied to the clipboard too`, 'success');
  } catch (e) { toast(e.message, 'error'); }
}
function dpOpenImportModal() { dpFillProjectSelect('dpImportProject'); $('dpImportText').value = ''; $('dpImportReport').textContent = ''; $('dpImportFile').value = ''; $('dpImportModal').showModal(); }
$('dpImportFile').addEventListener('change', async () => { const f = $('dpImportFile').files[0]; if (f) $('dpImportText').value = await f.text(); });
$('btnDpImportCancel').addEventListener('click', () => $('dpImportModal').close());
async function dpRunImport(dryRun) {
  const projectId = $('dpImportProject').value;
  if (!dpValidProject(projectId)) { $('dpImportProject').focus(); return toast('Choose a project for imported deployments', 'warning'); }
  let doc; try { doc = JSON.parse($('dpImportText').value); } catch (e) { return toast('Invalid JSON: ' + e.message, 'error'); }
  try {
    const rep = await api('/api/deploy/import', { method: 'POST', body: JSON.stringify({ config: doc, dryRun, projectId }) });
    const line = (k, arr) => (arr.length ? `<div><b>${k}</b>: ${arr.map(esc).join(', ')}</div>` : '');
    $('dpImportReport').innerHTML = `${dryRun ? '<div class="dp-chip">preview: nothing written</div>' : '<div class="dp-chip ok">imported</div>'}${line('repos', rep.repos)}${line('targets', rep.targets)}${line('templates', rep.templates)}${line('skipped', rep.skipped)}${rep.missingSecrets.length ? `<div class="dp-warn">Add these secrets to the vault: ${rep.missingSecrets.map(esc).join(', ')}</div>` : ''}${rep.unresolvedProfiles.length ? `<div class="dp-warn">SSH servers not found on this machine (edit the target afterwards): ${rep.unresolvedProfiles.map(esc).join('; ')}</div>` : ''}`;
    if (!dryRun) { toast('Configuration imported', 'success'); await loadDeploy(); }
  } catch (e) { toast(e.message, 'error'); }
}
$('btnDpImportDry').addEventListener('click', () => dpRunImport(true));
$('dpImportForm').addEventListener('submit', (e) => { e.preventDefault(); dpRunImport(false); });

/* ---------- cloud servers: panel, details, modal ---------- */
function dpRenderCloudPanel() {
  const j = dp.cloudJob; const el = $('dpCloudPanel');
  if (!j) { el.hidden = true; el.innerHTML = ''; return; }
  const running = j.status === 'running';
  const lines = (j.log || []).slice(-6).map((l) => `<div class="dl-line ${l.line.startsWith('── ') ? 'dl-head' : 'dl-sys'}">${esc(l.line)}</div>`).join('');
  el.hidden = false;
  el.innerHTML = `<div class="dp-card cloud-panel ${running ? 'live' : j.status === 'succeeded' ? 'ok' : 'bad'}">
    <h4>${running ? '<span class="srv-dot on"></span>' : ''}Provisioning ${esc(j.spec?.name || '')} on ${esc(j.spec?.provider || '')} <span class="dp-chip ${running ? '' : j.status === 'succeeded' ? 'ok' : 'bad'}">${esc(running ? j.stage : j.status)}</span>${j.server?.ip ? `<span class="dp-chip">${esc(j.server.ip)}</span>` : ''}
      <span class="spacer"></span>${running ? '<button class="warn" data-cloud-cancel style="padding:.15rem .55rem;font-size:.72rem">Cancel</button>' : '<button data-cloud-dismiss style="padding:.15rem .55rem;font-size:.72rem">Dismiss</button>'}</h4>
    <pre class="dp-log" style="min-height:0;max-height:140px">${lines}</pre>
    ${j.error ? `<div class="dp-err">${esc(j.error)}</div>` : ''}
    ${j.status === 'succeeded' ? `<div class="dp-actions" style="margin-top:.4rem">${j.targetId ? `<button class="primary" data-cloud-open="${esc(j.targetId)}">Open target</button>` : '<span class="hint">SSH profile registered: add a target that uses it.</span>'}${j.server?.console ? `<a class="btn-link" href="${esc(j.server.console)}" target="_blank" rel="noopener">Provider console ↗</a>` : ''}</div>` : ''}
  </div>`;
  el.querySelector('[data-cloud-cancel]')?.addEventListener('click', async () => { try { await api(`/api/deploy/cloud/jobs/${j.id}/cancel`, { method: 'POST' }); } catch (e) { toast(e.message, 'error'); } });
  el.querySelector('[data-cloud-dismiss]')?.addEventListener('click', () => { dp.cloudJob = null; dpRenderCloudPanel(); });
  el.querySelector('[data-cloud-open]')?.addEventListener('click', (e) => { dp.cloudJob = null; dpRenderCloudPanel(); dpSelect(e.target.dataset.cloudOpen); });
}
function dpShowServer(x) {
  if (!x) return;
  const prof = dp.profiles.find((p) => p.id === x.profileId);
  confirmDialog({ title: `${x.name} · ${x.provider}`, okLabel: 'Close', cancelLabel: 'Add a target here', message: `<dl class="dp-kv"><dt>status</dt><dd>${esc(x.status)}${x.error ? ': ' + esc(x.error) : ''}</dd><dt>ip</dt><dd>${esc(x.ip || 'not assigned yet')}</dd><dt>region / size</dt><dd>${esc(x.region)} · ${esc(x.size)} · ${esc(x.image)}</dd><dt>recipe</dt><dd>${esc(x.recipe)}</dd><dt>ssh profile</dt><dd>${prof ? esc(prof.name) : (x.profileId ? esc(x.profileId) : 'not registered')}</dd><dt>private key</dt><dd>${esc(x.privateKeyPath || 'none')}</dd>${x.console ? `<dt>console</dt><dd><a href="${esc(x.console)}" target="_blank" rel="noopener">${esc(x.console)}</a></dd>` : ''}</dl>` })
    .then((closed) => { if (!closed && x.profileId) { dpOpenTargetModal(null); setTimeout(() => { $('dtType').value = 'vps-ssh'; $('dtProfile').value = x.profileId; tfState.rootTouched = true; $('dtRoot').value = `/var/www/${x.name}`; $('dtHealth').value = x.ip ? `http://${x.ip}/` : ''; }, 50); } });
}
async function dpOpenCloudModal() {
  dpFillProjectSelect('dcProject');
  try { dp.cloudMeta = dp.cloudMeta || await api('/api/deploy/cloud/providers'); } catch (e) { return toast(e.message, 'error'); }
  const m = dp.cloudMeta;
  dpFillSelect($('dcProvider'), m.providers.map((p) => ({ value: p.id, label: p.label })), 'hetzner');
  dpFillSelect($('dcToken'), dp.secrets.map((x) => ({ value: '${vault:' + x.name + '}', label: x.name })), null, dp.secrets.length ? 'API token secret' : 'store the API token in the vault first');
  dpFillSelect($('dcRecipe'), m.recipes.map((r) => ({ value: r.id, label: r.label })), 'php');
  dpFillSelect($('dcRepo'), dp.repos.map((r) => ({ value: r.id, label: r.name })), dp.repos[0]?.id, dp.repos.length ? null : 'no repositories yet');
  $('dcName').value = ''; $('dcKeyPath').value = ''; $('dcMakeTarget').checked = false; $('dcTargetName').value = ''; $('dcHealth').value = ''; $('dcPreview').textContent = '';
  dpCloudSync(true); $('dpCloudModal').showModal();
}
function dpCloudSync(resetDefaults) {
  const p = dp.cloudMeta?.providers.find((x) => x.id === $('dcProvider').value); if (!p) return;
  $('dcTokenWrap').hidden = p.auth !== 'token';
  $('dcProviderHint').textContent = p.tokenHint || '';
  if (resetDefaults) { $('dcRegionText').value = p.defaults.region; $('dcSizeText').value = p.defaults.size; $('dcImageText').value = p.defaults.image; for (const k of ['Region', 'Size', 'Image']) { $('dc' + k).hidden = true; $('dc' + k + 'Text').hidden = false; } }
  $('btnDcOptions').hidden = p.auth !== 'token';
  $('dcTargetRow').hidden = !$('dcMakeTarget').checked;
  $('dcProject').required = $('dcMakeTarget').checked;
  $('dcProject').disabled = !$('dcMakeTarget').checked;
  if ($('dcMakeTarget').checked && !$('dcTargetName').value) $('dcTargetName').value = $('dcName').value;
}
$('dcProvider').addEventListener('change', () => dpCloudSync(true));
$('dcMakeTarget').addEventListener('change', () => dpCloudSync(false));
$('dcRecipe').addEventListener('change', () => { $('dcPreview').textContent = ''; });
$('btnDcOptions').addEventListener('click', async () => {
  const provider = $('dcProvider').value, tokenRef = $('dcToken').value;
  if (!tokenRef) return toast('Pick the API token secret first', 'warning');
  $('btnDcOptions').disabled = true;
  try {
    const o = await api(`/api/deploy/cloud/options?provider=${encodeURIComponent(provider)}&tokenRef=${encodeURIComponent(tokenRef)}`);
    const cur = { Region: $('dcRegionText').value, Size: $('dcSizeText').value, Image: $('dcImageText').value };
    const lists = { Region: o.regions, Size: o.sizes, Image: o.images };
    for (const k of ['Region', 'Size', 'Image']) { const list = lists[k] || []; if (!list.length) continue; dpFillSelect($('dc' + k), list.map((x) => ({ value: x.id, label: x.label })), list.some((x) => x.id === cur[k]) ? cur[k] : list[0].id); $('dc' + k).hidden = false; $('dc' + k + 'Text').hidden = true; }
    toast(`${o.regions.length} regions · ${o.sizes.length} sizes · ${o.images.length} images`, 'success');
  } catch (e) { toast(e.message, 'error'); }
  finally { $('btnDcOptions').disabled = false; }
});
$('dpCloudModal').querySelector('details').addEventListener('toggle', async (e) => {
  if (!e.target.open) return;
  try { const r = await fetch('/api/deploy/cloud/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ recipe: $('dcRecipe').value, appName: $('dcTargetName').value || $('dcName').value || 'app' }) }); $('dcPreview').textContent = await r.text(); } catch (err) { $('dcPreview').textContent = err.message; }
});
$('btnDpCloudCancel').addEventListener('click', () => $('dpCloudModal').close());
$('dpCloudForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if ($('dcMakeTarget').checked && !dpValidProject($('dcProject').value)) { $('dcProject').focus(); return toast('Choose a project for this deployment', 'warning'); }
  const val = (k) => ($('dc' + k).hidden ? $('dc' + k + 'Text').value.trim() : $('dc' + k).value);
  const body = { provider: $('dcProvider').value, tokenRef: $('dcToken').value || undefined, name: $('dcName').value.trim(), region: val('Region'), size: val('Size'), image: val('Image'), recipe: $('dcRecipe').value, privateKeyPath: $('dcKeyPath').value.trim() || undefined,
    projectId: $('dcMakeTarget').checked ? $('dcProject').value : undefined,
    createTarget: $('dcMakeTarget').checked ? { repoId: $('dcRepo').value, targetName: $('dcTargetName').value.trim() || $('dcName').value.trim(), healthUrl: $('dcHealth').value.trim() || undefined } : undefined };
  const p = dp.cloudMeta.providers.find((x) => x.id === body.provider);
  if (!(await confirmDialog({ title: 'Provision a server', message: `Create <b>${esc(body.name)}</b> on <b>${esc(p?.label || body.provider)}</b> (${esc(body.region)} · ${esc(body.size)} · ${esc(body.image)}) with the <b>${esc(body.recipe)}</b> recipe? <span class="hint">This creates billable infrastructure at the provider.</span>`, okLabel: 'Provision', okClass: 'warn' }))) return;
  try {
    const r = await api('/api/deploy/cloud/provision', { method: 'POST', body: JSON.stringify(body) });
    $('dpCloudModal').close(); dp.cloudJob = r.job; dpRenderCloudPanel(); toast('Provisioning started', 'success'); loadDeploy();
  } catch (err) { toast(err.message, 'error'); }
});

/* ---------- context strip ---------- */
function dpRunPill(last) {
  if (!last) return '<span class="status-pill"><span class="srv-dot"></span>never deployed</span>';
  if (dpIsActive(last)) return `<span class="status-pill running"><span class="srv-dot"></span>${esc(last.mode)} · ${esc(last.stage || 'starting')}</span>`;
  const cls = last.status === 'succeeded' ? (last.mode === 'plan' ? '' : 'succeeded') : ['rolled_back', 'cancelled'].includes(last.status) ? 'warn' : 'failed';
  return `<span class="status-pill ${cls}"><span class="srv-dot"></span>${esc(last.mode)} ${esc(last.status.replace('_', ' '))} · ${esc(dpFmtAgo(last.endedAt || last.startedAt))}</span>`;
}
function dpRenderContext(t) {
  const repo = dpRepoOf(t);
  const runs = dpRunsFor(t.id); const last = runs[0];
  const active = dpIsActive(last);
  const branch = last?.branch || repo?.source?.branch || repo?.lastFetch?.branch || (repo?.source?.kind === 'local' ? 'working tree' : 'default branch');
  const commit = last?.shortCommit || repo?.lastFetch?.commit?.slice(0, 8) || null;
  const env = dpEnvOf(t);
  $('dpContext').innerHTML = `
    <div class="dp-ctx-main">
      <span class="dp-avatar" style="width:34px;height:34px;font-size:.8rem">${esc(dpInitials(repo?.name || t.name))}</span>
      <div style="min-width:0">
        <div class="dp-ctx-name">${esc(repo?.name || 'no repository')} <span style="color:var(--muted);font-weight:400">→</span> ${esc(t.name)}</div>
        <div class="dp-ctx-meta">
          <span class="badge" title="Owning project">${esc(dpProjectName(t.projectId))}</span>
          <span class="env ${env}">${esc(env === 'neutral' ? (t.type === 'vps-ssh' ? 'vps' : t.type === 'paas' ? 'platform' : t.type === 'local' ? 'this computer' : 'shared hosting') : env)}</span>
          <span class="mono">${esc(branch)}</span>${commit ? `<span class="sep">·</span><span class="mono" title="commit">${esc(commit)}</span>` : ''}
          <span class="sep">·</span><span class="mono">${t.type === 'paas' ? esc(t.paths.root) : esc(dpHostOf(t) || t.type) + (t.paths?.root || t.paths?.docroot ? ':' + esc(t.paths.root || t.paths.docroot) : '')}</span>
          <span class="sep">·</span>${dpRunPill(last)}
        </div>
      </div>
    </div>
    <div class="dp-ctx-actions">
      <button class="ghost" data-act="test" title="Connect and probe the server (read-only)">Test</button>
      <button class="ghost" data-act="fetch" title="git fetch / inspect the local folder">Fetch</button>
      <button class="ghost" data-act="detect" title="Detect the stack and show the resolved manifest">Detect</button>
      <span class="sep"></span>
      <button class="primary" data-act="plan" title="Dry run: shows every command without changing anything" ${active ? 'disabled' : ''}>Plan</button>
      <button class="btn-ship" data-act="ship" title="${dpAssist('preShipReview') && !dpReviewFresh(t) ? 'The AI assistant reviews the manifest, plan and last run first, then asks for confirmation' : 'Build and deploy this target (asks for confirmation)'}" ${active ? 'disabled' : ''}>${ICO.ship} ${dpAssist('preShipReview') && !dpReviewFresh(t) ? 'Review & Ship' : 'Ship'}</button>
      ${dpAssist('preShipReview') ? `<button class="ghost" data-act="review" title="Run the AI pre-ship review without shipping" ${active ? 'disabled' : ''}>Review</button>` : ''}
      <button class="btn-rollback" data-act="rollback" title="Switch back to a previous release" ${active ? 'disabled' : ''}>Rollback</button>
      ${active ? '<button class="warn" data-act="cancel">Cancel run</button>' : ''}
      <span class="sep"></span>
      <button class="ghost dp-mini" data-act="duplicate" title="Duplicate as another environment" ${active ? 'disabled' : ''}>⧉</button>
      <button class="ghost dp-mini" data-act="edit" title="Edit the target" ${active ? 'disabled' : ''}>✎</button>
      <button class="ghost dp-mini" data-act="remove" title="Delete the target" ${active ? 'disabled' : ''}>✕</button>
    </div>`;
}

/* ---------- pipeline (the centerpiece) ---------- */
const PIPE = [
  { key: 'test', label: 'Test', stages: ['connect'] }, { key: 'fetch', label: 'Fetch', stages: ['fetch'] }, { key: 'detect', label: 'Detect', stages: ['detect'] },
  { key: 'plan', label: 'Plan', stages: ['plan'] }, { key: 'ship', label: 'Ship', stages: ['build', 'package', 'ship', 'activate'] }, { key: 'verify', label: 'Verify', stages: ['verify', 'cleanup'] },
];
function dpPipelineModel(t) {
  const runs = dpRunsFor(t.id); const last = runs[0] || null;
  const st = Object.fromEntries((last?.stages || []).map((s) => [s.name, s]));
  const steps = PIPE.map((p) => {
    const s = p.stages.map((n) => st[n]).filter(Boolean);
    const ms = s.reduce((a, x) => a + (x.ms || 0), 0);
    let status = 'idle', meta = '';
    if (s.some((x) => x.status === 'running')) { status = 'running'; meta = s.find((x) => x.status === 'running').name; }
    else if (s.some((x) => x.status === 'failed')) { status = 'failed'; meta = s.find((x) => x.status === 'failed').name + ' failed'; }
    else if (s.length) { status = 'ok'; meta = dpFmtMs(ms); }
    if (p.key === 'ship' && last && last.mode === 'plan' && last.status === 'succeeded' && !s.length) { status = 'ready'; meta = 'plan reviewed'; }
    if (p.key === 'verify' && last && !dpIsActive(last)) {
      if (['rolled_back', 'rollback_failed'].includes(last.status)) { status = 'failed'; meta = last.status === 'rolled_back' ? 'rolled back' : 'rollback failed'; }
      else if (last.mode !== 'plan' && last.status === 'succeeded' && !t.healthUrl) { status = 'warn'; meta = 'no health check'; }
    }
    return { ...p, status, meta };
  });
  const currentIdx = steps.findIndex((s) => s.status === 'running');
  const lastDone = [...steps].reverse().findIndex((s) => s.status !== 'idle');
  const current = currentIdx >= 0 ? currentIdx : lastDone >= 0 ? steps.length - 1 - lastDone : -1;
  return { steps, current, last };
}
function dpRenderPipeline(t) {
  const { steps, current, last } = dpPipelineModel(t);
  const next = !last ? { text: 'Nothing has run yet. Start with a read-only <b>Plan</b>.', btn: '<button class="primary" data-act="plan">Plan</button>' }
    : dpIsActive(last) ? { text: dpLiveHtml(last), btn: '<button class="warn" data-act="cancel">Cancel</button>', live: true }
    : last.mode === 'plan' && last.status === 'succeeded' ? { text: `Plan reviewed (${esc(String(last.plan?.steps?.length ?? dp.plan?.steps?.length ?? '?'))} steps, ${esc(last.buildMode || '')} build). Ready to <b>Ship</b> the same commands.`, btn: `<button class="btn-ship" data-act="ship">${ICO.ship} Ship</button>` }
    : last.status === 'succeeded' ? { text: `Release <b>${esc(last.release || '')}</b> is live${t.healthUrl ? ' and healthy' : ''}. Plan again to preview the next change.`, btn: '<button class="primary" data-act="plan">Plan next</button>' }
    : last.status === 'rolled_back' ? { text: `Last ship failed at <b>${esc((last.error || '').split(':')[0])}</b> and was rolled back to <b>${esc(last.previousRelease || 'previous')}</b>. Fix, then plan again.`, btn: '<button data-act="log-last">Open log</button>' }
    : { text: `Last ${esc(last.mode)} <b>${esc(last.status.replace('_', ' '))}</b>${last.error ? `${esc(last.error.slice(0, 120))}` : ''}.`, btn: '<button data-act="log-last">Open log</button>' };
  $('dpPipeline').innerHTML = `<div class="pl-track">${steps.map((s, i) => `
    <div class="pl-step ${s.status} ${i === current ? 'current' : ''}" title="${esc(s.stages.join(', '))}">
      <div class="pl-line"></div>
      <div class="pl-dot">${ICO[s.key]}</div>
      <div class="pl-name">${s.label}</div>
      <div class="pl-meta">${esc(s.meta)}</div>
    </div>`).join('')}</div>
    <div class="pl-foot ${next.live ? 'live' : ''}"><span class="pl-foot-text">${next.text}</span><span class="next">${next.btn}</span></div>
    ${last?.actionRequired?.length ? `<div class="dp-action"><b>Action required</b><ul>${last.actionRequired.map((m) => `<li>${esc(m)}</li>`).join('')}</ul></div>` : ''}`;
}

/* ---- live activity: what the run is doing right now, how far, and when it last gave a sign of life ---- */
const dpFmtNum = (n) => (n == null ? '' : Number(n).toLocaleString());
const dpFmtQty = (n, unit) => (unit === 'bytes' ? dpFmtBytes(n) : dpFmtNum(n));
const dpFmtBytes = (n) => (n >= 1 << 30 ? (n / (1 << 30)).toFixed(2) + ' GB' : n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(0) + ' KB' : (n || 0) + ' B');
const dpFmtDur = (ms) => (ms < 1000 ? '0 s' : ms < 60000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60000)}m ${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s`);
function dpLiveHtml(run) {
  const now = Date.now();
  const stage = (run.stages || []).find((s) => s.status === 'running');
  const stageMs = stage?._t ? now - stage._t : (stage ? now - Date.parse(run.lastStageAt || run.startedAt) : 0);
  const idle = run.lastActivityAt ? now - Date.parse(run.lastActivityAt) : 0;
  const idleCls = idle > 120000 ? 'bad' : idle > 25000 ? 'warn' : '';
  const p = run.progress;
  const total = p && p.total != null;
  const bar = p ? `<div class="pl-bar ${total ? '' : 'indeterminate'}"><div class="pl-bar-fill" style="width:${total ? p.pct : 40}%"></div></div>
    <div class="pl-prog-txt">${esc(p.label)}${total ? ` · <b>${esc(dpFmtQty(p.done, p.unit))}</b> / ${esc(dpFmtQty(p.total, p.unit))} ${p.unit === 'bytes' ? '' : esc(p.unit)} (${p.pct}%)` : (p.done ? ` · ${esc(dpFmtQty(p.done, p.unit))} ${esc(p.unit)} so far` : '')}</div>` : '';
  const total7 = (run.stages || []).filter((s) => s.status !== 'running').length;
  return `<div class="pl-live" data-run="${esc(run.id)}">
    <div class="pl-live-head"><span class="pl-pulse" aria-hidden="true"></span><b>${esc(run.mode)}</b> in progress · stage <b>${esc(run.stage || 'queued')}</b> <span class="hint">${esc(dpFmtDur(stageMs))} in this stage · ${esc(dpFmtDur(now - Date.parse(run.startedAt)))} total · ${total7} stage${total7 === 1 ? '' : 's'} done</span></div>
    ${bar}
    <div class="pl-live-foot ${idleCls}">${idle > 120000 ? `⚠ no output for ${esc(dpFmtDur(idle))}: the step may be stuck. Check the Log tab, or cancel the run.` : idle > 25000 ? `quiet for ${esc(dpFmtDur(idle))}: a long build step or a large transfer is normal here` : `last activity ${idle < 2000 ? 'just now' : esc(dpFmtDur(idle)) + ' ago'}`}${run.lastLine ? ` · <span class="pl-lastline">${esc(run.lastLine)}</span>` : ''}</div>
  </div>`;
}
/* a 1 s ticker keeps the elapsed/idle counters moving between server events */
setInterval(() => {
  const el = $('dpPipeline')?.querySelector('.pl-live'); if (!el) return;
  const run = dp.runs.get(el.dataset.run); if (!run || !dpIsActive(run)) return;
  el.outerHTML = dpLiveHtml(run);
}, 1000);

/* ---------- status cards ---------- */
function dpRenderReview(t) {
  const el = $('dpReview'); if (!el) return;
  const r = t?.preShip;
  if (!dpAssist('preShipReview') || !r) { el.innerHTML = ''; return; }
  const fresh = dpReviewFresh(t);
  const cls = r.verdict === 'ready' ? 'ok' : r.verdict === 'block' ? 'bad' : 'warn';
  el.innerHTML = `<div class="dp-card dp-review ${cls}"><h4>AI pre-ship review <span class="dp-chip ${cls}">${esc(r.verdict)}</span>${r.env ? `<span class="dp-chip" title="Environment inferred from the host and name">${esc(r.env)}${r.env === 'local' ? ' test' : ''}</span>` : ''}<span class="dp-chip hint">${esc(dpFmtAgo(r.at))}</span>${fresh ? '' : '<span class="dp-chip warn" title="The plan or commit changed since this review">stale</span>'}<span class="spacer"></span><button class="ghost dp-mini" data-act="review" title="Review again">↻</button></h4>
    <div class="dp-review-sum">${esc(r.summary || '')}</div>
    ${(r.findings || []).length ? `<ul class="dp-review-list">${r.findings.map((f) => `<li class="${esc(f.level)}">${esc(f.text)}</li>`).join('')}</ul>` : ''}</div>`;
}
async function dpPreShipReview(t) {
  toast('AI pre-ship review running…', 'loading');
  const r = await api(`/api/deploy/targets/${t.id}/preflight`, { method: 'POST' });
  t.preShip = r.review;
  const live = dp.targets.find((x) => x.id === t.id); if (live) live.preShip = r.review;
  toast(`Review: ${r.review.verdict}`, r.review.verdict === 'ready' ? 'success' : r.review.verdict === 'block' ? 'error' : 'warning');
  dpRenderMain();
  return r.review;
}
function dpRenderCards(t) {
  const repo = dpRepoOf(t);
  const runs = dpRunsFor(t.id); const last = runs[0];
  const lastShip = runs.find((r) => r.mode === 'ship');
  const lastOk = runs.find((r) => r.mode === 'ship' && r.status === 'succeeded');
  const manifest = last?.plan?.manifest || dp.plan?.manifest || repo?.manifest || null;
  const stack = manifest?.stack?.type ? `${manifest.stack.type}/${manifest.stack.framework || ''}` : (dp.det && dp.detRepo === t.repoId && dp.det.best ? `${dp.det.best.fragment.stack.type}/${dp.det.best.fragment.stack.framework}` : null);
  const buildWhere = last?.buildMode || (t.buildMode === 'auto' ? 'auto' : t.buildMode);
  const card = (cls, k, v, s, dot) => `<div class="sc ${cls}"><div class="sc-k">${dot ? `<span class="srv-dot ${dot}"></span>` : ''}${k}</div><div class="sc-v" title="${esc(v)}">${esc(v)}</div><div class="sc-s" title="${esc(s)}">${esc(s)}</div></div>`;
  const buildCls = last && dpIsActive(last) && ['build', 'package'].includes(last.stage) ? 'live' : lastShip?.stages?.some((x) => ['build', 'package'].includes(x.name) && x.status === 'failed') ? 'bad' : lastShip?.stages?.some((x) => x.name === 'build' && x.status === 'ok') ? 'ok' : '';
  const depCls = !lastShip ? '' : dpIsActive(lastShip) ? 'live' : lastShip.status === 'succeeded' ? 'ok' : lastShip.status === 'rolled_back' ? 'warn' : 'bad';
  const verify = lastShip?.stages?.find((x) => x.name === 'verify');
  const healthCls = !t.healthUrl ? 'warn' : !verify ? '' : verify.status === 'ok' ? 'ok' : verify.status === 'running' ? 'live' : 'bad';
  const dotOf = (c) => (c === 'ok' ? 'ok' : c === 'bad' ? 'bad' : c === 'warn' ? 'warn' : '');
  dpRenderReview(t);
  $('dpCards').innerHTML = [
    card(buildCls, 'Build', stack || 'not detected', `${buildWhere} build · ${manifest ? (manifest.build?.steps || []).length : '?'} step(s)`, dotOf(buildCls)),
    card(depCls, 'Deployment', !lastShip ? 'none yet' : dpIsActive(lastShip) ? `${lastShip.stage || 'running'}…` : lastShip.status.replace('_', ' '), lastShip ? `release ${lastShip.release || 'n/a'} · ${lastShip.trigger || ''}` : 'no ship has run', dotOf(depCls)),
    card(healthCls, 'Health', !t.healthUrl ? 'not configured' : !verify ? 'not checked' : verify.status === 'ok' ? 'healthy' : verify.status === 'running' ? 'checking…' : 'failed', t.healthUrl ? t.healthUrl.replace(/^https?:\/\//, '') : 'add a health URL to the target', dotOf(healthCls)),
    card('', 'Environment', dpHostOf(t) || t.type, t.type === 'paas' ? `${t.paths.root} · ${t.paas?.prod === false ? 'preview' : 'production'}` : `${t.type === 'vps-ssh' || t.type === 'local' ? t.paths.root : t.paths.docroot} · ${t.type === 'local' ? 'link swap' : t.type === 'vps-ssh' ? (t.web?.server || 'no web reload') : (t.docrootStrategy || 'auto')}`),
    card(lastOk ? 'ok' : '', 'Last deployment', lastOk ? dpFmtAgo(lastOk.endedAt || lastOk.startedAt) : 'never', lastOk ? `${lastOk.shortCommit ? lastOk.shortCommit + ' · ' : ''}${lastOk.release}` : 'ship once to populate'),
    card('', 'Duration', lastOk?.ms ? dpFmtMs(lastOk.ms) : last?.ms ? dpFmtMs(last.ms) : 'n/a', lastOk ? 'last successful ship' : last ? `last ${last.mode}` : `keep ${t.keepReleases} release(s)`),
  ].join('');
}

function dpRenderTab() {
  const t = dpTarget(); if (!t) return;
  if (dp.tab === 'overview') dpRenderOverview(t);
  else if (dp.tab === 'map') dpRenderMap(t);
  else if (dp.tab === 'plan') dpRenderPlan(t);
  else if (dp.tab === 'log') dpRenderLogBar(t);
  else if (dp.tab === 'releases') dpRenderReleases(t);
  else if (dp.tab === 'setup') dpRenderSetup(t);
  else if (dp.tab === 'manifest') dpRenderManifest(t);
}

/* ---------- overview: activity + details ---------- */
function dpRenderOverview(t) {
  const repo = dpRepoOf(t);
  const runs = dpRunsFor(t.id);
  const kv = (o) => `<dl class="dp-kv">${Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
  const prof = dp.profiles.find((p) => p.id === (t.ssh?.profileId || t.transport?.profileId));
  const verb = (r) => r.mode === 'plan' ? 'Planned' : r.mode === 'ship' ? (r.status === 'succeeded' ? 'Shipped' : dpIsActive(r) ? 'Shipping' : 'Ship ' + r.status.replace('_', ' ')) : (r.status === 'succeeded' ? 'Rolled back' : 'Rollback ' + r.status.replace('_', ' '));
  const activity = runs.length ? runs.slice(0, 12).map((r) => `
    <div class="act-row" data-run-log="${r.id}">
      <span class="act-dot ${dpIsActive(r) ? 'running' : r.status}"></span>
      <div><div class="act-title">${esc(verb(r))}${r.release ? ` release ${esc(r.release)}` : ''}${r.shortCommit ? ` <span style="color:var(--muted);font-weight:400">@ ${esc(r.shortCommit)}</span>` : ''}</div>
        <div class="act-sub">${esc(r.id)} · ${esc(r.trigger || 'ui')} · ${esc(r.buildMode || '')}${r.error ? ` · ${esc(r.error.slice(0, 140))}` : ''}${r.warningsCount || r.warnings?.length ? ` · ${r.warnings?.length || r.warningsCount} warning(s)` : ''}</div></div>
      <div class="act-right">${dpBadge(dpIsActive(r) ? 'running' : r.status)}<br>${esc(dpFmtAgo(r.startedAt))}${r.ms ? ` · ${esc(dpFmtMs(r.ms))}` : ''}${dp.status?.ai ? `<br><button class="ghost dp-mini act-chat" data-run-chat="${r.id}" title="Send this run's log to the AI chat">→ AI chat</button>` : ''}</div>
    </div>`).join('') : '<div class="empty-block"><b>No deployments yet</b>Run <b>Plan</b> to preview the exact commands, then Ship when the plan looks right.<br><button class="primary" data-act="plan">Plan a deployment</button></div>';
  let detCard = '';
  if (dp.det && dp.detRepo === t.repoId) {
    const d = dp.det, best = d.best;
    detCard = `<div class="dp-card"><h4>Detection ${d.ambiguous ? '<span class="dp-chip warn">not confident</span>' : '<span class="dp-chip ok">confident</span>'}</h4>
      ${best ? `<div class="dp-chips"><span class="dp-chip ok">${esc(best.label)}</span><span class="dp-chip">${esc(best.fragment.stack.type)}/${esc(best.fragment.stack.framework)}</span>${best.fragment.stack.packageManager ? `<span class="dp-chip">${esc(best.fragment.stack.packageManager)}</span>` : ''}<span class="dp-chip">runtime ${esc(best.fragment.runtime.kind)}</span>${best.root !== '.' ? `<span class="dp-chip">root ${esc(best.root)}</span>` : ''}<span class="dp-chip">score ${best.score}</span></div><div class="hint">evidence: ${esc(best.evidence.join(', '))}</div>` : `<div class="dp-warn">${esc(d.reason || 'no stack markers found')}</div>`}
      ${d.candidates.length > 1 ? `<div class="hint" style="margin-top:.3rem">other candidates: ${d.candidates.slice(1).map((c) => `${esc(c.id)} (${esc(c.root)}, ${c.score})`).join('; ')}</div>` : ''}
      ${d.shipJson ? '<div class="hint">ship.json found in the repo</div>' : ''}${d.shipJsonError ? `<div class="dp-err">${esc(d.shipJsonError)}</div>` : ''}
      ${d.resolved ? `<details style="margin-top:.4rem"><summary style="cursor:pointer;font-size:.78rem;color:var(--accent)">Resolved manifest</summary><pre style="font-size:.7rem">${esc(JSON.stringify(d.resolved, null, 2))}</pre></details>` : d.resolveError ? `<div class="dp-err">${esc(d.resolveError)}</div>` : ''}
      ${d.suggestion ? `<div class="dp-card" style="border-color:var(--amber);margin:.5rem 0 0"><h4>AI suggestion <span class="hint" style="margin:0">confidence ${d.suggestion.confidence}</span></h4><div class="hint">${esc(d.suggestion.reasoning || '')}</div><pre style="font-size:.7rem">${esc(JSON.stringify(d.suggestion.fragment, null, 2))}</pre><div class="dp-actions"><button class="primary" data-act="accept-ai">Accept as saved manifest</button></div></div>` : ''}
    </div>`;
  }
  let probeCard = '';
  if (dp.probe) {
    const p = dp.probe;
    probeCard = `<div class="dp-card"><h4>Server probe ${p.ok ? '<span class="dp-chip ok">connected</span>' : '<span class="dp-chip bad">failed</span>'}</h4>
      ${p.ok ? kv({ user: esc(`${p.user}@${p.host}`), shell: p.canExec ? 'yes' : '<span class="dp-warn">no (file transfer only)</span>', os: esc(`${p.probe.os || ''} ${p.probe.arch || ''}`), sudo: p.probe.sudo ? 'passwordless sudo available' : 'no passwordless sudo', tools: Object.entries(p.probe.versions || {}).filter(([, v]) => v).map(([k, v]) => `<span class="dp-chip">${esc(k)} ${esc(v)}</span>`).join(' ') || 'none detected', disk: esc(p.probe.disk || ''), 'current release': esc(p.probe.current || 'none'), writable: p.probe.rootWritable === false ? '<span class="dp-err">NO</span>' : 'yes', strategy: esc(p.strategy || '') }) : `<div class="dp-err">${esc(p.error)}</div>`}</div>`;
  }
  const targetKv = t.type === 'paas'
    ? { platform: esc(dpHostOf(t)), ...Object.fromEntries(Object.entries(t.paas || {}).filter(([k, v]) => v && !['provider', 'tokenRef', 'prod'].includes(k)).map(([k, v]) => [k, esc(String(v))])), token: esc(t.paas?.tokenRef || ''), mode: t.paas?.prod === false ? 'preview' : 'production', 'last deployment': (() => { const d = dpRunsFor(t.id).find((r) => r.deployment)?.deployment; return d ? `${d.url ? `<a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.url)}</a>` : ''}${d.id ? ` <span class="hint">id ${esc(d.id)}</span>` : ''}` : ''; })() }
    : t.type === 'local'
    ? { folder: esc(t.paths.root), 'after activation': esc(t.web?.reloadCmd || 'nothing'), process: esc(t.process?.manager === 'pm2' ? 'pm2 ' + t.process.name : 'none') }
    : t.type === 'vps-ssh'
    ? { server: esc(prof ? `${prof.user}@${prof.host}:${prof.port}` : t.ssh?.profileId), 'app root': esc(t.paths.root), domain: t.domain?.name ? `<a href="${t.domain.ssl ? 'https' : 'http'}://${esc(t.domain.name)}/" target="_blank" rel="noopener">${esc(t.domain.name)}</a>${t.domain.ssl ? " · Let's Encrypt" : ''}${t.domain.www ? ' · www' : ''}` : '', 'web server': esc(t.web?.server || 'none') + (t.web?.reloadCmd ? ` <span class="hint">${esc(t.web.reloadCmd)}</span>` : ''), 'php-fpm reload': esc(t.web?.phpFpmReload || ''), process: t.process?.manager && t.process.manager !== 'none' ? esc(`${t.process.manager} ${t.process.unit || t.process.name}`) : '' }
    : { transport: esc(t.transport.kind === 'sftp' ? `sftp ${prof ? prof.user + '@' + prof.host : ''}` : `${t.transport.kind} ${t.transport.user}@${t.transport.host}:${t.transport.port}`), home: esc(t.paths.home), docroot: esc(t.paths.docroot), strategy: esc(t.docrootStrategy) };
  Object.assign(targetKv, { build: esc(t.buildMode), 'keep releases': String(t.keepReleases), '.env': t.envFile?.fromVault ? esc(`${t.envFile.target} ← \${vault:${t.envFile.fromVault}} (${t.envFile.mode})`) : '', overrides: t.overrides ? `<details><summary style="cursor:pointer">${Object.keys(t.overrides).length} key(s)</summary><pre style="margin:.2rem 0 0;font-size:.7rem">${esc(JSON.stringify(t.overrides, null, 2))}</pre></details>` : '' });
  $('dpOverview').innerHTML = `<div class="ov-grid">
    <div><div class="dp-card"><h4>Recent activity <span class="hint" style="margin:0">${runs.length ? `${runs.length} run(s)` : ''}</span></h4>${activity}</div>${detCard}${probeCard}</div>
    <div>
      <div class="dp-card"><h4>Target</h4>${kv(targetKv)}</div>
      ${dpAutoCard(t)}
      ${repo ? `<div class="dp-card"><h4>Repository <span class="hint" style="margin:0">${esc(repo.name)}</span></h4>${kv({ source: esc(repo.source.kind === 'git' ? repo.source.url : repo.source.path), branch: esc(repo.source.branch || ''), auth: esc(repo.source.auth?.kind || (repo.source.kind === 'git' ? 'none' : '')), 'last fetch': repo.lastFetch ? `${esc(repo.lastFetch.commit?.slice(0, 8) || '')} ${esc(repo.lastFetch.subject || '')} <span class="hint">${dpFmtAgo(repo.lastFetch.at)}</span>` : '<span class="hint">never: click Fetch</span>', manifest: repo.manifest ? `${esc(repo.manifest.stack?.type || '?')}/${esc(repo.manifest.stack?.framework || '?')} <span class="hint">saved</span>` : '<span class="hint">none saved (detection + ship.json only)</span>' })}</div>` : '<div class="dp-card dp-err">The repository of this target no longer exists.</div>'}
    </div></div>`;
  $('dpOverview').querySelectorAll('[data-run-log]').forEach((b) => b.addEventListener('click', () => { dp.logRun = b.dataset.runLog; dpShowTab('log'); dpLoadLog(dp.logRun); }));
  $('dpOverview').querySelectorAll('[data-run-chat]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); dpRunToChat(b.dataset.runChat); }));
  dpWireAutoCard(t);
  const acceptAi = $('dpOverview').querySelector('[data-act="accept-ai"]');
  if (acceptAi) acceptAi.addEventListener('click', async (e) => { e.stopPropagation(); try { await api(`/api/deploy/repos/${t.repoId}/manifest`, { method: 'PUT', body: JSON.stringify({ manifest: dp.det.suggestion.fragment }) }); toast('Manifest saved', 'success'); dp.det.suggestion = null; await loadDeploy(); } catch (err) { toast(err.message, 'error'); } });
}

/* ---------- auto-ship card ---------- */
function dpAutoCard(t) {
  const a = t.autoShip;
  if (!a?.enabled) return `<div class="dp-card"><h4>Auto-ship <span class="dp-chip">off</span></h4><div class="hint">Deploy automatically on push (signed webhook) or by polling the remote. Enable it in the target settings.</div><div class="dp-actions" style="margin-top:.4rem"><button data-act="edit" style="padding:.2rem .6rem;font-size:.74rem">Enable auto-ship</button></div></div>`;
  return `<div class="dp-card" id="dpAutoCard"><h4>Auto-ship <span class="dp-chip ok">${esc(a.mode)}</span>${a.branch ? `<span class="dp-chip">${esc(a.branch)}</span>` : ''}</h4><div class="hint" id="dpAutoBody">loading…</div></div>`;
}
async function dpWireAutoCard(t) {
  const body = $('dpAutoBody'); if (!body) return;
  try {
    const w = await api(`/api/deploy/targets/${t.id}/webhook`);
    if (!w.enabled) { body.textContent = 'disabled'; return; }
    if (w.mode === 'webhook') {
      const L = w.listener || {};
      body.innerHTML = `<dl class="dp-kv"><dt>payload URL</dt><dd>${esc(w.url || '')} <button class="dp-mini" data-copy-text="${esc(w.url || '')}" title="Copy">⧉</button></dd><dt>secret</dt><dd><span class="dp-mono" style="user-select:all">${esc(w.secret)}</span> <button class="dp-mini" data-copy-text="${esc(w.secret)}" title="Copy">⧉</button></dd><dt>listener</dt><dd>${L.listening ? `<span style="color:var(--green)">listening on ${esc(L.bind)}:${L.port}</span>` : `<span style="color:var(--amber)">not listening${L.lastError ? ': ' + esc(L.lastError) : ''}</span>`}</dd></dl>
        <div class="hint" style="margin-top:.4rem">GitHub: Settings → Webhooks → payload URL above, content type <code>application/json</code>, secret above, event <b>push</b>. GitLab: Webhooks → URL + secret token. Expose 127.0.0.1:${L.port || 3001} with <code>cloudflared tunnel --url http://127.0.0.1:${L.port || 3001}</code> or a reverse proxy.</div>`;
    } else {
      const p = w.poller || {};
      body.innerHTML = `<dl class="dp-kv"><dt>every</dt><dd>${esc(String(w.pollMinutes))} min</dd><dt>last check</dt><dd>${p.lastCheck ? esc(dpFmtAgo(p.lastCheck)) : 'not yet'}${p.error ? ` <span class="dp-err">${esc(p.error)}</span>` : ''}</dd><dt>remote head</dt><dd>${esc(p.lastCommit ? p.lastCommit.slice(0, 8) : 'unknown')}</dd></dl><div class="dp-actions" style="margin-top:.4rem"><button data-poll-now style="padding:.2rem .6rem;font-size:.74rem">Poll now</button></div>`;
      body.querySelector('[data-poll-now]')?.addEventListener('click', async (e) => { e.stopPropagation(); try { await api(`/api/deploy/targets/${t.id}/poll-now`, { method: 'POST' }); toast('Polled', 'success'); dpWireAutoCard(t); } catch (err) { toast(err.message, 'error'); } });
    }
    body.querySelectorAll('[data-copy-text]').forEach((b) => b.addEventListener('click', async (e) => { e.stopPropagation(); try { await navigator.clipboard.writeText(b.dataset.copyText); toast('Copied', 'success'); } catch { toast('Clipboard blocked', 'warning'); } }));
  } catch (e) { body.innerHTML = `<span class="dp-err">${esc(e.message)}</span>`; }
}

/* ---------- deploy map (SVG) ---------- */
const STAGE_ORDER = ['connect', 'fetch', 'detect', 'plan', 'build', 'package', 'ship', 'activate', 'verify', 'rollback', 'cleanup'];
/* Deploy map zoom and pan: the SVG viewBox is the camera. The view is kept per target across live re-renders. */
function dpMapZoomInit(t, W, H) {
  const wrap = $('dpMapWrap'), svg = wrap && wrap.querySelector('svg.asc-map'); if (!svg) return;
  const base = { x: 0, y: 0, w: W, h: H };
  let v = dp.mapView && dp.mapView.tid === t.id && dp.mapView.bw === W ? dp.mapView : { tid: t.id, bw: W, ...base };
  const apply = () => { svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`); dp.mapView = v; const z = $('dpMapZoom'); if (z) z.textContent = Math.round((base.w / v.w) * 100) + '%'; };
  const zoomAt = (factor, cx, cy) => { // cx/cy in map units stay under the cursor
    const nw = Math.min(base.w * 3, Math.max(base.w / 8, v.w / factor)), nh = nw * (base.h / base.w);
    v = { tid: t.id, bw: W, x: cx - (cx - v.x) * (nw / v.w), y: cy - (cy - v.y) * (nh / v.h), w: nw, h: nh }; apply();
  };
  const toMap = (ev) => { const r = svg.getBoundingClientRect(); return { x: v.x + ((ev.clientX - r.left) / r.width) * v.w, y: v.y + ((ev.clientY - r.top) / r.height) * v.h }; };
  const fit = () => { v = { tid: t.id, bw: W, ...base }; apply(); };
  wrap.addEventListener('wheel', (e) => { e.preventDefault(); const c = toMap(e); zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, c.x, c.y); }, { passive: false });
  let drag = null;
  wrap.addEventListener('pointerdown', (e) => { if (e.button !== 0 || e.target.closest('button')) return; drag = { x: e.clientX, y: e.clientY, vx: v.x, vy: v.y }; wrap.classList.add('dragging'); try { wrap.setPointerCapture(e.pointerId); } catch {} });
  wrap.addEventListener('pointermove', (e) => { if (!drag) return; const r = svg.getBoundingClientRect(); v = { ...v, x: drag.vx - ((e.clientX - drag.x) / r.width) * v.w, y: drag.vy - ((e.clientY - drag.y) / r.height) * v.h }; apply(); });
  const end = () => { drag = null; wrap.classList.remove('dragging'); };
  wrap.addEventListener('pointerup', end); wrap.addEventListener('pointercancel', end); wrap.addEventListener('lostpointercapture', end);
  wrap.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) fit(); });
  wrap.addEventListener('keydown', (e) => { if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomAt(1.25, v.x + v.w / 2, v.y + v.h / 2); } else if (e.key === '-') { e.preventDefault(); zoomAt(1 / 1.25, v.x + v.w / 2, v.y + v.h / 2); } else if (e.key === '0') { e.preventDefault(); fit(); } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) { e.preventDefault(); const s = v.w * 0.08; v = { ...v, x: v.x + (e.key === 'ArrowRight' ? s : e.key === 'ArrowLeft' ? -s : 0), y: v.y + (e.key === 'ArrowDown' ? s : e.key === 'ArrowUp' ? -s : 0) }; apply(); } });
  const bar = $('dpMap').querySelector('.asc-zoom');
  bar.querySelector('[data-map="in"]').addEventListener('click', () => zoomAt(1.25, v.x + v.w / 2, v.y + v.h / 2));
  bar.querySelector('[data-map="out"]').addEventListener('click', () => zoomAt(1 / 1.25, v.x + v.w / 2, v.y + v.h / 2));
  bar.querySelector('[data-map="fit"]').addEventListener('click', fit);
  apply();
}
function dpRenderMap(t) {
  const repo = dpRepoOf(t);
  const runs = dpRunsFor(t.id); const last = runs[0] || null;
  const plan = (last && last.plan) || dp.plan || null;
  const manifest = plan?.manifest || repo?.manifest || null;
  const stages = Object.fromEntries((last?.stages || []).map((s) => [s.name, s]));
  const agg = (...names) => {
    const s = names.map((n) => stages[n]).filter(Boolean);
    if (!s.length) return 'pending';
    if (s.some((x) => x.status === 'running')) return 'running';
    if (s.some((x) => x.status === 'failed')) return 'failed';
    return 'ok';
  };
  const cut = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const host = dpHostOf(t) || 'server';
  const buildWhere = plan?.buildWhere || last?.buildMode || (t.buildMode === 'auto' ? 'auto' : t.buildMode);
  const remote = buildWhere === 'remote';
  const transport = t.type === 'vps-ssh' ? 'ssh + sftp' : t.type === 'local' ? 'local folder' : t.transport?.kind;
  const rels = dp.releases?.releases || [];
  const relRows = rels.length ? [...rels].reverse().slice(0, 5) : [last?.release && { ts: last.release, current: last.status === 'succeeded' && last.mode !== 'plan' }, last?.previousRelease && { ts: last.previousRelease, current: false }].filter(Boolean);
  const verifyStatus = t.healthUrl ? agg('verify') : 'pending';
  const rolledBack = last && ['rolled_back', 'rollback_failed'].includes(last.status);
  const node = (x, y, w, h, status, kicker, title, lines, icon) => `
    <rect class="node-box ${status}" x="${x}" y="${y}" width="${w}" height="${h}"/>
    <g transform="translate(${x + 16} ${y + 16})" class="icon ${status}">${icon}</g>
    <text class="node-kicker" x="${x + 48}" y="${y + 24}">${esc(kicker)}</text>
    <text class="node-title" x="${x + 48}" y="${y + 44}">${esc(cut(title, 22))}</text>
    ${lines.map((l, i) => `<text class="${l.dim ? 'node-dim' : 'node-line'}" x="${x + 16}" y="${y + 72 + i * 18}">${esc(cut(l.t ?? l, 30))}</text>`).join('')}`;
  const edge = (x1, x2, y, status, label) => `
    <path class="edge ${status}" d="M${x1} ${y} C ${x1 + 40} ${y}, ${x2 - 40} ${y}, ${x2 - 8} ${y}"/>
    <polygon points="${x2 - 10},${y - 6} ${x2},${y} ${x2 - 10},${y + 6}" fill="${status === 'ok' ? 'var(--green)' : status === 'failed' ? 'var(--red)' : status === 'running' ? 'var(--accent)' : '#3a4756'}"/>
    <text class="edge-label ${status}" x="${(x1 + x2) / 2}" y="${y - 12}">${esc(label)}</text>`;
  const ICON = {
    repo: '<circle cx="5" cy="4" r="3"/><circle cx="5" cy="20" r="3"/><circle cx="19" cy="8" r="3"/><path d="M5 7v10M19 11c0 4-6 3-10 6"/>',
    build: '<path d="M14 3l7 7-4 4-7-7zM10 7l-7 7 7 7 4-4"/><path d="M3 21l4-4"/>',
    ship: '<path d="M12 21V8M6 14l6-6 6 6"/><path d="M4 3h16"/>',
    server: '<rect x="3" y="3" width="18" height="7" rx="1.5"/><rect x="3" y="14" width="18" height="7" rx="1.5"/><path d="M7 6.5h.01M7 17.5h.01"/>',
  };
  const stackLine = manifest?.stack?.type ? `${manifest.stack.type}/${manifest.stack.framework || ''}${manifest.stack.packageManager ? ' · ' + manifest.stack.packageManager : ''}` : (dp.det && dp.detRepo === t.repoId && dp.det.best ? `${dp.det.best.fragment.stack.type}/${dp.det.best.fragment.stack.framework}` : 'stack: run Detect');
  const steps = manifest?.build?.steps || [];
  const W = 1180, H = 470, y = 120, nh = 190;
  const repoX = 30, buildX = 320, shipX = 610, srvX = 900, nw = 212;
  const cloud = remote
    ? `<rect class="cloud" x="${buildX - 18}" y="${y - 40}" width="${srvX + nw - buildX + 36}" height="${nh + 60}"/><text class="cloud-label" x="${buildX}" y="${y - 20}">on the server · ${esc(host)}</text>`
    : `<rect class="cloud" x="${repoX - 18}" y="${y - 40}" width="${shipX + nw - repoX + 36}" height="${nh + 60}"/><text class="cloud-label" x="${repoX}" y="${y - 20}">this machine · ${buildWhere === 'auto' ? 'build location decided at plan time' : 'local build'}</text>`;
  const pills = STAGE_ORDER.filter((s) => s !== 'rollback' || stages.rollback).map((s, i) => {
    const status = stages[s] ? (stages[s].status === 'ok' ? 'ok' : stages[s].status) : 'pending';
    const x = 30 + i * 108;
    return `<rect class="stage-pill ${status}" x="${x}" y="${H - 92}" width="98" height="24"/><text class="stage-txt ${status}" x="${x + 49}" y="${H - 79}">${esc(s)}${stages[s]?.ms ? ` · ${dpFmtMs(stages[s].ms)}` : ''}</text>`;
  }).join('');
  const meta = last ? `<text class="run-meta" x="30" y="40"><tspan style="fill:#dce3ea;font-weight:700">${esc(last.mode)} ${esc(dpIsActive(last) ? last.stage || 'running' : last.status.replace('_', ' '))}</tspan> · run ${esc(last.id)} · ${esc(last.trigger || '')} · ${esc(dpFmtAgo(last.startedAt))}${last.commit ? ` · ${esc(last.shortCommit || last.commit.slice(0, 8))}` : ''}${last.error ? `  ⚠ ${esc(cut(last.error, 90))}` : ''}</text>`
    : '<text class="run-meta" x="30" y="40">No run yet · Plan to light up the map.</text>';
  const legend = ['pending', 'running', 'ok', 'failed'].map((s, i) => `<rect class="swatch" x="${W - 330 + i * 80}" y="${H - 34}" width="10" height="10" fill="${s === 'ok' ? 'var(--green)' : s === 'failed' ? 'var(--red)' : s === 'running' ? 'var(--accent)' : '#3a4756'}"/><text class="legend" x="${W - 314 + i * 80}" y="${H - 25}">${s}</text>`).join('');
  const releasesSvg = relRows.length ? relRows.map((r, i) => `<circle class="rel-dot ${r.current ? 'current' : ''}" cx="${srvX + 22}" cy="${y + 112 + i * 17}" r="3.5"/><text class="rel-row ${r.current ? 'current' : ''}" x="${srvX + 32}" y="${y + 116 + i * 17}">${esc(r.ts)}${r.current ? ' · current' : ''}</text>`).join('')
    : `<text class="node-dim" x="${srvX + 16}" y="${y + 116}">no releases known yet</text>`;
  const svg = `<svg class="asc-map" viewBox="0 0 ${W} ${H}" role="img" aria-label="Deploy map of ${esc(t.name)}">
    ${meta}${cloud}
    ${node(repoX, y, nw, nh, agg('fetch', 'detect'), 'source', repo?.name || 'no repo', [repo ? (repo.source.kind === 'git' ? repo.source.url.replace(/^https?:\/\//, '') : repo.source.path) : '', repo?.source.branch ? `branch ${repo.source.branch}` : (last?.branch ? `branch ${last.branch}` : { t: 'default branch / working tree', dim: true }), last?.shortCommit ? `commit ${last.shortCommit}` : { t: repo?.lastFetch?.commit ? `commit ${repo.lastFetch.commit.slice(0, 8)}` : 'not fetched yet', dim: true }, stackLine], ICON.repo)}
    ${edge(repoX + nw, buildX, y + nh / 2, agg('fetch'), 'fetch')}
    ${node(buildX, y, nw, nh, agg('build', 'package'), `build · ${buildWhere}`, steps.length ? `${steps.length} step${steps.length === 1 ? '' : 's'}` : 'no build step', steps.length ? [...steps.slice(0, 4).map((s) => `$ ${s}`), ...(steps.length > 4 ? [{ t: `+ ${steps.length - 4} more`, dim: true }] : [])] : [{ t: 'files are shipped as they are', dim: true }], ICON.build)}
    ${edge(buildX + nw, shipX, y + nh / 2, agg('build', 'package'), remote ? 'build' : 'package')}
    ${node(shipX, y, nw, nh, agg('ship', 'activate'), `ship · ${transport}`, last?.release ? `release ${last.release}` : 'release <timestamp>', [t.type === 'vps-ssh' || t.type === 'local' ? `${t.paths.root}/releases/<ts>` : `${t.paths.docroot}${plan?.strategy || t.docrootStrategy ? ' · ' + (plan?.strategy || t.docrootStrategy) : ''}`, t.type === 'vps-ssh' ? 'current → releases/<ts> (atomic swap)' : (plan?.strategy === 'in-place' || t.transport.kind !== 'sftp' ? 'rename swap, previous copy kept' : 'current symlink + docroot binding'), { t: (manifest?.shared?.dirs?.length || manifest?.shared?.files?.length) ? `shared: ${[...(manifest.shared.files || []), ...(manifest.shared.dirs || [])].slice(0, 3).join(', ')}` : 'no shared paths', dim: true }, rolledBack ? { t: `⟲ rolled back to ${last.previousRelease || 'previous'}`, dim: false } : { t: last?.previousRelease ? `previous ${last.previousRelease}` : ' ', dim: true }], ICON.ship)}
    ${edge(shipX + nw, srvX, y + nh / 2, rolledBack ? 'failed' : agg('ship', 'activate'), rolledBack ? 'rolled back' : 'activate')}
    <rect class="node-box ${verifyStatus === 'pending' && agg('cleanup') === 'ok' ? 'ok' : verifyStatus}" x="${srvX}" y="${y}" width="${nw}" height="${nh}"/>
    <g transform="translate(${srvX + 16} ${y + 16})" class="icon ${verifyStatus}">${ICON.server}</g>
    <text class="node-kicker" x="${srvX + 48}" y="${y + 24}">target · ${esc(t.type === 'vps-ssh' ? 'vps' : t.type === 'local' ? 'this computer' : 'shared hosting')}</text>
    <text class="node-title" x="${srvX + 48}" y="${y + 44}">${esc(cut(host, 22))}</text>
    <text class="node-line" x="${srvX + 16}" y="${y + 72}">${esc(cut(t.paths.root || t.paths.docroot, 30))}</text>
    <text class="node-kicker" x="${srvX + 16}" y="${y + 96}">releases</text>
    ${releasesSvg}
    <text class="health-txt ${verifyStatus}" x="${srvX + 16}" y="${y + nh + 22}">${t.healthUrl ? `health ${esc(cut(t.healthUrl.replace(/^https?:\/\//, ''), 26))} · ${esc(verifyStatus === 'pending' ? 'not checked' : verifyStatus)}` : 'no health check configured'}</text>
    ${pills}${legend}
  </svg>`;
  $('dpMap').innerHTML = `<div class="asc-mapbar"><span class="hint">Live map of this target: nodes and arrows follow the ${last ? 'latest' : 'next'} run. Wheel to zoom, drag to pan, double-click to fit.</span><span class="spacer"></span>
      <span class="asc-zoom" role="group" aria-label="Zoom"><button type="button" data-map="out" title="Zoom out (-)" aria-label="Zoom out">−</button><span id="dpMapZoom" aria-live="polite">100%</span><button type="button" data-map="in" title="Zoom in (+)" aria-label="Zoom in">+</button><button type="button" data-map="fit" title="Fit the whole map (0)">Fit</button></span>
      <button data-act="map-releases" style="padding:.15rem .55rem;font-size:.72rem">${dp.releases ? 'Refresh releases' : 'Load releases from the server'}</button></div>
    <div class="asc-map-wrap" id="dpMapWrap" tabindex="0" aria-label="Deploy map: wheel to zoom, drag to pan, +/- keys to zoom, 0 to fit" style="--map-ar:${(W / H).toFixed(4)}">${svg}</div>`;
  $('dpMap').querySelector('[data-act="map-releases"]').addEventListener('click', async (e) => { e.stopPropagation(); try { dp.releases = await api(`/api/deploy/targets/${t.id}/releases`); dpRenderMap(t); } catch (err) { toast(err.message, 'error'); } });
  dpMapZoomInit(t, W, H);
}

/* ---------- plan ---------- */
function dpRenderPlan(t) {
  const p = dp.plan;
  if (!p) { $('dpPlan').innerHTML = '<div class="empty-block"><b>No plan yet</b>Plan is a read-only dry run: it connects, fetches, detects the stack and lists every command a Ship would execute.<br><button class="primary" data-act="plan">Run Plan</button></div>'; return; }
  const stages = [...new Set(p.steps.map((s) => s.stage))];
  const rows = stages.map((st) => `<tr class="stage-row"><td colspan="3">${esc(st)}</td></tr>` + p.steps.filter((s) => s.stage === st).map((s) => `<tr><td style="white-space:nowrap">${esc(s.where)}</td><td class="mono hint">${esc(s.cwd || '')}</td><td class="mono">${esc(s.cmd)}</td></tr>`).join('')).join('');
  const stale = p.commit && dpRepoOf(t)?.lastFetch?.commit && p.commit !== dpRepoOf(t).lastFetch.commit;
  $('dpPlan').innerHTML = `<div class="dp-card"><h4>Plan <span class="dp-chip">${esc(p.buildWhere)} build</span><span class="dp-chip">release ${esc(p.release)}</span>${p.commit ? `<span class="dp-chip">${esc(p.commit.slice(0, 8))}</span>` : ''}${p.strategy ? `<span class="dp-chip">${esc(p.strategy)}</span>` : ''}<span class="dp-chip hint">hash ${esc(p.hash)}</span></h4>
    ${stale ? '<div class="dp-warn">The repo has been fetched since this plan was made; re-plan before shipping.</div>' : ''}
    ${(p.warnings || []).map((w) => `<div class="dp-warn">⚠ ${esc(w)}</div>`).join('')}
    ${p.diff ? dpDiffHtml(p.diff) : ''}
    <div style="overflow:auto"><table class="dp-table"><thead><tr><th>where</th><th>cwd</th><th>command</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="dp-actions" style="margin-top:.6rem"><button class="btn-ship" data-act="ship-plan">${ICO.ship} Ship this plan</button><span class="hint">Shipping re-checks the plan hash, so the commands you reviewed are the ones that run.</span></div>
    <details style="margin-top:.5rem"><summary style="cursor:pointer;font-size:.78rem;color:var(--accent)">Manifest used</summary><pre style="font-size:.7rem">${esc(JSON.stringify(p.manifest, null, 2))}</pre></details></div>`;
  $('dpPlan').querySelector('[data-act="ship-plan"]').addEventListener('click', (e) => { e.stopPropagation(); dpShip(t, p.hash); });
}

function dpDiffHtml(d) {
  const rows = [];
  if (d.commits?.log?.length) rows.push(`<details><summary>${d.commits.count} commit(s) since ${esc(String(d.baseline?.commit || '').slice(0, 8))}</summary><pre class="dp-code">${esc(d.commits.log.join('\n'))}</pre></details>`);
  if (d.manifest?.length) rows.push(`<details><summary>${d.manifest.length} manifest change(s)</summary><table class="dp-table"><tbody>${d.manifest.map((m) => `<tr><td class="mono">${esc(m.path)}</td><td class="mono hint">${esc(JSON.stringify(m.from))}</td><td class="mono">${esc(JSON.stringify(m.to))}</td></tr>`).join('')}</tbody></table></details>`);
  if (d.steps && (d.steps.added?.length || d.steps.removed?.length)) rows.push(`<details><summary>commands: +${d.steps.added.length} / -${d.steps.removed.length}</summary>${d.steps.added.map((x) => `<div class="dp-diff add mono">+ [${esc(x.stage)}] ${esc(x.cmd)}</div>`).join('')}${d.steps.removed.map((x) => `<div class="dp-diff del mono">- [${esc(x.stage)}] ${esc(x.cmd)}</div>`).join('')}</details>`);
  return `<div class="dp-diffcard ${d.firstDeploy ? 'first' : ''}"><div class="dp-diff-head">Changes versus ${d.baseline ? `the last ship (release ${esc(d.baseline.release || '')})` : 'a fresh server'}</div><ul class="dp-diff-sum">${(d.summary || []).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>${rows.join('')}</div>`;
}

/* ---------- log ---------- */
function dpRenderLogBar(t) {
  const runs = dpRunsFor(t.id);
  const sel = $('dpRunSel');
  sel.innerHTML = runs.map((r) => `<option value="${r.id}" ${r.id === dp.logRun ? 'selected' : ''}>${esc(r.id)} · ${esc(r.mode)} · ${esc(dpIsActive(r) ? 'running' : r.status)}${r.release ? ' · ' + esc(r.release) : ''}</option>`).join('') || '<option value="">no runs yet</option>';
  const r = dp.runs.get(dp.logRun);
  $('btnDpExplain').hidden = !(r && !dpIsActive(r) && r.status !== 'succeeded' && dp.status?.ai);
  $('dpLogFilter').hidden = !dpAssist('logSearch');
  $('btnDpToChat').hidden = !(dp.status?.ai && dp.logRun);
  if (!runs.length) { $('dpLog').innerHTML = '<span class="dl-sys">No runs yet. Plan or Ship to stream the log here.</span>'; $('dpLog').dataset.run = ''; return; }
  if (dp.logRun && $('dpLog').dataset.run !== dp.logRun) dpLoadLog(dp.logRun);
}
$('dpRunSel').addEventListener('change', () => { dp.logRun = $('dpRunSel').value || null; dpLoadLog(dp.logRun); });
async function dpLoadLog(runId) {
  const el = $('dpLog');
  el.innerHTML = ''; el.dataset.run = runId || ''; dp.logCursor = 0;
  if (!runId) return;
  try {
    const d = await api(`/api/deploy/runs/${runId}/log?since=0`);
    dpAppendLog(runId, d.lines);
    const run = dp.runs.get(runId); const lastL = d.lines[d.lines.length - 1];
    if (run && lastL) { run.lastActivityAt = run.lastActivityAt && run.lastActivityAt > lastL.t ? run.lastActivityAt : lastL.t; if (!run.lastLine) run.lastLine = lastL.line.slice(0, 140); }
    $('dpLogHint').textContent = d.live ? 'live' : `${d.lines.length} lines`;
  } catch (e) { el.textContent = e.message; }
}
function dpAppendLog(runId, lines) {
  if (runId !== dp.logRun) return;
  const el = $('dpLog');
  const frag = document.createDocumentFragment();
  for (const l of lines) {
    if (l.n <= dp.logCursor) continue;
    dp.logCursor = l.n;
    const div = document.createElement('div');
    const isHead = l.stream === 'sys' && l.line.startsWith('── ');
    const isCmd = l.stream === 'sys' && l.line.startsWith('$ ');
    div.className = 'dl-line ' + (isHead ? 'dl-head' : isCmd ? 'dl-cmd' : l.stream === 'err' ? 'dl-err' : l.stream === 'sys' ? 'dl-sys' : '');
    div.innerHTML = isHead ? esc(l.line) : `<span class="dl-stage">${esc((l.stage || '').padEnd(8))}</span> ${esc(l.line)}`;
    frag.appendChild(div);
  }
  el.appendChild(frag);
  if ($('dpLogFilter').value) dpApplyLogFilter();
  while (el.childElementCount > 6000) el.removeChild(el.firstChild);
  if ($('dpAutoscroll').checked) el.scrollTop = el.scrollHeight;
}
function dpApplyLogFilter() {
  const q = $('dpLogFilter').value.trim();
  let re = null; if (q) { try { re = new RegExp(q, 'i'); } catch { re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); } }
  let n = 0;
  for (const line of $('dpLog').children) { const hit = !re || re.test(line.textContent); line.hidden = !hit; if (hit) n++; }
  if (re) $('dpLogHint').textContent = `${n} matching line(s)`;
}
$('dpLogFilter').addEventListener('input', dpApplyLogFilter);
function dpOpenProjectChat(projectId) {
  if (projectId && typeof setProject === 'function') {
    setProject(projectId);
    if (typeof currentProjectId === 'string' && currentProjectId !== projectId) return;
  }
  if (typeof openAgent === 'function') openAgent();
}
async function dpRunToChat(runId) {
  if (!runId) return;
  try {
    const r = await api(`/api/deploy/runs/${runId}/to-chat`, { method: 'POST', body: '{}' });
    toast(`${r.lines} log line(s) shared with the AI chat`, 'success');
    dpOpenProjectChat(r.projectId);
  } catch (e) { toast(e.message, 'error'); }
}
$('btnDpToChat').addEventListener('click', () => dpRunToChat(dp.logRun));
$('btnDpExplain').addEventListener('click', async () => {
  if (!dp.logRun) return;
  const runId = dp.logRun;
  $('btnDpExplain').disabled = true; $('dpLogHint').textContent = 'asking the AI…';
  try { const r = await api(`/api/deploy/runs/${runId}/explain`, { method: 'POST' }); const div = document.createElement('div'); div.className = 'dl-line dl-head'; div.textContent = '── AI analysis ──'; $('dpLog').appendChild(div); const body = document.createElement('div'); body.className = 'dl-line'; body.textContent = r.text; $('dpLog').appendChild(body); $('dpLog').scrollTop = $('dpLog').scrollHeight;
    if (r.proposal) { const prop = document.createElement('div'); prop.className = 'dl-line dl-head'; prop.textContent = `── proposed next step: ${r.proposal.action} on ${r.proposal.targetName} (approve it in the AI chat) ──`; $('dpLog').appendChild(prop); $('dpLogHint').textContent = 'a fix is proposed in the AI chat'; dpOpenProjectChat(r.projectId || dp.runs.get(runId)?.projectId); }
    else $('dpLogHint').textContent = 'analysis also posted in the AI chat'; }
  catch (e) { toast(e.message, 'error'); $('dpLogHint').textContent = ''; }
  finally { $('btnDpExplain').disabled = false; }
});

/* ---------- releases / setup / manifest ---------- */
async function dpRenderReleases(t) {
  const el = $('dpReleases');
  if (!dp.releases) {
    el.innerHTML = '<div class="hint">Connecting to the server…</div>';
    try { dp.releases = await api(`/api/deploy/targets/${t.id}/releases`); } catch (e) { el.innerHTML = `<div class="empty-block"><b>Could not list releases</b>${esc(e.message)}<br><button data-act="test">Test connection</button></div>`; return; }
    if (dp.tab !== 'releases') return;
  }
  const r = dp.releases;
  el.innerHTML = `<div class="dp-card"><h4>Releases on the server <span class="hint" style="margin:0">${r.canExec ? `current: ${esc(r.current || 'none')}` : 'in-place copies'}</span><button style="margin-left:auto;padding:.1rem .5rem;font-size:.7rem" data-act="refresh-rel">Refresh</button></h4>
    ${r.releases.length ? `<table class="dp-table"><thead><tr><th></th><th>release</th><th>commit</th><th>built</th><th></th></tr></thead><tbody>${[...r.releases].reverse().map((x) => `<tr><td>${x.current ? '<span class="dp-chip ok">current</span>' : ''}</td><td class="mono">${esc(x.ts)}</td><td class="mono">${esc(x.shortCommit || x.commit?.slice(0, 8) || '')} ${esc(x.branch || '')}</td><td class="hint">${esc(x.builtAt ? x.builtAt.replace('T', ' ').slice(0, 16) : '')}${x.builtOn ? ' on ' + esc(x.builtOn) : ''}</td><td>${x.current ? '' : `<button class="btn-rollback" data-rollback-to="${esc(x.ts)}" style="padding:.1rem .5rem;font-size:.7rem">Roll back to</button>`}</td></tr>`).join('')}</tbody></table>` : `<div class="empty-block"><b>No releases on the server yet</b>The first Ship creates <span class="dp-mono">${esc(t.type === 'vps-ssh' ? t.paths.root + '/releases/<timestamp>' : t.paths.docroot)}</span>; every later one is kept for rollback (${t.keepReleases} max).<br><button class="primary" data-act="plan">Plan the first release</button></div>`}</div>`;
  el.querySelector('[data-act="refresh-rel"]').addEventListener('click', (e) => { e.stopPropagation(); dp.releases = null; dpRenderReleases(t); });
  el.querySelectorAll('[data-rollback-to]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); dpRollback(t, b.dataset.rollbackTo); }));
}
async function dpRenderSetup(t) {
  const el = $('dpSetup');
  if (!dp.setup) { try { dp.setup = await api(`/api/deploy/targets/${t.id}/setup`); } catch (e) { el.innerHTML = `<div class="dp-err">${esc(e.message)}</div>`; return; } if (dp.tab !== 'setup') return; }
  const L = dp.setup.layout;
  el.innerHTML = `<div class="dp-card"><h4>Server layout</h4><dl class="dp-kv"><dt>releases</dt><dd>${esc(L.releases)}/&lt;YYYYMMDDHHmmss&gt;</dd><dt>current</dt><dd>${esc(L.current)} → releases/&lt;ts&gt;</dd><dt>shared</dt><dd>${esc(L.shared)} (.env, storage, uploads, build caches)</dd></dl><div class="hint" style="margin-top:.4rem">Copy-paste snippets below; The Ascension never edits server config itself. Point your web server at <b>current</b> so every release swap is atomic.</div></div>
    <div class="dp-tpl">${Object.entries(dp.setup.templates).map(([k, v], i) => `<h4 class="dp-card" style="padding:.4rem .6rem;margin:0 0 .3rem;display:flex;align-items:center;gap:.5rem;font-size:.76rem">${esc(k)}<button data-copy="${i}">Copy</button></h4><pre id="dpTpl${i}">${esc(v)}</pre>`).join('')}</div>`;
  el.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async (e) => { e.stopPropagation(); try { await navigator.clipboard.writeText($('dpTpl' + b.dataset.copy).textContent); toast('Copied', 'success'); } catch { toast('Clipboard blocked', 'warning'); } }));
}
function dpRenderManifest(t) {
  const repo = dpRepoOf(t);
  const ta = $('dpManifest');
  if (ta.dataset.repo !== (repo?.id || '')) { ta.value = repo?.manifest ? JSON.stringify(repo.manifest, null, 2) : ''; ta.dataset.repo = repo?.id || ''; }
  $('dpManifestMsg').textContent = '';
  $('dpManifestDownload').href = repo ? `/api/deploy/repos/${repo.id}/manifest/download` : '#';
  $('btnDpManifestDetected').disabled = !(dp.det && dp.detRepo === t.repoId && dp.det.best);
  const s = dp.det?.suggestion && dp.detRepo === t.repoId ? dp.det.suggestion : null;
  $('dpAiSuggestion').hidden = !s;
  if (s) { $('dpAiSuggestion').innerHTML = `<div class="agent-proposal"><div class="ap-head">AI-suggested manifest <span class="hint">(confidence ${s.confidence})</span></div><div class="ap-meta">${esc(s.reasoning || '')}</div><div class="actions"><button class="approve" id="btnDpUseAi">Load into editor</button></div></div>`; $('btnDpUseAi').addEventListener('click', () => { ta.value = JSON.stringify(s.fragment, null, 2); }); }
}
const dpManifestText = () => { const v = $('dpManifest').value.trim(); if (!v) return null; return JSON.parse(v); };
$('btnDpManifestValidate').addEventListener('click', async () => {
  try { const m = dpManifestText(); if (!m) { $('dpManifestMsg').textContent = 'empty: detection + ship.json only'; return; } const r = await fetch('/api/deploy/manifest/validate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ manifest: m }) }).then((x) => x.json()); $('dpManifestMsg').style.color = r.ok ? 'var(--green)' : 'var(--red)'; $('dpManifestMsg').textContent = r.ok ? 'valid' : r.errors.join('; '); if (r.ok) $('dpManifest').value = JSON.stringify(r.manifest, null, 2); }
  catch (e) { $('dpManifestMsg').style.color = 'var(--red)'; $('dpManifestMsg').textContent = 'invalid JSON: ' + e.message; }
});
$('btnDpManifestSave').addEventListener('click', async () => {
  const t = dpTarget(); if (!t) return;
  try { const m = dpManifestText(); const r = await api(`/api/deploy/repos/${t.repoId}/manifest`, { method: 'PUT', body: JSON.stringify({ manifest: m }) }); $('dpManifest').value = r.manifest ? JSON.stringify(r.manifest, null, 2) : ''; toast('Manifest saved', 'success'); await loadDeploy(); }
  catch (e) { $('dpManifestMsg').style.color = 'var(--red)'; $('dpManifestMsg').textContent = e.message; }
});
$('btnDpManifestDetected').addEventListener('click', () => { if (dp.det?.best) $('dpManifest').value = JSON.stringify(dp.det.resolved || dp.det.best.fragment, null, 2); });

/* ---------- actions (delegated on the whole target pane) ---------- */
$('dpTarget').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act; if (!act) return;
  const t = dpTarget(); if (!t) return;
  const repo = dpRepoOf(t);
  try {
    if (act === 'test') {
      toast('Connecting…', 'loading');
      try { const r = await api(`/api/deploy/targets/${t.id}/test`, { method: 'POST' }); dp.probe = { ok: true, ...r }; toast(`Connected to ${r.host}${r.canExec ? '' : ' (no shell)'}`, 'success'); }
      catch (err) { dp.probe = { ok: false, error: err.message }; toast(err.message, 'error'); }
      dpShowTab('overview');
    } else if (act === 'fetch') {
      if (!repo) return toast('Target has no repo', 'error');
      toast('Fetching…', 'loading');
      const r = await api(`/api/deploy/repos/${repo.id}/fetch`, { method: 'POST' });
      toast(r.commit ? `At ${r.shortCommit || r.commit.slice(0, 8)} (${r.branch || ''})${r.dirty ? 'working tree is dirty' : ''}` : 'Folder ready (not a git repo)', r.dirty ? 'warning' : 'success');
      await loadDeploy();
    } else if (act === 'detect') {
      if (!repo) return toast('Target has no repo', 'error');
      toast('Detecting…', 'loading');
      dp.det = await api(`/api/deploy/repos/${repo.id}/detect`, { method: 'POST', body: JSON.stringify({ ai: dpPrefAi() }) }); dp.detRepo = repo.id;
      toast(dp.det.best ? `${dp.det.best.label} detected` : 'No stack detected', dp.det.ambiguous ? 'warning' : 'success');
      dpRenderCards(t); dpShowTab('overview');
    } else if (act === 'plan') {
      const r = await api(`/api/deploy/targets/${t.id}/plan`, { method: 'POST', body: JSON.stringify({ ai: dpPrefAi() }) });
      dp.runs.set(r.run.id, r.run); dp.logRun = r.run.id; dpRenderMain(); dpShowTab('log'); dpLoadLog(r.run.id);
    } else if (act === 'ship') dpShip(t, null);
    else if (act === 'review') { await dpPreShipReview(t); }
    else if (act === 'rollback') dpRollback(t, null);
    else if (act === 'cancel') { const run = dpRunsFor(t.id)[0]; if (run) await api(`/api/deploy/runs/${run.id}/cancel`, { method: 'POST' }); }
    else if (act === 'log-last') { const run = dpRunsFor(t.id)[0]; if (run) { dp.logRun = run.id; dpShowTab('log'); dpLoadLog(run.id); } }
    else if (act === 'edit') dpOpenTargetModal(t);
    else if (act === 'duplicate') dpDuplicateTarget(t);
    else if (act === 'remove') {
      if (!(await confirmDialog({ title: 'Delete target', message: `Delete target <b>${esc(t.name)}</b>? Nothing is removed from the server.`, okLabel: 'Delete', okClass: 'reject' }))) return;
      await api(`/api/deploy/targets/${t.id}`, { method: 'DELETE' }); dp.sel = null; toast('Target deleted', 'success'); await loadDeploy();
    }
  } catch (err) { toast(err.message, 'error'); }
});
async function dpShip(t, planHash) {
  const repo = dpRepoOf(t);
  const env = dpEnvOf(t);
  let review = null;
  if (dpAssist('preShipReview')) {
    try { review = dpReviewFresh(t) ? t.preShip : await dpPreShipReview(t); }
    catch (e) { if (!(await confirmDialog({ title: 'Pre-ship review unavailable', message: `The AI review could not run: <b>${esc(e.message)}</b>. Continue without it?`, okLabel: 'Continue', okClass: 'warn' }))) return; }
  }
  const reviewHtml = review ? `<div class="dp-review-inline ${review.verdict === 'ready' ? 'ok' : review.verdict === 'block' ? 'bad' : 'warn'}"><b>AI review: ${esc(review.verdict)}</b>: ${esc(review.summary || '')}${(review.findings || []).length ? `<ul>${review.findings.map((f) => `<li class="${esc(f.level)}">${esc(f.text)}</li>`).join('')}</ul>` : ''}</div>` : '';
  const msg = `<p>Build and deploy <b>${esc(repo?.name || '?')}</b> to <b>${esc(t.name)}</b> <span class="env ${env}">${esc(env === 'neutral' ? t.type : env)}</span>${esc(t.type === 'vps-ssh' || t.type === 'local' ? t.paths.root : t.paths.docroot)} on ${esc(dpHostOf(t))}?</p>
    <ul style="margin:.3rem 0 .3rem 1rem;padding:0;font-size:.82rem;line-height:1.5">
      <li>build: <b>${esc(planHash ? dp.plan.buildWhere : t.buildMode)}</b>${planHash ? ` · plan hash <code>${esc(planHash)}</code> is re-checked` : ' · <span style="color:var(--amber)">no reviewed plan: it is computed and executed in one go</span>'}</li>
      <li>the current release stays live until the new one is fully prepared; the swap is atomic</li>
      <li>${t.healthUrl ? `health check <code>${esc(t.healthUrl)}</code>automatic rollback on failure` : '<span style="color:var(--amber)">no health check configured: failures after activation are NOT rolled back automatically</span>'}</li>
    </ul>${reviewHtml}`;
  if (!(await confirmDialog({ title: `Ship to ${t.name}`, message: msg, okLabel: review?.verdict === 'block' ? 'Ship anyway' : 'Ship now', okClass: review?.verdict === 'block' ? 'reject' : 'warn' }))) return;
  try {
    const r = await api(`/api/deploy/targets/${t.id}/ship`, { method: 'POST', body: JSON.stringify({ confirm: true, planHash: planHash || undefined, ai: dpPrefAi() }) });
    dp.runs.set(r.run.id, r.run); dp.logRun = r.run.id; dp.releases = null; dpRenderMain(); dpShowTab('log'); dpLoadLog(r.run.id);
  } catch (e) { toast(e.message, 'error'); }
}
async function dpRollback(t, release) {
  if (!(await confirmDialog({ title: `Roll back ${t.name}`, message: `Switch <b>${esc(t.name)}</b> back to ${release ? `release <b>${esc(release)}</b>` : 'the <b>previous release</b>'}? The web server / process is reloaded afterwards${t.healthUrl ? ' and the health check runs' : ''}.`, okLabel: 'Roll back', okClass: 'reject' }))) return;
  try {
    const r = await api(`/api/deploy/targets/${t.id}/rollback`, { method: 'POST', body: JSON.stringify({ confirm: true, release: release || undefined }) });
    dp.runs.set(r.run.id, r.run); dp.logRun = r.run.id; dp.releases = null; dpRenderMain(); dpShowTab('log'); dpLoadLog(r.run.id);
  } catch (e) { toast(e.message, 'error'); }
}

/* ---------- SSE ---------- */
function onDeployEvent(ev) {
  if (ev.type === 'run') {
    const run = ev; const prev = dp.runs.get(run.id);
    dp.runs.set(run.id, { ...prev, ...run, type: undefined, lastLine: prev?.lastLine, lastStageAt: prev && prev.stage === run.stage ? prev.lastStageAt : new Date().toISOString() });
    if (dpOpen() && run.targetId === dp.sel) {
      if (prev && dpIsActive(prev) && !dpIsActive(run)) { dp.releases = null; if (run.mode !== 'plan') toast(`${run.targetName}: ${run.mode} ${run.status.replace('_', ' ')}${run.error ? ': ' + run.error : ''}`, run.status === 'succeeded' ? 'success' : 'error'); loadDeploy(); }
      dpRenderMain();
    } else if (!dpOpen() && prev && dpIsActive(prev) && !dpIsActive(run) && run.mode !== 'plan') toast(`Deploy ${run.status.replace('_', ' ')}: ${run.targetName}`, run.status === 'succeeded' ? 'success' : 'error');
    if (dpOpen()) { dpRenderNav(); dpRenderHeader(); }
  } else if (ev.type === 'cloud') { const j = ev.job; if (!dp.cloudJob || dp.cloudJob.id === j.id || dp.cloudJob.status !== 'running') { const wasRunning = dp.cloudJob?.status === 'running'; dp.cloudJob = j; if (dpOpen()) { dpRenderCloudPanel(); if (wasRunning && j.status !== 'running') { toast(`Server ${j.spec?.name}: ${j.status}${j.error ? ': ' + j.error : ''}`, j.status === 'succeeded' ? 'success' : 'error'); loadDeploy(); } } } }
  else if (ev.type === 'log') {
    const run = dp.runs.get(ev.runId); const lastL = ev.lines[ev.lines.length - 1];
    if (run && lastL) { run.lastActivityAt = lastL.t; if (lastL.stream !== 'sys' || !lastL.line.startsWith('── ')) run.lastLine = lastL.line.slice(0, 140); }
    dpAppendLog(ev.runId, ev.lines);
    if (run && dpIsActive(run) && run.targetId === dp.sel) { const el = $('dpPipeline')?.querySelector('.pl-live'); if (el) el.outerHTML = dpLiveHtml(run); }
  }
  else if (ev.type === 'plan') { const r = dp.runs.get(ev.runId); if (r) r.plan = ev.plan; if (r && r.targetId === dp.sel) { dp.plan = ev.plan; if (dp.tab === 'plan') dpRenderTab(); } }
}

/* ---------- modals: repo ---------- */
function dpFillSelect(sel, items, current, placeholder) {
  sel.innerHTML = (placeholder ? `<option value="">${esc(placeholder)}</option>` : '') + items.map((i) => `<option value="${esc(i.value)}" ${i.value === current ? 'selected' : ''}>${esc(i.label)}</option>`).join('');
}
function dpOpenRepoModal(repo) {
  dp.editingRepo = repo;
  $('dpRepoTitle').textContent = repo ? `Edit repository "${repo.name}"` : 'Connect a repository';
  $('drName').value = repo?.name || '';
  $('drKind').value = repo?.source.kind || 'git';
  $('drUrl').value = repo?.source.url || ''; $('drBranch').value = repo?.source.branch || '';
  $('drAuth').value = repo?.source.auth?.kind || 'none';
  dpFillSelect($('drTokenRef'), dp.secrets.map((s) => ({ value: `\${vault:${s.name}}`, label: s.name })), repo?.source.auth?.tokenRef, dp.secrets.length ? 'pick a secret' : 'no secrets in the vault yet');
  $('drKeyPath').value = repo?.source.auth?.keyPath || ''; $('drPath').value = repo?.source.path || '';
  dpFillSelect($('drProviderToken'), dp.secrets.map((x) => ({ value: '${vault:' + x.name + '}', label: x.name })), repo?.source.auth?.tokenRef, dp.secrets.length ? 'token secret' : 'no secrets yet');
  $('drBrowse').hidden = true; $('drBrowseList').innerHTML = '';
  dpRepoSync(); $('dpRepoModal').showModal();
}
function dpRepoSync() {
  const kind = $('drKind').value, auth = $('drAuth').value;
  $('dpRepoModal').querySelectorAll('[data-kind]').forEach((d) => { d.hidden = d.dataset.kind !== kind; });
  $('dpRepoModal').querySelectorAll('[data-auth]').forEach((d) => { d.hidden = d.dataset.auth !== auth; });
}
$('drKind').addEventListener('change', dpRepoSync); $('drAuth').addEventListener('change', dpRepoSync);
$('btnDpRepoCancel').addEventListener('click', () => $('dpRepoModal').close());
let dpBrowseRows = [];
function dpRenderBrowse() {
  const q = $('drBrowseFilter').value.toLowerCase().trim();
  const rows = dpBrowseRows.filter((r) => !q || r.name.toLowerCase().includes(q)).slice(0, 80);
  $('drBrowseList').innerHTML = rows.length ? rows.map((r) => `<div class="dp-browse-row" data-i="${dpBrowseRows.indexOf(r)}"><b>${esc(r.name)}</b>${r.private ? '<span class="badge">private</span>' : ''}<span class="hint">${esc(r.defaultBranch || '')}${r.pushedAt ? ' · ' + esc(dpFmtAgo(r.pushedAt)) : ''}</span></div>`).join('') : '<div class="dp-empty-sec">No repositories match.</div>';
  $('drBrowseList').querySelectorAll('[data-i]').forEach((el) => el.addEventListener('click', () => {
    const r = dpBrowseRows[Number(el.dataset.i)];
    $('drUrl').value = r.url || r.sshUrl || ''; $('drBranch').value = r.defaultBranch || '';
    if (!$('drName').value.trim()) $('drName').value = r.name.split('/').pop();
    if ($('drAuth').value === 'none' && $('drProviderToken').value) { $('drAuth').value = 'https-token'; $('drTokenRef').value = $('drProviderToken').value; dpRepoSync(); }
    $('drBrowse').hidden = true;
  }));
}
$('btnDrBrowse').addEventListener('click', async () => {
  const kind = $('drProvider').value, tokenRef = $('drProviderToken').value;
  if (!kind) return toast('Pick a provider first', 'warning');
  if (!tokenRef) return toast('Store a personal access token in the vault and pick it here', 'warning');
  $('btnDrBrowse').disabled = true;
  try { const r = await api(`/api/deploy/providers/repos?kind=${encodeURIComponent(kind)}&tokenRef=${encodeURIComponent(tokenRef)}`); dpBrowseRows = r.repos; $('drBrowse').hidden = false; $('drBrowseFilter').value = ''; dpRenderBrowse(); toast(`${r.repos.length} repositories`, 'success'); }
  catch (e) { toast(e.message, 'error'); }
  finally { $('btnDrBrowse').disabled = false; }
});
$('drBrowseFilter').addEventListener('input', dpRenderBrowse);
$('dpRepoForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const kind = $('drKind').value, auth = $('drAuth').value;
  const body = { name: $('drName').value.trim(), source: kind === 'local' ? { kind, path: $('drPath').value.trim() } : { kind, url: $('drUrl').value.trim(), branch: $('drBranch').value.trim() || null, auth: auth === 'none' ? null : auth === 'https-token' ? { kind: auth, tokenRef: $('drTokenRef').value } : { kind: auth, keyPath: $('drKeyPath').value.trim() || null } } };
  try {
    const wasNew = !dp.editingRepo;
    const r = await api(dp.editingRepo ? `/api/deploy/repos/${dp.editingRepo.id}` : '/api/deploy/repos', { method: dp.editingRepo ? 'PUT' : 'POST', body: JSON.stringify(body) });
    $('dpRepoModal').close(); toast('Repository saved', 'success'); await loadDeploy();
    if (wasNew && !dp.targets.some((t) => t.repoId === r.id)) { dp.sel = null; dpRenderNav(); dpRenderMain(r.id); }
  } catch (err) { toast(err.message, 'error'); }
});

/* ---------- modals: target ---------- */
/* ===== Deployment target form (create / edit) ==================================================
   Intent-first layout: Source (what) → Server (where) → progressive disclosure (Environment, Health
   checks, Release settings, Automation details, Advanced overrides). Field ids are unchanged so
   templates, the wizard hand-off and dpTargetFormBody() keep working. Defaults are applied to NEW
   targets only; an existing target is shown exactly as stored (custom ports, paths, strategies). */
const TF_FIELD_FOR = [ // server-side validation message prefix → field id
  ['projectId', 'dtProject'],
  ['transport.host', 'dtFtpHost'], ['transport.user', 'dtFtpUser'], ['transport.passwordRef', 'dtFtpPass'], ['transport.profileId', 'dtSftpProfile'], ['transport.port', 'dtFtpPort'],
  ['paths.docroot', 'dtDocroot'], ['paths.home', 'dtHome'], ['paths.root', 'dtRoot'], ['ssh.profileId', 'dtProfile'], ['healthUrl', 'dtHealth'], ['overrides', 'dtOverrides'],
  ['autoShip.branch', 'dtAutoBranch'], ['name', 'dtName'], ['repoId', 'dtRepo'], ['envFile', 'dtEnvTarget'], ['paas.tokenRef', 'dtPaasToken'], ['paas.provider', 'dtPaasProvider'], ['process.', 'dtProcName'], ['domain.email', 'dtSslEmail'], ['domain.', 'dtDomain'], ['keepReleases', 'dtKeep'], ['docrootStrategy', 'dtStrategy'], ['web.', 'dtWeb'], ['buildMode', 'dtBuild'],
];
let tfState = { isNew: true, nameTouched: false, homeTouched: false, docrootTouched: false, rootTouched: false, portTouched: false, testOk: false, testedSig: null, secretFor: null };
const tfRepo = () => dp.repos.find((r) => r.id === $('dtRepo').value) || null;
const tfRepoBranch = () => { const r = tfRepo(); return r?.source?.branch || r?.lastFetch?.branch || ''; };
const tfSlug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'app';
const tfProfileOf = (id) => dp.profiles.find((p) => p.id === id) || null;
/** Releases folder derived from the deployment directory when the user left it empty (new targets). */
function tfDeriveHome(docroot, transport) {
  if (transport !== 'sftp') return '/'; // FTP accounts are chrooted: "/" is the account home
  const parts = String(docroot || '').split('/').filter(Boolean);
  return parts.length >= 2 ? '/' + parts.slice(0, -1).join('/') : '/';
}
function tfUniqueName(base) {
  const taken = new Set(dp.targets.filter((x) => x.id !== dp.editingTarget?.id).map((x) => x.name));
  let n = base, i = 2; while (taken.has(n)) n = `${base}-${i++}`; return n;
}
function tfParseConnUrl(str) {
  const m = /^(sftp|ftps?):\/\/(?:([^:@/]+)(?::[^@/]*)?@)?([^:/\s]+)(?::(\d+))?(\/[^\s]*)?$/i.exec(String(str || '').trim());
  if (!m) return null;
  return { kind: m[1].toLowerCase(), user: m[2] ? decodeURIComponent(m[2]) : '', host: m[3], port: m[4] ? Number(m[4]) : null, path: m[5] ? m[5].replace(/\/+$/, '') || '/' : '' };
}

function dpOpenTargetModal(t) {
  dp.editingTarget = t && t.id ? t : null; // a template application passes { ...data, id: undefined }: a prefilled NEW target
  const isNew = !dp.editingTarget;
  tfState = { isNew, nameTouched: !!t?.name, homeTouched: !!t?.paths?.home, docrootTouched: !!t?.paths?.docroot, rootTouched: !!t?.paths?.root, portTouched: !!t?.transport?.port, testOk: false, testedSig: null, secretFor: null };
  $('dpTargetTitle').textContent = isNew ? 'New deployment' : 'Edit deployment';
  $('btnDtSubmit').textContent = isNew ? 'Test & create' : 'Test & save';
  $('btnDtSaveAnyway').hidden = true;
  $('dtName').value = t?.name || '';
  dpFillProjectSelect('dtProject', t?.projectId);
  $('dtProjectHelp').textContent = isNew ? 'Every deployment belongs to one project. Servers and repositories can be reused.' : 'Changing this project moves the deployment. Earlier runs remain with their original project.';
  dpFillSelect($('dtRepo'), dp.repos.map((r) => ({ value: r.id, label: r.name })), t?.repoId || dp.repos[0]?.id, dp.repos.length ? null : 'connect a repository first');
  $('dtType').value = t?.type || 'shared-hosting'; $('dtBuild').value = t?.buildMode && t.buildMode !== 'provider' ? t.buildMode : 'auto';
  const profs = dp.profiles.map((p) => ({ value: p.id, label: `${p.name} (${p.user}@${p.host})` }));
  dpFillSelect($('dtProfile'), profs, t?.ssh?.profileId, profs.length ? 'Choose a server' : 'no SSH servers yet: add one');
  dpFillSelect($('dtSftpProfile'), profs, t?.transport?.profileId, profs.length ? 'Choose a server' : 'no SSH servers yet: add one');
  $('dtRoot').value = t?.paths?.root || ''; $('dtWeb').value = t?.web?.server || 'nginx'; $('dtReload').value = t?.web?.reloadCmd || ''; $('dtFpm').value = t?.web?.phpFpmReload || '';
  $('dtProc').value = t?.process?.manager || 'none'; $('dtProcName').value = t?.process?.unit || t?.process?.name || '';
  $('dtLocalRoot').value = t?.type === 'local' ? t.paths?.root || '' : ''; $('dtLocalProc').value = t?.type === 'local' ? t.process?.manager || 'none' : 'none'; $('dtLocalProcName').value = t?.type === 'local' ? t.process?.name || '' : ''; $('dtLocalReload').value = t?.type === 'local' ? t.web?.reloadCmd || '' : '';
  tfState.localRootTouched = t?.type === 'local' && !!t.paths?.root;
  $('dtDomain').value = t?.domain?.name || ''; $('dtSsl').checked = !!t?.domain?.ssl; $('dtSslEmail').value = t?.domain?.email || ''; $('dtWww').checked = !!t?.domain?.www;
  $('dtTransport').value = t?.transport?.kind || 'sftp'; $('dtFtpHost').value = t?.transport?.host || ''; $('dtFtpPort').value = t?.transport?.port || ''; $('dtFtpUser').value = t?.transport?.user || ''; $('dtConnUrl').value = '';
  dpRefreshSecretSelects(null, null, t);
  $('dtFtpSecure').value = t?.transport?.secure === 'implicit' ? 'implicit' : 'explicit';
  $('dtHome').value = t?.paths?.home || ''; $('dtDocroot').value = t?.paths?.docroot || ''; $('dtStrategy').value = t?.docrootStrategy || 'auto';
  $('dtHealthEnabled').checked = !!t?.healthUrl; $('dtHealth').value = t?.healthUrl || ''; $('dtHealthRemote').checked = !!t?.healthRemote; $('dtKeep').value = t?.keepReleases || '';
  $('dtEnvMode').value = t?.envFile?.mode || 'upload'; $('dtEnvTarget').value = t?.envFile?.target || '';
  $('dtOverrides').value = t?.overrides ? JSON.stringify(t.overrides, null, 2) : '';
  const provs = dp.status?.paasProviders || [];
  dpFillSelect($('dtPaasProvider'), provs.map((p) => ({ value: p.id, label: p.label })), t?.paas?.provider || 'vercel');
  $('dtPaasProd').checked = t?.paas?.prod !== false;
  dpPaasFields(t);
  $('dtAutoEnabled').checked = !!t?.autoShip?.enabled; $('dtAutoMode').value = t?.autoShip?.mode || 'webhook'; $('dtAutoBranch').value = t?.autoShip?.branch || ''; $('dtAutoPoll').value = t?.autoShip?.pollMinutes || '';
  dpFillTemplates(dp.editingTarget);
  // disclosures start open only when they hold something non-default
  $('dtSecEnv').open = !!t?.envFile?.fromVault;
  $('dtSecHealth').open = !!t?.healthUrl;
  $('dtSecRelease').open = !!(t && (t.docrootStrategy && t.docrootStrategy !== 'auto' || (t.keepReleases && ![2, 5].includes(Number(t.keepReleases))) || (t.paths?.home && t.type === 'shared-hosting' && t.paths.home !== tfDeriveHome(t.paths.docroot, t.transport?.kind))));
  $('dtSecAuto').open = !!(t?.autoShip?.enabled && (t.autoShip.mode === 'poll' || t.autoShip.branch));
  $('dtSecOverrides').open = !!t?.overrides;
  $('dtConnAdv').open = !!(t?.transport && t.transport.kind !== 'sftp' && (t.transport.port && t.transport.port !== (t.transport.secure === 'implicit' ? 990 : 21) || t.transport.secure === 'implicit'));
  $('dtVpsAdv').open = !!(t?.domain?.name || (t?.process?.manager && t.process.manager !== 'none') || (t?.buildMode && t.buildMode !== 'auto' && t.type === 'vps-ssh'));
  tfClearErrors(); tfSetTestResult(null);
  if (isNew && !t?.name) tfPrefillName();
  dpTargetSync();
  dpTargetWebhookInfo();
  $('dpTargetModal').showModal();
  setTimeout(() => $(isNew ? 'dtRepo' : 'dtName').focus(), 30);
}
function tfPrefillName() {
  if (tfState.nameTouched) return;
  const r = tfRepo(); if (!r) return;
  $('dtName').value = tfUniqueName(`${tfSlug(r.name)}-prod`);
}
/** Secret selects (FTP password, platform token, environment file): refresh from dp.secrets, keep or set a value. */
function dpRefreshSecretSelects(newName, forId, t) {
  const refOpts = dp.secrets.map((s) => ({ value: `\${vault:${s.name}}`, label: s.name }));
  const keep = (id, cur) => { const v = $(id).value; return newName && forId === id ? (id === 'dtEnvVault' ? newName : `\${vault:${newName}}`) : (v || cur || ''); };
  dpFillSelect($('dtFtpPass'), refOpts, keep('dtFtpPass', t?.transport?.passwordRef), refOpts.length ? 'Choose a secret' : 'no secrets yet: add one');
  dpFillSelect($('dtPaasToken'), refOpts, keep('dtPaasToken', t?.paas?.tokenRef), refOpts.length ? 'Choose a secret' : 'no secrets yet: add one');
  dpFillSelect($('dtEnvVault'), dp.secrets.map((s) => ({ value: s.name, label: s.name })), keep('dtEnvVault', t?.envFile?.fromVault || ''), 'None');
}

/* ---- conditional rendering, derived defaults, summaries ---- */
function dpTargetSync() {
  const type = $('dtType').value, tr = $('dtTransport').value, isFtp = tr !== 'sftp';
  const M = $('dpTargetModal');
  M.querySelectorAll('[data-type]').forEach((d) => { d.hidden = d.dataset.type !== type; });
  M.querySelectorAll('[data-type-only]').forEach((d) => { d.hidden = d.dataset.typeOnly !== type; });
  M.querySelectorAll('[data-transport]').forEach((d) => { const k = d.dataset.transport; d.hidden = k === 'sftp' ? isFtp : k === 'ftps' ? tr !== 'ftps' : !isFtp; });
  // build strategy is implied: shared hosting always builds locally, platforms decide themselves
  if (type === 'shared-hosting' || type === 'local') $('dtBuild').value = 'local'; else if (type === 'paas') $('dtBuild').value = 'auto';
  if (tfState.isNew && !tfState.localRootTouched && type === 'local') $('dtLocalRoot').value = dpLocalDefaultRoot($('dtName').value);
  $('dtLocalProcNameWrap').hidden = $('dtLocalProc').value === 'none';
  // protocol defaults (placeholders, never overwriting an explicit port)
  const defPort = tr === 'ftps' && $('dtFtpSecure').value === 'implicit' ? 990 : 21;
  $('dtFtpPort').placeholder = String(defPort);
  $('dtPortHelp').textContent = `Default for ${tr.toUpperCase()}: ${defPort}. Only change it for a custom port.`;
  if (tfState.isNew && !tfState.docrootTouched && type === 'shared-hosting') {
    const prof = tfProfileOf($('dtSftpProfile').value);
    $('dtDocroot').value = !isFtp && prof?.user && prof.user !== 'root' ? `/home/${prof.user}/public_html` : '/public_html';
  }
  if (tfState.isNew && !tfState.rootTouched && type === 'vps-ssh') $('dtRoot').value = `/var/www/${tfSlug($('dtName').value)}`;
  const derivedHome = tfDeriveHome($('dtDocroot').value.trim(), tr);
  $('dtHome').placeholder = derivedHome;
  $('dtHomeHelp').textContent = $('dtHome').value.trim() ? 'Custom releases folder for this target.' : `Derived from the deployment directory: ${derivedHome}. Leave empty to keep deriving it.`;
  $('dtStrategy').querySelectorAll('option').forEach((o) => { o.disabled = isFtp && !['auto', 'in-place'].includes(o.value); });
  if (type === 'shared-hosting' && isFtp && !['auto', 'in-place'].includes($('dtStrategy').value)) $('dtStrategy').value = 'auto';
  // environment / health / automation subordinate fields
  const envOn = !!$('dtEnvVault').value;
  M.querySelectorAll('[data-env="on"]').forEach((d) => { d.hidden = !envOn; });
  const healthOn = $('dtHealthEnabled').checked;
  M.querySelectorAll('[data-health="on"]').forEach((d) => { d.hidden = !healthOn; });
  $('dtHealthRemoteWrap').hidden = type !== 'vps-ssh';
  const autoOn = $('dtAutoEnabled').checked, mode = $('dtAutoMode').value;
  $('dtSecAuto').hidden = !autoOn;
  M.querySelectorAll('[data-auto]').forEach((d) => { d.hidden = d.dataset.auto !== mode; });
  $('dtProcNameWrap').hidden = $('dtProc').value === 'none';
  $('dtTestBox').hidden = false;
  // branch shown from the repository; automation may follow another one
  const branch = tfRepoBranch();
  $('dtBranchView').value = branch || 'default branch';
  $('dtAutoBranchLabel').textContent = $('dtAutoBranch').value.trim() || branch || 'the default branch';
  // summaries in collapsed headers
  $('dtEnvSum').textContent = envOn ? `${$('dtEnvVault').value} · ${$('dtEnvMode').selectedOptions[0]?.textContent.toLowerCase() || ''} · ${$('dtEnvTarget').value.trim() || 'shared/.env'}` : 'None';
  $('dtHealthSum').textContent = healthOn ? ($('dtHealth').value.trim().replace(/^https?:\/\//, '') || 'URL missing') + ($('dtHealthRemote').checked && type === 'vps-ssh' ? ' · from the server' : '') : 'Off';
  const keep = $('dtKeep').value || (type === 'shared-hosting' ? 2 : type === 'local' ? 3 : 5);
  const method = type === 'shared-hosting' ? ($('dtStrategy').selectedOptions[0]?.textContent.split(' (')[0].split(':')[0] || 'Auto') : type === 'vps-ssh' ? 'Atomic symlink swap' : type === 'local' ? 'Link swap on this computer' : 'Platform release';
  $('dtReleaseSum').textContent = `${method} · keep ${keep}`;
  $('dtAutoSum').textContent = autoOn ? `${mode === 'poll' ? `poll every ${$('dtAutoPoll').value || 5} min` : 'webhook'} · ${$('dtAutoBranch').value.trim() || branch || 'default branch'}` : '';
  $('dtOverridesSum').textContent = $('dtOverrides').value.trim() ? 'Configured' : 'None';
  $('dtConnSum').textContent = isFtp ? `${tr.toUpperCase()} · port ${$('dtFtpPort').value || defPort}${tr === 'ftps' ? ` · ${$('dtFtpSecure').value} TLS` : ''}` : 'SSH profile settings';
  $('dtVpsSum').textContent = [$('dtDomain').value.trim() ? `domain ${$('dtDomain').value.trim()}` : '', $('dtProc').value !== 'none' ? $('dtProc').value : '', $('dtBuild').value !== 'auto' ? `build ${$('dtBuild').value}` : ''].filter(Boolean).join(' · ') || 'defaults';
  // subtitle: repo · branch → destination
  const repo = tfRepo(); let dest = '';
  if (type === 'shared-hosting') { const prof = tfProfileOf($('dtSftpProfile').value); dest = isFtp ? `${$('dtFtpUser').value.trim() || '…'}@${$('dtFtpHost').value.trim() || '…'}:${$('dtDocroot').value.trim() || '…'}` : `${prof ? `${prof.user}@${prof.host}` : 'SFTP server'}:${$('dtDocroot').value.trim() || '…'}`; }
  else if (type === 'vps-ssh') { const prof = tfProfileOf($('dtProfile').value); dest = `${prof ? `${prof.user}@${prof.host}` : 'SSH server'}:${$('dtRoot').value.trim() || '…'}`; }
  else if (type === 'local') dest = `this computer:${$('dtLocalRoot').value.trim() || '…'}`;
  else dest = (dp.status?.paasProviders || []).find((p) => p.id === $('dtPaasProvider').value)?.label || 'platform';
  $('dtSubtitle').textContent = `${repo?.name || 'repository'} · ${branch || 'default branch'} → ${dest}`;
}
/* any edit invalidates a previous connection test */
$('dpTargetForm').addEventListener('input', (e) => {
  const id = e.target.id;
  if (id === 'dtName') tfState.nameTouched = true;
  if (id === 'dtHome') tfState.homeTouched = true;
  if (id === 'dtDocroot') tfState.docrootTouched = true;
  if (id === 'dtRoot') tfState.rootTouched = true;
  if (id === 'dtFtpPort') tfState.portTouched = true;
  if (id !== 'dtOverrides') tfClearError(id);
  tfState.testOk = false; $('btnDtSaveAnyway').hidden = true;
  dpTargetSync();
});
['dtType', 'dtTransport', 'dtAutoEnabled', 'dtAutoMode', 'dtHealthEnabled', 'dtEnvVault', 'dtEnvMode', 'dtProc', 'dtStrategy', 'dtFtpSecure', 'dtSftpProfile', 'dtProfile', 'dtBuild', 'dtPaasProvider'].forEach((id) => $(id).addEventListener('change', () => { tfState.testOk = false; $('btnDtSaveAnyway').hidden = true; dpTargetSync(); }));
$('dtRepo').addEventListener('change', () => { tfPrefillName(); dpTargetSync(); });
$('dtHealthEnabled').addEventListener('change', () => { if ($('dtHealthEnabled').checked) setTimeout(() => $('dtHealth').focus(), 20); });
$('dtTemplate').addEventListener('change', () => { const v = $('dtTemplate').value; if (v === '__manage') { $('dtTemplate').value = ''; dpManageTemplates(); } else if (v) dpApplyTemplate(v); });
$('btnDtSaveTemplate').addEventListener('click', dpSaveTemplateFromForm);
$('dtWeb').addEventListener('change', () => { const w = $('dtWeb').value; const def = { nginx: 'sudo -n systemctl reload nginx', apache: 'sudo -n systemctl reload apache2', none: '' }; if (!$('dtReload').value || Object.values(def).includes($('dtReload').value)) $('dtReload').value = def[w] || ''; });
const tfApplyConnUrl = (strict) => {
  const u = tfParseConnUrl($('dtConnUrl').value); if (!u) { if (strict && $('dtConnUrl').value.trim()) tfShowError('dtConnUrl', 'Use the form protocol://user@host:port/path'); return; }
  $('dtTransport').value = u.kind;
  if (u.kind === 'sftp') toast('SFTP uses a server profile: pick the server for ' + u.host, 'warning');
  else { $('dtFtpHost').value = u.host; if (u.user) $('dtFtpUser').value = u.user; if (u.port) { $('dtFtpPort').value = u.port; tfState.portTouched = true; } }
  if (u.path) { $('dtDocroot').value = u.path; tfState.docrootTouched = true; }
  $('dtConnUrl').value = ''; dpTargetSync();
};
$('dtConnUrl').addEventListener('change', () => tfApplyConnUrl(true));
$('dtConnUrl').addEventListener('input', () => tfApplyConnUrl(false)); // a pasted URL applies immediately
$('dpTargetModal').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  if (b.dataset.act === 'new-secret') { tfState.secretFor = b.dataset.for; dpOpenSecretModal(); }
  if (b.dataset.act === 'add-server') { $('addServerForm').hidden = false; setTimeout(() => $('asName')?.focus(), 30); }
});
// a server added from the form becomes selectable without leaving the form
$('serverFormModal')?.addEventListener('close', async () => {
  if (!$('dpTargetModal').open) return;
  try { const d = await api('/api/ssh/sessions'); dp.profiles = d.sessions; } catch { return; }
  const profs = dp.profiles.map((p) => ({ value: p.id, label: `${p.name} (${p.user}@${p.host})` }));
  const newest = dp.profiles[dp.profiles.length - 1];
  for (const id of ['dtProfile', 'dtSftpProfile']) { const cur = $(id).value; dpFillSelect($(id), profs, cur || (newest && !cur ? newest.id : ''), profs.length ? 'Choose a server' : 'no SSH servers yet: add one'); }
  dpTargetSync();
});
function dpPaasFields(t) {
  const p = (dp.status?.paasProviders || []).find((x) => x.id === $('dtPaasProvider').value);
  $('dtPaasHint').textContent = p ? `${p.tokenHint}. CLI: ${p.cli} (${p.install}). ${p.buildLocal ? 'The app is built locally and the output directory is uploaded.' : 'The platform builds the app itself.'}` : '';
  $('dtPaasFields').innerHTML = (p?.fields || []).map((f) => `<div class="tf-field"><label for="dtPaas-${esc(f.key)}">${esc(f.label)}${f.required || /optional/i.test(f.label) ? '' : ' <span class="hint">(optional)</span>'}</label><input id="dtPaas-${esc(f.key)}" data-paas-field="${esc(f.key)}" placeholder="${esc(f.placeholder || '')}" value="${esc((t?.paas && t.paas.provider === p.id && t.paas[f.key]) || '')}"></div>`).join('');
}
$('dtPaasProvider').addEventListener('change', () => dpPaasFields(dp.editingTarget));
$('btnDpTargetCancel').addEventListener('click', () => $('dpTargetModal').close());

/* ---- errors next to their fields; collapsed sections show a count ---- */
function tfFieldWrap(id) { return $(id)?.closest('.tf-field') || $(id)?.closest('label.chk')?.parentElement || null; }
function tfShowError(id, msg) {
  const wrap = tfFieldWrap(id); if (!wrap) return false;
  let err = wrap.querySelector(':scope > .tf-err'); if (!err) { err = document.createElement('p'); err.className = 'tf-err'; wrap.appendChild(err); }
  err.textContent = msg; err.hidden = false; err.id = err.id || `${id}-err`;
  const ctl = $(id); if (ctl) { ctl.setAttribute('aria-invalid', 'true'); ctl.setAttribute('aria-describedby', err.id); }
  const det = wrap.closest('details'); if (det) det.open = true;
  tfCountIssues();
  return true;
}
function tfClearError(id) { const wrap = tfFieldWrap(id); const err = wrap?.querySelector(':scope > .tf-err'); if (err && err.id !== 'dtOverridesErr') err.remove(); else if (err) err.hidden = true; $(id)?.removeAttribute('aria-invalid'); tfCountIssues(); }
function tfClearErrors() { $('dpTargetModal').querySelectorAll('.tf-err:not(#dtOverridesErr):not(#dtFormError)').forEach((e) => e.remove()); $('dtOverridesErr').hidden = true; $('dpTargetModal').querySelectorAll('[aria-invalid]').forEach((e) => e.removeAttribute('aria-invalid')); $('dtFormError').hidden = true; tfCountIssues(); }
function tfCountIssues() {
  $('dpTargetModal').querySelectorAll('details.tf-more').forEach((d) => { const n = [...d.querySelectorAll('.tf-err')].filter((e) => !e.hidden).length; const b = d.querySelector(':scope > summary .tf-issues'); if (b) { b.hidden = !n; b.textContent = n ? `${n} issue${n === 1 ? '' : 's'}` : ''; } });
}
function tfMapServerError(msg) {
  const m = String(msg || '');
  for (const [prefix, id] of TF_FIELD_FOR) if (m.startsWith(prefix) || m.includes(` ${prefix}`)) return id;
  if (/a target named/.test(m)) return 'dtName';
  return null;
}
function tfFriendlyConnError(msg) {
  const m = String(msg || '');
  if (/ENOTFOUND|getaddrinfo/i.test(m)) return 'The host name could not be resolved. Check the host.';
  if (/ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|timed out|Timed out/i.test(m)) return 'The server did not answer on that port. Check the host, the port and that the service is running.';
  if (/530|Login|authentication|Authentication|password|Permission denied|publickey/i.test(m)) return 'Could not authenticate with this server. Check the username and the selected credential.';
  if (/certificate|self.signed|TLS|handshake/i.test(m)) return 'The TLS handshake failed. Try the other TLS mode under Advanced connection settings.';
  return m.replace(/^connection failed:\s*/i, '');
}
/** Client-side validation → [{ id, msg }] */
function tfValidate() {
  const errs = []; const type = $('dtType').value, tr = $('dtTransport').value;
  const need = (id, msg) => { if (!$(id).value.trim()) errs.push({ id, msg }); };
  need('dtName', 'Give this deployment a name.'); need('dtRepo', 'Choose a repository.');
  if (!dpValidProject($('dtProject').value)) errs.push({ id: 'dtProject', msg: 'Choose the project for this deployment.' });
  if (type === 'shared-hosting') {
    if (tr === 'sftp') need('dtSftpProfile', 'Choose the SSH server profile.');
    else { need('dtFtpHost', 'Enter the FTP host.'); need('dtFtpUser', 'Enter the FTP username.'); need('dtFtpPass', 'Choose the vault secret holding the password.'); if ($('dtFtpPort').value && !(Number($('dtFtpPort').value) >= 1 && Number($('dtFtpPort').value) <= 65535)) errs.push({ id: 'dtFtpPort', msg: 'Port must be between 1 and 65535.' }); }
    const dr = $('dtDocroot').value.trim(); if (!dr) errs.push({ id: 'dtDocroot', msg: 'Enter the deployment directory (for example /public_html).' }); else if (!dr.startsWith('/') || dr.includes('..')) errs.push({ id: 'dtDocroot', msg: 'Use an absolute path without "..".' });
    const home = $('dtHome').value.trim(); if (home && (!home.startsWith('/') || home.includes('..'))) errs.push({ id: 'dtHome', msg: 'Use an absolute path without "..".' });
  } else if (type === 'vps-ssh') {
    need('dtProfile', 'Choose the SSH server profile.');
    const root = $('dtRoot').value.trim(); if (!root) errs.push({ id: 'dtRoot', msg: 'Enter the deployment directory (for example /var/www/shop).' }); else if (!root.startsWith('/') || root.split('/').filter(Boolean).length < 2) errs.push({ id: 'dtRoot', msg: 'Use an absolute path at least two levels deep, such as /var/www/shop.' });
    if ($('dtProc').value !== 'none') need('dtProcName', $('dtProc').value === 'systemd' ? 'Enter the systemd unit name.' : 'Enter the pm2 app name.');
    if ($('dtSsl').checked && $('dtDomain').value.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test($('dtSslEmail').value.trim())) errs.push({ id: 'dtSslEmail', msg: "Let's Encrypt needs a contact e-mail." });
  } else if (type === 'local') {
    const root = $('dtLocalRoot').value.trim();
    if (!root) errs.push({ id: 'dtLocalRoot', msg: 'Enter the folder on this computer (for example C:\\www\\shop).' }); else if (!isAbsLocal(root)) errs.push({ id: 'dtLocalRoot', msg: 'Use an absolute path on this computer.' });
    if ($('dtLocalProc').value === 'pm2') need('dtLocalProcName', 'Enter the pm2 app name.');
  } else need('dtPaasToken', 'Choose the vault secret holding the platform token.');
  if ($('dtHealthEnabled').checked) { const u = $('dtHealth').value.trim(); if (!/^https?:\/\/\S+/.test(u)) errs.push({ id: 'dtHealth', msg: 'Enter the full URL to check, starting with http:// or https://.' }); }
  if ($('dtEnvVault').value && $('dtEnvTarget').value.includes('..')) errs.push({ id: 'dtEnvTarget', msg: 'Use a path relative to the deployment directory.' });
  const keep = $('dtKeep').value; if (keep && !(Number(keep) >= 2 && Number(keep) <= 50)) errs.push({ id: 'dtKeep', msg: 'Keep between 2 and 50 releases.' });
  if ($('dtAutoEnabled').checked && $('dtAutoMode').value === 'poll' && $('dtAutoPoll').value && !(Number($('dtAutoPoll').value) >= 1 && Number($('dtAutoPoll').value) <= 1440)) errs.push({ id: 'dtAutoPoll', msg: 'Poll between 1 and 1440 minutes.' });
  if ($('dtOverrides').value.trim()) { try { const o = JSON.parse($('dtOverrides').value); if (!o || typeof o !== 'object' || Array.isArray(o)) errs.push({ id: 'dtOverrides', msg: 'Overrides must be a JSON object.' }); } catch (e) { errs.push({ id: 'dtOverrides', msg: 'Invalid JSON: ' + e.message }); } }
  return errs;
}
function tfShowErrors(errs) {
  tfClearErrors();
  for (const e of errs) { if (e.id === 'dtOverrides') { $('dtOverridesErr').textContent = e.msg; $('dtOverridesErr').hidden = false; $('dtSecOverrides').open = true; $('dtOverrides').setAttribute('aria-invalid', 'true'); } else if (!tfShowError(e.id, e.msg)) { $('dtFormError').textContent = e.msg; $('dtFormError').hidden = false; } }
  tfCountIssues();
  const first = errs[0] && $(errs[0].id); if (first) { try { first.focus({ preventScroll: false }); } catch {} }
}

/* ---- payload: unchanged contract, derived defaults filled in ---- */
function dpTargetFormBody(overrides) {
  if (overrides === undefined && $('dtOverrides').value.trim()) { try { overrides = JSON.parse($('dtOverrides').value); } catch { overrides = null; } }
  const type = $('dtType').value;
  const body = { name: $('dtName').value.trim(), repoId: $('dtRepo').value, projectId: $('dtProject').value, type, buildMode: type === 'shared-hosting' || type === 'local' ? 'local' : $('dtBuild').value, healthUrl: $('dtHealthEnabled').checked ? $('dtHealth').value.trim() : '', healthRemote: type === 'vps-ssh' && $('dtHealthEnabled').checked && $('dtHealthRemote').checked, keepReleases: Number($('dtKeep').value) || undefined, overrides: overrides || null,
    envFile: $('dtEnvVault').value ? { fromVault: $('dtEnvVault').value, mode: $('dtEnvMode').value, target: $('dtEnvTarget').value.trim() || 'shared/.env' } : null,
    autoShip: $('dtAutoEnabled').checked ? { enabled: true, mode: $('dtAutoMode').value, branch: $('dtAutoBranch').value.trim() || null, pollMinutes: Number($('dtAutoPoll').value) || undefined } : { enabled: false } };
  if (type === 'paas') { const paas = { provider: $('dtPaasProvider').value, tokenRef: $('dtPaasToken').value, prod: $('dtPaasProd').checked }; $('dtPaasFields').querySelectorAll('[data-paas-field]').forEach((i) => { paas[i.dataset.paasField] = i.value.trim(); }); Object.assign(body, { paas }); }
  else if (type === 'vps-ssh') Object.assign(body, { domain: $('dtDomain').value.trim() ? { name: $('dtDomain').value.trim(), ssl: $('dtSsl').checked, email: $('dtSslEmail').value.trim(), www: $('dtWww').checked } : null, ssh: { profileId: $('dtProfile').value }, paths: { root: $('dtRoot').value.trim() }, web: { server: $('dtWeb').value, reloadCmd: $('dtReload').value.trim(), phpFpmReload: $('dtFpm').value.trim() }, process: { manager: $('dtProc').value, unit: $('dtProc').value === 'systemd' ? $('dtProcName').value.trim() : '', name: $('dtProc').value === 'pm2' ? $('dtProcName').value.trim() : '' } });
  else if (type === 'local') Object.assign(body, { paths: { root: $('dtLocalRoot').value.trim() }, web: { reloadCmd: $('dtLocalReload').value.trim() }, process: { manager: $('dtLocalProc').value, name: $('dtLocalProcName').value.trim() } });
  else {
    const tr = $('dtTransport').value, docroot = $('dtDocroot').value.trim();
    Object.assign(body, { transport: tr === 'sftp' ? { kind: 'sftp', profileId: $('dtSftpProfile').value } : { kind: tr, host: $('dtFtpHost').value.trim(), port: Number($('dtFtpPort').value) || undefined, user: $('dtFtpUser').value.trim(), passwordRef: $('dtFtpPass').value, secure: $('dtFtpSecure').value === 'implicit' ? 'implicit' : true }, paths: { home: $('dtHome').value.trim() || tfDeriveHome(docroot, tr), docroot }, docrootStrategy: $('dtStrategy').value });
  }
  return body;
}

/* ---- connection test (real backend probe of the draft), Test & save ---- */
function tfSetTestResult(state, html) {
  const box = $('dtTestResult'); box.className = 'tf-test-result' + (state ? ' ' + state : ''); box.innerHTML = html || '';
  $('btnDtTest').disabled = state === 'testing';
}
async function tfRunTest(body) {
  tfSetTestResult('testing', '<span class="spinner"></span> Connecting…');
  try {
    const r = await api('/api/deploy/targets/test', { method: 'POST', body: JSON.stringify({ ...body, id: dp.editingTarget?.id || undefined }) });
    const dir = r.dir ? (r.dir.exists ? `<b>${esc(r.dir.path)}</b> exists${r.dir.writable === false ? ' but is <b>not writable</b>' : r.dir.writable ? ' and is writable' : ''}` : `<b>${esc(r.dir.path)}</b> does not exist yet: it will be created on the first deploy`) : '';
    const who = r.host ? `${esc(r.user || '')}@${esc(r.host)}` : (r.cli ? `${esc(r.cli)} CLI ready` : 'connected');
    tfSetTestResult('ok', `✓ Connection successful · ${who}${r.canExec === false ? ' · file transfer only (no shell)' : ''}${dir ? '<br>' + dir : ''}${r.strategy ? `<br>Publishing method: <b>${esc(r.strategy)}</b>` : ''}`);
    tfState.testOk = true; tfState.testedSig = JSON.stringify(body);
    return true;
  } catch (e) {
    const fid = tfMapServerError(e.message);
    if (fid) tfShowError(fid, e.message);
    tfSetTestResult('bad', `✕ ${esc(tfFriendlyConnError(e.message))}${fid ? '' : `<br><span class="hint">${esc(e.message)}</span>`}`);
    tfState.testOk = false;
    return false;
  }
}
$('btnDtTest').addEventListener('click', async () => { const errs = tfValidate().filter((e) => !['dtName', 'dtRepo'].includes(e.id)); if (errs.length) return tfShowErrors(errs); await tfRunTest(dpTargetFormBody()); });
async function tfSave(body) {
  try {
    const r = await api(dp.editingTarget ? `/api/deploy/targets/${dp.editingTarget.id}` : '/api/deploy/targets', { method: dp.editingTarget ? 'PUT' : 'POST', body: JSON.stringify(body) });
    $('dpTargetModal').close(); toast(dp.editingTarget ? 'Deployment saved' : 'Deployment created', 'success'); await loadDeploy(); dpSelect(r.id);
  } catch (err) {
    const fid = tfMapServerError(err.message);
    if (fid) tfShowErrors([{ id: fid, msg: err.message }]); else { $('dtFormError').textContent = err.message; $('dtFormError').hidden = false; }
  }
}
$('dpTargetForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errs = tfValidate(); if (errs.length) return tfShowErrors(errs);
  tfClearErrors();
  const body = dpTargetFormBody();
  $('btnDtSubmit').disabled = true;
  try {
    const ok = tfState.testOk && tfState.testedSig === JSON.stringify(body) ? true : await tfRunTest(body);
    if (!ok) { $('btnDtSaveAnyway').hidden = false; return; }
    await tfSave(body);
  } finally { $('btnDtSubmit').disabled = false; }
});
$('btnDtSaveAnyway').addEventListener('click', async () => { const errs = tfValidate(); if (errs.length) return tfShowErrors(errs); await tfSave(dpTargetFormBody()); });

/* ---- webhook: URL + secret shown for saved targets; rotation is an explicit, confirmed action ---- */
async function dpTargetWebhookInfo() {
  const t = dp.editingTarget, box = $('dtWebhookInfo');
  if (!t || !t.autoShip?.enabled) { box.innerHTML = `<span class="hint">${t ? 'Enable automatic deployment and save: the webhook URL and its secret appear here.' : 'The webhook URL and its secret appear here once the target is saved.'}</span>`; return; }
  try {
    const w = await api(`/api/deploy/targets/${t.id}/webhook`);
    if (!w.enabled) { box.innerHTML = '<span class="hint">Automatic deployment is off.</span>'; return; }
    box.innerHTML = `<div class="tf-kv"><span>URL</span><code>${esc(w.url || 'listener not running')}</code><button type="button" class="tf-mini" data-copy="${esc(w.url || '')}">Copy</button></div>
      <div class="tf-kv"><span>Secret</span><code id="dtHookSecret" data-secret="${esc(w.secret || '')}">••••••••••••••••</code><button type="button" class="tf-mini" id="btnDtHookReveal">Reveal</button><button type="button" class="tf-mini" data-copy="${esc(w.secret || '')}">Copy</button><button type="button" class="tf-mini warn" id="btnDtRotate">Rotate secret…</button></div>`;
    box.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => { try { await navigator.clipboard.writeText(b.dataset.copy); toast('Copied', 'success'); } catch { toast('Clipboard blocked', 'warning'); } }));
    $('btnDtHookReveal').addEventListener('click', () => { const c = $('dtHookSecret'); const shown = c.textContent !== '••••••••••••••••'; c.textContent = shown ? '••••••••••••••••' : c.dataset.secret; $('btnDtHookReveal').textContent = shown ? 'Reveal' : 'Hide'; });
    $('btnDtRotate').addEventListener('click', async () => {
      const ok = await confirmDialog({ title: 'Rotate the webhook secret', message: `Pushes signed with the current secret will be <b>rejected</b> as soon as it is rotated. Update the webhook configuration on ${esc(w.mode === 'webhook' ? 'the git provider' : 'the provider')} with the new secret afterwards.`, okLabel: 'Rotate secret', okClass: 'warn' });
      if (!ok) return;
      try {
        const fresh = dp.targets.find((x) => x.id === t.id) || t;
        const body = { ...fresh, autoShip: { ...(fresh.autoShip || {}), enabled: true, rotateSecret: true } }; delete body.locked; delete body.lastRun; delete body.preShip; delete body.lastProbe;
        await api(`/api/deploy/targets/${t.id}`, { method: 'PUT', body: JSON.stringify(body) });
        toast('Webhook secret rotated', 'success'); await loadDeploy(); dp.editingTarget = dp.targets.find((x) => x.id === t.id) || t; dpTargetWebhookInfo();
      } catch (e) { toast(e.message, 'error'); }
    });
  } catch (e) { box.innerHTML = `<span class="hint">${esc(e.message)}</span>`; }
}

/* ---------- modals: secret ---------- */
function dpOpenSecretModal() { $('dsName').value = ''; $('dsValue').value = ''; $('dpSecretModal').showModal(); $('dsName').focus(); }
$('btnDpSecretCancel').addEventListener('click', () => $('dpSecretModal').close());
$('dpSecretForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await api(`/api/deploy/secrets/${encodeURIComponent($('dsName').value.trim())}`, { method: 'PUT', body: JSON.stringify({ value: $('dsValue').value }) }); $('dpSecretModal').close(); toast('Secret stored', 'success'); await loadDeploy(); if ($('dpTargetModal').open) { dpRefreshSecretSelects($('dsName').value.trim(), tfState.secretFor, dp.editingTarget); tfState.secretFor = null; dpTargetSync(); } if ($('dpRepoModal').open) dpOpenRepoModal(dp.editingRepo); }
  catch (err) { toast(err.message, 'error'); }
});

/* ---------- header: add menu, refresh, settings, close, keys ---------- */
$('btnDpAdd').addEventListener('click', (e) => { e.stopPropagation(); $('dpAddMenu').hidden = !$('dpAddMenu').hidden; });
$('dpAddMenu').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act; $('dpAddMenu').hidden = true;
  if (act === 'add-repo') dpOpenRepoModal(null); else if (act === 'add-target') dpOpenTargetModal(null); else if (act === 'add-secret') dpOpenSecretModal(); else if (act === 'add-cloud') dpOpenCloudModal(); else if (act === 'wizard') dpOpenWizard(); else if (act === 'export') dpExportConfig(); else if (act === 'import') dpOpenImportModal();
});
document.addEventListener('click', (e) => { if (!$('dpAddMenu').hidden && !e.target.closest('.asc-add')) $('dpAddMenu').hidden = true; });
$('btnDpRefresh').addEventListener('click', () => loadDeploy());
$('btnDpTheme').addEventListener('click', () => toggleTheme());
$('btnDpSettings').addEventListener('click', () => { showSettings(); if (typeof showSettingsSection === 'function') showSettingsSection('deploy'); });
$('btnDpClose').addEventListener('click', closeDeploy);
$('btnDpNew')?.addEventListener('click', () => dpOpenWizard());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && dpOpen() && !document.querySelector('dialog[open]')) { if (!$('dpAddMenu').hidden) $('dpAddMenu').hidden = true; else closeDeploy(); }
});
$('btnManageDeploy')?.addEventListener('click', () => { $('settingsModal').close(); openDeploy(); });
$('setDpAi')?.addEventListener('change', () => { try { localStorage.setItem('st-deploy-ai', $('setDpAi').checked ? '1' : '0'); } catch {} });
async function renderDeploySettings() {
  try {
    const st = await api('/api/deploy/status');
    $('setDpVault').textContent = `vault key: ${st.vault.keySource === 'none' ? 'not created yet' : st.vault.keySource === 'env' ? 'DEPLOY_MASTER_KEY' : 'deploy-master.key file'}`;
    $('setDpTools').innerHTML = Object.entries(st.tools).map(([k, v]) => `<div class="settings-row"><span class="srv-dot ${v ? 'on' : ''}"></span><span class="sr-name">${esc(k)}</span><span class="spacer"></span><span class="sr-sub">${esc(v || 'not found')}</span></div>`).join('');
    $('setDpAi').checked = dpPrefAi();
  } catch (e) { $('setDpTools').innerHTML = `<div class="empty" style="color:var(--red)">${esc(e.message)}</div>`; }
}
