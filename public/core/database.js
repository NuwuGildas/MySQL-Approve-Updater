/* ---------- Transform editor ---------- */
const PARAM_FIELDS = {
  findReplace: [
    {key:'find', label:'Find', type:'text'},
    {key:'replace', label:'Replace with', type:'text'},
    {key:'regex', label:'Regex (capture groups: $1…)', type:'checkbox'},
    {key:'flags', label:'Regex flags', type:'text', placeholder:'g'},
  ],
  trim: [],
  changeCase: [{key:'mode', label:'Mode', type:'select', options:['upper','lower','title']}],
  prefix: [{key:'text', label:'Prefix text', type:'text'}],
  suffix: [{key:'text', label:'Suffix text', type:'text'}],
  setValue: [
    {key:'value', label:'New value', type:'text'},
    {key:'setNull', label:'Set NULL instead', type:'checkbox'},
  ],
};

function transformRowHtml(t = {}) {
  const type = t.type || 'findReplace';
  const opts = Object.entries(state.transformTypes)
    .map(([k, lbl]) => `<option value="${k}" ${k===type?'selected':''}>${esc(lbl)}</option>`).join('');
  const uid = ++transformUid; // unique ids so each visible label is associated with its control
  return `<div class="transform-row" data-uid="${uid}">
    <button type="button" class="del" title="Remove">✕</button>
    <div class="row">
      <div><label for="tcol-${uid}">Column</label><input id="tcol-${uid}" class="t-col" list="colList" value="${esc(t.column||'')}" required></div>
      <div><label for="ttype-${uid}">Type</label><select id="ttype-${uid}" class="t-type">${opts}</select></div>
    </div>
    <div class="t-params"></div>
    <label style="display:flex;align-items:center;gap:.4rem;margin-top:.45rem;font-size:.72rem;color:var(--muted)">
      <input type="checkbox" class="t-ser" style="width:auto" ${t.phpSerialized ? 'checked' : ''}>
      PHP-serialized value: transform the strings inside and auto-fix the s:N byte lengths
    </label>
  </div>`;
}

function renderParams(rowEl, type, params = {}) {
  const wrap = rowEl.querySelector('.t-params');
  const uid = rowEl.dataset.uid || rowEl.closest('.transform-row')?.dataset.uid || 'x';
  wrap.innerHTML = (PARAM_FIELDS[type] || []).map((f) => {
    if (f.type === 'checkbox')
      return `<label style="display:flex;align-items:center;gap:.4rem;margin-top:.4rem"><input type="checkbox" style="width:auto" data-k="${f.key}" ${params[f.key]?'checked':''}> ${esc(f.label)}</label>`;
    if (f.type === 'select')
      return `<label for="tp-${uid}-${f.key}">${esc(f.label)}</label><select id="tp-${uid}-${f.key}" data-k="${f.key}">${f.options.map(o=>`<option ${params[f.key]===o?'selected':''}>${o}</option>`).join('')}</select>`;
    return `<label for="tp-${uid}-${f.key}">${esc(f.label)}</label><input id="tp-${uid}-${f.key}" data-k="${f.key}" value="${esc(params[f.key]??'')}" placeholder="${esc(f.placeholder||'')}">`;
  }).join('');
}

let transformUid = 0;
function addTransformRow(t) {
  const div = document.createElement('div');
  div.innerHTML = transformRowHtml(t);
  const row = div.firstElementChild;
  row.dataset.uid = String(++transformUid); // lets the summary view address this row
  $('transformList').appendChild(row);
  renderParams(row, t?.type || 'findReplace', t?.params || {});
  row.querySelector('.t-type').addEventListener('change', (e) => renderParams(row, e.target.value, {}));
  row.querySelector('.del').addEventListener('click', () => { row.remove(); updateTransformCount(); });
  updateTransformCount();
}

function updateTransformCount() {
  const n = $('transformList').children.length;
  $('transformCount').textContent = n ? `(${n})` : '';
}

/* ---------- transforms: summarized view with drag-to-reorder ---------- */
let transformsSummaryView = false;

function renderTransformView() {
  $('transformList').hidden = transformsSummaryView;
  $('btnAddTransform').hidden = transformsSummaryView;
  $('transformSummary').hidden = !transformsSummaryView;
  $('btnTransformView').textContent = transformsSummaryView ? 'Detailed view' : 'Summary & reorder';
  $('transformViewHint').textContent = transformsSummaryView
    ? 'Drag the lines to change the execution order.'
    : 'Transforms run in order; later ones see earlier results.';
  if (transformsSummaryView) renderTransformSummary();
}
$('btnTransformView').addEventListener('click', () => {
  transformsSummaryView = !transformsSummaryView;
  renderTransformView();
});

function summarizeTransformRow(row) {
  const type = row.querySelector('.t-type').value;
  const col = row.querySelector('.t-col').value.trim() || '(no column)';
  const p = {};
  row.querySelectorAll('.t-params [data-k]').forEach((el) => { p[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value; });
  const short = (s, n = 34) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  let detail = '';
  if (type === 'findReplace') detail = `"${short(p.find)}" → "${short(p.replace)}"${p.regex ? ' (regex)' : ''}`;
  else if (type === 'changeCase') detail = p.mode || '';
  else if (type === 'prefix' || type === 'suffix') detail = `"${short(p.text)}"`;
  else if (type === 'setValue') detail = p.setNull ? 'NULL' : `"${short(p.value)}"`;
  if (row.querySelector('.t-ser').checked) detail += ' · serialized';
  return { type, col, detail };
}

function renderTransformSummary() {
  const rows = [...$('transformList').querySelectorAll('.transform-row')];
  const cont = $('transformSummary');
  cont.innerHTML = rows.length ? '' : '<div class="empty">No transforms yet: switch to detailed view to add one.</div>';
  rows.forEach((row, i) => {
    const s = summarizeTransformRow(row);
    const item = document.createElement('div');
    item.className = 'tsum-item';
    item.draggable = true;
    item.dataset.uid = row.dataset.uid;
    item.innerHTML = `<span class="tsum-grip">⣿</span><b>${i + 1}.</b>
      <span class="tsum-type">${esc(state.transformTypes[s.type] || s.type)}</span> on <b>${esc(s.col)}</b>
      <span class="tsum-detail">${esc(s.detail)}</span>`;
    cont.appendChild(item);
  });
}

(() => {
  const cont = $('transformSummary');
  let dragging = null;
  cont.addEventListener('dragstart', (e) => {
    dragging = e.target.closest('.tsum-item');
    if (!dragging) return;
    dragging.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', ''); } catch {} // Firefox needs data to start a drag
  });
  cont.addEventListener('dragover', (e) => {
    if (!dragging) return;
    e.preventDefault();
    const others = [...cont.querySelectorAll('.tsum-item:not(.dragging)')];
    const after = others.find((it) => e.clientY < it.getBoundingClientRect().top + it.offsetHeight / 2);
    if (after) cont.insertBefore(dragging, after);
    else cont.appendChild(dragging);
  });
  cont.addEventListener('drop', (e) => e.preventDefault());
  cont.addEventListener('dragend', () => {
    if (!dragging) return;
    dragging.classList.remove('dragging');
    dragging = null;
    // apply the summary order to the real editor rows (DOM moves keep all input state)
    const list = $('transformList');
    for (const it of cont.querySelectorAll('.tsum-item')) {
      const row = list.querySelector(`.transform-row[data-uid="${CSS.escape(it.dataset.uid)}"]`);
      if (row) list.appendChild(row);
    }
    renderTransformSummary(); // renumber
  });
})();

function readTransforms() {
  return [...$('transformList').querySelectorAll('.transform-row')].map((row) => {
    const type = row.querySelector('.t-type').value;
    const params = {};
    row.querySelectorAll('.t-params [data-k]').forEach((el) => {
      params[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value;
    });
    return {
      column: row.querySelector('.t-col').value.trim(),
      type,
      params,
      phpSerialized: row.querySelector('.t-ser').checked,
    };
  });
}

/* ---------- Rules list ---------- */
const RULE_ICONS = {
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  exp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 21h16"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.5-.76L3 21l1.76-5.27A8.38 8.38 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3a8.38 8.38 0 0 1 8.5 8.5Z"/><path d="M12.5 8.5v6M9.5 11.5h6"/></svg>',
};

async function loadRules() {
  state.rules = await api('/api/rules');
  const saved = state.rules.filter((r) => !r.draft);
  const drafts = state.rules.filter((r) => r.draft);
  $('ruleCount').textContent = saved.length ? `(${saved.length})` : '';
  $('draftCount').textContent = drafts.length ? `(${drafts.length})` : '';
  const fill = (elId, items, emptyMsg) => {
    const list = $(elId);
    list.innerHTML = items.length ? '' : `<div class="empty">${emptyMsg}</div>`;
    for (const r of items) list.appendChild(makeRuleCard(r));
  };
  fill('ruleList', saved, 'No rules yet: use "+ New rule".');
  fill('draftList', drafts, 'No drafts. Use "Save as draft" in the rule editor.');
  updateRuleHighlight();
}

function makeRuleCard(r) {
  {
    const el = document.createElement('div');
    el.className = 'rule-item';
    el.dataset.ruleId = r.id;
    el.innerHTML = `
      <div class="r1">
        <div class="name">${esc(r.name)} ${r.draft ? '<span class="badge draftbadge">draft</span>' : ''}<span class="badge runbadge" hidden></span><span class="meta">${esc(r.table)} · ${r.transforms.length} transform(s) · limit ${r.limit}</span></div>
        <button class="iconbtn danger" data-act="delete" title="Delete rule">${RULE_ICONS.trash}</button>
      </div>
      <div class="r2">
        <button class="primary" data-act="preview" ${r.draft ? 'disabled title="Drafts cannot run previews: open it and use Save rule to publish"' : ''}>Run preview</button>
        <button class="iconbtn" data-act="edit" title="Edit rule">${RULE_ICONS.edit}</button>
        <button class="iconbtn" data-act="dup" title="Duplicate this rule and edit the copy">${RULE_ICONS.copy}</button>
        <button class="iconbtn" data-act="export" title="Export the rule definition as JSON">${RULE_ICONS.exp}</button>
        <button class="iconbtn addchat" data-act="addchat" title="Add this rule to the AI chat as context">${RULE_ICONS.chat}</button>
        <button data-act="sql" title="Download the SQL this rule generates">SQL</button>
      </div>`;
    el.addEventListener('click', async (e) => {
      const btn = e.target.closest?.('[data-act]'); // clicks land on the SVGs inside the buttons
      const act = btn?.dataset.act;
      if (!act) return;
      try {
        if (act === 'preview') {
          btn.disabled = true; btn.textContent = 'Fetching…';
          showQueueLoading(r.name); // spinner in the approval queue until the preview lands
          await api(`/api/rules/${r.id}/preview`, { method: 'POST' });
        } else if (act === 'edit') {
          openRuleModal(r);
        } else if (act === 'dup') {
          openRuleModal({ ...r, id: '', name: r.name + ' (copy)' }, '- duplicate: adjust and save as a new rule');
        } else if (act === 'addchat') {
          await api('/api/agent/context', { method: 'POST', body: projectBody({ ruleId: r.id }) });
          if ($('agentDrawer').classList.contains('open')) {
            appendAgentMsg('note', '', null, { kind: 'context', rule: r });
            $('agentInput').focus();
          } else {
            openAgent(); // re-fetches the conversation, which now includes the context note
          }
        } else if (act === 'export') {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' }));
          a.download = `rule-${r.name.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60)}.json`;
          a.click();
          URL.revokeObjectURL(a.href);
        } else if (act === 'sql') {
          const res = await fetch(`/api/rules/${r.id}/sql`);
          if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
          const blob = await res.blob();
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = (res.headers.get('content-disposition')?.match(/filename="(.+)"/) || [])[1] || 'rule.sql';
          a.click();
          URL.revokeObjectURL(a.href);
        } else if (act === 'delete') {
          const ok = await confirmDialog({
            title: 'Delete rule',
            message: `Delete the rule <b>${esc(r.name)}</b>?<br>This only removes the rule definition; nothing in the database is touched.`,
            okLabel: 'Delete rule', okClass: 'reject',
          });
          if (ok) { await api(`/api/rules/${r.id}`, { method: 'DELETE' }); loadRules(); }
        }
      } catch (err) { toast(err.message); if (act === 'preview') { queueLoading = false; renderQueue(); } }
      finally { if (act === 'preview') { btn.disabled = false; btn.textContent = 'Run preview'; } }
    });
    return el;
  }
}

/* Mark the rule whose session is currently active */
function updateRuleHighlight() {
  const s = state.session;
  const activeRuleId = s && ['running', 'paused'].includes(s.status) ? s.ruleId : null;
  document.querySelectorAll('#ruleList .rule-item, #draftList .rule-item').forEach((el) => {
    const isActive = el.dataset.ruleId === activeRuleId;
    el.classList.toggle('running', isActive);
    const badge = el.querySelector('.runbadge');
    if (badge) {
      badge.hidden = !isActive;
      if (isActive) {
        badge.textContent = s.status;
        badge.className = 'badge runbadge ' + (s.status === 'running' ? 'approved' : 'skipped');
      }
    }
  });
}

function fillForm(r) {
  $('rId').value = r?.id || '';
  $('rName').value = r?.name || '';
  $('rTable').value = r?.table || '';
  $('rPk').value = r?.pkColumn || '';
  $('rWhere').value = r?.where || '';
  $('rLimit').value = r?.limit || '';
  $('rDisplay').value = (r?.displayColumns || []).join(', ');
  $('transformList').innerHTML = '';
  (r?.transforms?.length ? r.transforms : [undefined]).forEach(addTransformRow);
  updateColDatalist();
}

async function saveRule(asDraft) {
  const body = {
    name: $('rName').value, table: $('rTable').value.trim(), pkColumn: $('rPk').value.trim(),
    where: $('rWhere').value, limit: Number($('rLimit').value) || undefined,
    displayColumns: $('rDisplay').value, transforms: readTransforms(),
    draft: asDraft,
  };
  const id = $('rId').value;
  try {
    await api(id ? `/api/rules/${id}` : '/api/rules', { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) });
    if ($('ruleModal').open) $('ruleModal').close();
    loadRules();
  } catch (err) { toast(err.message); }
}
$('ruleForm').addEventListener('submit', (e) => { e.preventDefault(); saveRule(false); });
$('btnSaveDraft').addEventListener('click', () => { if ($('ruleForm').reportValidity()) saveRule(true); });
/* ---------- rule editor modal: the only place rules are edited ---------- */
function openRuleModal(rule, hint) {
  fillForm(rule);
  transformsSummaryView = false; // always open in the editable detailed view
  renderTransformView();
  $('ruleModalHint').textContent = hint ?? (rule?.id ? `- editing ${rule.draft ? 'draft ' : ''}"${rule.name}"` : '- new rule');
  $('ruleModal').showModal();
  $('rName').focus();
  if (rule && !rule.id) $('rName').select(); // duplicates: name is preselected for renaming
}
$('btnNewRule').addEventListener('click', () => openRuleModal(null));

/* ---------- rule import (single rule object or an array of rules) ---------- */
$('btnImportRules').addEventListener('click', () => $('ruleImportFile').click());
$('ruleImportFile').addEventListener('change', async () => {
  const files = [...$('ruleImportFile').files];
  $('ruleImportFile').value = '';
  if (!files.length) return;
  let imported = 0, failed = 0, firstError = '';
  for (const file of files) {
    let parsed;
    try { parsed = JSON.parse(await file.text()); }
    catch (e) { failed++; if (!firstError) firstError = `${file.name}: not valid JSON`; continue; }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const r of items) {
      if (!r || typeof r !== 'object' || !r.name || !r.table || !Array.isArray(r.transforms)) {
        failed++;
        if (!firstError) firstError = `${file.name}: entry is not a rule (needs name, table, transforms)`;
        continue;
      }
      try {
        // fresh id via POST: imports can never overwrite existing rules
        await api('/api/rules', {
          method: 'POST',
          body: JSON.stringify({
            name: r.name, table: r.table, pkColumn: r.pkColumn, where: r.where, limit: r.limit,
            displayColumns: Array.isArray(r.displayColumns) ? r.displayColumns.join(', ') : (r.displayColumns || ''),
            transforms: r.transforms, draft: !!r.draft,
          }),
        });
        imported++;
      } catch (e) {
        failed++;
        if (!firstError) firstError = `${file.name} (${r.name}): ${e.message}`;
      }
    }
  }
  loadRules();
  toast(`Import: ${imported} rule(s) imported${failed ? `, ${failed} failed (${firstError})` : ''}`);
});
$('btnCloseRuleModal').addEventListener('click', () => $('ruleModal').close());
$('btnCancelEdit').addEventListener('click', () => $('ruleModal').close());
$('btnAddTransform').addEventListener('click', () => addTransformRow());

