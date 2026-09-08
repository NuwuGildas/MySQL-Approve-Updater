'use strict';
/* Auto-ship: a tiny separate HTTP listener for signed push webhooks
   (GitHub / GitLab / generic), plus `git ls-remote` polling for targets
   that cannot receive webhooks. Both funnel into engine.start({mode:'ship'})
   with trigger 'webhook' | 'poll', only for targets with autoShip.enabled.

   The listener binds to DEPLOY_HOOK_BIND (default 127.0.0.1) on
   DEPLOY_HOOK_PORT (default 3001); expose it with a tunnel such as
   `cloudflared tunnel --url http://127.0.0.1:3001` or a reverse proxy. */

const http = require('http');
const crypto = require('crypto');
const git = require('./git');
const { refName } = require('./vault');

const MAX_BODY = 1024 * 1024;

/** Which branch does a push payload touch? (GitHub, GitLab, Bitbucket, Gitea) */
function pushedBranch(payload, headers = {}) {
  const ref = payload?.ref || payload?.push?.changes?.[0]?.new?.name || null;
  if (!ref) return null;
  return String(ref).replace(/^refs\/heads\//, '');
}
function pushedCommit(payload) { return payload?.after || payload?.checkout_sha || payload?.head_commit?.id || payload?.push?.changes?.[0]?.new?.target?.hash || null; }
function eventKind(headers) {
  if (headers['x-github-event']) return `github:${headers['x-github-event']}`;
  if (headers['x-gitlab-event']) return `gitlab:${String(headers['x-gitlab-event']).toLowerCase()}`;
  if (headers['x-event-key']) return `bitbucket:${headers['x-event-key']}`;
  if (headers['x-gitea-event']) return `gitea:${headers['x-gitea-event']}`;
  return 'generic';
}
const timingEqual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/** Verify a request against the target's shared secret. Returns null when ok, else a reason. */
function verifySignature(headers, rawBody, secret, url) {
  if (!secret) return 'target has no webhook secret';
  const gh = headers['x-hub-signature-256'];
  if (gh) { const mac = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex'); return timingEqual(gh, mac) ? null : 'bad X-Hub-Signature-256'; }
  const gl = headers['x-gitlab-token'];
  if (gl) return timingEqual(gl, secret) ? null : 'bad X-Gitlab-Token';
  const gitea = headers['x-gitea-signature'];
  if (gitea) { const mac = crypto.createHmac('sha256', secret).update(rawBody).digest('hex'); return timingEqual(gitea, mac) ? null : 'bad X-Gitea-Signature'; }
  const q = url.searchParams.get('token');
  if (q) return timingEqual(q, secret) ? null : 'bad token';
  const bearer = /^Bearer (.+)$/.exec(headers.authorization || '');
  if (bearer) return timingEqual(bearer[1], secret) ? null : 'bad bearer token';
  return 'no signature or token';
}

function createAutoShip({ ctx, engine, stores, vault }) {
  const port = Number(process.env.DEPLOY_HOOK_PORT || 3001);
  const bind = process.env.DEPLOY_HOOK_BIND || '127.0.0.1';
  let server = null, listening = false, lastError = null;
  const pollers = new Map(); // targetId -> { timer, lastCommit, lastCheck, error }

  const targetsWith = (mode) => stores.targets.get().targets.filter((t) => t.autoShip?.enabled && (!mode || t.autoShip.mode === mode));

  function startShip(target, { trigger, ref, reason }) {
    if (engine.isLocked(target.id)) { ctx.logEvent('warn', `auto-ship skipped for ${target.name}: a run is already in progress`); return null; }
    try {
      const run = engine.start({ targetId: target.id, mode: 'ship', confirm: true, trigger, ref, ai: false });
      ctx.audit({ action: trigger === 'webhook' ? 'deploy-webhook' : 'deploy-poll-trigger', target: target.name, targetId: target.id, runId: run.id, ref, reason });
      return run;
    } catch (e) { ctx.logEvent('warn', `auto-ship for ${target.name} could not start: ${e.message}`); return null; }
  }
  const branchOf = (target) => target.autoShip?.branch || stores.findRepo(target.repoId)?.source?.branch || null;

  /* ---------------- webhook listener ---------------- */
  function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const m = /^\/hooks\/([A-Za-z0-9-]+)\/?$/.exec(url.pathname);
    if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('The Ascension webhook listener\n'); }
    if (!m || req.method !== 'POST') { res.writeHead(404); return res.end('not found'); }
    const target = stores.findTarget(m[1]);
    if (!target || !target.autoShip?.enabled || target.autoShip.mode !== 'webhook') { res.writeHead(404); return res.end('unknown target or auto-ship disabled'); }
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const why = verifySignature(req.headers, raw, target.autoShip.secret, url);
      if (why) { ctx.audit({ action: 'deploy-webhook-rejected', target: target.name, targetId: target.id, reason: why, ip: req.socket.remoteAddress }); res.writeHead(401); return res.end(why); }
      let payload = {};
      try { payload = JSON.parse(raw.toString('utf8') || '{}'); } catch { /* form-encoded or empty: treat as generic trigger */ }
      const kind = eventKind(req.headers);
      if (/^github:ping$/.test(kind)) { res.writeHead(200); return res.end('pong'); }
      if (!/push|generic/.test(kind)) { res.writeHead(202); return res.end(`ignored event ${kind}`); }
      const branch = pushedBranch(payload, req.headers);
      const want = branchOf(target);
      if (want && branch && branch !== want) { res.writeHead(202); return res.end(`ignored push to ${branch} (target follows ${want})`); }
      if (payload?.deleted === true) { res.writeHead(202); return res.end('ignored branch deletion'); }
      const run = startShip(target, { trigger: 'webhook', ref: branch || want || undefined, reason: `${kind} ${pushedCommit(payload) || ''}`.trim() });
      if (!run) { res.writeHead(409); return res.end('a deploy is already running for this target'); }
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, runId: run.id, target: target.name }));
    });
  }
  function ensureListener() {
    const need = targetsWith('webhook').length > 0;
    if (need && !server) {
      server = http.createServer(handle);
      server.on('error', (e) => { lastError = e.message; listening = false; ctx.logEvent('warn', `webhook listener error: ${e.message}`); });
      server.listen(port, bind, () => { listening = true; lastError = null; ctx.logEvent('info', `webhook listener on http://${bind}:${port}/hooks/<targetId>`); });
    } else if (!need && server) { try { server.close(); } catch {} server = null; listening = false; }
  }

  /* ---------------- polling ---------------- */
  async function pollOnce(target) {
    const st = pollers.get(target.id) || {};
    const repo = stores.findRepo(target.repoId);
    if (!repo || repo.source.kind !== 'git') { st.error = 'polling needs a git repo'; return; }
    const branch = branchOf(target) || 'HEAD';
    try {
      const token = repo.source.auth?.kind === 'https-token' && repo.source.auth.tokenRef ? vault.get(refName(repo.source.auth.tokenRef)) : null;
      const list = await git.listBranches(repo.source, { token });
      const hit = list.find((b) => b.name === branch && b.kind === 'branch') || (branch === 'HEAD' ? list[0] : null);
      st.lastCheck = new Date().toISOString(); st.error = null;
      if (!hit) { st.error = `branch ${branch} not found on the remote`; return; }
      const deployed = engine.list({ targetId: target.id, limit: 20 }).find((r) => r.mode === 'ship' && r.status === 'succeeded')?.commit || null;
      const baseline = st.lastCommit || deployed;
      st.lastCommit = hit.commit;
      if (baseline && baseline !== hit.commit) startShip(target, { trigger: 'poll', ref: branch === 'HEAD' ? undefined : branch, reason: `new commit ${hit.commit.slice(0, 8)} on ${branch}` });
    } catch (e) { st.error = e.message; st.lastCheck = new Date().toISOString(); }
    finally { pollers.set(target.id, st); }
  }
  function refresh() {
    ensureListener();
    const wanted = new Map(targetsWith('poll').map((t) => [t.id, t]));
    for (const [id, st] of pollers) if (!wanted.has(id)) { clearInterval(st.timer); pollers.delete(id); }
    for (const [id, t] of wanted) {
      const minutes = Math.max(1, Math.min(1440, Number(t.autoShip.pollMinutes) || 5));
      const st = pollers.get(id) || {};
      if (st.timer && st.minutes === minutes) continue;
      if (st.timer) clearInterval(st.timer);
      st.minutes = minutes; st.timer = setInterval(() => pollOnce(stores.findTarget(id) || t), minutes * 60000); st.timer.unref?.();
      pollers.set(id, st);
      setTimeout(() => pollOnce(stores.findTarget(id) || t), 2000);
    }
  }
  function status() {
    return {
      listener: { port, bind, listening, lastError, url: `http://${bind}:${port}/hooks/<targetId>`, targets: targetsWith('webhook').length },
      pollers: [...pollers.entries()].map(([id, st]) => ({ targetId: id, minutes: st.minutes, lastCheck: st.lastCheck || null, lastCommit: st.lastCommit || null, error: st.error || null })),
    };
  }
  function stop() { if (server) { try { server.close(); } catch {} } for (const st of pollers.values()) clearInterval(st.timer); }

  return { refresh, status, stop, pollOnce, handle, port, bind };
}

/** Normalize the autoShip block of a target (called from the routes' target sanitizer). */
function normalizeAutoShip(body, existing) {
  const a = body?.autoShip;
  if (!a || !a.enabled) return existing?.autoShip ? { ...existing.autoShip, enabled: false } : null;
  const mode = a.mode === 'poll' ? 'poll' : 'webhook';
  const branch = String(a.branch || '').trim() || null;
  if (branch && !/^[\w./+-]+$/.test(branch)) { const e = new Error('autoShip.branch has invalid characters'); e.status = 400; throw e; }
  return {
    enabled: true, mode, branch,
    pollMinutes: Math.max(1, Math.min(1440, Number(a.pollMinutes) || existing?.autoShip?.pollMinutes || 5)),
    // the webhook secret is generated once and kept across edits (rotate explicitly with rotateSecret:true)
    secret: a.rotateSecret || !existing?.autoShip?.secret ? crypto.randomBytes(24).toString('hex') : existing.autoShip.secret,
  };
}

module.exports = { createAutoShip, normalizeAutoShip, verifySignature, pushedBranch, pushedCommit, eventKind };
