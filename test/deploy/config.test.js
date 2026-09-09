'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { fakeCtx, deps } = require('./helpers');
const { createConfig, suggestTarget } = require('../../lib/deploy/config');
const { sanitizeRepo, sanitizeTarget } = require('../../lib/deploy/routes');

const fx = (n) => path.join(__dirname, '..', 'fixtures', 'repos', n);
const mk = () => { const ctx = fakeCtx(); const d = deps(ctx); return { ctx, d, cfg: createConfig({ ctx, stores: d.stores, vault: d.vault, sanitizeRepo, sanitizeTarget }) }; };

test('suggestTarget fills sensible defaults per kind and stack', () => {
  const v = suggestTarget({ kind: 'vps-ssh', repoName: 'shop', env: 'prod', stackType: 'php' });
  assert.equal(v.name, 'shop-prod'); assert.equal(v.paths.root, '/var/www/shop-prod'); assert.match(v.web.phpFpmReload, /php8\.3-fpm/); assert.equal(v.process.manager, 'none'); assert.equal(v.keepReleases, 5);
  const n = suggestTarget({ kind: 'vps-ssh', name: 'api-staging', stackType: 'node', web: 'apache' });
  assert.equal(n.process.manager, 'systemd'); assert.equal(n.process.unit, 'api-staging.service'); assert.match(n.web.reloadCmd, /apache2/); assert.equal(n.web.phpFpmReload, '');
  const s = suggestTarget({ kind: 'shared-hosting', name: 'site', host: 'acme' });
  assert.equal(s.paths.docroot, '/home/acme/public_html'); assert.equal(s.buildMode, 'local');
  assert.equal(suggestTarget({ kind: 'paas', name: 'x', env: 'staging' }).paas.prod, false);
});

test('guided setup creates secrets, repo and target atomically; validation failures write nothing', async () => {
  const { ctx, d, cfg } = mk();
  // invalid target (missing docroot) → nothing created, secret not stored
  await assert.rejects(cfg.setup({ secrets: { FTP_PW: 'pw' }, repo: { name: 'site', source: { kind: 'local', path: fx('plain-html') } }, target: { projectId: 'general', name: 'shared', type: 'shared-hosting', transport: { kind: 'ftp', host: 'h', user: 'u', passwordRef: '${vault:FTP_PW}' }, paths: { home: '/' } } }), /docroot/);
  assert.equal(d.vault.names().length, 0); assert.equal(d.stores.repos.get().repos.length, 0);
  // secret referenced but not provided
  await assert.rejects(cfg.setup({ repo: { name: 'site', source: { kind: 'local', path: fx('plain-html') } }, target: { projectId: 'general', name: 'shared', type: 'shared-hosting', transport: { kind: 'ftp', host: 'h', user: 'u', passwordRef: '${vault:NOPE}' }, paths: { home: '/', docroot: '/public_html' } } }), /NOPE is referenced/);
  const out = await cfg.setup({ secrets: { FTP_PW: 'pw' }, repo: { name: 'site', source: { kind: 'local', path: fx('plain-html') } }, target: { projectId: 'general', name: 'shared', type: 'shared-hosting', transport: { kind: 'ftp', host: 'h', user: 'u', passwordRef: '${vault:FTP_PW}' }, paths: { home: '/', docroot: '/public_html' }, autoShip: { enabled: true, mode: 'poll', pollMinutes: 10 } } });
  assert.equal(out.repo.name, 'site'); assert.equal(out.target.repoId, out.repo.id); assert.deepEqual(out.secrets, ['FTP_PW']);
  assert.equal(d.vault.get('FTP_PW'), 'pw'); assert.equal(d.stores.targets.get().targets.length, 1);
  assert.ok(ctx._audits.some((a) => a.action === 'deploy-target-add' && a.by === 'setup'));
  // reuse an existing repo by id
  const out2 = await cfg.setup({ repoId: out.repo.id, target: { projectId: 'general', name: 'shared-2', type: 'shared-hosting', transport: { kind: 'ftp', host: 'h', user: 'u', passwordRef: '${vault:FTP_PW}' }, paths: { home: '/', docroot: '/public_html' } } });
  assert.equal(out2.target.repoId, out.repo.id);
});