/* ---------- Schema autocomplete ---------- */
// Fetch schema, refresh datalists + SQL autocomplete. Shared by the button and
// the AI SQL prompt (which loads schema first when it isn't cached yet).
async function loadSchema() {
  state.schema = await api('/api/schema');
  $('tableList').innerHTML = Object.keys(state.schema.tables).map((t) => `<option value="${esc(t)}">`).join('');
  updateColDatalist();
  updateSqlHints();
  return state.schema;
}
$('btnLoadSchema').addEventListener('click', async () => {
  try {
    $('btnLoadSchema').textContent = 'Loading…';
    await loadSchema();
    toast(`Schema loaded: ${Object.keys(state.schema.tables).length} tables - SQL console autocomplete active`);
  } catch (err) { dbErrorToast(err, 'Schema load failed: '); }
  finally { $('btnLoadSchema').textContent = 'Load schema'; }
});
$('rTable').addEventListener('change', updateColDatalist);
function updateColDatalist() {
  const cols = state.schema?.tables?.[$('rTable').value.trim()] || [];
  $('colList').innerHTML = cols.map((c) => `<option value="${esc(c.name)}">`).join('');
  const pk = cols.find((c) => c.isPk);
  if (pk && !$('rPk').value) $('rPk').value = pk.name;
}

/* ---------- Diff rendering ----------
 * Token-level Myers diff so every changed spot is highlighted individually
 * (a small edit repeated 50× in a big text shows as 50 small marks, not one
 * giant red/green block). Long unchanged stretches collapse into a clickable
 * "⋯ N unchanged chars ⋯" pill. */
const foldStore = [];            // hidden text behind fold pills (reset per render)
const diffCache = new Map();     // changeId:column → segments (cols never mutate)

function tokenize(s) {
  return s.match(/[A-Za-z0-9À-ɏ_]+|\s+|[\s\S]/g) || [];
}

/* Myers O(ND) diff on token arrays. Returns [op, text] runs (op −1/0/1),
 * or null when the edit distance exceeds CAP (caller falls back). */
function myers(a, b) {
  const N = a.length, M = b.length;
  if (!N && !M) return [];
  if (!N) return [[1, b.join('')]];
  if (!M) return [[-1, a.join('')]];
  const CAP = 800;
  const offset = CAP;
  let v = new Int32Array(2 * CAP + 1);
  const trace = [];
  let D = -1;
  outer:
  for (let d = 0; d <= CAP; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= N && y >= M) { D = d; break outer; }
    }
  }
  if (D < 0) return null;
  const rev = [];
  let x = N, y = M;
  for (let d = D; d > 0; d--) {
    const vd = trace[d];
    const k = x - y;
    const prevK = (k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1])) ? k + 1 : k - 1;
    const prevX = vd[offset + prevK], prevY = prevX - prevK;
    while (x > prevX && y > prevY) { rev.push([0, a[--x]]); y--; }
    if (x === prevX) rev.push([1, b[--y]]);
    else rev.push([-1, a[--x]]);
  }
  while (x > 0 && y > 0) { rev.push([0, a[--x]]); y--; }
  const ops = [];
  for (let i = rev.length - 1; i >= 0; i--) {
    const [op, text] = rev[i];
    const last = ops[ops.length - 1];
    if (last && last[0] === op) last[1] += text; else ops.push([op, text]);
  }
  return ops;
}

function makeSegPusher(segs) {
  return (op, text) => {
    if (!text) return;
    const last = segs[segs.length - 1];
    if (last && last.op === op) last.text += text; else segs.push({ op, text });
  };
}

/* Fine, token-level diff. Degrades to a single del+ins block when the edit
 * distance exceeds the Myers cap - callers keep the regions it sees small. */
function fineDiffSegs(beforeStr, afterStr) {
  const a = tokenize(beforeStr), b = tokenize(afterStr);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let ea = a.length, eb = b.length;
  while (ea > start && eb > start && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const segs = [];
  const push = makeSegPusher(segs);
  push(0, a.slice(0, start).join(''));
  const midA = a.slice(start, ea), midB = b.slice(start, eb);
  const ops = (midA.length + midB.length <= 40000) ? myers(midA, midB) : null;
  if (ops) for (const [op, text] of ops) push(op, text);
  else { push(-1, midA.join('')); push(1, midB.join('')); } // too big/different: block replace
  push(0, a.slice(ea).join(''));
  return segs;
}

/* Two-tier diff: a coarse pass over lines (or tag-boundary chunks when the
 * text has few lines) localizes the changes, then each changed region gets
 * the fine token diff. This keeps huge documents with MANY scattered edits
 * (e.g. 50 font-family removals in 100KB of HTML) from blowing the fine
 * diff's edit-distance cap, which would collapse the whole middle of the
 * text into one giant deleted block + one giant inserted block. */
function diffSegments(beforeStr, afterStr) {
  let a = beforeStr.split(/(?<=\n)/), b = afterStr.split(/(?<=\n)/);
  if (a.length < 20 || b.length < 20) { a = beforeStr.split(/(?<=>)/); b = afterStr.split(/(?<=>)/); }
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let ea = a.length, eb = b.length;
  while (ea > start && eb > start && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const coarse = myers(a.slice(start, ea), b.slice(start, eb));
  if (!coarse) return fineDiffSegs(beforeStr, afterStr); // coarse pass failed: old single-tier behavior
  const segs = [];
  const push = makeSegPusher(segs);
  push(0, a.slice(0, start).join(''));
  for (let k = 0; k < coarse.length; k++) {
    const [op, text] = coarse[k];
    if (op === 0) { push(0, text); continue; }
    const next = coarse[k + 1];
    if (next && next[0] === -op) { // paired del+ins region → refine at token level
      const delText = op === -1 ? text : next[1];
      const insText = op === -1 ? next[1] : text;
      for (const s of fineDiffSegs(delText, insText)) push(s.op, s.text);
      k++;
    } else {
      push(op, text);
    }
  }
  push(0, a.slice(ea).join(''));
  return segs;
}

const FOLD_CTX = 60;   // chars of context kept around each change
const FOLD_MIN = 160;  // only fold when it hides at least this much
function renderSegments(segs, fold = true) {
  let html = '';
  segs.forEach((seg, i) => {
    if (seg.op === -1) { html += `<del>${esc(seg.text)}</del>`; return; }
    if (seg.op === 1) { html += `<ins>${esc(seg.text)}</ins>`; return; }
    if (!fold) { html += esc(seg.text); return; }
    const t = seg.text;
    const keepL = i === 0 ? 0 : FOLD_CTX;              // start of text: no left context needed
    const keepR = i === segs.length - 1 ? 0 : FOLD_CTX; // end of text: no right context needed
    if (t.length > keepL + keepR + FOLD_MIN) {
      const hidden = t.slice(keepL, t.length - keepR);
      const fi = foldStore.push(hidden) - 1;
      html += esc(t.slice(0, keepL))
        + `<span class="fold" data-fi="${fi}" title="Click to show">⋯ ${hidden.length.toLocaleString()} unchanged chars ⋯</span>`
        + esc(t.slice(t.length - keepR));
    } else html += esc(t);
  });
  return html;
}

function diffHtml(before, after, cacheKey, fold = true) {
  if (before === null || before === undefined) return `<span class="nullv">NULL</span> → <ins>${esc(after ?? 'NULL')}</ins>`;
  if (after === null || after === undefined) return `<del>${esc(before)}</del> → <span class="nullv">NULL</span>`;
  let segs = cacheKey ? diffCache.get(cacheKey) : null;
  if (!segs) {
    segs = diffSegments(String(before), String(after));
    if (cacheKey) diffCache.set(cacheKey, segs);
  }
  return renderSegments(segs, fold);
}

/* ---------- Queue rendering ---------- */
const MAX_CARDS = 40;
const selected = new Set();     // change ids picked for batch actions
const editorOpen = new Map();   // "changeId:column" → draft text of an open inline editor

function updateToolbar() {
  const s = state.session;
  const hasSel = selected.size > 0;
  const canAct = s && s.status === 'running';
  $('selCount').textContent = hasSel ? `${selected.size} selected` : '';
  $('btnSelAll').disabled = !s || !s.changes.some((c) => c.status === 'pending');
  $('btnSelNone').disabled = !hasSel;
  $('btnBatchApprove').disabled = !canAct || !hasSel;
  $('btnBatchReject').disabled = !canAct || !hasSel;
  $('btnBatchSkip').disabled = !canAct || !hasSel;
  if ($('btnReviewSel') && !reviewingAll) $('btnReviewSel').disabled = !s || !hasSel;
  $('backupSelect').style.display = s && s.changes.length ? '' : 'none';
  $('btnClearAll').disabled = !s;
  $('backupWarn').style.display =
    s && s.changes.length && !s.backupDownloaded && (s.counts?.pending || 0) > 0 ? '' : 'none';
  updateRuleHighlight();
}

/* One backup nag per session: confirm the first approval made without a downloaded backup */
let backupWarnedFor = null;
async function confirmNoBackup(extra) {
  const s = state.session;
  if (!s || s.backupDownloaded || backupWarnedFor === s.id) return true;
  const ok = await confirmDialog({
    title: 'No backup downloaded',
    message: `A restore script was auto-saved on the server (<code>${esc(s.backupFile || 'backups/')}</code>), but you have no local copy.<br>` +
      `Use the <b>Backup…</b> menu in the queue toolbar to download one first.<br><br>${esc(extra)}`,
    okLabel: 'Proceed without backup', okClass: 'warn',
    cancelLabel: 'Go back',
  });
  if (ok) backupWarnedFor = s.id;
  return ok;
}

let queueLoading = false;
function showQueueLoading(ruleName) {
  queueLoading = true;
  $('queue').innerHTML = `<div class="queue-loading">
    <div class="ql-head"><span class="spinner"></span>Running preview${ruleName ? ` for "${esc(ruleName)}"` : ''}…</div>
    <div class="ql-steps" id="queueSteps"></div>
  </div>`;
}
function queueStep(text) {
  if (!queueLoading) return;
  const steps = $('queueSteps');
  if (!steps) return;
  // mark the previous step done, add the new active one
  const prev = steps.lastElementChild;
  if (prev) prev.classList.replace('active', 'ql-done');
  const el = document.createElement('div');
  el.className = 'ql-step active';
  el.textContent = text;
  steps.appendChild(el);
}

function renderQueue() {
  const q = $('queue');
  const s = state.session;
  if (queueLoading) return; // a preview is in flight; the loader stays until its session arrives
  foldStore.length = 0;
  // selection only ever holds ids that are still pending
  if (s) {
    const pendingIds = new Set(s.changes.filter((c) => c.status === 'pending').map((c) => c.id));
    for (const id of [...selected]) if (!pendingIds.has(id)) selected.delete(id);
    for (const key of [...editorOpen.keys()]) if (!pendingIds.has(key.slice(0, key.indexOf(':')))) closeEditor(key);
  } else { selected.clear(); editorOpen.clear(); editorSerialized.clear(); editorBeforeJson.clear(); }
  $('queueRule').textContent = s ? `- ${s.ruleName} on ${s.table} [${s.status}]` : '';
  $('sessStatus').textContent = s ? `${s.ruleName}: ${s.status}` : 'no session';
  $('btnPause').disabled = !s || s.status !== 'running';
  $('btnResume').disabled = !s || s.status !== 'paused';
  $('btnAbort').disabled = !s || ['aborted','done'].includes(s.status);
  document.body.classList.toggle('queue-paused', !!s && s.status === 'paused');
  const banner = $('pausedBanner');
  if (banner) banner.hidden = !(s && s.status === 'paused');
  if (!s) {
    q.innerHTML = '<div class="empty">Run a preview to load changes.</div>';
    updateToolbar(); // the early return must not skip toolbar state (buttons, backup links)
    return;
  }

  const pending = s.changes.filter((c) => c.status === 'pending');
  const settledRecent = s.changes.filter((c) => c.status !== 'pending').slice(-6).reverse();
  let html = '';
  if (!pending.length) {
    html += `<div class="empty">No pending changes${s.changes.length ? ` - ${s.changes.length} processed.` : ' (nothing matched or nothing would change).'}</div>`;
  }
  pending.slice(0, MAX_CARDS).forEach((c, i) => { html += cardHtml(c, s, i === 0); });
  if (pending.length > MAX_CARDS) html += `<div class="empty">…and ${pending.length - MAX_CARDS} more pending.</div>`;
  if (settledRecent.length) {
    html += '<h2 style="margin-top:1rem;font-size:.75rem;color:var(--muted)">Recently decided</h2>';
    settledRecent.forEach((c) => { html += cardHtml(c, s, false); });
  }
  q.innerHTML = html;
  q.querySelectorAll('[data-decide]').forEach((btn) => {
    btn.addEventListener('click', () => decide(btn.dataset.id, btn.dataset.decide));
  });
  q.querySelectorAll('.fold').forEach((el) => {
    el.addEventListener('click', () => el.replaceWith(document.createTextNode(foldStore[+el.dataset.fi] ?? '')), { once: true });
  });
  q.querySelectorAll('[data-sel]').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) selected.add(cb.dataset.sel); else selected.delete(cb.dataset.sel);
      updateToolbar();
    });
  });
  q.querySelectorAll('[data-expand]').forEach((b) => b.addEventListener('click', () => openCardModal(b.dataset.expand)));
  wireAiReviewButtons(q);
  q.querySelectorAll('[data-editopen]').forEach((b) => b.addEventListener('click', () => {
    openColumnEditor(b.dataset.cid, b.dataset.col); // editing happens in the large card view
  }));
  updateToolbar();
}

// robot logo (same assets as the header button): rest = idle, focus = working
const AI_LOGO_REST = '<img class="ai-mini" src="/assets/robot-logo-animated_1.svg" alt="" aria-hidden="true">';
const AI_LOGO_FOCUS = '<img class="ai-mini" src="/assets/robot-logo-focused.svg" alt="" aria-hidden="true">';

