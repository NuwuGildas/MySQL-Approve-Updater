/* The timeline itself: categories, one-line descriptions, filters and rendering.
   Moved out of the base application's navigation.js and history client, which
   is why the filter persistence and the day grouping look familiar. */
'use strict';

const CAT_META = {
  ai: { label: 'AI', icon: '🤖', cls: 'ai' },
  approvals: { label: 'Approvals', icon: '✓', cls: 'approve' },
  rules: { label: 'Rules', icon: '▤', cls: 'rules' },
  ssh: { label: 'SSH', icon: '›_', cls: 'ssh' },
  deploy: { label: 'Ascension', icon: '⇧', cls: 'deploy' },
  other: { label: 'Other', icon: '•', cls: 'other' },
};

function auditCategory(a) {
  if (!a) return 'other';
  if (a === 'ai-chat' || a === 'ai-chat-cancelled') return 'ai';
  if (a === 'approve') return 'approvals';
  if (a.startsWith('ssh')) return 'ssh';
  if (a.startsWith('deploy') || a.startsWith('agent-deploy') || a.startsWith('connector')) return 'deploy';
  return 'rules';
}

function dayLabel(iso) {
  if (!iso) return 'Earlier';
  const day = iso.slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (day === today) return 'Today';
  if (day === yesterday) return 'Yesterday';
  return day;
}
const hhmm = (iso) => (iso || '').slice(11, 16);