test('templates: save from a target, list, apply via duplicate, delete', async () => {
  const { ctx, d, cfg } = mk();
  d.vault.set('FTP_PW', 'pw');
  const { target } = await cfg.setup({ repo: { name: 'site', source: { kind: 'local', path: fx('plain-html') } }, target: { projectId: 'general', name: 'prod', type: 'shared-hosting', transport: { kind: 'ftp', host: 'h', user: 'u', passwordRef: '${vault:FTP_PW}' }, paths: { home: '/', docroot: '/public_html' }, autoShip: { enabled: true, mode: 'webhook' } } });
  const tpl = await cfg.saveTemplate({ name: 'cPanel FTP', fromTargetId: target.id });
  assert.equal(tpl.type, 'shared-hosting'); assert.equal(tpl.data.name, undefined); assert.equal(tpl.data.repoId, undefined);
  assert.equal(tpl.data.autoShip.secret, undefined, 'webhook secret is not part of a template');
  assert.equal(cfg.listTemplates().length, 1);
  await cfg.saveTemplate({ name: 'cPanel FTP', fromTargetId: target.id }); // same name → update, not duplicate
  assert.equal(cfg.listTemplates().length, 1);
  await assert.rejects(cfg.saveTemplate({ name: '', fromTargetId: target.id }), /name is required/);
  const dup = await cfg.duplicateTarget(target.id, { name: 'preprod', env: 'preprod' });
  assert.equal(dup.name, 'preprod'); assert.equal(dup.repoId, target.repoId); assert.ok(!dup.autoShip?.enabled, 'triggers are not cloned live');
  assert.equal(d.stores.targets.get().targets.length, 2);
  await cfg.deleteTemplate(tpl.id); assert.equal(cfg.listTemplates().length, 0);
  await assert.rejects(cfg.deleteTemplate('nope'), /not found/);
  assert.ok(ctx._audits.some((a) => a.action === 'deploy-template-save'));
});

test('export never carries secret values; import merges by name, remaps repo ids, reports missing secrets/profiles', async () => {
  const a = mk();
  a.d.vault.set('FTP_PW', 'pw-value');
  const { repo, target } = await a.cfg.setup({ repo: { name: 'site', source: { kind: 'local', path: fx('plain-html') } }, target: { projectId: 'general', name: 'prod', type: 'shared-hosting', transport: { kind: 'ftp', host: 'h', user: 'u', passwordRef: '${vault:FTP_PW}' }, paths: { home: '/', docroot: '/public_html' }, autoShip: { enabled: true, mode: 'webhook' } } });
  await a.cfg.saveTemplate({ name: 'tpl', fromTargetId: target.id });
  a.d.stores.targets.get().targets.push(sanitizeTarget({ projectId: 'general', name: 'vps', repoId: repo.id, type: 'vps-ssh', ssh: { profileId: 'p1' }, paths: { root: '/var/www/site' } }, a.ctx, a.d.stores, null));
  const doc = a.cfg.exportConfig();
  const json = JSON.stringify(doc);
  assert.ok(!json.includes('pw-value'), 'no secret values'); assert.ok(!json.includes(target.autoShip.secret), 'no webhook secret');
  assert.deepEqual(doc.secrets, [{ name: 'FTP_PW' }]); assert.equal(doc.targets.length, 2); assert.equal(doc.sshProfiles[0].host, 'box.local');
  // import into a fresh machine: no secrets, ssh profile with the same host/user exists (p1)
  const b = mk();
  const dry = await b.cfg.importConfig(doc, { dryRun: true });
  assert.deepEqual(dry.missingSecrets, ['FTP_PW']); assert.equal(b.d.stores.targets.get().targets.length, 0);
  const rep = await b.cfg.importConfig(doc);
  assert.deepEqual(rep.repos, ['site']); assert.deepEqual(rep.targets.sort(), ['prod', 'vps']); assert.deepEqual(rep.templates, ['tpl']);
  assert.equal(rep.unresolvedProfiles.length, 0);
  const vps = b.d.stores.findTarget('vps'); assert.equal(vps.ssh.profileId, 'p1'); assert.equal(vps.repoId, b.d.stores.findRepo(b.d.stores.targets.get().targets[0].repoId).id);
  assert.notEqual(vps.repoId, repo.id, 'repo id remapped to the new machine');
  const prod = b.d.stores.findTarget('prod'); assert.equal(prod.autoShip.enabled, true); assert.equal(prod.autoShip.secret.length, 48, 'fresh webhook secret generated');
  // second import is a no-op
  const again = await b.cfg.importConfig(doc);
  assert.equal(again.repos.length + again.targets.length + again.templates.length, 0); assert.equal(again.skipped.length, 4);
  await assert.rejects(b.cfg.importConfig({ hello: 1 }), /not an Ascension configuration/);
});