function aiReviewStrip(c) {
  const r = c.aiReview;
  if (!r) return '';
  if (r.status === 'pending') return `<div class="ai-review pending">${AI_LOGO_FOCUS}<span>AI review running…</span></div>`;
  if (r.status === 'error') return `<div class="ai-review bad">${AI_LOGO_REST}<span>AI review failed: ${esc(r.summary || '')}</span></div>`;
  const send = `<button type="button" class="ai-send" data-sendreview="${c.id}" title="Send this review to the AI chat as context">Send to chat</button>`;
  return `<div class="ai-review ${esc(r.verdict)}">${AI_LOGO_REST}<span class="airv-verdict">${esc(r.verdict)}</span><span class="airv-text">${esc(r.summary || '')}</span>${send}</div>`;
}

/* wire the AI-review + send-to-chat buttons inside a container (card list or modal) */
function wireAiReviewButtons(root) {
  root.querySelectorAll('[data-review]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    b.querySelector('span').textContent = 'Reviewing…';
    try { await api('/api/session/review/' + b.dataset.review, { method: 'POST' }); }
    catch (e) { toast(e.message); b.disabled = false; b.querySelector('span').textContent = 'AI review'; }
  }));
  root.querySelectorAll('[data-sendreview]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await api('/api/agent/context-review', { method: 'POST', body: projectBody({ changeId: b.dataset.sendreview }) });
      b.textContent = 'Sent ✓';
      const c = state.session?.changes.find((x) => x.id === b.dataset.sendreview);
      if ($('agentDrawer').classList.contains('open')) {
        // drawer already open: append the review card live instead of only on reopen
        if (c?.aiReview) appendAgentMsg('note', '', null, {
          kind: 'review', verdict: c.aiReview.verdict, summary: c.aiReview.summary,
          rule: state.session.ruleName, table: state.session.table, pk: c.pk,
          columns: c.cols.map((x) => x.column).join(', '),
        });
      } else {
        openAgent(); // refetches the conversation, which now includes the note
      }
    } catch (e) { toast(e.message); b.disabled = false; }
  }));
}

function aiReviewButton(c) {
  if (c.status !== 'pending') return '';
  const busy = c.aiReview?.status === 'pending';
  return `<button type="button" class="aireview glossy" data-review="${c.id}" ${busy ? 'disabled' : ''} title="Ask the connected AI to review this change">${busy ? AI_LOGO_FOCUS : AI_LOGO_REST}<span>${busy ? 'Reviewing…' : 'AI review'}</span></button>`;
}

function cardHtml(c, s, active) {
  const shorten = (v) => { const t = String(v ?? 'NULL'); return t.length > 60 ? t.slice(0, 60) + '…' : t; };
  const ident = Object.entries(c.display || {}).map(([k, v]) => `${esc(k)}: ${esc(shorten(v))}`).join(' · ');
  const diffs = c.cols.map((col) => {
    const key = c.id + ':' + col.column;
    const editedMark = col.manualEdit ? '<span class="editedmark" title="Proposed value was manually edited">edited</span>' : '';
    return `<div class="diff"><span class="col">${esc(col.column)} ${editedMark}</span>${diffHtml(col.before, col.after, key)}</div>`;
  }).join('');
  const staleInfo = c.status === 'stale' && c.currentValues
    ? `<div class="note">Current DB value(s): ${esc(JSON.stringify(c.currentValues))}. Re-run the preview to act on this row.</div>` : '';
  const actions = c.status === 'pending'
    ? `<div class="actions">
        <button class="approve" data-decide="approve" data-id="${c.id}" ${state.session?.status !== 'running' ? 'disabled' : ''}>Approve${active?' <kbd>A</kbd>':''}</button>
        <button class="reject" data-decide="reject" data-id="${c.id}" ${state.session?.status !== 'running' ? 'disabled' : ''}>Reject${active?' <kbd>R</kbd>':''}</button>
        <button data-decide="skip" data-id="${c.id}" ${state.session?.status !== 'running' ? 'disabled' : ''}>Skip${active?' <kbd>S</kbd>':''}</button>
        ${aiReviewButton(c)}
      </div>`
    : `<span class="badge ${c.status}">${c.status}</span>`;
  const selBox = c.status === 'pending'
    ? `<input type="checkbox" data-sel="${c.id}" ${selected.has(c.id) ? 'checked' : ''} title="Select for batch action">` : '';
  return `<div class="card ${c.status} ${active?'active':''}">
    <div class="head">${selBox}<span class="pk">${esc(s.pkColumn)} = ${esc(c.pk)}</span><span class="ident">${ident}</span>
      ${c.status !== 'pending' ? `<span class="badge ${c.status}">${c.status}</span>` : ''}
      <span class="headbtns">
        ${c.status === 'pending' && c.cols.length ? `<button type="button" data-editopen="1" data-cid="${c.id}" data-col="${esc(c.cols[0].column)}" title="Edit the proposed value in the large view">✎ Edit</button>` : ''}
        <button type="button" data-expand="${c.id}" title="Open in large view">⤢</button>
      </span></div>
    ${diffs}
    ${aiReviewStrip(c)}
    ${c.status === 'pending' ? actions : ''}
    ${c.note ? `<div class="note">${esc(c.note)}</div>` : ''}${staleInfo}
  </div>`;
}

/* Live-diff backdrop for the inline editor: marks every region of the draft
   that differs from the DB value, recomputed on each keystroke. */
function findChangeCol(key) {
  const cid = key.slice(0, key.indexOf(':'));
  const colName = key.slice(key.indexOf(':') + 1);
  return state.session?.changes.find((c) => c.id === cid)?.cols.find((x) => x.column === colName) || null;
}

// A textarea always normalizes its value to \n, so DB values with \r\n must be
// normalized the same way before diffing - otherwise every line looks changed.
const normNl = (v) => String(v ?? '').replace(/\r\n?/g, '\n');

function syncEditBackdrop(area) {
  const back = area.parentElement.querySelector('.editback');
  const col = findChangeCol(area.dataset.key);
  if (!back || !col) return;
  const segs = diffSegments(editorBeforeText(area.dataset.key, col), area.value);
  let html = '';
  for (const s of segs) {
    if (s.op === -1) continue; // removed text does not exist in the draft
    html += s.op === 1 ? `<mark>${esc(s.text)}</mark>` : esc(s.text);
  }
  back.innerHTML = html + '​'; // keeps a trailing newline from collapsing
  back.scrollTop = area.scrollTop;
}

/* ---------- Large card view ---------- */
let modalChangeId = null;

function openCardModal(changeId) {
  modalChangeId = changeId;
  renderCardModal();
  if (!$('cardModal').open) $('cardModal').showModal();
}

/* serialized-value editing state */
const editorSerialized = new Set();   // keys whose editor shows decoded JSON
const editorBeforeJson = new Map();   // key → decoded BEFORE value, for meaningful diffs
function closeEditor(key) {
  editorOpen.delete(key);
  editorSerialized.delete(key);
  editorBeforeJson.delete(key);
}
/* the text the live diff should compare the draft against */
function editorBeforeText(key, col) {
  return editorSerialized.has(key) ? String(editorBeforeJson.get(key) ?? '') : normNl(col.before);
}

/* Open the large view with one column's editor active, cursor on the first change */
async function openColumnEditor(cid, colName) {
  const key = cid + ':' + colName;
  if (!editorOpen.has(key)) {
    const col = findChangeCol(key);
    const after = String(col?.after ?? '').trim();
    if (col && /^(a|O):\d+:|^s:\d+:"/.test(after)) {
      // PHP-serialized: edit the decoded structure as JSON, re-serialize on save
      try {
        const dec = await api('/api/php', { method: 'POST', body: JSON.stringify({ mode: 'decode', value: String(col.after ?? '') }) });
        editorOpen.set(key, dec.json);
        editorSerialized.add(key);
        try {
          editorBeforeJson.set(key, (await api('/api/php', { method: 'POST', body: JSON.stringify({ mode: 'decode', value: String(col.before ?? '') }) })).json);
        } catch { editorBeforeJson.set(key, String(col.before ?? '')); }
      } catch {
        editorOpen.set(key, null); // not decodable (e.g. unknown PHP classes): raw editing
      }
    } else {
      editorOpen.set(key, null); // null draft = start from the proposed value
    }
  }
  openCardModal(cid);
  focusEditor(key);
}

function focusEditor(key) {
  const area = $('cardModalBody').querySelector(`.editArea[data-key="${CSS.escape(key)}"]`);
  const col = findChangeCol(key);
  if (!area || !col) return;
  area.focus();
  const segs = diffSegments(editorBeforeText(key, col), area.value);
  let pos = 0, start = -1, len = 0;
  for (const s of segs) {
    if (s.op === -1) continue;
    if (s.op === 1) { start = pos; len = s.text.length; break; }
    pos += s.text.length;
  }
  if (start >= 0) {
    area.setSelectionRange(start, start + len);
    area.scrollTop = Math.max(0, (start / Math.max(1, area.value.length)) * area.scrollHeight - area.clientHeight / 2);
    const back = area.parentElement.querySelector('.editback');
    if (back) back.scrollTop = area.scrollTop;
  }
}

function renderCardModal() {
  const s = state.session;
  const c = s?.changes.find((x) => x.id === modalChangeId);
  if (!c) { modalChangeId = null; if ($('cardModal').open) $('cardModal').close(); return; }
  const ident = Object.entries(c.display || {}).map(([k, v]) => `${esc(k)}: ${esc(String(v ?? 'NULL'))}`).join(' · ');
  const diffs = c.cols.map((col) => {
    const key = c.id + ':' + col.column;
    const edited = col.manualEdit ? '<span class="editedmark" title="Proposed value was manually edited">edited</span>' : '';
    const editBtn = c.status === 'pending' && !editorOpen.has(key)
      ? `<button type="button" class="editbtn" data-editopen="1" data-cid="${c.id}" data-col="${esc(col.column)}">✎ Edit</button>` : '';
    const serialized = editorSerialized.has(key);
    const body = editorOpen.has(key)
      ? `${serialized ? '<div class="hint" style="margin:0 0 .3rem">PHP-serialized value, decoded to JSON for editing. It is validated and re-serialized (byte lengths fixed) on save.</div>' : ''}
         <div class="editwrap"><div class="editback"></div><textarea class="editArea" data-key="${esc(key)}" rows="5">${esc(editorOpen.get(key) ?? (col.after ?? ''))}</textarea></div>
         <div class="actions">
           <button type="button" class="primary" data-editsave="1" data-cid="${c.id}" data-col="${esc(col.column)}">${serialized ? 'Re-serialize and save' : 'Save proposed value'}</button>
           <button type="button" data-editcancel="1" data-cid="${c.id}" data-col="${esc(col.column)}">Cancel</button>
         </div>`
      : diffHtml(col.before, col.after, key, false);
    return `<div class="diff"><span class="col">${esc(col.column)} ${edited} ${editBtn}</span>${body}</div>`;
  }).join('');
  const actions = c.status === 'pending'
    ? `<div class="actions">
        <button class="approve" data-decide="approve" data-id="${c.id}" ${state.session?.status !== 'running' ? 'disabled' : ''}>Approve <kbd>A</kbd></button>
        <button class="reject" data-decide="reject" data-id="${c.id}" ${state.session?.status !== 'running' ? 'disabled' : ''}>Reject <kbd>R</kbd></button>
        <button data-decide="skip" data-id="${c.id}" ${state.session?.status !== 'running' ? 'disabled' : ''}>Skip <kbd>S</kbd></button>
        ${aiReviewButton(c)}
      </div>` : '';
  const staleInfo = c.status === 'stale' && c.currentValues
    ? `<div class="note">Current DB value(s): ${esc(JSON.stringify(c.currentValues))}. Re-run the preview to act on this row.</div>` : '';
  $('cardModalBody').innerHTML = `<div class="card ${c.status}">
    <div class="head"><span class="pk">${esc(s.pkColumn)} = ${esc(c.pk)}</span><span class="ident">${ident}</span>
      ${c.status !== 'pending' ? `<span class="badge ${c.status}">${c.status}</span>` : ''}</div>
    ${diffs}${aiReviewStrip(c)}${actions}
    ${c.note ? `<div class="note">${esc(c.note)}</div>` : ''}${staleInfo}
  </div>`;
  const body = $('cardModalBody');
  wireAiReviewButtons(body);
  body.querySelectorAll('[data-decide]').forEach((btn) => {
    btn.addEventListener('click', () => decide(btn.dataset.id, btn.dataset.decide));
  });
  body.querySelectorAll('[data-editopen]').forEach((b) => b.addEventListener('click', () => {
    openColumnEditor(b.dataset.cid, b.dataset.col);
  }));
  body.querySelectorAll('[data-editcancel]').forEach((b) => b.addEventListener('click', () => {
    closeEditor(b.dataset.cid + ':' + b.dataset.col);
    renderCardModal();
  }));
  body.querySelectorAll('.editArea').forEach((t) => {
    t.addEventListener('input', () => {
      editorOpen.set(t.dataset.key, t.value); // keep the draft across SSE re-renders
      syncEditBackdrop(t);
    });
    t.addEventListener('scroll', () => {
      const back = t.parentElement.querySelector('.editback');
      if (back) back.scrollTop = t.scrollTop;
    });
    syncEditBackdrop(t);
  });
  body.querySelectorAll('[data-editsave]').forEach((b) => b.addEventListener('click', async () => {
    const key = b.dataset.cid + ':' + b.dataset.col;
    const area = body.querySelector(`.editArea[data-key="${CSS.escape(key)}"]`);
    if (!area) return;
    const col = findChangeCol(key);
    let newValue;
    if (editorSerialized.has(key)) {
      // JSON draft → validate and re-serialize server-side; bad JSON stays in the editor
      try {
        newValue = (await api('/api/php', { method: 'POST', body: JSON.stringify({ mode: 'encode', value: area.value }) })).serialized;
      } catch (err) { toast(err.message); return; }
    } else {
      // the textarea normalized \r\n to \n - restore the original convention so a
      // manual edit doesn't rewrite every line ending in the column
      newValue = col && /\r\n/.test(String(col.before ?? '')) ? area.value.replace(/\n/g, '\r\n') : area.value;
    }
    try {
      await api('/api/session/edit', {
        method: 'POST',
        body: JSON.stringify({ changeId: b.dataset.cid, column: b.dataset.col, newValue }),
      });
      closeEditor(key); // the SSE change event re-renders with the new diff
    } catch (err) { toast(err.message); }
  }));
}

$('btnCloseCard').addEventListener('click', () => $('cardModal').close());
$('cardModal').addEventListener('close', () => { modalChangeId = null; });

let deciding = false;
async function decide(changeId, action) {
  if (deciding) return;
  const blocked = decisionBlockedReason(changeId);
  if (blocked) { toast(blocked, 'warning'); return; }
  if (action === 'approve' && !(await confirmNoBackup('Approve this row anyway?'))) return;
  if (deciding) return; // re-check: another decision may have started while the dialog was open
  deciding = true;
  try { await api('/api/session/decision', { method: 'POST', body: JSON.stringify({ changeId, action }) }); }
  catch (err) { toast(err.message); }
  finally { deciding = false; }
}