export function createTimeline({ host, $, esc }) {
  let entries = [];
  let category = 'all';
  let filters = host.storage.get('filters', { q: '', time: 'all', outcome: 'all' });
  let pending = 0;

  /* ---- one-line human description per entry ---- */
  function describe(e) {
    const action = e.action;
    const table = e.table ? ` on <b>${esc(e.table)}</b>` : '';
    const rule = e.rule ? ` "${esc(e.rule)}"` : '';
    switch (action) {
      case 'ai-chat': return null; // rendered as a chat bubble instead
      case 'ai-chat-cancelled': return 'AI reply stopped by the user' + (e.tools?.length ? ' after ' + esc(e.tools.join(', ')) : '');
      case 'preview': return `Previewed${rule}${table}: ${e.matchedRows} matched, ${e.proposedChanges} would change`;
      case 'approve': return `Approved a change${table}${e.pk !== undefined ? ` (id ${esc(String(e.pk))})` : ''}`;
      case 'reject': return `Rejected a change${table}${e.pk !== undefined ? ` (id ${esc(String(e.pk))})` : ''}`;
      case 'skip': return `Skipped a change${table}${e.pk !== undefined ? ` (id ${esc(String(e.pk))})` : ''}`;
      case 'edit': return `Hand-edited a proposed value${table}${e.column ? ` · ${esc(e.column)}` : ''}`;
      case 'abort': return `Aborted the session${rule}: ${e.discardedPending ?? 0} discarded`;
      case 'clear': return `Cleared the preview${rule}: ${e.discardedPending ?? 0} discarded`;
      case 'agent-rule-approved': return `Approved the AI's rule proposal${rule}`;
      case 'agent-rule-rejected': return `Rejected the AI's rule proposal${rule}`;
      case 'project-create': return `Created project <b>${esc(e.project || '')}</b>`;
      case 'project-update': return `Updated project <b>${esc(e.project || '')}</b>`;
      case 'project-delete': return `Deleted project <b>${esc(e.project || '')}</b> (its resources were kept)`;
      case 'project-link': return `Added a ${esc(e.kind || 'resource')} to project <b>${esc(e.project || '')}</b>`;
      case 'project-unlink': return `Removed a ${esc(e.kind || 'resource')} from project <b>${esc(e.project || '')}</b>`;
      case 'ssh-session-connect': return `Connected SSH: ${esc(e.sshUser || '')}@${esc(e.sshHost || '')}`;
      case 'ssh-session-cleanup': return `Cleaned up ${esc(e.sshHost || '')} (${esc((e.cleaned || []).join(', '))})`;
      case 'ssh-terminal-open': return `Opened a terminal on ${esc(e.sshHost || '')}`;
      case 'ai-ssh-attach': return `The assistant joined a terminal on <b>${esc(e.profile || '')}</b>`;
      case 'ai-ssh-proposed': return `The assistant proposed a ${esc(e.class || '')} command: <code>${esc(String(e.cmd || '').slice(0, 120))}</code>`;
      case 'ai-ssh-exec': return `Approved command ran (exit ${esc(String(e.exitCode))}): <code>${esc(String(e.cmd || '').slice(0, 120))}</code>`;
      case 'connector-add': return `Connector <b>${esc(e.connector || '')}</b> (${esc(e.kind || '')}) added${e.status === 'ok' ? ' and verified' : ': verification failed'}`;
      case 'connector-update': return `Connector <b>${esc(e.connector || '')}</b> updated${e.status === 'ok' ? ' and verified' : ''}`;
      case 'connector-verify': return `Connector <b>${esc(e.connector || '')}</b> verified: ${esc(e.status || '')}`;
      case 'connector-remove': return `Connector <b>${esc(e.connector || '')}</b> removed`;
      case 'deploy-plan': return `Planned a deploy of <b>${esc(e.target || '')}</b>${e.ref ? ` (${esc(e.ref)})` : ''}`;
      case 'deploy-ship-start': return `Started shipping <b>${esc(e.target || '')}</b>${e.trigger ? ` via ${esc(e.trigger)}` : ''}`;
      case 'deploy-ship-success': return `Shipped <b>${esc(e.target || '')}</b> release ${esc(e.release || '')}${e.commit ? ` @ ${esc(String(e.commit).slice(0, 8))}` : ''}${e.ms ? ` in ${Math.round(e.ms / 1000)}s` : ''}`;
      case 'deploy-ship-failed': return `Deploy of <b>${esc(e.target || '')}</b> failed at ${esc(e.stage || '?')}${e.error ? ` — ${esc(e.error)}` : ''}`;
      case 'deploy-ship-rolled-back': return `Deploy of <b>${esc(e.target || '')}</b> failed at ${esc(e.stage || '?')} and was rolled back to ${esc(e.previousRelease || 'the previous release')}`;
      case 'deploy-rollback-start': return `Started a rollback of <b>${esc(e.target || '')}</b>`;
      case 'deploy-rollback': return `Rolled <b>${esc(e.target || '')}</b> back to ${esc(e.release || '')}`;
      case 'deploy-cancel': return `Cancelled a deploy of <b>${esc(e.target || '')}</b>${e.stage ? ` during ${esc(e.stage)}` : ''}`;
      case 'deploy-force-unlock': return `Force-unlocked <b>${esc(e.target || '')}</b>`;
      case 'deploy-repo-add': return `Connected repo <b>${esc(e.repo || '')}</b> (${esc(e.kind || '')})`;
      case 'deploy-repo-update': return `Updated repo <b>${esc(e.repo || '')}</b>`;
      case 'deploy-repo-remove': return `Removed repo <b>${esc(e.repo || '')}</b>`;
      case 'deploy-target-add': return `Added deploy target <b>${esc(e.target || '')}</b> (${esc(e.type || '')})`;
      case 'deploy-target-update': return `Updated deploy target <b>${esc(e.target || '')}</b>`;
      case 'deploy-target-remove': return `Removed deploy target <b>${esc(e.target || '')}</b>`;
      case 'deploy-manifest-save': return `Saved the deploy manifest of <b>${esc(e.repo || '')}</b>${e.by === 'agent-proposal' ? ' (AI proposal approved)' : ''}`;
      case 'deploy-secret-set': return `Stored secret <b>${esc(e.name || '')}</b> in the vault`;
      case 'deploy-secret-remove': return `Removed secret <b>${esc(e.name || '')}</b> from the vault`;
      case 'deploy-webhook': return `Webhook push started a ship of <b>${esc(e.target || '')}</b>${e.ref ? ` (${esc(e.ref)})` : ''}`;
      case 'deploy-webhook-rejected': return `Rejected a webhook call for <b>${esc(e.target || '')}</b> — ${esc(e.reason || '')}${e.ip ? ` from ${esc(e.ip)}` : ''}`;
      case 'deploy-cloud-provision': return `Provisioning <b>${esc(e.name || '')}</b> on ${esc(e.provider || '')} (${esc(e.region || '')} · ${esc(e.size || '')})`;
      case 'deploy-cloud-ready': return `Cloud server <b>${esc(e.name || '')}</b> is ready at ${esc(e.ip || '')}`;
      case 'deploy-cloud-failed': return `Provisioning of <b>${esc(e.name || '')}</b> failed: ${esc(e.error || '')}`;
      case 'deploy-cloud-destroy': return `Destroyed cloud server <b>${esc(e.name || '')}</b> (${esc(e.provider || '')})`;
      default: return `${esc(action || 'event')}${rule}${table}`;
    }
  }
  const describePlain = (entry) => (describe(entry) || `AI chat · ${String(entry.text || '').slice(0, 60)}`).replace(/<[^>]+>/g, '');

  /* ---- filters ---- */
  function outcome(e) {
    const text = `${e.action || ''} ${e.status || ''} ${e.decision || ''} ${e.verdict || ''}`.toLowerCase();
    if (/fail|reject|rolled|error|cancel|block/.test(text)) return 'failed';
    if (/success|approv|succeeded|done|saved|added|ready/.test(text)) return 'succeeded';
    return 'other';
  }
  function passes(e) {
    if (filters.time !== 'all') {
      const age = Date.now() - Date.parse(e.ts || 0);
      const max = filters.time === 'today' ? 86400e3 : filters.time === '7d' ? 7 * 86400e3 : 30 * 86400e3;
      if (!(age <= max)) return false;
    }
    if (filters.outcome !== 'all' && outcome(e) !== filters.outcome) return false;
    if (filters.q && !JSON.stringify(e).toLowerCase().includes(filters.q.toLowerCase())) return false;
    return true;
  }
  const persist = () => host.storage.set('filters', filters);
  function syncFilterUi() {
    $('auditSearch').value = filters.q;
    $('auditTime').value = filters.time;
    $('auditOutcome').value = filters.outcome;
  }
  function clearFilters() { filters = { q: '', time: 'all', outcome: 'all' }; syncFilterUi(); persist(); render(); }

  /* ---- loading ---- */
  async function load() {
    $('auditBody').innerHTML = '<div class="empty" style="padding:1rem">Loading…</div>';
    try {
      const data = await host.get('list', { limit: 500 });
      entries = data.entries || [];
      render();
    } catch (error) {
      $('auditBody').innerHTML = `<div class="empty" style="padding:1rem;color:var(--red)">${esc(error.message)}</div>`;
    }
  }
  function loadSoon() {
    host.clearTimer(pending);
    pending = host.setTimeout(() => load().catch(() => {}), 600);
  }

  /* ---- rendering ---- */
  function renderChips(rows) {
    const counts = { all: rows.length };
    for (const entry of rows) { const c = auditCategory(entry.action); counts[c] = (counts[c] || 0) + 1; }
    const cats = ['all', 'ai', 'approvals', 'rules', 'ssh', 'deploy'].filter((c) => c === 'all' || counts[c]);
    $('auditChips').innerHTML = cats.map((c) =>
      `<button class="chip-btn ${category === c ? 'on' : ''}" data-cat="${c}">${esc(c === 'all' ? 'All' : CAT_META[c].label)} <span class="chip-n">${counts[c] || 0}</span></button>`).join('');
    $('auditChips').querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => { category = b.dataset.cat; render(); }));
  }

  function render() {
    const filtered = entries.filter(passes);
    renderChips(filtered);
    const rows = filtered.filter((e) => category === 'all' || auditCategory(e.action) === category);
    $('auditCount').textContent = `— ${rows.length}${category !== 'all' ? ' ' + CAT_META[category].label.toLowerCase() : ''}`;
    $('btnAuditResume').style.display = entries.some((e) => e.action === 'ai-chat') ? '' : 'none';
    const filtering = filters.q || filters.time !== 'all' || filters.outcome !== 'all';
    $('btnAuditClear').hidden = !filtering;

    if (!rows.length) {
      $('auditBody').innerHTML = filtering
        ? '<div class="empty" style="padding:1rem">No events match these filters. <button type="button" data-clear>Clear filters</button></div>'
        : '<div class="empty" style="padding:1rem">Nothing here yet.</div>';
      $('auditBody').querySelector('[data-clear]')?.addEventListener('click', clearFilters);
      return;
    }

    let html = '';
    let lastDay = null;
    for (const entry of rows) {
      const day = dayLabel(entry.ts);
      if (day !== lastDay) { html += `<div class="tl-day">${esc(day)}</div>`; lastDay = day; }
      if (entry.action === 'ai-chat') {
        const mine = entry.role === 'user';
        const tools = entry.tools?.length ? `<div class="tl-tools">used: ${esc(entry.tools.join(', '))}</div>` : '';
        html += `<div class="tl-chat ${mine ? 'me' : 'ai'}" data-resume="1">
          <div class="tl-who">${mine ? 'You' : 'AI'} <span class="tl-time">${esc(hhmm(entry.ts))}</span></div>
          <div class="tl-bubble">${esc(String(entry.text || ''))}</div>${tools}</div>`;
        continue;
      }
      const meta = CAT_META[auditCategory(entry.action)] || CAT_META.other;
      html += `<div class="tl-item">
        <span class="tl-ic ${meta.cls}">${esc(meta.icon)}</span>
        <div class="tl-body"><div class="tl-desc">${describe(entry)}</div>
          <details class="tl-raw"><summary>details</summary><pre>${esc(JSON.stringify(entry, (k, v) => (k === '_n' ? undefined : v), 2))}</pre></details></div>
        <span class="tl-time">${esc(hhmm(entry.ts))}</span>
      </div>`;
    }
    $('auditBody').innerHTML = html;
    $('auditBody').querySelectorAll('.tl-chat[data-resume]').forEach((el) => el.addEventListener('click', (event) => {
      if (event.target.closest('summary')) return;
      host.assistant.open(); // the history view stays open underneath
    }));
  }

  /* ---- wiring, all of it disposable ---- */
  syncFilterUi();
  let searchTimer = 0;
  host.on($('auditSearch'), 'input', () => {
    host.clearTimer(searchTimer);
    searchTimer = host.setTimeout(() => { filters.q = $('auditSearch').value.trim(); persist(); render(); }, 200);
  });
  host.on($('auditTime'), 'change', () => { filters.time = $('auditTime').value; persist(); render(); });
  host.on($('auditOutcome'), 'change', () => { filters.outcome = $('auditOutcome').value; persist(); render(); });
  host.on($('btnAuditClear'), 'click', clearFilters);
  host.on($('btnAuditRefresh'), 'click', () => load());
  host.on($('btnAuditResume'), 'click', () => host.assistant.open());
  host.on($('btnAuditDock'), 'click', () => host.ui.toggleDrawerOrientation());
  host.on($('btnAuditDownload'), 'click', async () => {
    try {
      const response = await fetch(`/api/m/${host.id}/download`);
      if (!response.ok) throw new Error('History could not be downloaded');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = 'audit.log';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (error) { host.ui.toast(error.message, 'error'); }
  });

  return { load, loadSoon, render, describePlain, dispose() { entries = []; } };
}
