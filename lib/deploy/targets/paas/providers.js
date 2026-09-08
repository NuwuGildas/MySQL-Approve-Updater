'use strict';
/* PaaS providers wrapped through their official CLIs. Each provider says
   how to authenticate (env var filled from the vault), whether the app must
   be built locally first (directory-based deploys), how to compose the
   deploy command, how to read the resulting URL/deployment id, and how to
   roll back when the platform supports it. Tokens NEVER appear in argv. */

const { qLocal: q } = require('../../shell');
const last = (re, out) => { let m, r = null; const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'); while ((m = g.exec(out))) r = m; return r; };
const jsonOut = (out) => { try { const s = out.slice(out.indexOf('{')); return JSON.parse(s.slice(0, s.lastIndexOf('}') + 1)); } catch { return null; } };

const PROVIDERS = {
  vercel: {
    id: 'vercel', label: 'Vercel', cli: 'vercel', install: 'npm i -g vercel', tokenEnv: 'VERCEL_TOKEN', tokenHint: 'Account token (Settings → Tokens); the CLI links the project on first deploy',
    buildLocal: false, fields: [{ key: 'project', label: 'Project name', placeholder: 'my-site', required: false }, { key: 'scope', label: 'Team / scope (optional)', placeholder: 'my-team' }],
    deploy(t, c) { return { cmd: `vercel deploy${c.prod ? ' --prod' : ''} --yes${t.paas.project ? ` --name ${q(t.paas.project)}` : ''}${t.paas.scope ? ` --scope ${q(t.paas.scope)}` : ''} --token "$${'{'}VERCEL_TOKEN}"`, cwd: c.dir, tokenInCmdVar: 'VERCEL_TOKEN' }; },
    parse(out) { const m = last(/https:\/\/[a-z0-9.-]+\.vercel\.app/i, out); return { url: m ? m[0] : null, id: m ? m[0] : null }; },
    rollback(t, prev) { return prev?.id ? { cmd: `vercel rollback ${q(prev.id)} --yes${t.paas.scope ? ` --scope ${q(t.paas.scope)}` : ''} --token "$${'{'}VERCEL_TOKEN}"`, tokenInCmdVar: 'VERCEL_TOKEN' } : null; },
    tokenArg: true,
  },
  netlify: {
    id: 'netlify', label: 'Netlify', cli: 'netlify', install: 'npm i -g netlify-cli', tokenEnv: 'NETLIFY_AUTH_TOKEN', tokenHint: 'Personal access token (User settings → Applications)',
    buildLocal: true, fields: [{ key: 'site', label: 'Site ID or name', placeholder: 'a1b2c3d4-… or my-site', required: true }],
    deploy(t, c) { return { cmd: `netlify deploy${c.prod ? ' --prod' : ''} --dir ${q(c.dir)} --site ${q(t.paas.site)} --json --message ${q(`ascension ${c.release}${c.shortCommit ? ' ' + c.shortCommit : ''}`)}`, cwd: c.appDir }; },
    parse(out) { const j = jsonOut(out); return { url: j?.deploy_url || j?.url || (last(/https:\/\/[a-z0-9.-]+\.netlify\.app/i, out) || [])[0] || null, id: j?.deploy_id || null, prodUrl: j?.url || null }; },
    rollback(t, prev) { return prev?.id ? { cmd: `netlify api restoreSiteDeploy --data ${q(JSON.stringify({ site_id: t.paas.site, deploy_id: prev.id }))}` } : null; },
  },
  'cloudflare-pages': {
    id: 'cloudflare-pages', label: 'Cloudflare Pages', cli: 'wrangler', install: 'npm i -g wrangler', tokenEnv: 'CLOUDFLARE_API_TOKEN', tokenHint: 'API token with Cloudflare Pages: Edit; also set the account id',
    buildLocal: true, fields: [{ key: 'project', label: 'Pages project name', placeholder: 'my-site', required: true }, { key: 'accountId', label: 'Account ID', placeholder: '32 hex chars', required: true }],
    env(t) { return { CLOUDFLARE_ACCOUNT_ID: t.paas.accountId }; },
    deploy(t, c) { return { cmd: `wrangler pages deploy ${q(c.dir)} --project-name ${q(t.paas.project)}${c.branch ? ` --branch ${q(c.prod ? 'main' : c.branch)}` : ''} --commit-dirty=true${c.shortCommit ? ` --commit-hash ${q(c.commit)}` : ''}`, cwd: c.appDir }; },
    parse(out) { const m = last(/https:\/\/[a-z0-9.-]+\.pages\.dev/i, out); return { url: m ? m[0] : null, id: m ? m[0] : null }; },
    rollback() { return null; },
  },
  'cloudflare-workers': {
    id: 'cloudflare-workers', label: 'Cloudflare Workers', cli: 'wrangler', install: 'npm i -g wrangler', tokenEnv: 'CLOUDFLARE_API_TOKEN', tokenHint: 'API token with Workers Scripts: Edit; wrangler.toml in the repo names the worker',
    buildLocal: false, fields: [{ key: 'accountId', label: 'Account ID', placeholder: '32 hex chars', required: true }, { key: 'environment', label: 'wrangler environment (optional)', placeholder: 'production' }],
    env(t) { return { CLOUDFLARE_ACCOUNT_ID: t.paas.accountId }; },
    deploy(t, c) { return { cmd: `wrangler deploy${t.paas.environment ? ` --env ${q(t.paas.environment)}` : ''}`, cwd: c.appDir }; },
    parse(out) { const m = last(/https:\/\/[a-z0-9.-]+\.workers\.dev/i, out); const v = /Current Version ID:\s*([a-f0-9-]+)/i.exec(out); return { url: m ? m[0] : null, id: v ? v[1] : null }; },
    rollback(t, prev) { return prev?.id ? { cmd: `wrangler rollback ${q(prev.id)}${t.paas.environment ? ` --env ${q(t.paas.environment)}` : ''} --yes` } : { cmd: `wrangler rollback${t.paas.environment ? ` --env ${q(t.paas.environment)}` : ''} --yes` }; },
  },
  fly: {
    id: 'fly', label: 'Fly.io', cli: 'flyctl', install: 'https://fly.io/docs/flyctl/install/', tokenEnv: 'FLY_API_TOKEN', tokenHint: 'Deploy token for the app (fly tokens create deploy -a <app>)',
    buildLocal: false, fields: [{ key: 'app', label: 'Fly app name', placeholder: 'my-app', required: true }, { key: 'config', label: 'fly.toml path (optional)', placeholder: 'fly.toml' }],
    deploy(t, c) { return { cmd: `flyctl deploy --remote-only --app ${q(t.paas.app)}${t.paas.config ? ` --config ${q(t.paas.config)}` : ''} --yes`, cwd: c.appDir }; },
    parse(out, t) { const v = last(/release v(\d+)/i, out) || last(/version\s*:?\s*(\d+)/i, out); return { url: `https://${t.paas.app}.fly.dev`, id: v ? v[1] : null }; },
    rollback(t, prev) { return prev?.image ? { cmd: `flyctl deploy --image ${q(prev.image)} --app ${q(t.paas.app)} --yes` } : null; },
    afterDeploy(t) { return `flyctl releases --app ${q(t.paas.app)} --json`; },
    parseAfter(out) { try { const rel = JSON.parse(out)[0]; return { image: rel?.ImageRef || rel?.Image || null, id: rel?.Version ? String(rel.Version) : null }; } catch { return {}; } },
  },
  render: {
    id: 'render', label: 'Render', cli: 'render', install: 'https://render.com/docs/cli', tokenEnv: 'RENDER_API_KEY', tokenHint: 'API key (Account settings → API Keys); the service must already exist and be connected to the repo',
    buildLocal: false, fields: [{ key: 'serviceId', label: 'Service ID', placeholder: 'srv-…', required: true }],
    deploy(t, c) { return { cmd: `render deploys create ${q(t.paas.serviceId)} --wait --confirm --output json${c.commit ? ` --commit ${q(c.commit)}` : ''}`, cwd: c.appDir }; },
    parse(out) { const j = jsonOut(out); return { url: null, id: j?.id || null }; },
    rollback(t, prev) { return prev?.id ? { cmd: `render deploys create ${q(t.paas.serviceId)} --wait --confirm --output json --commit ${q(prev.commit)}` } : null; },
  },
};

module.exports = { PROVIDERS, jsonOut, last };
