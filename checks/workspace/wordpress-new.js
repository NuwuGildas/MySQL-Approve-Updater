'use strict';
/* Starting a WordPress project with no repository, through the wizard that offers it.
   The one wizard step that writes to the disk before Finish, so it is worth watching a browser do
   it: pick the source, name a folder, press the button, and check that a project appears, is
   connected as a repository, and arrives at the framework step already recognised.
   Run: node checks/workspace/wordpress-new.js */
const fs = require('fs'); const os = require('os'); const path = require('path');
const { startSandbox } = require('./sandbox');
const { launch, openApp, shot, until, sleep } = require('./browser');

(async () => {
  const s = await startSandbox({ port: Number(process.env.PORT || 3119), servers: 0 });
  const browser = await launch();
  let page, bad = 0;
  const say = (ok, m, d = '') => { if (!ok) bad++; console.log((ok ? 'PASS ' : 'FAIL ') + m + (d ? ' — ' + d : '')); };
  const dir = path.join(os.tmpdir(), 'st-wz-' + Date.now().toString(36), 'acme-site');
  try {
    page = await openApp(browser, s.base);
    await page.evaluate(() => { location.hash = '#/deployments'; });
    await until(page, () => !!document.getElementById('btnDpNew'), null, 25000);
    await sleep(800);
    await page.evaluate(() => document.getElementById('btnDpNew').click());
    await until(page, () => document.getElementById('dpWizard')?.open, null, 10000);

    const hasOption = await page.evaluate(() => !!document.querySelector('#wzSourceKind [data-v="new-wp"]'));
    say(hasOption, 'the wizard offers "New WordPress project"');

    await page.evaluate(() => document.querySelector('#wzSourceKind [data-v="new-wp"]').click());
    await sleep(300);
    const shown = await page.evaluate(() => ({
      panel: !!document.querySelector('[data-wz="new-wp"]') && !document.querySelector('[data-wz="new-wp"]').hidden,
      git: document.querySelector('[data-wz="git"]').hidden,
      btn: !!document.getElementById('btnWzNewWp'),
    }));
    say(shown.panel && shown.git && shown.btn, 'picking it shows its own panel and hides the git one', JSON.stringify(shown));

    // Next must refuse before anything is created
    await page.evaluate(() => document.getElementById('btnWzNext')?.click());
    await sleep(400);
    const stillOne = await page.evaluate(() => !!document.querySelector('.wz-step[data-step="1"].on'));
    say(stillOne, 'Next refuses until the project exists');

    await page.evaluate((d) => { document.getElementById('wzNewDir').value = d; document.getElementById('wzRepoName').value = 'Acme Studio'; }, dir);
    await page.evaluate(() => document.getElementById('btnWzNewWp').click());
    const created = await until(page, () => /Created/.test(document.getElementById('wzNewWpHint').textContent), null, 25000);
    say(created, 'the project is written', await page.evaluate(() => document.getElementById('wzNewWpHint').textContent));
    say(fs.existsSync(path.join(dir, 'ship.json')), 'ship.json is on disk');
    say(fs.existsSync(path.join(dir, 'wp-content', 'themes', 'acme-studio-theme', 'style.css')), 'the theme is on disk');
    await shot(page, 'wz-new-wordpress');

    const repos = await (await fetch(s.base + '/api/m/deployments/http/deploy/repos')).json();
    say(repos.repos.length === 1 && repos.repos[0].source.path === path.resolve(dir), 'it is connected as a repository', JSON.stringify(repos.repos.map((r) => r.name)));

    // step 2 should arrive already detected as WordPress
    await page.evaluate(() => document.getElementById('btnWzNext').click());
    const onTwo = await until(page, () => !!document.querySelector('.wz-step[data-step="2"].on'), null, 15000);
    say(onTwo, 'Next moves on now that it exists');
    const fw = await until(page, () => /wordpress/i.test(document.getElementById('fwDetectHint').textContent), null, 25000);
    const detail = await page.evaluate(() => ({ hint: document.getElementById('fwDetectHint').textContent, wpPanel: !document.getElementById('fwWp').hidden, version: document.getElementById('fwWpVersion').value, vault: document.getElementById('fwWpVault').value }));
    say(fw && detail.wpPanel && detail.vault === 'WP_DB_ACME_STUDIO', 'it arrives detected as WordPress, with the secret it needs already named', JSON.stringify(detail));
    await shot(page, 'wz-new-wordpress-step2');

    say(page.__errors.length === 0, 'no page errors', page.__errors.slice(0, 2).join(' | '));
  } catch (e) {
    say(false, 'the check completed', (e && e.stack) || String(e));
  } finally {
    if (page) { try { await shot(page, 'wz-new-final'); } catch {} }
    await browser.close().catch(() => {});
    await s.stop().catch(() => {});
  }
  console.log(bad ? `\n${bad} failure(s)` : '\nall good');
  process.exit(bad ? 1 : 0);
})();
