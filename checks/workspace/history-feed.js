'use strict';
/* The activity feed: one column, one card per recorded event.
 *
 * The trail runs to thousands of entries across dozens of action types, written by the host and by
 * every module. What is being checked is that the page stays readable at that size and that it says
 * the right thing about each kind of event - a SQL write filed under "Rules", or a failed command
 * shown as a success, is worse than no history at all.
 *
 * The entries are seeded into a throwaway audit.log. Nothing here touches the user's own trail.
 *
 * Run: node checks/workspace/history-feed.js
 */

const fs = require('fs');
const path = require('path');
const { startSandbox } = require('./sandbox');
const { launch, openApp, recorder, shot, until, sleep } = require('./browser');

const PORT = Number(process.env.PORT || 3126);

/** A trail with one of everything the feed has to say something about, plus bulk to scroll through. */
function seedTrail(dir) {
  const day = (back, hh, mm) => new Date(Date.now() - back * 86400e3).toISOString().slice(0, 11) + `${hh}:${mm}:00.000Z`;
  const lines = [];
  /* Bulk first, so it is the OLDEST: the reader keeps the last N and shows newest first. */
  for (let i = 0; i < 520; i++) {
    lines.push({ ts: day(20, '08', String(i % 60).padStart(2, '0')), action: 'ssh-terminal-open', sshHost: '10.0.0.5', sshUser: 'deploy', sessionId: 'bulk', profileId: 'p0', module: 'servers' });
  }
  lines.push(
    { ts: day(9, '09', '00'), action: 'deploy-ship-start', target: 'prod-web', runId: 'run-1', ref: 'main', trigger: 'manual', module: 'deployments' },
    { ts: day(9, '09', '04'), action: 'deploy-ship-failed', target: 'prod-web', runId: 'run-1', stage: 'build', error: 'the test suite did not pass', trigger: 'manual', module: 'deployments' },
    { ts: day(9, '09', '06'), action: 'deploy-ship-rolled-back', target: 'prod-web', runId: 'run-1', stage: 'build', previousRelease: '2026-08-30-1100', module: 'deployments' },
    { ts: day(1, '10', '00'), action: 'console-write', kw: 'UPDATE', sql: 'UPDATE pages SET title = TRIM(title)', affectedRows: 447, changedRows: 447, warningStatus: 0 },
    { ts: day(1, '10', '02'), action: 'ai-sql', prompt: 'find the duplicated slugs', sql: 'SELECT slug, COUNT(*) FROM pages GROUP BY slug HAVING COUNT(*) > 1', schemaAttached: true },
    { ts: day(1, '10', '05'), action: 'project-link', project: 'Checks', kind: 'server', resource: 'srv-1' },
    { ts: day(1, '10', '07'), action: 'connector-verify', connector: 'github', status: 'ok' },
    { ts: day(0, '11', '00'), action: 'ai-chat', role: 'user', text: 'restart nginx on web-01', sessionId: 'sess-a', turnId: 'turn-1', chars: 23 },
    { ts: day(0, '11', '01'), action: 'ai-ssh-proposed', sessionId: 'sess-a', turnId: 'turn-1', profileId: 'srv-1', cmd: 'systemctl restart nginx', class: 'write', module: 'servers' },
    { ts: day(0, '11', '02'), action: 'ai-ssh-exec', profile: 'web-01', sshHost: '10.0.0.5', cmd: 'systemctl restart nginx', class: 'write', exitCode: 0, ok: true, ms: 1240, sessionId: 'sess-a', turnId: 'turn-1', module: 'servers' },
    { ts: day(0, '11', '03'), action: 'ai-chat', role: 'assistant', text: 'nginx is back up.', tools: ['ssh_exec'], sessionId: 'sess-a', turnId: 'turn-1', chars: 17 },
    { ts: day(0, '11', '10'), action: 'preview', rule: 'Trim titles', table: 'pages', matchedRows: 500, proposedChanges: 447, limit: 500 },
    { ts: day(0, '11', '12'), action: 'approve', rule: 'Trim titles', table: 'pages', pk: 8812, columns: ['title'], sqlResult: 'ok' },
    { ts: day(0, '11', '14'), action: 'ai-ssh-exec', profile: 'web-01', cmd: 'certbot renew', class: 'write', exitCode: 1, ok: false, ms: 8400, sessionId: 'sess-a', module: 'servers' },
    { ts: day(0, '11', '20'), action: 'backup-restore', name: 'nightly-01', rows: 1200, module: 'backups' },
  );
  const body = lines.map((l) => JSON.stringify(l)).join('\n')
    + '\n{"ts":"' + day(0, '11', '30') + '","action":"truncated"\n';   // a half-written line, as a crash leaves one
  fs.writeFileSync(path.join(dir, 'audit.log'), body);
}

