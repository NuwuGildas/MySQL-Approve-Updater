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

/** Poll a page predicate; returns true on success rather than throwing, so a check can record it. */
async function until(page, fn, arg, timeout = 15000) {
  const end = Date.now() + timeout;
  for (;;) {
    try { if (await page.evaluate(fn, arg)) return true; } catch {}
    if (Date.now() > end) return false;
    await sleep(120);
  }
}

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
  await until(page, () => typeof window.openSsh === 'function' && !!document.getElementById('wsSplit'));
  page.__errors = errors;
  return page;
}

module.exports = { launch, openApp, recorder, shot, until, sleep, SHOTS };