/* Decision eligibility, shared by buttons, batch actions and shortcuts (the server enforces it too). */
function decisionBlockedReason(changeId) {
  const s = state.session;
  if (!s) return 'No approval session is loaded.';
  if (s.status === 'paused') return 'The session is paused: press Resume to decide again.';
  if (s.status !== 'running') return `The session is ${s.status}: no decisions can be made.`;
  if (changeId && !s.changes.some((c) => c.id === changeId && c.status === 'pending')) return 'That row is no longer pending.';
  return null;
}
/* the approval workspace is "active" only when the Updates page is the visible page and nothing sits above it */
function approvalWorkspaceActive() {
  if (!document.body.classList.contains('view-mysql')) return false;
  if (['serversDrawer', 'deployDrawer', 'sshDrawer', 'auditDrawer', 'connectorsDrawer', 'projectsDrawer'].some((id) => $(id)?.classList.contains('open'))) return false;
  if ($('agentDrawer')?.classList.contains('open') && $('agentDrawer').contains(document.activeElement)) return false;
  const openDialog = document.querySelector('dialog[open]');
  if (openDialog && openDialog.id !== 'cardModal') return false;
  return true;
}
document.addEventListener('keydown', (e) => {
  if (e.repeat || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const t = e.target;
  if (t && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable || t.closest?.('.xterm, .CodeMirror, [contenteditable]'))) return;
  const map = { a: 'approve', r: 'reject', s: 'skip' };
  const action = map[String(e.key).toLowerCase()];
  if (!action || !state.session) return;
  if (!approvalWorkspaceActive()) return; // Home, Settings, Deployments, terminals...: the shortcut does nothing
  if (decisionBlockedReason(null)) { e.preventDefault(); toast(decisionBlockedReason(null), 'warning'); return; }
  // while the large card view is open, shortcuts act on that card; otherwise on the first visible pending row
  const target = modalChangeId && $('cardModal').open
    ? state.session.changes.find((c) => c.id === modalChangeId && c.status === 'pending')
    : state.session.changes.find((c) => c.status === 'pending');
  if (target) { e.preventDefault(); decide(target.id, action); }
});

/* ---------- Dashboard ---------- */
const COUNT_KEYS = ['matched','pending','approved','rejected','skipped','failed','stale'];
function renderDashboard() {
  const c = state.session?.counts || Object.fromEntries(COUNT_KEYS.map((k) => [k, 0]));
  $('counts').innerHTML = COUNT_KEYS.map((k) => `<div class="count ${k}"><b>${c[k]||0}</b><span>${k}</span></div>`).join('');
  const done = (c.approved||0)+(c.rejected||0)+(c.skipped||0)+(c.failed||0)+(c.stale||0);
  const total = c.matched || 0;
  const seg = (n, color) => total ? `<div style="width:${(n/total*100)}%;background:${color}"></div>` : '';
  $('bar').innerHTML = seg(c.approved,'var(--green)')+seg(c.rejected,'var(--red)')+seg(c.skipped,'var(--amber)')+seg(c.failed,'#7a2727')+seg(c.stale,'var(--purple)');
  $('barLabel').textContent = total ? `${done} / ${total} decided` : 'no active session';
  renderReviewSummary();
}

/* review roll-up under the activity log: counts + approve-the-OK-ones */
function renderReviewSummary() {
  const box = $('reviewSummary');
  const s = state.session;
  const reviewed = s ? s.changes.filter((c) => c.status === 'pending' && c.aiReview && ['done', 'error'].includes(c.aiReview.status)) : [];
  if (!reviewed.length) { box.hidden = true; box.innerHTML = ''; return; }
  const n = { ok: 0, warn: 0, bad: 0, error: 0 };
  for (const c of reviewed) n[c.aiReview.status === 'error' ? 'error' : c.aiReview.verdict]++;
  const canApprove = s.status === 'running' && n.ok > 0;
  box.hidden = false;
  box.innerHTML = `
    <h2 style="margin-top:1rem">AI review summary</h2>
    <div class="rs-counts">
      <span class="rs ok">${n.ok} OK</span>
      <span class="rs warn">${n.warn} warn</span>
      <span class="rs bad">${n.bad} bad</span>
      ${n.error ? `<span class="rs err">${n.error} error</span>` : ''}
    </div>
    <button id="btnApproveOk" class="approve" ${canApprove ? '' : 'disabled'}>Approve all OK-reviewed (${n.ok})</button>`;
  const btn = $('btnApproveOk');
  if (btn) btn.addEventListener('click', approveReviewedOk);
}

async function approveReviewedOk() {
  const s = state.session;
  if (!s) return;
  const ids = s.changes.filter((c) => c.status === 'pending' && c.aiReview?.status === 'done' && c.aiReview.verdict === 'ok').map((c) => c.id);
  if (!ids.length) { toast('No OK-reviewed pending changes'); return; }
  if (!(await confirmNoBackup(`Approve ${ids.length} OK-reviewed row(s) anyway?`))) return;
  const ok = await confirmDialog({
    title: 'Approve OK-reviewed changes',
    message: `Approve the <b>${ids.length}</b> change(s) the AI reviewed as <b>OK</b>? Each is written individually with the usual stale guard; warn/bad/unreviewed changes are left untouched for you to handle.`,
    okLabel: `Approve ${ids.length}`, okClass: 'approve',
  });
  if (!ok) return;
  try {
    const r = await api('/api/session/batch', { method: 'POST', body: JSON.stringify({ changeIds: ids, action: 'approve' }) });
    const parts = Object.entries(r.results).map(([k, v]) => `${v} ${k}`).join(', ');
    toast(`Approved OK-reviewed: ${parts || 'nothing'}${r.stopped ? ', stopped: ' + r.stopped : ''}`);
  } catch (e) { toast(e.message); }
}

function appendLog(entry) {
  const log = $('log');
  const el = document.createElement('div');
  el.className = entry.level;
  el.innerHTML = `<time>${entry.time.slice(11,19)}</time>${esc(entry.msg)}`;
  log.appendChild(el);
  while (log.children.length > 300) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

$('backupSelect').addEventListener('change', async () => {
  const fmt = $('backupSelect').value;
  $('backupSelect').value = '';
  if (!fmt) return;
  try {
    const res = await fetch('/api/session/backup?format=' + fmt);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (res.headers.get('content-disposition')?.match(/filename="(.+)"/) || [])[1] || `backup.${fmt}`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) { toast('Backup failed: ' + e.message); }
});

$('btnClearAll').addEventListener('click', async () => {
  const s = state.session;
  if (!s) return;
  const pending = s.counts?.pending ?? 0;
  const ok = await confirmDialog({
    title: 'Clear preview',
    message: `Clear the current preview and reset the queue?<br>` +
      `${pending ? `<b>${pending}</b> pending change(s) will be discarded and ` : ''}<b>nothing</b> is written to the database. ` +
      `Rows you already approved stay committed (they are in the audit log and backups).`,
    okLabel: 'Clear all', okClass: 'warn',
  });
  if (ok) api('/api/session/clear', { method: 'POST' }).catch((e) => toast(e.message));
});

/* ---------- Batch actions ---------- */
let batching = false;
async function batch(action) {
  if (batching || !selected.size) return;
  const n = selected.size;
  if (action === 'approve' && !(await confirmNoBackup(`Continue to the batch confirmation for ${n} row(s)?`))) return;
  const verb = action === 'approve' ? 'Approve' : action === 'reject' ? 'Reject' : 'Skip';
  const ok = await confirmDialog({
    title: `${verb} selected rows`,
    message: action === 'approve'
      ? `You are about to approve <b>${n}</b> selected row(s).<br>Each row is written individually with its own guarded UPDATE, verified against its preview value; rows modified externally in the meantime are flagged stale and never overwritten.`
      : `${verb} <b>${n}</b> selected row(s)?<br>Nothing will be written to the database.`,
    okLabel: `${verb} ${n} row(s)`,
    okClass: action === 'approve' ? 'approve' : action === 'reject' ? 'reject' : 'primary',
  });
  if (!ok) return;
  batching = true;
  try {
    const r = await api('/api/session/batch', { method: 'POST', body: JSON.stringify({ changeIds: [...selected], action }) });
    const parts = Object.entries(r.results).map(([k, v]) => `${v} ${k}`).join(', ');
    toast(`Batch ${action}: ${parts || 'nothing done'}${r.stopped ? ', stopped: ' + r.stopped : ''}`);
  } catch (e) { toast(e.message); }
  finally { batching = false; }
}
$('btnBatchApprove').addEventListener('click', () => batch('approve'));
$('btnBatchReject').addEventListener('click', () => batch('reject'));
$('btnBatchSkip').addEventListener('click', () => batch('skip'));
$('btnSelAll').addEventListener('click', () => {
  (state.session?.changes || []).forEach((c) => { if (c.status === 'pending') selected.add(c.id); });
  renderQueue();
});

// resolves when a change's SSE-updated review reaches a terminal state
function waitForReview(changeId, timeoutMs = 240000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      const c = state.session?.changes.find((x) => x.id === changeId);
      if (!c || !state.session) return resolve();
      if (c.aiReview && ['done', 'error'].includes(c.aiReview.status)) return resolve();
      if (Date.now() - t0 > timeoutMs) return resolve();
      setTimeout(tick, 250);
    };
    tick();
  });
}

let reviewingAll = false;
$('btnReviewSel').addEventListener('click', async () => {
  if (reviewingAll || !state.session) return;
  if (!selected.size) { toast('Select one or more changes first'); return; }
  // review selected pending changes without a completed/in-flight review
  const todo = state.session.changes.filter((c) =>
    selected.has(c.id) && c.status === 'pending' && !['pending', 'done'].includes(c.aiReview?.status));
  if (!todo.length) { toast('Selected changes are already reviewed'); return; }
  const ok = await confirmDialog({
    title: 'AI review selected',
    message: `Run an AI review on <b>${todo.length}</b> selected change(s)? Each is one AI call, done one at a time - this can take a while and consumes usage.`,
    okLabel: `Review ${todo.length}`, okClass: 'primary',
  });
  if (!ok) return;
  reviewingAll = true;
  const btn = $('btnReviewSel');
  const label = btn.querySelector('span');
  btn.disabled = true;
  try {
    for (let i = 0; i < todo.length; i++) {
      if (!state.session) break; // session cleared/aborted mid-run
      label.textContent = `Reviewing ${i + 1}/${todo.length}…`;
      try {
        await api('/api/session/review/' + todo[i].id, { method: 'POST' });
        // the endpoint returns before the LLM finishes (result arrives via SSE);
        // wait for THIS review to settle before starting the next one
        await waitForReview(todo[i].id);
      } catch { /* per-change failure already surfaces on its card; keep going */ }
    }
  } finally {
    reviewingAll = false;
    btn.disabled = false;
    label.textContent = 'AI review selected';
    updateToolbar();
  }
});
$('btnSelNone').addEventListener('click', () => { selected.clear(); renderQueue(); });

/* ---------- Connections modal ---------- */
let conns = { activeId: null, profiles: [] };

async function refreshHeader() {
  const st = await api('/api/state');
  $('dbInfo').textContent = `profile: ${st.config.profile} · db: ${st.config.database || '(unset)'}${st.config.sshTunnel ? ' · via SSH tunnel' : ''}`;
}

async function loadConns() {
  conns = await api('/api/connections');
  const list = $('connList');
  list.innerHTML = conns.profiles.length ? '' : '<div class="empty">No saved connections - create one below.</div>';
  for (const p of conns.profiles) {
    const isActive = p.id === conns.activeId;
    const el = document.createElement('div');
    el.className = 'conn-card' + (isActive ? ' active' : '');
    el.innerHTML = `
      <div class="conn-head">
        <b class="conn-name">${esc(p.name)}</b>
        ${isActive ? '<span class="badge approved">active</span>' : ''}
        <span class="spacer"></span>
        ${isActive ? '' : '<button data-act="activate" class="primary">Use</button>'}
        <button data-act="test">Test</button>
        <button class="iconbtn" data-act="edit" title="Edit connection">${RULE_ICONS.edit}</button>
        ${isActive ? '' : `<button class="iconbtn danger" data-act="delete" title="Delete connection">${RULE_ICONS.trash}</button>`}
      </div>
      <div class="conn-route">
        <span class="chip">This tool</span><span class="arrow">→</span>
        ${p.ssh.enabled ? `<span class="chip ssh">SSH · ${esc(p.ssh.user ? p.ssh.user + '@' : '')}${esc(p.ssh.host)}</span><span class="arrow">→</span>` : ''}
        <span class="chip db">MySQL · ${esc(p.db.host)}:${p.db.port}</span>
      </div>
      <div class="conn-fields">
        <div><span class="flabel">Database</span><span class="fval">${esc(p.db.database)}</span></div>
        <div><span class="flabel">User</span><span class="fval">${esc(p.db.user)}</span></div>
        <div><span class="flabel">Connection</span><span class="fval">${p.ssh.enabled ? 'SSH tunnel' : 'Direct'}</span></div>
      </div>
      <div class="conn-status" hidden></div>`;
    el.addEventListener('click', async (e) => {
      const btn = e.target.closest?.('[data-act]');
      const act = btn?.dataset.act;
      if (!act) return;
      const status = el.querySelector('.conn-status');
      try {
        if (act === 'activate') {
          await api(`/api/connections/${p.id}/activate`, { method: 'POST' });
          state.schema = null;
          $('tableList').innerHTML = '';
          $('colList').innerHTML = '';
          updateSqlHints(); // stale tables from the previous connection must not be suggested
          await Promise.all([refreshHeader(), loadConns()]);
          toast(`Now using "${p.name}" - reload the schema for autocomplete`);
        } else if (act === 'test') {
          btn.disabled = true;
          status.hidden = false;
          status.className = 'conn-status';
          status.textContent = 'Testing connection…';
          const t0 = Date.now();
          await api(`/api/connections/${p.id}/test`, { method: 'POST' });
          status.className = 'conn-status ok';
          status.textContent = `Connection OK, reached the database in ${Date.now() - t0} ms`;
        } else if (act === 'edit') {
          fillConnForm(p);
        } else if (act === 'delete') {
          const ok = await confirmDialog({
            title: 'Delete connection',
            message: `Delete the connection profile <b>${esc(p.name)}</b>?<br>Its stored credentials are removed from connections.json.`,
            okLabel: 'Delete connection', okClass: 'reject',
          });
          if (ok) { await api(`/api/connections/${p.id}`, { method: 'DELETE' }); loadConns(); }
        }
      } catch (err) {
        if (act === 'test' && status) {
          status.hidden = false;
          status.className = 'conn-status err';
          status.textContent = 'Failed: ' + err.message;
        } else {
          toast(err.message);
        }
      } finally {
        if (act === 'test' && btn) btn.disabled = false;
      }
    });
    list.appendChild(el);
  }
}

function fillConnForm(p) {
  $('connForm').hidden = false;
  $('cId').value = p?.id || '';
  $('cName').value = p?.name || '';
  $('cDbHost').value = p?.db.host || '';
  $('cDbPort').value = p?.db.port || '';
  $('cDbUser').value = p?.db.user || '';
  $('cDbPass').value = '';
  $('cDbPass').placeholder = p?.db.passwordSet ? '(unchanged - type to replace)' : '';
  $('cDbName').value = p?.db.database || '';
  $('cSshOn').checked = !!p?.ssh.enabled;
  $('sshFields').hidden = !p?.ssh.enabled;
  $('cSshHost').value = p?.ssh.host || '';
  $('cSshPort').value = p?.ssh.port || '';
  $('cSshUser').value = p?.ssh.user || '';
  $('cSshPass').value = '';
  $('cSshPass').placeholder = p?.ssh.passwordSet ? '(unchanged - type to replace)' : '';
  $('cSshKey').value = p?.ssh.privateKeyPath || '';
  $('cSshPhrase').value = '';
  $('cSshPhrase').placeholder = p?.ssh.passphraseSet ? '(unchanged - type to replace)' : '';
  $('cName').focus();
}

// Connections opens from the sidebar (navigation.js: openConnectionsPage)
$('btnCloseConn').addEventListener('click', () => $('connModal').close());
$('btnNewConn').addEventListener('click', () => fillConnForm(null));
$('btnCancelConn').addEventListener('click', () => { $('connForm').hidden = true; });
$('cSshOn').addEventListener('change', () => { $('sshFields').hidden = !$('cSshOn').checked; });