const cards = () => document.querySelectorAll('#auditBody .ev').length;

/**
 * Open the History page and wait until it is actually on screen.
 *
 * Setting the hash is not enough: History is a module page, and until the module has registered it
 * the route does not parse, nothing navigates, and the startup route the app deferred is replayed
 * over the top - leaving the check reading a drawer that is display:none, where every measurement
 * is zero and every assertion about layout passes for the wrong reason.
 */
const historyIsUp = () => {
  const drawer = document.getElementById('auditDrawer');
  return !!drawer && drawer.classList.contains('open') && drawer.getClientRects().length > 0
    && document.querySelectorAll('#auditBody .ev').length > 0;
};

async function openHistory(page) {
  /* Wait for the nav entry, not for the drawer: the markup is mounted before the page is
     registered, and until it is registered "#/history" does not parse. Then CLICK it, the way a
     reader does - a real navigation is also what tells the app not to replay its startup route. */
  await until(page, () => !!document.querySelector('[data-nav="history"]'), null, 25000);
  let open = false;
  for (let attempt = 0; attempt < 5 && !open; attempt++) {
    await page.evaluate(() => document.querySelector('[data-nav="history"]').click());
    open = await until(page, historyIsUp, null, 6000);
  }
  /* Loudly, and here: everything after this measures the page, and a check that carries on without
     it reports a dozen passes taken off a drawer nobody can see. */
  if (!open) {
    const why = await page.evaluate(() => {
      const drawer = document.getElementById('auditDrawer');
      return { route: location.hash, open: !!drawer?.classList.contains('open'), boxes: drawer?.getClientRects().length ?? -1, cards: document.querySelectorAll('#auditBody .ev').length };
    });
    throw new Error('the History page never came up: ' + JSON.stringify(why));
  }
  await sleep(400);
}

