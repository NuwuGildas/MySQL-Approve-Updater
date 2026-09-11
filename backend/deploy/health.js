'use strict';
/* Post-activation health check: poll a URL (locally via fetch, or on the
   target via curl over SSH) until the status is in range or time runs out. */

const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('cancelled')); }, { once: true });
});

/**
 * @param {string} url
 * @param {{expectStatus:[number,number], timeoutSec:number, intervalSec:number, signal?:AbortSignal, onLine?:fn, remote?:{conn}}} o
 */
async function verify(url, o = {}) {
  const [min, max] = o.expectStatus || [200, 399];
  const deadline = Date.now() + (o.timeoutSec || 60) * 1000;
  const interval = (o.intervalSec || 3) * 1000;
  let attempt = 0, last = null;
  while (Date.now() < deadline) {
    if (o.signal?.aborted) throw new Error('cancelled');
    attempt++;
    try {
      let status;
      if (o.remote?.conn) {
        const { q } = require('./shell');
        const out = await o.remote.conn.capture(`curl -sS -o /dev/null -w '%{http_code}' --max-time 15 -L ${q(url)}`, { timeoutMs: 30000 });
        status = Number(out.trim().slice(-3));
      } else {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 15000);
        try {
          const res = await fetch(url, { redirect: 'manual', signal: ac.signal, headers: { 'user-agent': 'server-tools-deploy/1.0' } });
          status = res.status;
        } finally { clearTimeout(t); }
      }
      last = `HTTP ${status}`;
      if (status >= min && status <= max) { if (o.onLine) o.onLine(`health check passed: ${last} (attempt ${attempt})`); return { ok: true, status, attempts: attempt }; }
      if (o.onLine) o.onLine(`health check attempt ${attempt}: ${last}, expected ${min}-${max}`);
    } catch (e) {
      last = e.message;
      if (o.onLine) o.onLine(`health check attempt ${attempt}: ${last}`);
    }
    await sleep(interval, o.signal);
  }
  const err = new Error(`health check failed after ${attempt} attempt(s): ${last}`);
  err.attempts = attempt;
  throw err;
}

module.exports = { verify };