$('connForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    name: $('cName').value,
    db: { host: $('cDbHost').value, port: Number($('cDbPort').value) || 3306, user: $('cDbUser').value, password: $('cDbPass').value, database: $('cDbName').value },
    ssh: { enabled: $('cSshOn').checked, host: $('cSshHost').value, port: Number($('cSshPort').value) || 22, user: $('cSshUser').value, password: $('cSshPass').value, privateKeyPath: $('cSshKey').value, passphrase: $('cSshPhrase').value },
  };
  const id = $('cId').value;
  try {
    await api(id ? `/api/connections/${id}` : '/api/connections', { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) });
    $('connForm').hidden = true;
    await Promise.all([loadConns(), refreshHeader()]);
  } catch (err) { toast(err.message); }
});

/* ---------- Schema map (SVG) ---------- */
/* Pure layout+markup builder - takes the /api/schema/graph payload,
 * returns {svg, width, height}. Kept DOM-free so it is unit-testable. */
/* Turn a list of waypoints into a path whose corners are smoothed with
 * quadratic beziers - straight runs, curved bends. */
function roundedPath(pts, radius = 22) {
  const n = (v) => Math.round(v * 10) / 10;
  let d = `M ${n(pts[0].x)} ${n(pts[0].y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i], prev = pts[i - 1], next = pts[i + 1];
    const d1 = Math.hypot(p.x - prev.x, p.y - prev.y);
    const d2 = Math.hypot(next.x - p.x, next.y - p.y);
    const r = Math.min(radius, d1 / 2, d2 / 2);
    if (r < 0.5) { d += ` L ${n(p.x)} ${n(p.y)}`; continue; }
    const inP = { x: p.x - ((p.x - prev.x) / d1) * r, y: p.y - ((p.y - prev.y) / d1) * r };
    const outP = { x: p.x + ((next.x - p.x) / d2) * r, y: p.y + ((next.y - p.y) / d2) * r };
    d += ` L ${n(inP.x)} ${n(inP.y)} Q ${n(p.x)} ${n(p.y)} ${n(outP.x)} ${n(outP.y)}`;
  }
  const last = pts[pts.length - 1];
  return d + ` L ${n(last.x)} ${n(last.y)}`;
}

/* Edge path between two (movable) boxes - also used live while dragging.
 * 4-point orthogonal routing (start, two bends, end) with bezier-rounded
 * corners: leaves the card horizontally, turns smoothly, enters horizontally. */
function schemaEdgeD(a, b, fromColumn, toColumn) {
  const GAP = 26; // clearance beyond a card edge before turning
  const sy = a.y + (a.rows[fromColumn] ?? a.h / 2);
  const ty = b.y + (b.rows[toColumn] ?? 12);
  if (a === b) { // self-reference: loop out of the right edge and back in
    const r = a.x + a.w, x0 = r + GAP + 10;
    return roundedPath([{ x: r, y: sy }, { x: x0, y: sy }, { x: x0, y: ty }, { x: r, y: ty }], 14);
  }
  const aL = a.x, aR = a.x + a.w, bL = b.x, bR = b.x + b.w;
  if (bL - aR >= GAP) { // target clearly to the right: elbow through the middle
    const mx = (aR + bL) / 2;
    return roundedPath([{ x: aR, y: sy }, { x: mx, y: sy }, { x: mx, y: ty }, { x: bL, y: ty }]);
  }
  if (aL - bR >= GAP) { // target clearly to the left
    const mx = (aL + bR) / 2;
    return roundedPath([{ x: aL, y: sy }, { x: mx, y: sy }, { x: mx, y: ty }, { x: bR, y: ty }]);
  }
  // cards overlap horizontally: detour along the right side of both
  const x0 = Math.max(aR, bR) + GAP;
  return roundedPath([{ x: aR, y: sy }, { x: x0, y: sy }, { x: x0, y: ty }, { x: bR, y: ty }]);
}

function buildSchemaSvg(g) {
  const BOX_W = 210, ROW_H = 15, HEAD_H = 24, PAD_X = 70, PAD_Y = 46, MAX_ROWS = 14;
  const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  const boxes = new Map();
  const nCols = Math.max(2, Math.ceil(Math.sqrt(g.tables.length * 1.7)));
  const colY = new Array(nCols).fill(PAD_Y);
  for (const t of [...g.tables].sort((a, b) => a.name.localeCompare(b.name))) {
    const shown = t.columns.slice(0, MAX_ROWS);
    const extra = t.columns.length - shown.length;
    const h = HEAD_H + (shown.length + (extra > 0 ? 1 : 0)) * ROW_H + 8;
    const ci = colY.indexOf(Math.min(...colY));
    const x = PAD_X + ci * (BOX_W + PAD_X);
    const y = colY[ci];
    colY[ci] = y + h + PAD_Y;
    const rows = {}; // row centers relative to the box top, so boxes can move freely
    shown.forEach((c, i) => { rows[c.name] = HEAD_H + i * ROW_H + ROW_H / 2 + 2; });
    boxes.set(t.name, { name: t.name, t, x, y, w: BOX_W, h, shown, extra, rows });
  }
  const width = PAD_X + nCols * (BOX_W + PAD_X);
  const height = Math.max(...colY) + PAD_Y;

  let edges = '';
  for (const r of g.relations) {
    const a = boxes.get(r.from), b = boxes.get(r.to);
    if (!a || !b) continue;
    edges += `<path class="edge${r.inferred ? ' inferred' : ''}" data-from="${esc(r.from)}" data-to="${esc(r.to)}"
      data-fromcol="${esc(r.fromColumn)}" data-tocol="${esc(r.toColumn)}"
      d="${schemaEdgeD(a, b, r.fromColumn, r.toColumn)}" marker-end="url(#arrow)">
      <title>${esc(r.from)}.${esc(r.fromColumn)} → ${esc(r.to)}.${esc(r.toColumn)}${r.inferred ? ' (inferred)' : ''}</title></path>`;
  }

  let nodes = '';
  for (const { t, x, y, w, h, shown, extra, rows } of boxes.values()) {
    let rowsMk = '';
    for (const c of shown) {
      rowsMk += `<text x="8" y="${rows[c.name] + 3.5}" font-size="10" class="${c.isPk ? 'col-pk' : ''}">
        ${esc(trunc(c.name, 22))}${c.isPk ? ' ⚿' : ''}<title>${esc(c.name)} · ${esc(c.type)}</title></text>
        <text x="${w - 8}" y="${rows[c.name] + 3.5}" font-size="8.5" text-anchor="end" class="col-type">${esc(trunc(c.type, 10))}</text>`;
    }
    if (extra > 0) rowsMk += `<text x="8" y="${h - 7}" font-size="9" class="col-more">… +${extra} more columns</text>`;
    nodes += `<g data-table="${esc(t.name)}"${t.related ? ' data-related="1"' : ''} transform="translate(${x} ${y})">
      <rect class="tbl-box" x="0" y="0" width="${w}" height="${h}" rx="7"></rect>
      <rect class="tbl-head" x="0" y="0" width="${w}" height="${HEAD_H}" rx="7"></rect>
      <rect class="tbl-head" x="0" y="${HEAD_H - 7}" width="${w}" height="7"></rect>
      <text class="tbl-title" x="8" y="16" font-size="11">${esc(trunc(t.name, 23))}<title>${esc(t.name)} - ${t.columns.length} columns</title></text>
      <text class="ddl-btn" data-ddl="${esc(t.name)}" x="${w - 8}" y="16" text-anchor="end" font-size="9">DDL<title>Show CREATE TABLE statement</title></text>
      ${rowsMk}</g>`;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">
    <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#3d4f66"></path></marker></defs>
    ${edges}${nodes}</svg>`;
  return { svg, width, height, boxes };
}

const schemaView = { el: null, vb: null, boxes: null, graph: null, selected: null };

function updateEdgesFor(name) {
  schemaView.el.querySelectorAll(`.edge[data-from="${CSS.escape(name)}"], .edge[data-to="${CSS.escape(name)}"]`).forEach((p) => {
    const a = schemaView.boxes.get(p.dataset.from), b = schemaView.boxes.get(p.dataset.to);
    if (a && b) p.setAttribute('d', schemaEdgeD(a, b, p.dataset.fromcol, p.dataset.tocol));
  });
}
const applySchemaVb = () => {
  if (schemaView.el && schemaView.vb) {
    const { x, y, w, h } = schemaView.vb;
    schemaView.el.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
  }
};

function renderSchemaMap(g) {
  const canvas = $('schemaCanvas');
  if (!g.tables.length) {
    schemaView.el = null;
    canvas.innerHTML = '<div class="empty" style="padding:1rem">No tables match this filter.</div>';
    $('schemaMapInfo').textContent = `- ${g.database}: 0 of ${g.totalTables} tables`;
    return;
  }
  const { svg, width, height, boxes } = buildSchemaSvg(g);
  canvas.innerHTML = svg;
  schemaView.boxes = boxes;
  schemaView.graph = g;
  schemaView.selected = null;
  $('schemaDrawer').hidden = true;
  const nRelated = g.tables.filter((t) => t.related).length;
  const nMatched = g.tables.length - nRelated;
  const truncated = nMatched < g.totalTables;
  $('schemaMapInfo').textContent =
    `- ${g.database}: showing ${nMatched} of ${g.totalTables} tables` +
    (nRelated ? ` + ${nRelated} related` : '') +
    `, ${g.relations.length} relations (${g.relations.filter((r) => r.inferred).length} inferred)` +
    (truncated ? '. Use the filter to narrow down' : '');
  schemaView.el = canvas.querySelector('svg');
  schemaView.vb = { x: 0, y: 0, w: width, h: height };
  applySchemaVb();

  // hovering a table lights up its relations
  schemaView.el.querySelectorAll('g[data-table]').forEach((gEl) => {
    const name = gEl.dataset.table;
    gEl.addEventListener('mouseenter', () => schemaView.el.querySelectorAll(`.edge[data-from="${CSS.escape(name)}"], .edge[data-to="${CSS.escape(name)}"]`).forEach((p) => p.classList.add('hot')));
    gEl.addEventListener('mouseleave', () => schemaView.el.querySelectorAll('.edge.hot').forEach((p) => p.classList.remove('hot')));
  });
}

/* pan / zoom via viewBox - wired once */
(() => {
  const canvas = $('schemaCanvas');
  canvas.addEventListener('wheel', (e) => {
    if (!schemaView.el) return;
    e.preventDefault();
    const vb = schemaView.vb;
    const k = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    const rect = canvas.getBoundingClientRect();
    const mx = vb.x + ((e.clientX - rect.left) / rect.width) * vb.w;
    const my = vb.y + ((e.clientY - rect.top) / rect.height) * vb.h;
    vb.x = mx - (mx - vb.x) * k; vb.y = my - (my - vb.y) * k;
    vb.w *= k; vb.h *= k;
    applySchemaVb();
  }, { passive: false });
  let drag = null, dragDist = 0, downTarget = null, tableDrag = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (!schemaView.el) return;
    drag = { x: e.clientX, y: e.clientY };
    dragDist = 0;
    downTarget = e.target; // real element under the press - pointer capture retargets later events to the canvas
    const gEl = e.target.closest?.('g[data-table]');
    if (gEl && schemaView.boxes?.has(gEl.dataset.table)) {
      tableDrag = { gEl, box: schemaView.boxes.get(gEl.dataset.table) };
      schemaView.el.appendChild(gEl); // bring the dragged card to the front
    }
    canvas.classList.add('dragging');
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || !schemaView.el) return;
    const vb = schemaView.vb;
    const rect = canvas.getBoundingClientRect();
    // preserveAspectRatio "meet": one scale for both axes
    const upp = Math.max(vb.w / rect.width, vb.h / rect.height);
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    dragDist += Math.abs(dx) + Math.abs(dy);
    if (tableDrag) {
      tableDrag.box.x += dx * upp;
      tableDrag.box.y += dy * upp;
      tableDrag.gEl.setAttribute('transform', `translate(${tableDrag.box.x} ${tableDrag.box.y})`);
      updateEdgesFor(tableDrag.box.name);
    } else {
      vb.x -= dx * upp;
      vb.y -= dy * upp;
      applySchemaVb();
    }
    drag = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener('pointerup', () => {
    drag = null;
    tableDrag = null;
    canvas.classList.remove('dragging');
    // a press-and-release without dragging is a click on whatever was under the press
    if (dragDist <= 5 && downTarget) {
      const ddl = downTarget.closest?.('[data-ddl]');
      if (ddl) {
        showDdl(ddl.dataset.ddl);
      } else {
        const gT = downTarget.closest?.('g[data-table]');
        selectSchemaTable(gT ? gT.dataset.table : null); // background click deselects
      }
    }
    downTarget = null;
  });
})();

/* ---------- table selection + details drawer ---------- */
function selectSchemaTable(name) {
  if (!schemaView.el) return;
  schemaView.el.querySelectorAll('g.selected').forEach((el) => el.classList.remove('selected'));
  schemaView.el.querySelectorAll('.edge.sel').forEach((p) => p.classList.remove('sel'));
  schemaView.selected = name || null;
  if (!name) { $('schemaDrawer').hidden = true; return; }
  const gEl = schemaView.el.querySelector(`g[data-table="${CSS.escape(name)}"]`);
  if (gEl) gEl.classList.add('selected');
  schemaView.el.querySelectorAll(`.edge[data-from="${CSS.escape(name)}"], .edge[data-to="${CSS.escape(name)}"]`)
    .forEach((p) => p.classList.add('sel'));
  renderSchemaDrawer(name);
}

function renderSchemaDrawer(name) {
  const g = schemaView.graph;
  const t = g?.tables.find((x) => x.name === name);
  if (!t) { $('schemaDrawer').hidden = true; return; }
  $('drawerTitle').textContent = t.name;
  const pkMark = (c) => (c.isPk ? ' <span class="cpk">⚿ PK</span>' : '');
  const cols = t.columns.map((c) =>
    `<div class="colrow"><span>${esc(c.name)}${pkMark(c)}</span><span class="ctype">${esc(c.type)}</span></div>`).join('');
  const relRow = (r, dir) => {
    const partner = dir === 'out' ? r.to : r.from;
    const label = dir === 'out'
      ? `${esc(r.fromColumn)} → ${esc(r.to)}.${esc(r.toColumn)}`
      : `${esc(r.from)}.${esc(r.fromColumn)} → ${esc(r.toColumn)}`;
    const canJump = schemaView.boxes?.has(partner) && partner !== name;
    return `<div class="relrow">${canJump ? `<button data-goto="${esc(partner)}" title="Select ${esc(partner)}">→</button>` : ''}
      <span>${label}${r.inferred ? ' <span class="relinf">(inferred)</span>' : ''}</span></div>`;
  };
  const out = g.relations.filter((r) => r.from === name);
  const inc = g.relations.filter((r) => r.to === name && r.from !== name);
  const approx = t.approxRows == null ? 'rows: n/a' : `≈ ${Number(t.approxRows).toLocaleString()} rows`;
  $('drawerBody').innerHTML =
    `<div class="hint" style="margin:0">${t.columns.length} columns · <span id="drawerRows">${approx}</span>
      <button id="btnExactCount" style="padding:0 .4rem;font-size:.68rem" title="Run SELECT COUNT(*) - may take a moment on large tables">count exactly</button>${t.related ? ' · pulled in as a relation of your search' : ''}</div>
     <h3>Columns</h3>${cols}
     <h3>References (outgoing: ${out.length})</h3>${out.map((r) => relRow(r, 'out')).join('') || '<div class="hint" style="margin:0">none</div>'}
     <h3>Referenced by (incoming: ${inc.length})</h3>${inc.map((r) => relRow(r, 'in')).join('') || '<div class="hint" style="margin:0">none</div>'}`;
  $('drawerBody').querySelectorAll('[data-goto]').forEach((b) =>
    b.addEventListener('click', () => selectSchemaTable(b.dataset.goto)));
  $('btnExactCount').addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'counting…';
    try {
      const r = await api('/api/schema/table/' + encodeURIComponent(name) + '/count');
      $('drawerRows').textContent = `${Number(r.rows).toLocaleString()} rows (exact)`;
      e.target.remove();
    } catch (err) {
      toast(err.message);
      e.target.disabled = false;
      e.target.textContent = 'count exactly';
    }
  });
  $('schemaDrawer').hidden = false;
}