async function main() {
  const s = await startSandbox({ port: PORT, servers: 1, beforeStart: seedTrail });
  const browser = await launch();
  const r = recorder('history-feed');
  let page;
  try {
    page = await openApp(browser, s.base);
    await openHistory(page);

    /* ---- the feed itself ---- */
    const first = await page.evaluate(() => {
      const ev = document.querySelector('#auditBody .ev');
      return {
        drawn: document.querySelectorAll('#auditBody .ev').length,
        days: [...document.querySelectorAll('#auditBody .tl-day')].map((d) => d.textContent),
        tag: ev.tagName,
        type: ev.querySelector('.ev-type')?.textContent,
        title: ev.querySelector('.ev-title')?.textContent,
        label: ev.getAttribute('aria-label'),
        count: document.getElementById('auditCount').textContent,
        lanes: document.querySelectorAll('#auditBody .tl-chat.me').length,
      };
    });
    r.ok('feed', 'events are drawn as cards in one column', first.drawn > 0 && !first.lanes, JSON.stringify({ drawn: first.drawn, lanes: first.lanes }));
    r.ok('feed', 'and only a screenful of them at a time, not all 500', first.drawn > 0 && first.drawn <= 120, `${first.drawn} drawn`);
    r.ok('feed', 'the day is said once, at the top of its group',
      first.days[0] === 'Today' && new Set(first.days).size === first.days.length, first.days.join(' / '));
    r.ok('feed', 'a card is something you can open', first.tag === 'BUTTON' && !!first.label, `${first.tag} · ${String(first.label).slice(0, 60)}`);
    r.ok('feed', 'the header says how much there is', /events/.test(first.count), first.count);
    /* Both of these were true once: [hidden] loses to a display rule, and the base stylesheet
       centres every button, so the cards read down the middle. Neither showed up in a DOM query. */
    const looks = await page.evaluate(() => {
      const ev = document.querySelector('#auditBody .ev');
      const box = ev.getBoundingClientRect();
      return {
        /* Measured, not assumed: on a drawer that is display:none every offset below is 0, and
           every comparison against 0 passes. The width is what tells the two apart. */
        cardWidth: Math.round(box.width),
        panelDrawn: document.getElementById('auditMorePanel').getClientRects().length,
        clearDrawn: document.getElementById('btnAuditClear').getClientRects().length,
        typeLeft: Math.round(ev.querySelector('.ev-type').getBoundingClientRect().left - box.left),
        titleLeft: Math.round(ev.querySelector('.ev-title').getBoundingClientRect().left - box.left),
        timeRight: Math.round(box.right - ev.querySelector('.ev-time').getBoundingClientRect().right),
      };
    });
    r.ok('feed', 'a card reads from its left edge, not down the middle',
      looks.cardWidth > 300 && looks.typeLeft < 24 && looks.titleLeft < 24 && looks.timeRight < 24, JSON.stringify(looks));
    r.ok('feed', 'the advanced filters stay put away until they are asked for', looks.panelDrawn === 0, `${looks.panelDrawn} boxes drawn`);
    r.ok('feed', 'and nothing offers to clear filters that are not on', looks.clearDrawn === 0, `${looks.clearDrawn} boxes drawn`);
    await shot(page, 'hf-feed');

    /* ---- what each kind of event is called ---- */
    const seen = await page.evaluate(() => {
      const out = {};
      for (const ev of document.querySelectorAll('#auditBody .ev')) {
        out[ev.querySelector('.ev-title').textContent] = {
          type: ev.querySelector('.ev-type').textContent,
          cat: [...ev.classList].find((c) => c.startsWith('ev-') && c !== 'ev-bad'),
          status: ev.querySelector('.ev-status')?.textContent || '',
          facts: [...ev.querySelectorAll('.ev-fact')].map((f) => f.textContent),
        };
      }
      return out;
    });
    const titles = Object.keys(seen);
    const find = (re) => titles.find((t) => re.test(t));

    const sqlTitle = find(/Ran a UPDATE/i);
    r.ok('meaning', 'a SQL write is a SQL write, not a rule', !!sqlTitle && seen[sqlTitle].cat === 'ev-sql', sqlTitle ? seen[sqlTitle].cat : titles.join(' | ').slice(0, 200));
    const failTitle = find(/An approved command failed|approved command ran/i);
    const failed = titles.find((t) => seen[t].status === 'Failed');
    r.ok('meaning', 'a command that exited non-zero is shown as failed', !!failed, failed || 'nothing was marked failed');
    const shipped = find(/^A deploy failed$/);
    r.ok('meaning', 'a failed deploy says so and says where', !!shipped && seen[shipped].facts.some((f) => /Stage.*build/.test(f)), shipped ? seen[shipped].facts.join(' · ') : '(missing)');
    const preview = find(/Previewed a rule/i);
    r.ok('meaning', 'a rule preview carries its numbers', !!preview && seen[preview].facts.some((f) => /Would change.*447/.test(f)), preview ? seen[preview].facts.join(' · ') : '(missing)');
    /* An undescribed action is named by its badge, so the card must not then repeat that name as its
       title - it says what it acted on instead, and still carries the numbers it recorded. */
    const unknown = titles.find((t) => seen[t].type === 'Backup restore');
    r.ok('meaning', 'an action nobody wrote a description for is still readable',
      unknown === 'nightly-01' && seen[unknown].facts.some((f) => /Rows.*1200/.test(f)),
      unknown ? `${unknown} · ${seen[unknown].facts.join(' · ')}` : titles.join(' | ').slice(0, 200));
    r.ok('meaning', 'and its name is not printed twice on the same card', unknown !== 'Backup restore', String(unknown));
    r.ok('meaning', 'a half-written line is shown, not dropped', !!find(/could not be read/i));

    /* The host strips what was said before the entry ever leaves the server. The old view drew that
       as an empty chat bubble; it has to say what is missing instead. */
    const chat = await page.evaluate(() => {
      const ev = [...document.querySelectorAll('#auditBody .ev')].find((e) => /assistant replied/i.test(e.textContent));
      return ev ? { note: ev.querySelector('.ev-redacted')?.textContent || '', facts: [...ev.querySelectorAll('.ev-fact')].map((f) => f.textContent) } : null;
    });
    r.ok('meaning', 'a chat turn says the words themselves are not kept', !!chat && /not kept/.test(chat.note), JSON.stringify(chat));
    r.ok('meaning', 'while still saying how big it was', !!chat && chat.facts.some((f) => /Characters/.test(f)), chat ? chat.facts.join(' · ') : '(no chat card)');

    /* ---- the categories ---- */
    const chips = await page.evaluate(() => [...document.querySelectorAll('#auditChips [data-cat]')].map((b) => b.textContent.trim()));
    r.ok('chips', 'the categories are the ones present, with counts', chips.length > 3 && chips.some((c) => /^SQL/.test(c)) && chips.some((c) => /^Deployments/.test(c)), chips.join(' | '));
    await page.evaluate(() => [...document.querySelectorAll('#auditChips [data-cat]')].find((b) => /^SQL/.test(b.textContent))?.click());
    await sleep(250);
    const onlySql = await page.evaluate(() => [...document.querySelectorAll('#auditBody .ev')].every((e) => e.classList.contains('ev-sql')));
    r.ok('chips', 'choosing one shows only that kind', onlySql);
    await page.evaluate(() => document.querySelector('#auditChips [data-cat].on')?.click());
    await sleep(250);
    r.ok('chips', 'and choosing it again takes the narrowing off', await page.evaluate(() => document.querySelector('#auditChips [data-cat="all"]').classList.contains('on')));

    /* ---- details ---- */
    await page.evaluate(() => [...document.querySelectorAll('#auditBody .ev')].find((e) => e.querySelector('.ev-title').textContent === 'A deploy failed')?.click());
    await until(page, () => document.getElementById('auditDetail').open, null, 8000);
    const detail = await page.evaluate(() => ({
      title: document.getElementById('auditDetailTitle').textContent,
      facts: [...document.querySelectorAll('#auditDetailBody .ev-detail-facts dt')].map((d) => d.textContent),
      kin: [...document.querySelectorAll('#auditDetailBody .ev-kin')].map((b) => b.textContent.replace(/\s+/g, ' ').trim()),
      kinHeading: document.querySelector('#auditDetailBody .ev-detail-kin h4')?.textContent || '',
      raw: document.querySelector('#auditDetailBody .tl-raw pre')?.textContent || '',
      chatAction: document.getElementById('btnAuditDetailChat').getClientRects().length > 0,
    }));
    r.ok('details', 'the raw line is here rather than under every card', /"action": "deploy-ship-failed"/.test(detail.raw), detail.raw.slice(0, 80).replace(/\s+/g, ' '));
    r.ok('details', 'with the recorded fields spelled out', detail.facts.includes('Stage') && detail.facts.includes('Error'), detail.facts.join(', '));
    r.ok('details', 'and the rest of the same deploy run', detail.kin.length >= 2 && /deploy run/.test(detail.kinHeading), `${detail.kinHeading}: ${detail.kin.join(' | ')}`);
    r.ok('details', 'a deploy is not offered a chat to resume', !detail.chatAction);
    await shot(page, 'hf-details');

    await page.evaluate(() => document.querySelector('#auditDetailBody .ev-kin').click());
    await sleep(250);
    const jumped = await page.evaluate(() => document.getElementById('auditDetailTitle').textContent);
    r.ok('details', 'and a related event opens in its place', jumped !== detail.title, `${detail.title} → ${jumped}`);
    await page.evaluate(() => document.getElementById('btnAuditDetailDone').click());
    await until(page, () => !document.getElementById('auditDetail').open, null, 8000);

    await page.evaluate(() => [...document.querySelectorAll('#auditBody .ev')].find((e) => /you wrote/i.test(e.textContent))?.click());
    await until(page, () => document.getElementById('auditDetail').open, null, 8000);
    r.ok('details', 'a chat turn can still be picked back up', await page.evaluate(() => document.getElementById('btnAuditDetailChat').getClientRects().length > 0));
    await page.evaluate(() => document.getElementById('btnAuditDetailDone').click());

    /* ---- filters ---- */
    const typed = async (id, value) => page.evaluate((i, v) => {
      const el = document.getElementById(i);
      el.value = v;
      el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    }, id, value);

    await typed('auditSearch', 'nginx');
    await sleep(500);
    const searched = await page.evaluate(() => ({
      n: document.querySelectorAll('#auditBody .ev').length,
      all: [...document.querySelectorAll('#auditBody .ev')].every((e) => /nginx/i.test(e.textContent)),
      clear: !document.getElementById('btnAuditClear').hidden,
      count: document.getElementById('auditCount').textContent,
    }));
    r.ok('filters', 'search narrows the feed to what matches', searched.n > 0 && searched.all, `${searched.n} cards`);
    r.ok('filters', 'and the header says how much of the whole it is', /of/.test(searched.count), searched.count);
    r.ok('filters', 'and offers a way back', searched.clear);
    await page.evaluate(() => document.getElementById('btnAuditClear').click());
    await sleep(300);
    r.ok('filters', 'clearing puts everything back', await page.evaluate(() => document.querySelectorAll('#auditBody .ev').length) > searched.n);

    await typed('auditOutcome', 'failed');
    await sleep(300);
    const failedOnly = await page.evaluate(() => [...document.querySelectorAll('#auditBody .ev')].map((e) => e.querySelector('.ev-status')?.textContent || ''));
    r.ok('filters', 'outcome keeps the failures and the warnings', failedOnly.length > 0 && failedOnly.every((t) => /Failed|Warning/.test(t)), failedOnly.join(', '));
    await typed('auditOutcome', 'all');

    /* the two advanced filters live behind a button, and it says how many are on */
    await page.evaluate(() => document.getElementById('btnAuditMore').click());
    await until(page, () => !document.getElementById('auditMorePanel').hidden, null, 8000);
    const types = await page.evaluate(() => [...document.getElementById('auditAction').options].map((o) => o.textContent));
    r.ok('filters', 'every event type recorded can be picked, with its count', types.length > 8 && types.some((t) => /\(\d+\)/.test(t)), `${types.length} types · ${types.slice(1, 4).join(' | ')}`);
    await shot(page, 'hf-more-filters');

    await typed('auditAction', 'ai-ssh-exec');
    await sleep(300);
    const byType = await page.evaluate(() => ({
      n: document.querySelectorAll('#auditBody .ev').length,
      more: document.getElementById('btnAuditMore').textContent,
    }));
    r.ok('filters', 'picking one type shows only that type', byType.n === 2, `${byType.n} cards`);
    r.ok('filters', 'and the button says a hidden filter is on', /\(1\)/.test(byType.more), byType.more);

    await typed('auditActor', 'ai');
    await sleep(300);
    await typed('auditAction', 'all');
    await sleep(300);
    const byActor = await page.evaluate(() => [...document.querySelectorAll('#auditBody .ev')].map((e) => e.querySelector('.ev-actor').textContent));
    r.ok('filters', 'and who set it off can be picked too', byActor.length > 0 && byActor.every((a) => a === 'Assistant'), [...new Set(byActor)].join(', '));
    await page.evaluate(() => document.getElementById('btnAuditClear').click());
    await sleep(300);

    /* ---- the filters survive leaving the page ---- */
    await typed('auditSearch', 'nginx');
    await sleep(500);
    await page.evaluate(() => { location.hash = '#/'; });
    await sleep(500);
    await openHistory(page);
    r.ok('filters', 'the filters are still on when you come back', await page.evaluate(() => document.getElementById('auditSearch').value) === 'nginx');
    await page.evaluate(() => document.getElementById('btnAuditClear').click());
    await sleep(400);

    /* ---- the length of the trail ---- */
    const before = await page.evaluate(cards);
    await page.evaluate(() => { const b = document.getElementById('auditBody'); b.scrollTop = b.scrollHeight; });
    await until(page, () => document.querySelectorAll('#auditBody .ev').length > 100, null, 12000);
    const grown = await page.evaluate(cards);
    r.ok('volume', 'more is drawn as you reach the bottom', grown > before, `${before} → ${grown}`);

    for (let i = 0; i < 12 && await page.evaluate(() => !document.querySelector('.tl-sentinel .tl-note')); i++) {
      await page.evaluate(() => { const b = document.getElementById('auditBody'); b.scrollTop = b.scrollHeight; });
      await sleep(400);
    }
    const foot = await page.evaluate(() => ({
      note: document.querySelector('.tl-sentinel .tl-note')?.textContent || '',
      deeper: !!document.querySelector('.tl-sentinel [data-deeper]'),
      drawn: document.querySelectorAll('#auditBody .ev').length,
    }));
    r.ok('volume', 'the end of the feed says what it is the end of', /recorded/.test(foot.note), foot.note);
    r.ok('volume', 'and offers to go further back', foot.deeper, JSON.stringify(foot));
    await shot(page, 'hf-bottom');

    /* ---- responsive ---- */
    await page.setViewport({ width: 390, height: 780 });
    await sleep(500);
    const narrow = await page.evaluate(() => {
      const body = document.getElementById('auditBody');
      const ev = document.querySelector('#auditBody .ev');
      return { overflow: body.scrollWidth - body.clientWidth, w: ev.getBoundingClientRect().width, page: document.documentElement.scrollWidth - window.innerWidth };
    });
    r.ok('narrow', 'nothing spills sideways on a phone', narrow.w > 200 && narrow.overflow <= 2 && narrow.page <= 2, JSON.stringify(narrow));
    await shot(page, 'hf-narrow');
    await page.setViewport({ width: 1400, height: 900 });

    r.ok('errors', 'no page errors were raised during the run', page.__errors.length === 0, page.__errors.slice(0, 3).join(' | '));
  } catch (e) {
    r.ok('run', 'the check completed', false, (e && e.stack) || String(e));
  } finally {
    if (page) { try { await shot(page, 'hf-final'); } catch {} }
    await browser.close().catch(() => {});
    await s.stop().catch(() => {});
  }
  process.exit(r.report() ? 0 : 1);
}

main();
