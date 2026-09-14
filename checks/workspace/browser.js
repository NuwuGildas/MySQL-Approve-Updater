'use strict';
/* Shared puppeteer plumbing for the workspace checks: a headless Chrome, a tiny assertion
   recorder that keeps going after a failure (one run should report every problem, not the first),
   and the page helpers the two check scripts both need. */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SHOTS = path.join(__dirname, 'shots');

function recorder(name) {
  const results = [];
  return {
    results,
    ok(point, label, pass, detail = '') {
      results.push({ point, label, pass: !!pass, detail });
      console.log(`${pass ? 'PASS' : 'FAIL'}  [${point}] ${label}${detail ? ' — ' + detail : ''}`);
    },
    report() {
      const bad = results.filter((r) => !r.pass);
      console.log(`\n${name}: ${results.length - bad.length}/${results.length} checks passed`);
      return bad.length === 0;
    },
  };
}

async function launch() {
  fs.mkdirSync(SHOTS, { recursive: true });
  return puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1440,1000'],
    defaultViewport: { width: 1440, height: 1000 },
  });
}

const shot = async (page, name) => { const p = path.join(SHOTS, name + '.png'); await page.screenshot({ path: p }); return p; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll a page predicate; returns true on success rather than throwing, so a check can record it.
 *
 * A predicate that throws on every poll - a helper that no longer exists, say - used to be
 * indistinguishable from a condition that simply never came true: both returned false after the
 * timeout, and the check then failed somewhere else entirely. The last error is reported when the
 * wait runs out, so a broken predicate says so.
 */
async function until(page, fn, arg, timeout = 15000) {
  const end = Date.now() + timeout;
  let lastError = null;
  for (;;) {
    try { if (await page.evaluate(fn, arg)) return true; lastError = null; }
    catch (error) { lastError = error; }
    if (Date.now() > end) {
      if (lastError) console.log(`  (wait gave up after ${timeout}ms; the predicate kept throwing: ${lastError.message})`);
      return false;
    }
    await sleep(120);
  }
}

/**
 * Poll a predicate HERE, in the check process, not in the page. For things only this side knows -
 * requests seen, files written - where until() would evaluate the body in the browser and find
 * nothing it refers to.
 */
async function untilLocal(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > end) return false;
    await sleep(120);
  }
}

/* The base application is loaded first and the modules only after it is running, so "ready" means
   the router exists AND the Terminals workspace a module contributes has been mounted. */
const APP_READY = () => typeof navigate === 'function' && !!document.getElementById('wsSplit');

/** Open the app and wait for its scripts to have wired themselves up. */
async function openApp(browser, base) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  // a missing static asset is not a scripting fault; the checks are about the app's own behaviour
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('requestfailed', () => {});
  page.on('response', (res) => { if (res.status() === 404) (page.__missing ||= []).push(res.url()); });
  // a fresh profile auto-starts the guided tour, which navigates routes and binds the arrow keys:
  // mark it seen before any script runs, or it hijacks the checks
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('mau-tour-seen', '1'); } catch {} });
  await page.goto(base + '/#/servers', { waitUntil: 'domcontentloaded' });
  // Loudly: everything after this assumes the app is up, and a check that carries on without it
  // fails ten steps later on something unrelated.
  if (!await until(page, APP_READY, null, 30000)) {
    throw new Error('the application did not finish starting: ' + (errors.slice(0, 3).join(' | ') || 'no page errors were raised'));
  }
  page.__errors = errors;
  return page;
}

module.exports = { launch, openApp, recorder, shot, until, untilLocal, sleep, APP_READY, SHOTS };