$('btnDrawerClose').addEventListener('click', () => selectSchemaTable(null));
$('btnDrawerDdl').addEventListener('click', () => { if (schemaView.selected) showDdl(schemaView.selected); });

async function showDdl(table) {
  try {
    const r = await api('/api/schema/table/' + encodeURIComponent(table) + '/ddl');
    $('ddlTitle').textContent = `- ${r.table}`;
    $('ddlText').textContent = r.ddl + ';';
    $('ddlModal').showModal();
  } catch (e) { toast(e.message); }
}
$('btnCloseDdl').addEventListener('click', () => $('ddlModal').close());
$('btnCopyDdl').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('ddlText').textContent); toast('Copied to clipboard'); }
  catch { toast('Clipboard unavailable - select the text manually'); }
});
$('btnDownloadDdl').addEventListener('click', () => {
  const name = ($('ddlTitle').textContent.replace(/^-\s*/, '') || 'table').replace(/[^A-Za-z0-9_-]+/g, '_');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([$('ddlText').textContent], { type: 'application/sql' }));
  a.download = `create-${name}.sql`;
  a.click();
  URL.revokeObjectURL(a.href);
});

/* Database errors: a plain explanation with recovery actions; the raw driver message stays available but folded. */
const DB_CONN_RE = /ECONN[A-Z]+|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|EPIPE|PROTOCOL_CONNECTION_LOST|PROTOCOL_ENQUEUE|ER_ACCESS_DENIED|ER_BAD_DB_ERROR|ER_DBACCESS_DENIED|Handshake|ssh|tunnel|connect(ion)? (failed|refused|timed out)|getaddrinfo/i;
function dbErrorInfo(e) {
  const raw = String(e?.message || e || '');
  if (/ER_ACCESS_DENIED|ER_DBACCESS_DENIED|Access denied/i.test(raw)) return { title: 'This database refused the credentials', hint: 'The user or password of the active connection profile is not accepted.' };
  if (/ER_BAD_DB_ERROR|Unknown database/i.test(raw)) return { title: "This database doesn't exist on the server", hint: 'Check the database name in the connection profile.' };
  if (/ssh|tunnel/i.test(raw)) return { title: "Couldn't open the SSH tunnel to this database", hint: 'The SSH host, port, user or key of the connection profile may be wrong, or the server is unreachable.' };
  if (DB_CONN_RE.test(raw)) return { title: "Couldn't connect to this database", hint: 'The host is unreachable or nothing listens on that port. Is the database (or its SSH tunnel) up, and is the profile pointing at the right host and port?' };
  return null;
}
function dbErrorBlock(e, { retry, compact = false } = {}) {
  const info = dbErrorInfo(e);
  const raw = String(e?.message || e || '');
  const el = document.createElement('div');
  el.className = 'db-error';
  el.innerHTML = `<b>${esc(info ? info.title : 'The database request failed')}</b>${info ? `<div class="hint">${esc(info.hint)}</div>` : ''}
    <div class="actions"><button type="button" class="primary" data-db="edit">Edit connection</button>${retry ? '<button type="button" data-db="retry">Retry</button>' : ''}</div>
    ${info || !compact ? `<details><summary>Technical details</summary><pre>${esc(raw)}</pre></details>` : ''}`;
  el.querySelector('[data-db="edit"]').addEventListener('click', () => {
    if (typeof openConnectionsPage === 'function') return openConnectionsPage(); // the Connections page (router)
    ['schemaModal', 'settingsModal'].forEach((id) => { const d = $(id); if (d?.open) d.close(); }); $('connForm').hidden = true; loadConns().catch((err) => toast(err.message, 'error')); $('connModal').showModal();
  });
  if (retry) el.querySelector('[data-db="retry"]').addEventListener('click', retry);
  return el;
}
const dbErrorToast = (e, prefix = '') => { const info = dbErrorInfo(e); toast(`${prefix}${info ? info.title : String(e?.message || e)}`, 'error'); };
async function loadSchemaMap(q) {
  $('schemaCanvas').innerHTML = '<div class="empty" style="padding:1rem">Loading schema…</div>';
  schemaView.el = null;
  try { renderSchemaMap(await api('/api/schema/graph?q=' + encodeURIComponent(q || ''))); }
  catch (e) {
    $('schemaCanvas').innerHTML = '';
    $('schemaCanvas').appendChild(dbErrorBlock(e, { retry: () => loadSchemaMap($('schemaFilter').value.trim()) }));
    dbErrorToast(e, 'Schema map: ');
  }
}

$('btnSchemaMap').addEventListener('click', () => {
  $('schemaModal').showModal();
  loadSchemaMap($('schemaFilter').value.trim());
});
let schemaFilterTimer;
$('schemaFilter').addEventListener('input', () => {
  clearTimeout(schemaFilterTimer);
  schemaFilterTimer = setTimeout(() => loadSchemaMap($('schemaFilter').value.trim()), 350);
});
$('btnCloseSchema').addEventListener('click', () => $('schemaModal').close());

/* ---------- Session controls ---------- */
$('btnPause').addEventListener('click', () => api('/api/session/pause', {method:'POST'}).catch((e)=>toast(e.message)));
$('btnResume').addEventListener('click', () => api('/api/session/resume', {method:'POST'}).catch((e)=>toast(e.message)));
$('btnAbort').addEventListener('click', async () => {
  const pending = state.session?.counts?.pending ?? 0;
  const ok = await confirmDialog({
    title: 'Abort session',
    message: `Abort the current session?<br><b>${pending}</b> pending change(s) will be discarded and <b>nothing</b> is written to the database. Rows you already approved stay committed.`,
    okLabel: 'Abort session', okClass: 'warn',
  });
  if (ok) api('/api/session/abort', { method: 'POST' }).catch((e) => toast(e.message));
});

/* ---------- SSE ----------
   The 'agent' stream is conversation-scoped on the server (lib/agent-workflow agentEventForViewer):
   an UNSCOPED subscriber only ever receives operational summaries, never a word of what was said.
   So the stream is NAMED at subscribe time and re-pointed at the conversation on screen through
   POST /api/events/scope, because EventSource cannot send anything after it is opened. The scope
   value is the conversationId the server reports (a terminal session, or "project:<id>"). */
const sseStreamId = 'st-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
let sseScopedTo;            // the conversation the live stream is currently pointed at ('' = none)
let sseSource = null;
const sseUrl = () => '/api/events?' + new URLSearchParams({ stream: sseStreamId, ...(agentConversation() ? { sessionId: agentConversation() } : {}) });
function scopeSse(conversationId = agentConversation()) {
  const want = conversationId || '';
  if (!sseSource || sseScopedTo === want) return;
  sseScopedTo = want;
  api('/api/events/scope', { method: 'POST', body: JSON.stringify({ stream: sseStreamId, sessionId: want || null }) })
    .catch(() => { sseScopedTo = undefined; }); // an ended/unknown conversation: retry on the next switch
}

/* Every 'agent' event names its session AND its turn. An event for another conversation, for a turn
   the user stopped, or for a turn that was superseded, is dropped rather than painted somewhere wrong. */
let agentTurn = null; // { sessionId, turnId, cancelled } for the turn this tab is waiting on
function agentEventForTurn(ev) {
  const turn = agentTurn;
  if (!turn || turn.cancelled) return false;      // nothing running, or the user pressed Stop
  if (turn.sessionId !== agentSessionId()) return false;
  if (!ev.turnId) return true;                    // unnamed: an older server, still ours
  // the first turn id we see IS this turn: the HTTP reply that carries it has not landed yet.
  // Once pinned it never moves, so any other id belongs to a turn we stopped showing.
  if (!turn.turnId) turn.turnId = ev.turnId;
  return turn.turnId === ev.turnId;
}
function connectSSE() {
  const es = sseSource = new EventSource(sseUrl());
  es.onopen = () => {
    $('sseDot').classList.add('ok');
    // a reconnect reuses the original URL, so record what it asked for and re-scope if we moved on
    sseScopedTo = new URLSearchParams(es.url.split('?')[1] || '').get('sessionId') || '';
    scopeSse();
  };
  es.onerror = () => $('sseDot').classList.remove('ok');
  es.addEventListener('session', (e) => {
    state.session = JSON.parse(e.data);
    diffCache.clear();
    queueLoading = false; // the preview (or any session update) has arrived
    renderQueue(); renderDashboard();
    if (modalChangeId) renderCardModal();
  });
  es.addEventListener('change', (e) => {
    const { change, counts, sessionStatus } = JSON.parse(e.data);
    if (!state.session) return;
    change.cols.forEach((col) => diffCache.delete(change.id + ':' + col.column)); // values may have been edited
    const idx = state.session.changes.findIndex((c) => c.id === change.id);
    if (idx !== -1) state.session.changes[idx] = change;
    if (counts) state.session.counts = counts;
    if (sessionStatus) state.session.status = sessionStatus;
    renderQueue(); renderDashboard();
    if (modalChangeId) renderCardModal();
  });
  es.addEventListener('log', (e) => {
    const entry = JSON.parse(e.data);
    appendLog(entry);
    HostSDK.bus.emit('log', entry); // modules watch the operational log through the host bus
  });
  /* Streams that belong to optional features are forwarded to the host bus.
     Nothing here knows which module, if any, is listening. */
  for (const name of ['ssh-agent', 'deploy', 'module']) {
    es.addEventListener(name, (e) => {
      let payload; try { payload = JSON.parse(e.data); } catch { return; }
      if (name !== 'module') return HostSDK.bus.emit(name, payload);
      HostSDK.bus.emit(`module:${payload.module}`, payload);
    });
  }
  /* Installed state is server-owned: another tab adding or removing a module
     reconciles this one without a reload. */
  es.addEventListener('modules', (e) => {
    let snapshot; try { snapshot = JSON.parse(e.data); } catch { return; }
    ModuleLoader.sync(snapshot, { onError: (m, error) => toast(`${m.name} could not start: ${error.message}`, 'error') })
      .then(() => { if (typeof renderModuleCatalog === 'function') renderModuleCatalog(snapshot); });
  });
  es.addEventListener('preview', (e) => {
    const p = JSON.parse(e.data);
    // "computing" is a rolling counter: update the active line in place, don't stack
    if (p.stage === 'computing') {
      const active = $('queueSteps')?.querySelector('.ql-step.active');
      if (active) { active.textContent = p.text; return; }
    }
    queueStep(p.text);
  });
  es.addEventListener('agent', (e) => {
    const ev = JSON.parse(e.data);
    // an event names its conversation in sessionId (a terminal session, or "project:<id>");
    // anything that is not the one on screen is not ours to paint
    if ((ev.sessionId || null) !== agentConversation()) return;
    if (ev.type === 'done') {
      // exactly one completion per turn, on every path: final | awaiting-approval | cancelled | failed
      agentPendingSessions.delete(ev.sessionId);
      const mine = agentTurn && !agentTurn.cancelled && (!ev.turnId || !agentTurn.turnId || agentTurn.turnId === ev.turnId);
      // a turn this tab is awaiting paints from its own HTTP reply; anything else (a decision's
      // continuation, another viewer of the same session) repaints the saved conversation
      if (!mine && $('agentDrawer').classList.contains('open')) openAgent();
      return;
    }
    if (!agentEventForTurn(ev)) return; // cancelled or superseded turn: drop it
    if (!agentFeedEl || !agentFeedEl.isConnected) return;
    // activity list (same step component as the preview loader): previous step ticks off, the new one is active
    const feed = agentFeedEl;
    const active = feed.querySelector('.ql-step.active');
    const add = (text) => {
      if (active) active.classList.replace('active', 'ql-done');
      const l = document.createElement('div'); l.className = 'ql-step active'; l.textContent = text; feed.appendChild(l);
    };
    const short = (s) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > 70 ? s.slice(0, 69) + '…' : s; };
    if (ev.type === 'text' || ev.type === 'text-discard') { // the answer being written, live
      const card = feed.parentElement; const live = card && card.querySelector('.agent-stream'); if (!live) return;
      if (ev.type === 'text-discard') { live.textContent = ''; live.hidden = true; }
      else {
        if (ev.reset) live.textContent = '';
        live.hidden = false; live.textContent += ev.text;
        const head = card.querySelector('.aw-head span:last-child'); if (head) head.textContent = 'Replying…';
        if (active) active.classList.replace('active', 'ql-done');
      }
      $('agentMessages').scrollTop = $('agentMessages').scrollHeight;
      return;
    }
    if (ev.type === 'step') add(ev.msg);
    else if (ev.type === 'tool') add(`Running ${ev.tool}${ev.input ? ' · ' + short(ev.input) : ''}`);
    else if (ev.type === 'tool-done') {
      const text = `${ev.tool}${ev.ok ? '' : ' failed'} · ${ev.ms} ms`;
      if (active) { active.classList.remove('active'); active.classList.add(ev.ok ? 'ql-done' : 'err'); active.textContent = text; }
      else add(text);
    } else if (ev.type === 'final') add('Writing the answer…');
    else return;
    $('agentMessages').scrollTop = $('agentMessages').scrollHeight;
  });
}

/* ---------- SQL console drawer ---------- */
const SQL_HIST_KEY = 'mau-sql-history';
const sqlHistLoad = () => { try { return JSON.parse(localStorage.getItem(SQL_HIST_KEY)) || []; } catch { return []; } };
function sqlHistSave(q) {
  localStorage.setItem(SQL_HIST_KEY, JSON.stringify([q, ...sqlHistLoad().filter((x) => x !== q)].slice(0, 20)));
  renderSqlHistory();
}
function renderSqlHistory() {
  $('sqlHistory').innerHTML = '<option value="">history…</option>' +
    sqlHistLoad().map((q) => `<option value="${esc(q)}">${esc(q.length > 60 ? q.slice(0, 60) + '…' : q)}</option>`).join('');
}
$('sqlHistory').addEventListener('change', () => {
  if ($('sqlHistory').value) { sqlSetValue($('sqlHistory').value); $('sqlHistory').value = ''; }
});

function toggleSqlConsole() {
  const open = $('sqlConsole').classList.toggle('open');
  $('btnSqlToggle').textContent = open ? 'Close' : 'Open';
  if (open) {
    sqlTableRedraw(); // box may have changed while the drawer was closed
    if (sqlEditor) { sqlEditor.refresh(); sqlEditor.focus(); } // CM cannot measure itself while hidden
    else $('sqlInput').focus();
  } else if (aiSqlPromptOpen()) {
    closeAiSqlPrompt(); // don't orphan the prompt bar above a closed drawer
  }
}
$('sqlBar').addEventListener('click', (e) => { if (e.target.tagName !== 'BUTTON' && !document.body.classList.contains('page-sql')) toggleSqlConsole(); }); // on the SQL page the bar is a toolbar, not a toggle
$('btnSqlToggle').addEventListener('click', toggleSqlConsole);

