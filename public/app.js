'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

let state = { session: null, transformTypes: {}, rules: [], schema: null, maxPreviewRows: 500 };

/* ---------- API helper ---------- */
async function api(url, opts) {
  const res = await fetch(url, opts ? { headers: {'Content-Type':'application/json'}, ...opts } : undefined);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.style.display = 'none', 4500);
}

/* ---------- confirm modal (replaces window.confirm) ---------- */
let confirmResolve = null;
function confirmDialog({ title = 'Please confirm', message = '', okLabel = 'Confirm', okClass = 'primary', cancelLabel = 'Cancel' } = {}) {
  if (confirmResolve) { confirmResolve(false); confirmResolve = null; } // settle any dangling ask
  return new Promise((resolve) => {
    confirmResolve = resolve;
    $('confirmTitle').textContent = title;
    $('confirmMsg').innerHTML = message; // messages are app-authored; dynamic parts must be esc()-ed by callers
    const ok = $('btnConfirmOk');
    ok.textContent = okLabel;
    ok.className = okClass;
    $('btnConfirmCancel').textContent = cancelLabel;
    $('confirmModal').showModal();
    ok.focus();
  });
}
function settleConfirm(v) {
  const r = confirmResolve;
  confirmResolve = null;
  if ($('confirmModal').open) $('confirmModal').close();
  if (r) r(v);
}
$('btnConfirmOk').addEventListener('click', () => settleConfirm(true));
$('btnConfirmCancel').addEventListener('click', () => settleConfirm(false));
$('confirmModal').addEventListener('close', () => settleConfirm(false)); // Esc or backdrop = cancel

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
  return `<div class="transform-row">
    <button type="button" class="del" title="Remove">✕</button>
    <div class="row">
      <div><label>Column</label><input class="t-col" list="colList" value="${esc(t.column||'')}" required></div>
      <div><label>Type</label><select class="t-type">${opts}</select></div>
    </div>
    <div class="t-params"></div>
  </div>`;
}

function renderParams(rowEl, type, params = {}) {
  const wrap = rowEl.querySelector('.t-params');
  wrap.innerHTML = (PARAM_FIELDS[type] || []).map((f) => {
    if (f.type === 'checkbox')
      return `<label style="display:flex;align-items:center;gap:.4rem;margin-top:.4rem"><input type="checkbox" style="width:auto" data-k="${f.key}" ${params[f.key]?'checked':''}> ${esc(f.label)}</label>`;
    if (f.type === 'select')
      return `<label>${esc(f.label)}</label><select data-k="${f.key}">${f.options.map(o=>`<option ${params[f.key]===o?'selected':''}>${o}</option>`).join('')}</select>`;
    return `<label>${esc(f.label)}</label><input data-k="${f.key}" value="${esc(params[f.key]??'')}" placeholder="${esc(f.placeholder||'')}">`;
  }).join('');
}

