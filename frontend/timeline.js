/* The activity feed: one column, newest first, one card per recorded event.
 *
 * It used to be two lanes - your messages on the right, the assistant's on the left, everything
 * else in a thin line between them - which read well for a conversation and badly for everything
 * else, and most of the trail is everything else. So: a single chronological column, each event a
 * card that answers "what happened, to what, how did it go" at a glance, with the identifiers and
 * the raw line moved into a details view for when that glance is not enough.
 *
 * What an event MEANS lives in ./events.mjs and is tested on its own. This file is the view: what
 * is on screen, what is filtered out, and how much of it is drawn at once.
 */
'use strict';

import {
  CATEGORIES, CATEGORY, EMPTY_FILTERS, classify, describePlain as plain,
  dayLabel, hhmm, isFiltering, matches, typeLabel,
} from './events.mjs';

/** Cards drawn per pass. The trail runs to thousands of entries and they are not all worth drawing. */
const CHUNK = 60;
/** How far the reader can ask the host to go back. The backend clamps at 2000 either way. */
const DEPTHS = [500, 1000, 2000];

const STATUS_TEXT = { success: 'Succeeded', failed: 'Failed', warn: 'Warning', pending: 'Running' };
const ACTOR_TEXT = { you: 'You', ai: 'Assistant', system: 'System' };