const sqlState = { sql: '', page: 0, result: null, transposed: false };
let SQL_PAGE = 200; // server SQL console page size; synced from /api/state and Settings

/* CodeMirror-backed SQL editor (falls back to the plain textarea if the
 * vendor bundle is missing) */
let sqlEditor = null;
(() => {
  if (typeof CodeMirror === 'undefined') return;
  const ta = $('sqlInput');
  sqlEditor = CodeMirror.fromTextArea(ta, {
    mode: 'text/x-mysql',
    theme: 'material-darker',
    lineNumbers: true,
    lineWrapping: true,
    placeholder: ta.placeholder,
    extraKeys: {
      'Ctrl-Enter': () => runSql(0),
      'Cmd-Enter': () => runSql(0),
      'Ctrl-Space': 'autocomplete',
    },
    hintOptions: { completeSingle: false, tables: {} },
  });
  // live suggestions while typing identifiers (schema tables/columns + keywords)
  sqlEditor.on('inputRead', (cm, change) => {
    if (cm.state.completionActive) return;
    const ch = change.text[change.text.length - 1];
    if (/[\w.]/.test(ch)) cm.showHint({ completeSingle: false });
  });
})();
const sqlGetValue = () => (sqlEditor ? sqlEditor.getValue() : $('sqlInput').value);
const sqlSetValue = (v) => {
  if (sqlEditor) { sqlEditor.setValue(v); sqlEditor.focus(); }
  else { $('sqlInput').value = v; $('sqlInput').focus(); }
};

/* feed the loaded schema into autocomplete: { table: [column, ...] } */
function updateSqlHints() {
  if (!sqlEditor) return;
  const tables = {};
  for (const [t, cols] of Object.entries(state.schema?.tables || {})) tables[t] = cols.map((c) => c.name);
  sqlEditor.setOption('hintOptions', { completeSingle: false, tables });
}

/* ---------- inline AI SQL (Ctrl+/): JetBrains-style prompt -> follow-up ----------
   Two phases share one bar docked above the editor:
   - prompt:   type a request, Enter generates. ArrowUp/Down walks prompt history.
   - followup: the SQL is in the editor; refine via a follow-up message, cycle
               variants, Accept All (Enter) to keep, Discard All (Esc) to revert.
   The database schema is attached to the request ONLY after the user agrees each
   time (see aiAskAttach). */
const aiSql = {
  busy: false, phase: 'prompt',
  history: [], histIdx: -1, histDraft: '',
  variants: [], varIdx: -1,
  preContent: '', inserted: false, baseAsk: '',
};
const AI_HIST_KEY = 'servertools-aisql-hist';
const aiHistLoad = () => { try { return JSON.parse(localStorage.getItem(AI_HIST_KEY)) || []; } catch { return []; } };
function aiHistSave(q) { if (!q) return; aiSql.history = [q, ...aiHistLoad().filter((x) => x !== q)].slice(0, 50); try { localStorage.setItem(AI_HIST_KEY, JSON.stringify(aiSql.history)); } catch {} }
const aiSqlPutSql = (v) => { if (sqlEditor) sqlEditor.setValue(v); else $('sqlInput').value = v; }; // set editor WITHOUT stealing focus
function aiSetPhase(p) { aiSql.phase = p; $('aiSqlRowPrompt').hidden = p !== 'prompt'; $('aiSqlRowFollow').hidden = p !== 'followup'; }
function aiBusy(on) { aiSql.busy = on; $('aiSqlSpin').hidden = !(on && aiSql.phase === 'prompt'); $('aiSqlSpin2').hidden = !(on && aiSql.phase === 'followup'); }
function aiVarUpdate() {
  const m = aiSql.variants.length, n = aiSql.varIdx + 1;
  $('aiSqlVarCount').textContent = m ? `${n}/${m}` : '0/0';
  $('btnAiVarPrev').disabled = aiSql.varIdx <= 0;
  $('btnAiVarNext').disabled = aiSql.varIdx >= m - 1;
}
function aiVarShow(i) { if (i < 0 || i >= aiSql.variants.length) return; aiSql.varIdx = i; aiSqlPutSql(aiSql.variants[i].sql); aiVarUpdate(); }
function aiHistNav(dir) { // dir<0 older (ArrowUp), dir>0 newer (ArrowDown)
  const h = aiSql.history; if (!h.length) return;
  const inp = $('aiSqlInput');
  if (aiSql.histIdx === -1) aiSql.histDraft = inp.value;
  let i = aiSql.histIdx;
  i = dir < 0 ? (i === -1 ? 0 : Math.min(i + 1, h.length - 1)) : (i <= 0 ? -1 : i - 1);
  aiSql.histIdx = i;
  inp.value = i === -1 ? aiSql.histDraft : h[i];
  requestAnimationFrame(() => inp.setSelectionRange(inp.value.length, inp.value.length));
}
function aiAskAttach() { // honors the Settings default: always / never / ask each time
  let pref = 'ask'; try { pref = localStorage.getItem('st-ai-schema') || 'ask'; } catch {}
  if (pref === 'always') return Promise.resolve(true);
  if (pref === 'never') return Promise.resolve(false);
  return confirmDialog({
    title: 'Attach database schema?',
    message: 'Send this database\'s table &amp; column names to the AI as context for the query?'
      + '<br><span class="hint" style="margin:0">Choose "Without schema" to generate from your prompt alone.</span>',
    okLabel: 'Attach schema', okClass: 'primary', cancelLabel: 'Without schema',
  });
}
async function aiGenerate(instruction, previousSql) {
  if (aiSql.busy || !instruction) return;
  if (!document.body.classList.contains('agent-on')) { toast('AI not connected: connect a provider (top-right)', 'error'); return; }
  const attach = await aiAskAttach(); // ask every time
  aiBusy(true);
  try {
    const r = await api('/api/agent/sql', { method: 'POST', body: JSON.stringify({ prompt: instruction, attachSchema: attach, previousSql: previousSql || '' }) });
    aiSql.variants.push({ sql: r.sql, prompt: instruction });
    aiSql.varIdx = aiSql.variants.length - 1;
    aiSql.inserted = true;
    aiSqlPutSql(r.sql);            // the result lands directly in the console editor
    aiVarUpdate();
    aiHistSave(instruction);
    if (aiSql.phase !== 'followup') { aiSql.baseAsk = instruction; aiSetPhase('followup'); }
    const f = $('aiSqlFollow'); f.value = ''; f.focus();
    if (r.tablesOmitted) toast(`Schema truncated: ${r.tablesOmitted} tables not sent as context`, 'info');
  } catch (e) {
    toast('AI SQL: ' + e.message, 'error');
  } finally { aiBusy(false); }
}
const aiSubmitPrompt = () => { const v = $('aiSqlInput').value.trim(); if (v) aiGenerate(v, ''); };
const aiSubmitFollow = () => { const v = $('aiSqlFollow').value.trim(); const cur = aiSql.variants[aiSql.varIdx]; if (v) aiGenerate(v, cur ? cur.sql : sqlGetValue()); };
const aiRegenerate = () => { const base = aiSql.baseAsk || (aiSql.variants[0] && aiSql.variants[0].prompt); if (base) aiGenerate(base, ''); };
function aiReset(discard) {
  if (aiSql.busy) return;
  if (discard && aiSql.inserted) aiSqlPutSql(aiSql.preContent); // revert the editor to its pre-AI content
  $('aiSqlPrompt').hidden = true;
  aiSetPhase('prompt');
  $('aiSqlInput').value = ''; $('aiSqlFollow').value = '';
  aiSql.variants = []; aiSql.varIdx = -1; aiSql.histIdx = -1; aiSql.inserted = false; aiSql.baseAsk = '';
  if ($('sqlConsole').classList.contains('open')) { if (sqlEditor) sqlEditor.focus(); else $('sqlInput').focus(); }
}
const aiAccept = () => aiReset(false);   // keep the generated SQL in the editor
const aiDiscard = () => aiReset(true);    // revert the editor
const aiSqlPromptOpen = () => !$('aiSqlPrompt').hidden;
const closeAiSqlPrompt = () => aiReset(false); // drawer-close / prompt-phase Esc: keep whatever is in the editor
function openAiSqlPrompt() {
  if (!$('sqlConsole').classList.contains('open')) toggleSqlConsole(); // ensure the console is visible
  if (aiSqlPromptOpen()) { (aiSql.phase === 'followup' ? $('aiSqlFollow') : $('aiSqlInput')).focus(); return; }
  aiSql.history = aiHistLoad();
  aiSql.histIdx = -1; aiSql.histDraft = '';
  aiSql.preContent = sqlGetValue(); aiSql.inserted = false;
  aiSql.variants = []; aiSql.varIdx = -1; aiSql.baseAsk = '';
  aiSetPhase('prompt');
  $('aiSqlPrompt').hidden = false;
  if (!document.body.classList.contains('agent-on')) toast('AI not connected: connect a provider (top-right)', 'error');
  const inp = $('aiSqlInput'); inp.value = ''; inp.focus();
}

$('aiSqlInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); aiSubmitPrompt(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); aiHistNav(-1); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); aiHistNav(1); }
});
$('aiSqlInput').addEventListener('input', () => { aiSql.histIdx = -1; });
$('aiSqlFollow').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); if ($('aiSqlFollow').value.trim()) aiSubmitFollow(); else aiAccept(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); aiVarShow(aiSql.varIdx - 1); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); aiVarShow(aiSql.varIdx + 1); }
});
$('btnAiAccept').addEventListener('click', aiAccept);
$('btnAiDiscard').addEventListener('click', aiDiscard);
$('btnAiRegen').addEventListener('click', aiRegenerate);
$('btnAiVarPrev').addEventListener('click', () => aiVarShow(aiSql.varIdx - 1));
$('btnAiVarNext').addEventListener('click', () => aiVarShow(aiSql.varIdx + 1));
// Ctrl+Shift+/ (open) and Esc (close/discard) at the document level so they work
// regardless of focus: e.g. after the SQL drawer was toggled shut underneath.
// Ctrl+/ is left free for the editor's line-comment. We match the physical Slash
// key (e.code) because Shift turns "/" into "?" in e.key.
// Ignored while a modal dialog (e.g. the schema-attach confirm) is open.
document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return;
  // the physical slash key (main or numpad); Shift turns "/" into "?" in e.key
  const isSlash = e.code === 'Slash' || e.code === 'NumpadDivide' || e.key === '/' || e.key === '?';
  if (isSlash && e.shiftKey && (e.ctrlKey || e.metaKey)) { e.preventDefault(); openAiSqlPrompt(); }
  else if (e.key === 'Escape' && aiSqlPromptOpen()) { e.preventDefault(); aiSql.phase === 'followup' ? aiDiscard() : closeAiSqlPrompt(); }
});

const SQL_READ_KW = ['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH'];
const SQL_DESTRUCTIVE_KW = ['DROP', 'DELETE', 'TRUNCATE', 'ALTER', 'UPDATE'];
function updateSqlModeHint() {
  const el = $('sqlModeHint'); if (!el) return;
  el.innerHTML = state.allowWrites
    ? '<span style="color:var(--amber)">writes enabled</span>reads + INSERT/UPDATE/DELETE/DDL · Ctrl+Enter runs · Ctrl+Shift+/ asks AI'
    : 'read-only: SELECT / SHOW / DESCRIBE / EXPLAIN · Ctrl+Enter runs · Ctrl+Shift+/ asks AI';
}
async function runSql(page = 0) {
  const sql = page === 0 ? sqlGetValue().trim() : sqlState.sql;
  if (!sql) return;
  // confirm destructive writes before executing (when writes are enabled)
  if (page === 0) {
    const kw = (sql.match(/^[\s(]*([a-zA-Z]+)/) || [])[1]?.toUpperCase();
    const isWrite = kw && !SQL_READ_KW.includes(kw);
    if (isWrite && state.allowWrites && prefConfirmDestructive() && SQL_DESTRUCTIVE_KW.includes(kw)) {
      const ok = await confirmDialog({ title: `Run ${esc(kw)}?`, message: `This executes a <b>${esc(kw)}</b> statement directly against <b>${esc(state.config?.database || 'the database')}</b>. The tool cannot undo it.`, okLabel: `Run ${esc(kw)}`, okClass: 'reject' });
      if (!ok) return;
    }
  }
  $('btnSqlRun').disabled = true;
  $('sqlResults').innerHTML = '<div class="empty" style="padding:.8rem">Running…</div>';
  $('sqlMeta').textContent = '';
  destroySqlTable();
  try {
    const r = await api('/api/sql', { method: 'POST', body: JSON.stringify({ sql, page }) });
    sqlState.sql = sql;
    sqlState.page = r.page ?? 0;
    sqlState.result = r;
    if (page === 0) sqlHistSave(sql);
    renderSqlResult();
  } catch (e) {
    sqlState.result = null;
    $('sqlResults').innerHTML = `<div class="empty" style="padding:.8rem;color:var(--red)">${esc(e.message)}</div>`;
    $('sqlPager').hidden = true;
  } finally {
    $('btnSqlRun').disabled = false;
  }
}

let sqlTable = null; // current Tabulator instance
function destroySqlTable() {
  if (sqlTable) { try { sqlTable.destroy(); } catch {} sqlTable = null; }
}

function renderSqlResult() {
  const r = sqlState.result;
  if (!r) return;
  if (r.write) { // write statement outcome (no result grid)
    destroySqlTable();
    $('sqlPager').hidden = true;
    const i = r.info || {};
    $('sqlMeta').textContent = `${r.kw} OK · ${i.affectedRows ?? 0} affected · ${r.ms} ms`;
    $('sqlResults').innerHTML = `<div class="empty" style="padding:.8rem;color:var(--green)">Query OK: ${i.affectedRows ?? 0} row(s) affected${i.changedRows != null ? `, ${i.changedRows} changed` : ''}${i.insertId ? `, insert id ${i.insertId}` : ''}${i.warningStatus ? ` · ${i.warningStatus} warning(s)` : ''}.</div>`;
    return;
  }
  const page = r.page ?? 0; // tolerate a server still running the pre-pagination code
  const from = page * SQL_PAGE + 1;
  $('sqlMeta').textContent = `${r.rowCount} row(s), ${r.ms} ms`;
  $('sqlPage').textContent = `page ${page + 1}`;
  $('sqlRange').textContent = r.rowCount ? `rows ${from} to ${from + r.rowCount - 1}${r.hasMore ? ', more available' : ''}` : '0 rows';
  $('btnSqlPrev').disabled = page === 0;
  $('btnSqlNext').disabled = !r.hasMore;
  $('btnSqlTranspose').disabled = !r.rows.length;
  $('btnSqlTranspose').classList.toggle('primary', sqlState.transposed);
  $('sqlPager').hidden = !r.rows.length && page === 0;
  destroySqlTable();
  if (!r.rows.length) { $('sqlResults').innerHTML = '<div class="empty" style="padding:.8rem">Query OK, 0 rows.</div>'; return; }

  // index-based field keys: column aliases may contain dots etc.
  let titles, data;
  if (sqlState.transposed) {
    titles = ['column', ...r.rows.map((_, i) => 'row ' + (from + i))];
    data = r.columns.map((c) => Object.fromEntries([['c0', c], ...r.rows.map((row, i) => ['c' + (i + 1), row[c] ?? null])]));
  } else {
    titles = r.columns;
    data = r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => ['c' + i, row[c] ?? null])));
  }
  const cellFmt = (cell) => {
    const v = cell.getValue();
    if (v === null || v === undefined) return '<span class="nullv">NULL</span>';
    const s = String(v);
    return esc(s.length > 300 ? s.slice(0, 300) + '…' : s);
  };
  $('sqlResults').innerHTML = '';
  sqlTable = new Tabulator('#sqlResults', {
    data,
    height: '100%',
    layout: 'fitDataFill',
    // virtual rendering on both axes: only visible rows AND columns get DOM
    // nodes, so wide tables (100+ columns, transposed views) stay light
    renderVertical: 'virtual',
    renderHorizontal: 'virtual',
    // no ResizeObserver: a full re-layout (~100ms on wide tables) would run on
    // EVERY pointermove while dragging the drawer/splitter. We redraw once at
    // drag end / window resize instead (see sqlTableRedraw callers).
    autoResize: false,
    columnDefaults: { resizable: true, headerSortTristate: true, maxInitialWidth: 380, formatter: cellFmt, tooltip: true },
    columns: titles.map((t, i) => ({ title: t, field: 'c' + i })),
  });
}