function addTransformRow(t) {
  const div = document.createElement('div');
  div.innerHTML = transformRowHtml(t);
  const row = div.firstElementChild;
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

function readTransforms() {
  return [...$('transformList').querySelectorAll('.transform-row')].map((row) => {
    const type = row.querySelector('.t-type').value;
    const params = {};
    row.querySelectorAll('.t-params [data-k]').forEach((el) => {
      params[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value;
    });
    return { column: row.querySelector('.t-col').value.trim(), type, params };
  });
}

/* ---------- Rules list ---------- */
async function loadRules() {
  state.rules = await api('/api/rules');
  const list = $('ruleList');
  $('ruleCount').textContent = state.rules.length ? `(${state.rules.length})` : '';
  list.innerHTML = state.rules.length ? '' : '<div class="empty">No rules yet — create one below.</div>';
  for (const r of state.rules) {
    const el = document.createElement('div');
    el.className = 'rule-item';
    el.dataset.ruleId = r.id;
    el.innerHTML = `<div class="name">${esc(r.name)} <span class="badge runbadge" hidden></span><span class="meta">${esc(r.table)} · ${r.transforms.length} transform(s) · limit ${r.limit}</span></div>
      <button class="primary" data-act="preview">Run preview</button>
      <button data-act="edit">Edit</button>
      <button data-act="sql" title="Download the SQL this rule generates">SQL</button>
      <button data-act="delete" title="Delete rule">✕</button>`;
    el.addEventListener('click', async (e) => {
      const act = e.target.dataset?.act;
      if (!act) return;
      try {
        if (act === 'preview') {
          e.target.disabled = true; e.target.textContent = 'Fetching…';
          await api(`/api/rules/${r.id}/preview`, { method: 'POST' });
        } else if (act === 'edit') {
          fillForm(r);
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
      } catch (err) { toast(err.message); }
      finally { if (act === 'preview') { e.target.disabled = false; e.target.textContent = 'Run preview'; } }
    });
    list.appendChild(el);
  }
  updateRuleHighlight();
}

/* Mark the rule whose session is currently active */
function updateRuleHighlight() {
  const s = state.session;
  const activeRuleId = s && ['running', 'paused'].includes(s.status) ? s.ruleId : null;
  document.querySelectorAll('#ruleList .rule-item').forEach((el) => {
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
  $('editorHint').textContent = r ? `— editing "${r.name}"` : '';
  if (r) $('secEditor').open = true; // jump the editor open when a rule is loaded into it
  updateColDatalist();
}

$('ruleForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    name: $('rName').value, table: $('rTable').value.trim(), pkColumn: $('rPk').value.trim(),
    where: $('rWhere').value, limit: Number($('rLimit').value) || undefined,
    displayColumns: $('rDisplay').value, transforms: readTransforms(),
  };
  const id = $('rId').value;
  try {
    await api(id ? `/api/rules/${id}` : '/api/rules', { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) });
    fillForm(null);
    loadRules();
  } catch (err) { toast(err.message); }
});
$('btnNewRule').addEventListener('click', () => { fillForm(null); $('secEditor').open = true; $('rName').focus(); });
$('btnCancelEdit').addEventListener('click', () => fillForm(null));
$('btnAddTransform').addEventListener('click', () => addTransformRow());

/* ---------- Schema autocomplete ---------- */
$('btnLoadSchema').addEventListener('click', async () => {
  try {
    $('btnLoadSchema').textContent = 'Loading…';
    state.schema = await api('/api/schema');
    $('tableList').innerHTML = Object.keys(state.schema.tables).map((t) => `<option value="${esc(t)}">`).join('');
    updateColDatalist();
    updateSqlHints();
    toast(`Schema loaded: ${Object.keys(state.schema.tables).length} tables — SQL console autocomplete active`);
  } catch (err) { toast('Schema load failed: ' + err.message); }
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
 * distance exceeds the Myers cap — callers keep the regions it sees small. */
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
  const showBackup = s && s.changes.length ? '' : 'none';
  $('lnkBackupSql').style.display = showBackup;
  $('lnkBackupJson').style.display = showBackup;
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
      `Use the <b>Backup .sql</b> button in the queue toolbar to download one first.<br><br>${esc(extra)}`,
    okLabel: 'Proceed without backup', okClass: 'warn',
    cancelLabel: 'Go back',
  });
  if (ok) backupWarnedFor = s.id;
  return ok;
}

function renderQueue() {
  const q = $('queue');
  const s = state.session;
  foldStore.length = 0;
  // selection only ever holds ids that are still pending
  if (s) {
    const pendingIds = new Set(s.changes.filter((c) => c.status === 'pending').map((c) => c.id));
    for (const id of [...selected]) if (!pendingIds.has(id)) selected.delete(id);
    for (const key of [...editorOpen.keys()]) if (!pendingIds.has(key.slice(0, key.indexOf(':')))) editorOpen.delete(key);
  } else { selected.clear(); editorOpen.clear(); }
  $('queueRule').textContent = s ? `— ${s.ruleName} on ${s.table} [${s.status}]` : '';
  $('sessStatus').textContent = s ? `${s.ruleName}: ${s.status}` : 'no session';
  $('btnPause').disabled = !s || s.status !== 'running';
  $('btnResume').disabled = !s || s.status !== 'paused';
  $('btnAbort').disabled = !s || ['aborted','done'].includes(s.status);
  if (!s) { q.innerHTML = '<div class="empty">Run a preview to load changes.</div>'; return; }

  const pending = s.changes.filter((c) => c.status === 'pending');
  const settledRecent = s.changes.filter((c) => c.status !== 'pending').slice(-6).reverse();
  let html = '';
  if (!pending.length) {
    html += `<div class="empty">No pending changes${s.changes.length ? ` — ${s.changes.length} processed.` : ' (nothing matched or nothing would change).'}</div>`;
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
  q.querySelectorAll('[data-editopen]').forEach((b) => b.addEventListener('click', () => {
    openColumnEditor(b.dataset.cid, b.dataset.col); // editing happens in the large card view
  }));
  updateToolbar();
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
        <button class="approve" data-decide="approve" data-id="${c.id}">Approve${active?' <kbd>A</kbd>':''}</button>
        <button class="reject" data-decide="reject" data-id="${c.id}">Reject${active?' <kbd>R</kbd>':''}</button>
        <button data-decide="skip" data-id="${c.id}">Skip${active?' <kbd>S</kbd>':''}</button>
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
// normalized the same way before diffing — otherwise every line looks changed.
const normNl = (v) => String(v ?? '').replace(/\r\n?/g, '\n');

function syncEditBackdrop(area) {
  const back = area.parentElement.querySelector('.editback');
  const col = findChangeCol(area.dataset.key);
  if (!back || !col) return;
  const segs = diffSegments(normNl(col.before), area.value);
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

/* Open the large view with one column's editor active, cursor on the first change */
function openColumnEditor(cid, colName) {
  const key = cid + ':' + colName;
  if (!editorOpen.has(key)) editorOpen.set(key, null); // null draft = start from the proposed value
  openCardModal(cid);
  focusEditor(key);
}

function focusEditor(key) {
  const area = $('cardModalBody').querySelector(`.editArea[data-key="${CSS.escape(key)}"]`);
  const col = findChangeCol(key);
  if (!area || !col) return;
  area.focus();
  const segs = diffSegments(normNl(col.before), area.value);
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
    const body = editorOpen.has(key)
      ? `<div class="editwrap"><div class="editback"></div><textarea class="editArea" data-key="${esc(key)}" rows="5">${esc(editorOpen.get(key) ?? (col.after ?? ''))}</textarea></div>
         <div class="actions">
           <button type="button" class="primary" data-editsave="1" data-cid="${c.id}" data-col="${esc(col.column)}">Save proposed value</button>
           <button type="button" data-editcancel="1" data-cid="${c.id}" data-col="${esc(col.column)}">Cancel</button>
         </div>`
      : diffHtml(col.before, col.after, key, false);
    return `<div class="diff"><span class="col">${esc(col.column)} ${edited} ${editBtn}</span>${body}</div>`;
  }).join('');
  const actions = c.status === 'pending'
    ? `<div class="actions">
        <button class="approve" data-decide="approve" data-id="${c.id}">Approve <kbd>A</kbd></button>
        <button class="reject" data-decide="reject" data-id="${c.id}">Reject <kbd>R</kbd></button>
        <button data-decide="skip" data-id="${c.id}">Skip <kbd>S</kbd></button>
      </div>` : '';
  const staleInfo = c.status === 'stale' && c.currentValues
    ? `<div class="note">Current DB value(s): ${esc(JSON.stringify(c.currentValues))}. Re-run the preview to act on this row.</div>` : '';
  $('cardModalBody').innerHTML = `<div class="card ${c.status}">
    <div class="head"><span class="pk">${esc(s.pkColumn)} = ${esc(c.pk)}</span><span class="ident">${ident}</span>
      ${c.status !== 'pending' ? `<span class="badge ${c.status}">${c.status}</span>` : ''}</div>
    ${diffs}${actions}
    ${c.note ? `<div class="note">${esc(c.note)}</div>` : ''}${staleInfo}
  </div>`;
  const body = $('cardModalBody');
  body.querySelectorAll('[data-decide]').forEach((btn) => {
    btn.addEventListener('click', () => decide(btn.dataset.id, btn.dataset.decide));
  });
  body.querySelectorAll('[data-editopen]').forEach((b) => b.addEventListener('click', () => {
    openColumnEditor(b.dataset.cid, b.dataset.col);
  }));
  body.querySelectorAll('[data-editcancel]').forEach((b) => b.addEventListener('click', () => {
    editorOpen.delete(b.dataset.cid + ':' + b.dataset.col);
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
    // the textarea normalized \r\n to \n — restore the original convention so a
    // manual edit doesn't rewrite every line ending in the column
    const col = findChangeCol(key);
    const newValue = col && /\r\n/.test(String(col.before ?? ''))
      ? area.value.replace(/\n/g, '\r\n')
      : area.value;
    try {
      await api('/api/session/edit', {
        method: 'POST',
        body: JSON.stringify({ changeId: b.dataset.cid, column: b.dataset.col, newValue }),
      });
      editorOpen.delete(key); // the SSE change event re-renders with the new diff
    } catch (err) { toast(err.message); }
  }));
}

$('btnCloseCard').addEventListener('click', () => $('cardModal').close());
$('cardModal').addEventListener('close', () => { modalChangeId = null; });

let deciding = false;
async function decide(changeId, action) {
  if (deciding) return;
  if (action === 'approve' && !(await confirmNoBackup('Approve this row anyway?'))) return;
  if (deciding) return; // re-check: another decision may have started while the dialog was open
  deciding = true;
  try { await api('/api/session/decision', { method: 'POST', body: JSON.stringify({ changeId, action }) }); }
  catch (err) { toast(err.message); }
  finally { deciding = false; }
}

document.addEventListener('keydown', (e) => {
  if (['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)) return;
  const map = { a: 'approve', r: 'reject', s: 'skip' };
  const action = map[e.key.toLowerCase()];
  if (!action || !state.session) return;
  // while the large card view is open, shortcuts act on that card
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
    toast(`Batch ${action}: ${parts || 'nothing done'}${r.stopped ? ' — stopped: ' + r.stopped : ''}`);
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
  list.innerHTML = conns.profiles.length ? '' : '<div class="empty">No saved connections — create one below.</div>';
  for (const p of conns.profiles) {
    const isActive = p.id === conns.activeId;
    const el = document.createElement('div');
    el.className = 'rule-item';
    el.innerHTML = `<div class="name">${esc(p.name)} ${isActive ? '<span class="badge approved">active</span>' : ''}
        <span class="meta">${esc(p.db.user)}@${esc(p.db.host)}:${p.db.port}/${esc(p.db.database)}${p.ssh.enabled ? ' · SSH ' + esc(p.ssh.host) : ''}</span></div>
      ${isActive ? '' : '<button data-act="activate" class="primary">Use</button>'}
      <button data-act="test">Test</button>
      <button data-act="edit">Edit</button>
      ${isActive ? '' : '<button data-act="delete" title="Delete connection">✕</button>'}`;
    el.addEventListener('click', async (e) => {
      const act = e.target.dataset?.act;
      if (!act) return;
      try {
        if (act === 'activate') {
          await api(`/api/connections/${p.id}/activate`, { method: 'POST' });
          state.schema = null;
          $('tableList').innerHTML = '';
          $('colList').innerHTML = '';
          updateSqlHints(); // stale tables from the previous connection must not be suggested
          await Promise.all([refreshHeader(), loadConns()]);
          toast(`Now using "${p.name}" — reload the schema for autocomplete`);
        } else if (act === 'test') {
          e.target.disabled = true; e.target.textContent = 'Testing…';
          await api(`/api/connections/${p.id}/test`, { method: 'POST' });
          toast(`✓ Connection "${p.name}" works`);
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
      } catch (err) { toast(err.message); }
      finally { if (act === 'test') { e.target.disabled = false; e.target.textContent = 'Test'; } }
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
  $('cDbPass').placeholder = p?.db.passwordSet ? '(unchanged — type to replace)' : '';
  $('cDbName').value = p?.db.database || '';
  $('cSshOn').checked = !!p?.ssh.enabled;
  $('sshFields').hidden = !p?.ssh.enabled;
  $('cSshHost').value = p?.ssh.host || '';
  $('cSshPort').value = p?.ssh.port || '';
  $('cSshUser').value = p?.ssh.user || '';
  $('cSshPass').value = '';
  $('cSshPass').placeholder = p?.ssh.passwordSet ? '(unchanged — type to replace)' : '';
  $('cSshKey').value = p?.ssh.privateKeyPath || '';
  $('cSshPhrase').value = '';
  $('cSshPhrase').placeholder = p?.ssh.passphraseSet ? '(unchanged — type to replace)' : '';
  $('cName').focus();
}

$('btnConns').addEventListener('click', () => { $('connForm').hidden = true; loadConns().catch((e) => toast(e.message)); $('connModal').showModal(); });
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
/* Pure layout+markup builder — takes the /api/schema/graph payload,
 * returns {svg, width, height}. Kept DOM-free so it is unit-testable. */
/* Turn a list of waypoints into a path whose corners are smoothed with
 * quadratic beziers — straight runs, curved bends. */
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

/* Edge path between two (movable) boxes — also used live while dragging.
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
      <text class="tbl-title" x="8" y="16" font-size="11">${esc(trunc(t.name, 23))}<title>${esc(t.name)} — ${t.columns.length} columns</title></text>
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
    $('schemaMapInfo').textContent = `— ${g.database}: 0 of ${g.totalTables} tables`;
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
    `— ${g.database}: showing ${nMatched} of ${g.totalTables} tables` +
    (nRelated ? ` + ${nRelated} related` : '') +
    `, ${g.relations.length} relations (${g.relations.filter((r) => r.inferred).length} inferred)` +
    (truncated ? ' — use the filter to narrow down' : '');
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

/* pan / zoom via viewBox — wired once */
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
    downTarget = e.target; // real element under the press — pointer capture retargets later events to the canvas
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
      <button id="btnExactCount" style="padding:0 .4rem;font-size:.68rem" title="Run SELECT COUNT(*) — may take a moment on large tables">count exactly</button>${t.related ? ' · pulled in as a relation of your search' : ''}</div>
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
    $('ddlTitle').textContent = `— ${r.table}`;
    $('ddlText').textContent = r.ddl + ';';
    $('ddlModal').showModal();
  } catch (e) { toast(e.message); }
}
$('btnCloseDdl').addEventListener('click', () => $('ddlModal').close());
$('btnCopyDdl').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('ddlText').textContent); toast('Copied to clipboard'); }
  catch { toast('Clipboard unavailable — select the text manually'); }
});
$('btnDownloadDdl').addEventListener('click', () => {
  const name = ($('ddlTitle').textContent.replace(/^—\s*/, '') || 'table').replace(/[^A-Za-z0-9_-]+/g, '_');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([$('ddlText').textContent], { type: 'application/sql' }));
  a.download = `create-${name}.sql`;
  a.click();
  URL.revokeObjectURL(a.href);
});

async function loadSchemaMap(q) {
  $('schemaCanvas').innerHTML = '<div class="empty" style="padding:1rem">Loading schema…</div>';
  schemaView.el = null;
  try { renderSchemaMap(await api('/api/schema/graph?q=' + encodeURIComponent(q || ''))); }
  catch (e) { $('schemaCanvas').innerHTML = `<div class="empty" style="padding:1rem">${esc(e.message)}</div>`; toast(e.message); }
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

/* ---------- SSE ---------- */
function connectSSE() {
  const es = new EventSource('/api/events');
  es.onopen = () => $('sseDot').classList.add('ok');
  es.onerror = () => $('sseDot').classList.remove('ok');
  es.addEventListener('session', (e) => {
    state.session = JSON.parse(e.data);
    diffCache.clear();
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
  es.addEventListener('log', (e) => appendLog(JSON.parse(e.data)));
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
  }
}
$('sqlBar').addEventListener('click', (e) => { if (e.target.tagName !== 'BUTTON') toggleSqlConsole(); });
$('btnSqlToggle').addEventListener('click', toggleSqlConsole);

const sqlState = { sql: '', page: 0, result: null, transposed: false };
const SQL_PAGE = 200;

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

async function runSql(page = 0) {
  const sql = page === 0 ? sqlGetValue().trim() : sqlState.sql;
  if (!sql) return;
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
    : `preview: the ${sqlState.result.rows.length} row(s) of this page — Copy and Download export the FULL result, uncapped`;
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
  $('exportTitle').textContent = '— ' + ({ updates: 'SQL UPDATE statements', inserts: 'SQL INSERT statements', csv: 'CSV', json: 'JSON' })[format];
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
  if (typeof introJs === 'undefined') { toast('Tour library not loaded: run npm install and restart the server'); return; }
  localStorage.setItem('mau-tour-seen', '1');
  const steps = [
    { title: 'Welcome', intro: 'This tool runs <b>rule-based batch updates</b> on MySQL with one hard guarantee: <b>nothing is written without your explicit approval</b>.' },
    { element: '#btnConns', title: 'Connections', intro: 'Manage <b>connection profiles</b>: database credentials plus an optional SSH tunnel. Test them and switch between them; switching is blocked while changes are pending.' },
    { element: '#secRuleList > summary', title: 'Saved rules', intro: '<b>Run preview</b> fetches matching rows and computes proposed changes, in memory only. <b>SQL</b> exports the exact queries a rule generates. The rule with an active session is highlighted.' },
    { element: '#secEditor > summary', title: 'Rule editor', intro: 'A rule is a <b>fetch</b> (table, WHERE as raw SQL, server-capped LIMIT) plus <b>transforms</b> applied in order: find/replace with regex and capture groups, trim, case, prefix/suffix, fixed value.' },
    { element: '#btnSchemaMap', title: 'Schema tools', intro: '<b>Load schema</b> fills table and column autocomplete. <b>Schema map</b> opens a visual diagram: drag cards, follow relation lines, click a card for details, row counts and its CREATE TABLE.' },
    { element: '#queueToolbar', title: 'Batch and backup', intro: 'Select cards for <b>batch approve / reject / skip</b>. Every preview auto-saves a <b>restore script</b> server-side. Download it here; you will be warned if you approve without a local copy.' },
    { element: '#queue', title: 'Approval cards', intro: 'Each card shows a <b>before/after diff</b> of one row. <b>Approve</b> writes exactly that row (parameterized, verified, stale-guarded: externally modified rows are never overwritten). The Edit button hand-tunes the proposed value, the expand button opens a large view. Keys: <b>A / R / S</b>.' },
    { element: '#dashPanel', title: 'Live progress', intro: 'Counts, progress bar and activity log update in real time. Every decision is also appended to <b>audit.log</b>.' },
    { element: '#btnAbort', title: 'Session control', intro: '<b>Pause</b> blocks approvals server-side; <b>Abort</b> discards all pending changes (nothing written). The full audit trail can be downloaded from the header.' },
    { title: 'All set', intro: 'Define a rule, then <b>Run preview</b>, then approve change by change (or in batches). Re-run this tour anytime with the <b>Tour</b> button.' },
  ];
  const t = introJs.tour ? introJs.tour() : introJs();
  t.setOptions({
    steps,
    showProgress: true,
    exitOnOverlayClick: true,
    scrollToElement: true,
    tooltipRenderAsHtml: true,
    tooltipClass: 'mau-tour',
    nextLabel: 'Next',
    prevLabel: 'Back',
    doneLabel: 'Done',
  });
  // targets can live inside inner scrollable panels intro.js cannot scroll itself
  const ensureVisible = (el) => { try { el?.scrollIntoView({ block: 'nearest' }); } catch {} };
  if (typeof t.onBeforeChange === 'function') t.onBeforeChange(ensureVisible);
  else if (typeof t.onbeforechange === 'function') t.onbeforechange(ensureVisible);
  t.start();
}
$('btnTour').addEventListener('click', startTour);

/* ---------- init ---------- */
(async function init() {
  try {
    const st = await api('/api/state');
    state.transformTypes = st.transformTypes;
    state.session = st.session;
    state.maxPreviewRows = st.config.maxPreviewRows;
    $('maxRows').textContent = st.config.maxPreviewRows;
    $('dbInfo').textContent = `profile: ${st.config.profile} · db: ${st.config.database || '(unset)'}${st.config.sshTunnel ? ' · via SSH tunnel' : ''}`;
    (st.recentLog || []).forEach(appendLog);
  } catch (err) { toast('Init failed: ' + err.message); }
  fillForm(null);
  await loadRules().catch((e) => toast(e.message));
  renderQueue(); renderDashboard();
  connectSSE();
  if (!localStorage.getItem('mau-tour-seen')) setTimeout(startTour, 700); // first visit: offer the tour
})();