export function createTimeline({ host, $, esc }) {
  let entries = [];
  let actions = [];
  let depth = 0;                 // index into DEPTHS
  let reachedEnd = false;        // asking for more stopped bringing more
  let category = 'all';
  let filters = { ...EMPTY_FILTERS, ...(host.storage.get('filters', null) || {}) };
  let rows = [];                 // {entry, i, c} that survived every filter
  let shown = 0;
  let lastDay = null;
  let sentinelObserver = null;
  let pending = 0;
  let searchTimer = 0;

  const describePlain = (entry) => plain(entry);

  /* ------------------------------------------------------------ one card */

  function card({ entry, i, c }) {
    const status = STATUS_TEXT[c.status] || '';
    const facts = c.facts.slice(0, 4).map((f) => `<span class="ev-fact"><i>${esc(f.label)}</i>${esc(f.value)}</span>`).join('');
    /* An action nobody described is titled after itself, and the badge already says that. Saying it
       twice on one card is how the old view filled space. */
    const title = c.title === c.type ? '' : `<span class="ev-title">${esc(c.title)}</span>`;
    const subject = c.subject ? `<span class="${title ? 'ev-subject' : 'ev-title'}">${esc(c.subject)}</span>` : '';
    /* The label is what a screen reader reads instead of the layout: the same few things, in the
       order they are looked for. */
    const label = esc([...new Set([c.type, ACTOR_TEXT[c.actor], status, c.title, c.subject, hhmm(c.ts)])].filter(Boolean).join(', '));
    return `<button type="button" class="ev ev-${esc(c.cat)}${c.status === 'failed' ? ' ev-bad' : ''}" data-i="${i}" aria-label="${label}">
      <span class="ev-top">
        <span class="ev-type">${esc(c.type)}</span>
        <span class="ev-actor ev-actor-${esc(c.actor)}">${esc(ACTOR_TEXT[c.actor])}</span>
        ${status ? `<span class="ev-status ev-${esc(c.status)}">${esc(status)}</span>` : ''}
        <span class="spacer"></span>
        <time class="ev-time" datetime="${esc(c.ts)}">${esc(hhmm(c.ts))}</time>
      </span>
      ${title}
      ${subject}
      ${facts ? `<span class="ev-facts">${facts}</span>` : ''}
      ${c.redacted ? `<span class="ev-redacted">${esc(c.redacted)}</span>` : ''}
    </button>`;
  }

  /* ------------------------------------------------------------ drawing */

  /** Draw the next CHUNK cards. Day headings are emitted as the day changes, across chunks. */
  function appendChunk() {
    const body = $('auditBody');
    const sentinel = body.querySelector('.tl-sentinel');
    const next = rows.slice(shown, shown + CHUNK);
    if (!next.length) { finishFeed(); return; }
    let html = '';
    for (const row of next) {
      const day = dayLabel(row.c.ts);
      if (day && day !== lastDay) { html += `<h3 class="tl-day">${esc(day)}</h3>`; lastDay = day; }
      html += card(row);
    }
    shown += next.length;
    sentinel.insertAdjacentHTML('beforebegin', html);
    if (shown >= rows.length) finishFeed();
  }

  /** What sits at the bottom once every filtered row is on screen. */
  function finishFeed() {
    stopWatchingSentinel();
    const sentinel = $('auditBody').querySelector('.tl-sentinel');
    if (!sentinel) return;
    const deeper = DEPTHS[depth + 1];
    if (deeper && !reachedEnd) {
      sentinel.innerHTML = `<button type="button" class="tl-more" data-deeper>Load older events</button>
        <span class="tl-note">${rows.length.toLocaleString()} shown from the last ${DEPTHS[depth].toLocaleString()} recorded</span>`;
      sentinel.querySelector('[data-deeper]').addEventListener('click', () => { depth += 1; load(); });
    } else {
      sentinel.innerHTML = `<span class="tl-note">That is everything recorded${DEPTHS[depth] < 2000 ? '' : ' within the last 2,000 events'}.</span>`;
    }
  }

  function stopWatchingSentinel() {
    if (sentinelObserver) sentinelObserver.disconnect();
  }

  /** Draw more as the reader gets near the bottom, so the length of the feed costs nothing up front.
      One observer for the life of the view: a new one per render would pile up in the host. */
  function watchSentinel() {
    stopWatchingSentinel();
    const sentinel = $('auditBody').querySelector('.tl-sentinel');
    if (!sentinel || shown >= rows.length) { finishFeed(); return; }
    if (!sentinelObserver) {
      sentinelObserver = new IntersectionObserver(
        (hits) => { if (hits.some((h) => h.isIntersecting)) appendChunk(); },
        { root: $('auditBody'), rootMargin: '600px' },
      );
      host.observe(sentinelObserver);
    }
    sentinelObserver.observe(sentinel);
  }

  /* ------------------------------------------------------------ chips and counts */

  function countCategories(filtered) {
    const counts = { all: filtered.length };
    for (const row of filtered) counts[row.c.cat] = (counts[row.c.cat] || 0) + 1;
    return counts;
  }

  function renderChips(counts) {
    const shownCats = ['all', ...CATEGORIES.map((c) => c.id).filter((id) => counts[id])];
    $('auditChips').innerHTML = shownCats.map((id) => {
      const on = category === id;
      return `<button class="chip-btn${on ? ' on' : ''}" data-cat="${esc(id)}" aria-pressed="${on}">${esc(id === 'all' ? 'All' : CATEGORY[id].label)} <span class="chip-n">${counts[id] || 0}</span></button>`;
    }).join('');
    $('auditChips').querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => {
      /* Clicking the chip you are already on takes the narrowing off again. */
      category = category === b.dataset.cat ? 'all' : b.dataset.cat;
      render();
    }));
  }

  /** The event-type list, built from what the host says is in the trail rather than from a hardcoded list. */
  function syncActionOptions() {
    const select = $('auditAction');
    const counts = new Map();
    for (const e of entries) counts.set(e.action, (counts.get(e.action) || 0) + 1);
    const options = ['<option value="all">Every type</option>'].concat(
      actions.map((a) => `<option value="${esc(a)}">${esc(typeLabel(a))} (${counts.get(a) || 0})</option>`),
    );
    select.innerHTML = options.join('');
    /* A type that is no longer in the loaded window would otherwise filter everything away silently. */
    if (filters.action !== 'all' && !actions.includes(filters.action)) filters.action = 'all';
    select.value = filters.action;
  }

  /* ------------------------------------------------------------ the details view */

  function related(entry) {
    const c = classify(entry);
    if (!c.relation) return [];
    const { key, value } = c.relation;
    return entries.filter((e) => e !== entry && String(e[key] || '') === value).slice(0, 12);
  }

  function openDetail(i) {
    const entry = entries[i];
    if (!entry) return;
    const c = classify(entry);
    const dialog = $('auditDetail');
    const when = String(c.ts || '').replace('T', ' ').replace(/\.\d+Z?$/, '').replace(/Z$/, '');
    $('auditDetailMeta').innerHTML = [
      `<span class="ev-type">${esc(c.type)}</span>`,
      `<span class="ev-actor ev-actor-${esc(c.actor)}">${esc(ACTOR_TEXT[c.actor])}</span>`,
      STATUS_TEXT[c.status] ? `<span class="ev-status ev-${esc(c.status)}">${esc(STATUS_TEXT[c.status])}</span>` : '',
      `<time datetime="${esc(c.ts)}">${esc(when)}</time>`,
    ].filter(Boolean).join('');
    $('auditDetailTitle').textContent = c.title;

    const kin = related(entry);
    const sections = [];
    if (c.subject) sections.push(`<p class="ev-detail-subject">${esc(c.subject)}</p>`);
    if (c.redacted) sections.push(`<p class="ev-redacted">${esc(c.redacted)}</p>`);
    if (c.facts.length) {
      sections.push(`<dl class="ev-detail-facts">${c.facts.map((f) => `<dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd>`).join('')}</dl>`);
    }
    if (kin.length) {
      sections.push(`<section class="ev-detail-kin"><h4>Also part of ${esc(c.relation.label)}</h4>
        ${kin.map((e) => {
          const k = classify(e);
          return `<button type="button" class="ev-kin" data-i="${entries.indexOf(e)}">
            <span class="ev-time">${esc(hhmm(k.ts))}</span><span>${esc(k.title)}</span>
            ${STATUS_TEXT[k.status] ? `<span class="ev-status ev-${esc(k.status)}">${esc(STATUS_TEXT[k.status])}</span>` : ''}</button>`;
        }).join('')}</section>`);
    }
    sections.push(`<details class="tl-raw"><summary>The recorded line</summary><pre>${esc(rawJson(entry))}</pre></details>`);
    $('auditDetailBody').innerHTML = sections.join('');
    $('auditDetailBody').querySelectorAll('.ev-kin').forEach((b) => b.addEventListener('click', () => openDetail(Number(b.dataset.i))));

    /* The one action an event can carry: a chat turn can be picked back up. */
    $('btnAuditDetailChat').hidden = c.cat !== 'ai';
    dialog.__entry = entry;
    if (!dialog.open) dialog.showModal();
  }

  const rawJson = (entry) => JSON.stringify(entry, (k, v) => (k === '_n' ? undefined : v), 2);

  /* ------------------------------------------------------------ filters */

  const persist = () => host.storage.set('filters', filters);
  function syncFilterUi() {
    $('auditSearch').value = filters.q;
    $('auditTime').value = filters.time;
    $('auditOutcome').value = filters.outcome;
    $('auditActor').value = filters.actor;
    if ($('auditAction').options.length) $('auditAction').value = filters.action;
  }
  function clearFilters() {
    filters = { ...EMPTY_FILTERS };
    category = 'all';
    syncFilterUi();
    persist();
    render();
  }
  /** The "More filters" button says how many of the filters behind it are doing something. */
  function syncMoreButton() {
    const extra = (filters.actor !== 'all' ? 1 : 0) + (filters.action !== 'all' ? 1 : 0);
    const button = $('btnAuditMore');
    button.textContent = extra ? `More filters (${extra})` : 'More filters';
    button.classList.toggle('on', !!extra);
  }
  function toggleMore(open) {
    const panel = $('auditMorePanel');
    const next = open === undefined ? panel.hidden : open;
    panel.hidden = !next;
    $('btnAuditMore').setAttribute('aria-expanded', String(next));
    if (next) $('auditActor').focus();
  }

  /* ------------------------------------------------------------ loading */

  async function load() {
    const body = $('auditBody');
    body.innerHTML = '<div class="empty" style="padding:1rem">Loading…</div>';
    try {
      const data = await host.get('list', { limit: DEPTHS[depth] });
      const before = entries.length;
      entries = data.entries || [];
      actions = data.actions || [];
      /* Asking for twice as much and getting the same amount means the trail ends here. */
      if (depth > 0 && entries.length <= before) reachedEnd = true;
      syncActionOptions();
      render();
    } catch (error) {
      body.innerHTML = `<div class="empty" style="padding:1rem;color:var(--red)">${esc(error.message)}</div>`;
    }
  }
  function loadSoon() {
    host.clearTimer(pending);
    pending = host.setTimeout(() => load().catch(() => {}), 600);
  }

  /* ------------------------------------------------------------ render */

  function render() {
    const filtered = [];
    entries.forEach((entry, i) => { if (matches(entry, filters)) filtered.push({ entry, i, c: classify(entry) }); });
    const counts = countCategories(filtered);
    /* A category that nothing matches any more must not stay selected invisibly, showing an empty
       feed with no visible reason for it. Decided before the chips are drawn, not after. */
    if (category !== 'all' && !counts[category]) category = 'all';
    renderChips(counts);
    rows = filtered.filter((r) => category === 'all' || r.c.cat === category);

    const filtering = isFiltering(filters) || category !== 'all';
    $('btnAuditClear').hidden = !filtering;
    syncMoreButton();
    $('auditCount').textContent = filtering
      ? `${rows.length.toLocaleString()} of ${entries.length.toLocaleString()} events`
      : `${entries.length.toLocaleString()} events`;
    $('btnAuditResume').hidden = !entries.some((e) => e.action === 'ai-chat');

    stopWatchingSentinel();
    shown = 0;
    lastDay = null;
    const body = $('auditBody');
    if (!rows.length) {
      body.innerHTML = filtering
        ? '<div class="empty" style="padding:1rem">No events match these filters. <button type="button" data-clear>Clear filters</button></div>'
        : '<div class="empty" style="padding:1rem">Nothing here yet. Everything this application does is recorded as it happens.</div>';
      body.querySelector('[data-clear]')?.addEventListener('click', clearFilters);
      return;
    }
    body.innerHTML = '<div class="tl-sentinel"></div>';
    appendChunk();
    watchSentinel();
  }

  /* ------------------------------------------------------------ wiring, all of it disposable */

  syncFilterUi();
  syncMoreButton();

  host.on($('auditBody'), 'click', (event) => {
    const button = event.target.closest('.ev');
    if (button) openDetail(Number(button.dataset.i));
  });
  host.on($('auditSearch'), 'input', () => {
    host.clearTimer(searchTimer);
    searchTimer = host.setTimeout(() => { filters.q = $('auditSearch').value.trim(); persist(); render(); }, 200);
  });
  host.on($('auditTime'), 'change', () => { filters.time = $('auditTime').value; persist(); render(); });
  host.on($('auditOutcome'), 'change', () => { filters.outcome = $('auditOutcome').value; persist(); render(); });
  host.on($('auditActor'), 'change', () => { filters.actor = $('auditActor').value; persist(); render(); });
  host.on($('auditAction'), 'change', () => { filters.action = $('auditAction').value; persist(); render(); });
  host.on($('btnAuditMore'), 'click', () => toggleMore());
  host.on(document, 'click', (event) => {
    if (!$('auditMorePanel').hidden && !event.target.closest('.flt-more')) toggleMore(false);
  });
  host.on($('btnAuditClear'), 'click', clearFilters);
  host.on($('btnAuditRefresh'), 'click', () => load());
  host.on($('btnAuditResume'), 'click', () => host.assistant.open());

  host.on($('btnAuditDetailClose'), 'click', () => $('auditDetail').close());
  host.on($('btnAuditDetailDone'), 'click', () => $('auditDetail').close());
  host.on($('btnAuditDetailChat'), 'click', () => { $('auditDetail').close(); host.assistant.open(); });
  host.on($('btnAuditDetailCopy'), 'click', async () => {
    const entry = $('auditDetail').__entry;
    if (!entry) return;
    try { await navigator.clipboard.writeText(rawJson(entry)); host.ui.toast('The recorded line was copied', 'ok'); }
    catch { host.ui.toast('The line could not be copied', 'error'); }
  });

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

  return {
    load,
    loadSoon,
    render,
    describePlain,
    dispose() { stopWatchingSentinel(); entries = []; actions = []; rows = []; },
  };
}
