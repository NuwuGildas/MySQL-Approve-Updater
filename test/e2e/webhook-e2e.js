// Webhook end-to-end: needs `PORT=3999 node server.js` and `node test/e2e/ftp-server.js <dir> 2121` running.
// usage: node test/e2e/webhook-e2e.js   (creates a throwaway secret/repo/target named hook-*)
const crypto = require('crypto');
const base = 'http://127.0.0.1:3999/api/deploy';
const j = async (url, opts = {}) => { const r = await fetch(url, { headers: { 'content-type': 'application/json' }, ...opts }); const t = await r.text(); let b; try { b = JSON.parse(t); } catch { b = t; } if (!r.ok) throw new Error(`${r.status} ${url}: ${typeof b === 'string' ? b : b.error}`); return b; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (name, cond, extra = '') => { console.log(`${cond ? '✔' : '✖'} ${name}${extra ? ' — ' + extra : ''}`); if (!cond) process.exitCode = 1; };
(async () => {
  await j(`${base}/secrets/FTP_E2E`, { method: 'PUT', body: JSON.stringify({ value: 'ftp-secret' }) });
  const repo = await j(`${base}/repos`, { method: 'POST', body: JSON.stringify({ name: 'hook-site', source: { kind: 'local', path: 'C:\\Users\\GildasNuwu\\PhpstormProjects\\updateContent\\test\\fixtures\\repos\\plain-html' } }) });
  const t = await j(`${base}/targets`, { method: 'POST', body: JSON.stringify({ name: 'hook-prod', repoId: repo.id, type: 'shared-hosting', transport: { kind: 'ftp', host: '127.0.0.1', port: 2121, user: 'acme', passwordRef: '${vault:FTP_E2E}' }, paths: { home: '/', docroot: '/public_html' }, keepReleases: 2, autoShip: { enabled: true, mode: 'webhook', branch: 'main' } }) });
  ok('target created with auto-ship', t.autoShip?.enabled && t.autoShip.mode === 'webhook' && t.autoShip.hasSecret && t.autoShip.secret === undefined, JSON.stringify(t.autoShip));
  const w = await j(`${base}/targets/${t.id}/webhook`);
  ok('webhook info has URL + secret', /\/hooks\//.test(w.url) && w.secret?.length === 48, w.url);
  await sleep(1200);
  const st = await j(`${base}/autoship`);
  ok('listener is up', st.listener.listening === true, JSON.stringify(st.listener));
  const hookUrl = `http://127.0.0.1:${st.listener.port}/hooks/${t.id}`;
  // 1) bad signature → 401
  const body = JSON.stringify({ ref: 'refs/heads/main', after: 'deadbeef00000000', head_commit: { id: 'deadbeef00000000' } });
  let r = await fetch(hookUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) }, body });
  ok('bad signature rejected with 401', r.status === 401, String(r.status));
  // 2) push to another branch → ignored 202
  const sig = (b) => 'sha256=' + crypto.createHmac('sha256', w.secret).update(b).digest('hex');
  const other = JSON.stringify({ ref: 'refs/heads/feature', after: 'aaaa' });
  r = await fetch(hookUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': sig(other) }, body: other });
  ok('push to another branch ignored', r.status === 202 && /ignored push to feature/.test(await r.text()));
  // 3) ping → pong
  r = await fetch(hookUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'ping', 'x-hub-signature-256': sig('{}') }, body: '{}' });
  ok('ping answered', r.status === 200);
  // 4) real push → ship
  r = await fetch(hookUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': sig(body) }, body });
  const acc = await r.json().catch(() => ({}));
  ok('signed push accepted (202) and started a run', r.status === 202 && acc.runId, JSON.stringify(acc));
  // 5) second push while running → 409
  r = await fetch(hookUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': sig(body) }, body });
  ok('concurrent push while a run is active → 409 (or 202 if it already finished)', [409, 202].includes(r.status), String(r.status));
  let run;
  for (let i = 0; i < 40; i++) { await sleep(500); run = await j(`${base}/runs/${acc.runId}`); if (!['queued', 'running'].includes(run.status)) break; }
  ok('webhook-triggered ship succeeded', run.status === 'succeeded', `${run.status} ${run.error || ''}`);
  ok('run is attributed to the webhook trigger', run.trigger === 'webhook' && run.mode === 'ship');
  // GitLab style token on a second push
  await sleep(1200);
  r = await fetch(hookUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gitlab-event': 'Push Hook', 'x-gitlab-token': w.secret }, body: JSON.stringify({ ref: 'refs/heads/main', checkout_sha: 'cafebabe' }) });
  ok('GitLab token push accepted', r.status === 202, String(r.status));
  for (let i = 0; i < 40; i++) { await sleep(500); const a = await j(`${base}/runs?target=${t.id}&limit=5`); if (!a.active.length) break; }
  // disable → listener closes
  await j(`${base}/targets/${t.id}`, { method: 'PUT', body: JSON.stringify({ autoShip: { enabled: false } }) });
  await sleep(800);
  const st2 = await j(`${base}/autoship`);
  ok('listener stops when no target needs it', st2.listener.listening === false && st2.listener.targets === 0, JSON.stringify(st2.listener));
  // poll mode on a local repo reports a clear error
  await j(`${base}/targets/${t.id}`, { method: 'PUT', body: JSON.stringify({ autoShip: { enabled: true, mode: 'poll', pollMinutes: 1 } }) });
  const p = await j(`${base}/targets/${t.id}/poll-now`, { method: 'POST' });
  ok('poll on a local-folder repo explains itself', /needs a git repo/.test(p.poller?.error || ''), JSON.stringify(p.poller));
  const hist = await j('http://127.0.0.1:3999/api/audit?limit=50');
  ok('audit has deploy-webhook + rejected entries', hist.entries?.some((e) => e.action === 'deploy-webhook') && hist.entries?.some((e) => e.action === 'deploy-webhook-rejected'));
  console.log(process.exitCode ? 'WEBHOOK E2E FAILED' : 'WEBHOOK E2E OK');
})().catch((e) => { console.error('E2E error:', e.message); process.exit(2); });
