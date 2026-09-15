'use strict';
/* Managing a server, as opposed to working on one: renaming it, moving it, changing how we
 * authenticate to it, and removing it.
 *
 * The credentials never leave the host, so an edit form cannot show the password or the key and
 * cannot send them back. A blank field therefore has to mean "leave it alone" - saving a name
 * change must not quietly strip the key the server is reached with, which is what happens if the
 * blank is taken literally.
 *
 * Run: node checks/workspace/server-manage.js
 */

const { startSandbox } = require('./sandbox');
const { launch, openApp, recorder, shot, until, sleep } = require('./browser');
const { installPageHelpers } = require('./page-helpers');

const PORT = Number(process.env.PORT || 3125);
const api = (s, path, init) => fetch(s.base + '/api/m/servers/http' + path, init).then((r) => r.json());

async function main() {
  const s = await startSandbox({ port: PORT, servers: 2 });
  const browser = await launch();
  const r = recorder('server-manage');
  let page;
  try {
    page = await openApp(browser, s.base);
    await page.evaluate(installPageHelpers);
    await page.evaluate(() => { location.hash = '#/servers'; });
    await until(page, () => document.querySelectorAll('#serversList .srv-card').length >= 2, null, 25000);
    await sleep(800);

    /* ---- the actions are on the card ---- */
    const actions = await page.evaluate(() => {
      const card = srvCard('Fixture 1');
      return [...card.querySelectorAll('.srv-actions [data-act]')].map((b) => b.dataset.act);
    });
    r.ok('card', 'a server can be edited from its card', actions.includes('edit'), actions.join(', '));
    r.ok('card', 'and removed from it', actions.includes('remove'), actions.join(', '));

    /* ---- edit: rename, move, and keep the credential ---- */
    const before = (await api(s, '/sessions')).sessions.find((x) => x.name === 'Fixture 1');
    r.ok('edit', 'the list says how the server authenticates, without the secret',
      !!before.authKind && !JSON.stringify(before).includes('password":"'), JSON.stringify({ authKind: before.authKind, passwordSet: before.passwordSet, keySet: before.keySet }));

    await page.evaluate(() => srvCard('Fixture 1').querySelector('[data-act="edit"]').click());
    await until(page, () => !document.getElementById('addServerForm').hidden, null, 10000);
    const form = await page.evaluate(() => ({
      title: document.getElementById('serverFormHeading').textContent,
      submit: document.getElementById('btnAsSubmit').textContent,
      note: !document.getElementById('asFormNote').hidden,
      name: document.getElementById('asName').value,
      host: document.getElementById('asHost').value,
      port: document.getElementById('asPort').value,
      user: document.getElementById('asUser').value,
      auth: document.querySelector('#asAuthChoice [data-auth].on')?.dataset.auth,
      bootstrapHidden: document.getElementById('asBootstrapClaude').closest('label').hidden,
    }));
    r.ok('edit', 'the form opens filled in with the server', form.name === 'Fixture 1' && form.host === '127.0.0.1' && !!form.user, JSON.stringify(form));
    r.ok('edit', 'and says it is editing, not adding', /Edit Fixture 1/.test(form.title) && /Save changes/.test(form.submit), `${form.title} / ${form.submit}`);
    r.ok('edit', 'and says a blank credential is kept', form.note);
    r.ok('edit', 'it opens on the authentication the server actually uses', form.auth === before.authKind, `${form.auth} vs ${before.authKind}`);
    r.ok('edit', 'installing an agent is not part of editing one', form.bootstrapHidden);
    await shot(page, 'sm-edit-form');

    // change the name and the port, touch no credential
    await page.evaluate(() => {
      document.getElementById('asName').value = 'Fixture One (renamed)';
      document.getElementById('asPort').value = '2222';
      document.getElementById('addServerForm').requestSubmit();
    });
    await until(page, () => !!srvCard('Fixture One (renamed)'), null, 20000);
    const after = (await api(s, '/sessions')).sessions.find((x) => x.name === 'Fixture One (renamed)');
    r.ok('edit', 'the change is saved', !!after && after.port === 2222, JSON.stringify({ name: after?.name, port: after?.port }));
    r.ok('edit', 'and the credential it is reached with survives a rename',
      after.authKind === before.authKind && after.keySet === before.keySet && after.passwordSet === before.passwordSet,
      JSON.stringify({ was: { authKind: before.authKind, keySet: before.keySet }, now: { authKind: after.authKind, keySet: after.keySet } }));
    r.ok('edit', 'and it is the same server, not a second one', after.id === before.id && (await api(s, '/sessions')).sessions.length === 2);
    r.ok('edit', 'the form closes when it is done', await page.evaluate(() => document.getElementById('addServerForm').hidden));

    /* ---- and adding still adds ---- */
    await page.evaluate(() => document.getElementById('btnAddServer').click());
    const addForm = await page.evaluate(() => ({
      title: document.getElementById('serverFormHeading').textContent,
      name: document.getElementById('asName').value,
      note: !document.getElementById('asFormNote').hidden,
      bootstrapHidden: document.getElementById('asBootstrapClaude').closest('label').hidden,
    }));
    r.ok('add', 'the form goes back to adding, empty', /^Add server$/.test(addForm.title) && addForm.name === '' && !addForm.note, JSON.stringify(addForm));
    r.ok('add', 'and offers to install an agent again', !addForm.bootstrapHidden);
    await page.evaluate(() => document.getElementById('btnAddServerCancel').click());

    /* ---- remove ---- */
    await page.evaluate(() => srvCard('Fixture 2').querySelector('[data-act="remove"]').click());
    const dialog = await until(page, () => /Remove/.test(document.querySelector('dialog[open] h3, dialog[open] h2')?.textContent || ''), null, 10000);
    const warning = await page.evaluate(() => document.querySelector('dialog[open]')?.innerText.replace(/\s+/g, ' ') || '');
    r.ok('remove', 'it asks first, naming the server', dialog && /Fixture 2/.test(warning), warning.slice(0, 120));
    r.ok('remove', 'and says the server itself is not touched', /Nothing on the server itself is changed/.test(warning));
    await page.evaluate(() => [...document.querySelectorAll('dialog[open] button')].find((b) => /^Remove$/.test(b.textContent.trim()))?.click());
    await until(page, () => !srvCard('Fixture 2'), null, 20000);
    const left = (await api(s, '/sessions')).sessions;
    r.ok('remove', 'the server is gone', left.length === 1 && !left.some((x) => x.name === 'Fixture 2'), left.map((x) => x.name).join(', '));
    await shot(page, 'sm-after-remove');

    r.ok('errors', 'no page errors were raised during the run', page.__errors.length === 0, page.__errors.slice(0, 3).join(' | '));
  } catch (e) {
    r.ok('run', 'the check completed', false, (e && e.stack) || String(e));
  } finally {
    if (page) { try { await shot(page, 'sm-final'); } catch {} }
    await browser.close().catch(() => {});
    await s.stop().catch(() => {});
  }
  process.exit(r.report() ? 0 : 1);
}

main();