$('btnSqlRun').addEventListener('click', () => runSql(0));
$('btnSqlPrev').addEventListener('click', () => runSql(sqlState.page - 1));
$('btnSqlNext').addEventListener('click', () => runSql(sqlState.page + 1));
$('btnSqlTranspose').addEventListener('click', () => { sqlState.transposed = !sqlState.transposed; renderSqlResult(); });
$('sqlInput').addEventListener('keydown', (e) => {
  // plain-textarea fallback only; CodeMirror binds Ctrl-Enter via extraKeys
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runSql(0); }
});
renderSqlHistory();

/* ---------- result export (SQL UPDATEs / INSERTs / CSV / JSON) ---------- */
let exportCM = null;
const exportState = { format: null, text: '' };

const sqlQid = (n) => '`' + String(n).replace(/`/g, '``') + '`';
function sqlVal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  return "'" + String(v)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\0/g, '\\0') + "'";
}
function guessExportTable() {
  const m = /\bfrom\s+`?([A-Za-z0-9_$]+)`?/i.exec(sqlState.sql || '');
  return m ? m[1] : '';
}

function buildExport(format) {
  const r = sqlState.result;
  const cols = r.columns;
  const rows = r.rows;
  const table = $('expTable').value.trim() || 'my_table';
  const pk = $('expPk').value || cols[0];
  const head = (what) =>
    `-- ${what} generated from the SQL console result (page ${(r.page ?? 0) + 1}, ${rows.length} rows)\n` +
    `-- Source query: ${(sqlState.sql || '').replace(/\s+/g, ' ').slice(0, 160)}\n` +
    '-- Review before running: values are the DISPLAYED result values.\n\n';
  if (format === 'inserts') {
    const colList = cols.map(sqlQid).join(', ');
    return head('INSERT statements') +
      rows.map((row) => `INSERT INTO ${sqlQid(table)} (${colList}) VALUES (${cols.map((c) => sqlVal(row[c])).join(', ')});`).join('\n');
  }
  if (format === 'updates') {
    const setCols = cols.filter((c) => c !== pk);
    if (!setCols.length) return '-- The result only contains the primary-key column: nothing to SET.';
    return head('UPDATE statements') +
      rows.map((row) => `UPDATE ${sqlQid(table)} SET ${setCols.map((c) => `${sqlQid(c)} = ${sqlVal(row[c])}`).join(', ')} WHERE ${sqlQid(pk)} = ${sqlVal(row[pk])} LIMIT 1;`).join('\n');
  }
  if (format === 'csv') {
    const q = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return [cols.map(q).join(','), ...rows.map((row) => cols.map((c) => q(row[c])).join(','))].join('\r\n');
  }
  return JSON.stringify(rows, null, 2);
}

const exportIsComplete = () => { const r = sqlState.result; return r && (r.page ?? 0) === 0 && !r.hasMore; };

async function fetchFullExport() {
  const res = await fetch('/api/sql/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql: sqlState.sql, format: exportState.format, table: $('expTable').value.trim(), pk: $('expPk').value || '' }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res;
}

function refreshExportPreview() {
  exportState.text = buildExport(exportState.format);
  $('exportMeta').textContent = exportIsComplete()
    ? `${sqlState.result.rows.length} row(s), complete result`
    : `preview: the ${sqlState.result.rows.length} row(s) of this page - Copy and Download export the FULL result, uncapped`;
  if (!exportCM && typeof CodeMirror !== 'undefined') {
    exportCM = CodeMirror($('exportPreview'), { readOnly: true, lineNumbers: true, theme: 'material-darker', lineWrapping: false, mode: 'text/x-mysql' });
  }
  if (exportCM) {
    exportCM.setOption('mode', exportState.format === 'json' ? { name: 'javascript', json: true } : exportState.format === 'csv' ? null : 'text/x-mysql');
    exportCM.setValue(exportState.text);
    setTimeout(() => exportCM.refresh(), 0);
  } else {
    $('exportPreview').textContent = exportState.text;
  }
}

function openExport(format) {
  const r = sqlState.result;
  if (!r || !r.rows.length) { toast('Nothing to export: run a query first'); return; }
  exportState.format = format;
  const isSql = format === 'updates' || format === 'inserts';
  $('expSqlOpts').hidden = !isSql;
  $('expPkWrap').hidden = format !== 'updates';
  if (isSql) {
    $('expTable').value = guessExportTable();
    $('expPk').innerHTML = r.columns.map((c) =>
      `<option value="${esc(c)}" ${c.toLowerCase() === 'id' ? 'selected' : ''}>${esc(c)}</option>`).join('');
  }
  $('exportTitle').textContent = '- ' + ({ updates: 'SQL UPDATE statements', inserts: 'SQL INSERT statements', csv: 'CSV', json: 'JSON' })[format];
  refreshExportPreview();
  $('exportModal').showModal();
  if (exportCM) setTimeout(() => exportCM.refresh(), 0);
}

$('sqlExport').addEventListener('change', () => {
  const fmt = $('sqlExport').value;
  $('sqlExport').value = '';
  if (fmt) openExport(fmt);
});
$('expTable').addEventListener('input', refreshExportPreview);
$('expPk').addEventListener('change', refreshExportPreview);
$('btnExportClose').addEventListener('click', () => $('exportModal').close());
$('btnExportCopy').addEventListener('click', async (e) => {
  try {
    let text = exportState.text;
    if (!exportIsComplete()) {
      e.target.disabled = true; e.target.textContent = 'Fetching full result…';
      text = await (await fetchFullExport()).text();
    }
    await navigator.clipboard.writeText(text);
    toast(`Copied ${(text.length / 1024).toFixed(0)} KB to clipboard`);
  } catch (err) {
    toast('Copy failed: ' + err.message);
  } finally {
    e.target.disabled = false; e.target.textContent = 'Copy to clipboard';
  }
});
$('btnExportDownload').addEventListener('click', async (e) => {
  const ext = { updates: 'sql', inserts: 'sql', csv: 'csv', json: 'json' }[exportState.format] || 'txt';
  try {
    let blob;
    if (exportIsComplete()) {
      const mime = { sql: 'application/sql', csv: 'text/csv', json: 'application/json' }[ext] || 'text/plain';
      blob = new Blob([exportState.text], { type: mime });
    } else {
      e.target.disabled = true; e.target.textContent = 'Fetching full result…';
      blob = await (await fetchFullExport()).blob();
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `export-${exportState.format}.${ext}`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) {
    toast('Export failed: ' + err.message);
  } finally {
    e.target.disabled = false; e.target.textContent = 'Download';
  }
});

/* with autoResize off, the table must be told when its box changed */
function sqlTableRedraw() {
  if (sqlTable && $('sqlConsole').classList.contains('open')) {
    try { sqlTable.redraw(true); } catch {}
  }
}

/* drawer height + editor/results splitter (persisted).
 * pointermoves are coalesced to one style write per animation frame, and the
 * expensive Tabulator re-layout runs ONCE at drag end, not per move. */
(() => {
  const consoleEl = $('sqlConsole');
  const dragVar = (handle, computeValue, cssVar, storeKey) => {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      let pending = null, rafId = 0;
      const flush = () => { rafId = 0; if (pending !== null) { consoleEl.style.setProperty(cssVar, pending); pending = null; } };
      const move = (ev) => {
        pending = computeValue(ev);
        if (!rafId) rafId = requestAnimationFrame(flush);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        if (rafId) cancelAnimationFrame(rafId);
        flush();
        localStorage.setItem(storeKey, consoleEl.style.getPropertyValue(cssVar));
        sqlTableRedraw(); // pay the table re-layout exactly once, at release
        if (sqlEditor) sqlEditor.refresh(); // editor box changed too
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    const saved = localStorage.getItem(storeKey);
    if (saved) consoleEl.style.setProperty(cssVar, saved);
  };
  dragVar($('sqlResize'), (ev) => {
    const h = window.innerHeight - ev.clientY - $('sqlBar').offsetHeight - 8;
    return Math.min(window.innerHeight - 130, Math.max(140, h)) + 'px';
  }, '--sql-h', 'mau-sql-h');
  dragVar($('sqlSplit'), (ev) => {
    const rect = consoleEl.querySelector('.body').getBoundingClientRect();
    return Math.min(rect.width - 280, Math.max(240, ev.clientX - rect.left)) + 'px';
  }, '--sql-left', 'mau-sql-left');
  let winResizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(winResizeTimer);
    winResizeTimer = setTimeout(sqlTableRedraw, 150);
  });
})();

/* ---------- guided tour (intro.js) ---------- */
function startTour() {
  if (typeof introJs === 'undefined') { toast('Tour library not loaded: run npm install and restart the server', 'error'); return; }
  localStorage.setItem('mau-tour-seen', '1');
  // the tour walks the shell page by page: each step names the route it belongs to and the element it highlights
  const go = (r) => { if (typeof navigate === 'function') navigate(r, { focus: false }); };
  const origin = location.hash || '#/home';
  /* Core steps, plus one from every installed module: a module describes its own
     page, and its step disappears with it. */
  const steps = [
    { title: 'Welcome to Server Tools', intro: 'One shell and the tools you choose: <b>database updates with per-row approval</b>, a SQL console and a schema map come built in; servers, deployments, connectors, projects and history are modules you add. Two rules hold everywhere: nothing is written to a database and nothing is shipped to a server without <b>your explicit approval</b>. This tour moves between pages as it goes; use Next, Back or the arrow keys.' },
    { element: '#appNav', route: '#/home', title: 'Navigation', intro: 'Every module is one click away and has its own address (for example <code>#/deployments</code>), so browser Back/Forward, reload and bookmarks work. On narrower screens the sidebar collapses to icons; on phones it sits behind the ☰ button in the header.' },
    { element: '#compassGrid', route: '#/home', title: 'Home', intro: 'The Compass shows the same tools as cards with a short description and a search box. The green dot in the header only means this browser is connected to the app, not that a database or server is healthy.' },
    { element: '#rulesPanel', route: '#/database/updates', title: 'Updates: rules', intro: 'A rule is a <b>fetch</b> (table, WHERE, limit) plus an ordered list of <b>transforms</b>. <b>Run preview</b> fetches the matching rows and computes the proposed changes in memory only. New rule, edit and duplicate open the rule editor; Import loads exported JSON.' },
    { element: '#queuePanel', route: '#/database/updates', title: 'Approval queue', intro: 'Each card is one row with a before/after diff. <b>Approve</b> writes exactly that row (parameterized and stale-guarded); Reject and Skip write nothing. Select cards for batch decisions and download the auto-saved restore script. Keyboard <b>A / R / S</b> act on the highlighted card only while this page is visible and the session is running.' },
    { element: '#sessionBar', route: '#/database/updates', title: 'Session controls', intro: '<b>Pause</b> blocks every decision, on the server too; <b>Resume</b> lifts it; <b>Abort</b> discards all pending changes without writing anything. The session state and the active database profile are always shown here.' },
    { element: '#sqlBar', route: '#/database/sql', title: 'SQL console', intro: 'A full page: editor on the left, results on the right (stacked on phones). It is <b>read-only</b> unless you enable writes in Settings, which then asks before destructive statements. Ctrl+Enter runs, Ctrl+Shift+/ asks the assistant for a query. <b>Load schema</b> powers autocomplete here and in the rule editor; <b>Schema map</b> draws tables and relations with an inspector and a searchable table list.' },
    ...HostSDK.tourSteps.values().slice().sort((a, b) => (a.order || 50) - (b.order || 50)),
    { element: '#appNav [data-nav="modules"]', title: 'Modules', intro: 'Everything beyond the database tools is optional: servers and terminals, deployments, git connectors, projects and the activity history. <b>+ Add module</b> downloads one, checks its publisher signature and switches it on right here — no reload, no restart, and nothing you were doing is lost. Removing one keeps everything it saved.' },
    { element: '.ai-agent', title: 'AI assistant', intro: 'Works across every module from this button and floats above whatever you are doing. Its database access is read-only; rule changes, deploy manifests and deploy actions arrive as <b>proposals you approve in the chat</b>. Replies stream live and can be stopped. Optional deploy capabilities (repo files, plan diffs, health checks, log search, guardrail templates, pre-ship review) are switched on under Settings → AI assistant.' },
    { element: '#appNav [data-nav="settings"]', title: 'Settings and this tour', intro: 'Appearance and theme, SQL writes, rule limits, assistant capabilities, connections, servers and deploy options live in Settings. Run this tour again anytime from <b>Guided tour</b> just above it.' },
  ];
  /* A step whose element is not on the page is dropped rather than shown empty. */
  const usable = steps.filter((step) => !step.element || document.querySelector(step.element) || step.route);
  const t = introJs.tour ? introJs.tour() : introJs();
  t.setOptions({
    steps: usable.map(({ route, order, id, moduleId, ...s }) => s),
    showProgress: true, exitOnOverlayClick: true, scrollToElement: true, tooltipRenderAsHtml: true, tooltipClass: 'mau-tour',
    nextLabel: 'Next', prevLabel: 'Back', doneLabel: 'Done', disableInteraction: true,
  });
  // before each step: open the page it belongs to, give the view a moment to lay out, then let intro.js highlight
  const beforeChange = async function (el, stepIndex) {
    // intro.js hands us the element about to be shown: resolve the step from it (the index argument lags one step behind)
    let s = el ? usable.find((x) => x.element && (el.matches?.(x.element) || el === document.querySelector(x.element))) : null;
    if (!s && typeof stepIndex === 'number') s = usable[stepIndex];
    if (s?.route && location.hash !== s.route) { go(s.route); await new Promise((r) => setTimeout(r, s.route.startsWith('#/deploy') ? 600 : 300)); }
    try { (el || document.querySelector(s?.element || ''))?.scrollIntoView?.({ block: 'nearest' }); } catch {}
    return true;
  };
  if (typeof t.onBeforeChange === 'function') t.onBeforeChange(beforeChange);
  else if (typeof t.onbeforechange === 'function') t.onbeforechange(beforeChange);
  const backToOrigin = () => { if (location.hash !== origin) go(origin); };
  if (typeof t.onExit === 'function') t.onExit(backToOrigin); else if (typeof t.onexit === 'function') t.onexit(backToOrigin);
  if (typeof t.onComplete === 'function') t.onComplete(backToOrigin); else if (typeof t.oncomplete === 'function') t.oncomplete(backToOrigin);
  t.start();
}
