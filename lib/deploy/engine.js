'use strict';
/* Run engine: creates Run objects, enforces per-target locking and
   concurrency, persists the run index and per-run NDJSON logs, fans events
   out (SSE for the UI, stdout for the CLI). The stages themselves live in
   pipeline.js. */

const EventEmitter = require('events');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { runPipeline } = require('./pipeline');
const plandiff = require('./plandiff');

const MAX_INDEX = 200;
const MAX_CONCURRENT = 2;
const STATUS = ['queued', 'running', 'succeeded', 'failed', 'rolled_back', 'rollback_failed', 'cancelled'];

class Run extends EventEmitter {
  constructor(o) {
    super();
    this.id = o.id; this.targetId = o.targetId; this.repoId = o.repoId; this.mode = o.mode; this.trigger = o.trigger;
    this.status = 'queued'; this.stage = null; this.startedAt = new Date().toISOString(); this.endedAt = null; this.ms = null;
    this.ref = o.ref || null; this.commit = null; this.shortCommit = null; this.branch = null; this.release = null; this.previousRelease = null;
    this.buildMode = o.buildMode || null; this.stages = []; this.plan = null; this.warnings = []; this.error = null; this.logLines = 0;
    this.targetName = o.targetName; this.repoName = o.repoName; this.rollbackTo = o.rollbackTo || null; this.planHash = o.planHash || null; this.ai = !!o.ai; this.force = !!o.force;
    this.abort = new AbortController();
    this._tail = [];
  }
  get signal() { return this.abort.signal; }
  toJSON() {
    const { abort, _tail, _events, _eventsCount, _maxListeners, ...rest } = this;
    return rest;
  }
  /** log a line; stream: out|err|sys */
  log(line, stream = 'sys', stage = this.stage) {
    const entry = { n: ++this.logLines, t: new Date().toISOString(), stage, stream, line: String(line) };
    this._tail.push(entry); if (this._tail.length > 400) this._tail.shift();
    this.emit('log', entry);
    return entry;
  }
  warn(msg) { this.warnings.push({ stage: this.stage, msg }); this.log(`WARN ${msg}`, 'err'); }
  setStage(name) {
    const now = Date.now();
    const prev = this.stages[this.stages.length - 1];
    if (prev && prev.status === 'running') { prev.status = 'ok'; prev.ms = now - prev._t; delete prev._t; }
    this.stage = name;
    if (name) { this.stages.push({ name, status: 'running', _t: now }); this.log(`── ${name} ──`, 'sys'); }
    this.emit('stage', name);
    this.emit('status', this);
  }
  finishStage(status, ms) {
    const prev = this.stages[this.stages.length - 1];
    if (prev && prev.status === 'running') { prev.status = status; prev.ms = ms ?? Date.now() - prev._t; delete prev._t; }
  }
  setStatus(status, error) {
    if (!STATUS.includes(status)) throw new Error(`bad status ${status}`);
    this.status = status;
    if (error) this.error = typeof error === 'string' ? error : (error.message || String(error));
    if (!['queued', 'running'].includes(status)) { this.endedAt = new Date().toISOString(); this.ms = Date.parse(this.endedAt) - Date.parse(this.startedAt); this.finishStage(status === 'succeeded' ? 'ok' : 'failed'); }
    this.emit('status', this);
  }
  tail(n = 200) { return this._tail.slice(-n); }
  cancel() { if (['queued', 'running'].includes(this.status)) { this.log('cancel requested', 'sys'); this.abort.abort(); return true; } return false; }
}

function createEngine(ctx, deps) {
  const { stores, vault, redact } = deps;
  const runs = new Map();          // id → Run (live + recently finished)
  const targetLocks = new Map();   // targetId → runId
  const listeners = new Set();     // fan-out: fn(type, payload)
  fs.mkdirSync(stores.runsDir, { recursive: true });

  const emit = (type, payload) => { for (const l of listeners) { try { l(type, payload); } catch {} } };

  function persistIndex(run) {
    const idx = stores.runs.get();
    const j = { ...run.toJSON() };
    delete j.plan; // plans are large; kept in the live run and re-derivable
    if (run.plan) j.planSummary = plandiff.summarizePlan(run.plan); // small: enough to diff the next plan against
    j.warningsCount = run.warnings.length;
    const i = idx.runs.findIndex((r) => r.id === run.id);
    if (i >= 0) idx.runs[i] = j; else idx.runs.unshift(j);
    if (idx.runs.length > MAX_INDEX) idx.runs.length = MAX_INDEX;
    stores.runs.save();
  }

  function attachRun(run) {
    const logFile = path.join(stores.runsDir, `${run.id}.log`);
    const ws = fs.createWriteStream(logFile, { flags: 'a' });
    let batch = [], timer = null;
    const flush = () => { if (batch.length) { emit('log', { runId: run.id, lines: batch }); batch = []; } timer = null; };
    run.on('log', (e) => {
      e.line = redact(e.line);
      ws.write(JSON.stringify(e) + '\n');
      batch.push(e); if (batch.length >= 200) flush(); else if (!timer) timer = setTimeout(flush, 100);
    });
    run.on('status', () => { emit('run', run.toJSON()); });
    run.on('plan', (plan) => emit('plan', { runId: run.id, plan }));
    run.once('done', () => { flush(); ws.end(); persistIndex(run); emit('runs', { active: activeIds() }); });
    runs.set(run.id, run);
    // keep memory bounded: drop finished runs beyond 50
    if (runs.size > 50) for (const [id, r] of runs) { if (runs.size <= 50) break; if (!['queued', 'running'].includes(r.status)) runs.delete(id); }
  }

  const activeIds = () => [...runs.values()].filter((r) => ['queued', 'running'].includes(r.status)).map((r) => r.id);

  /**
   * Start a run. mode: plan | ship | rollback. Returns the Run synchronously (status queued).
   */
  function start(o) {
    const target = stores.findTarget(o.targetId);
    if (!target) { const e = new Error('target not found'); e.status = 404; throw e; }
    const repo = stores.findRepo(target.repoId);
    if (!repo && o.mode !== 'rollback') { const e = new Error('the target has no repo attached'); e.status = 400; throw e; }
    const mode = ['plan', 'ship', 'rollback'].includes(o.mode) ? o.mode : 'plan';
    if (mode !== 'plan' && o.confirm !== true) { const e = new Error(`${mode} requires confirm:true`); e.status = 400; throw e; }
    if (mode !== 'plan' && targetLocks.has(target.id)) { const e = new Error(`target "${target.name}" already has a run in progress (${targetLocks.get(target.id)})`); e.status = 409; throw e; }
    if (activeIds().length >= MAX_CONCURRENT) { const e = new Error(`at most ${MAX_CONCURRENT} deploys can run at once`); e.status = 429; throw e; }
    const id = `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14).replace(/(\d{8})(\d{6})/, '$1-$2')}-${crypto.randomBytes(2).toString('hex')}`;
    const run = new Run({ id, targetId: target.id, repoId: repo?.id || null, mode, trigger: o.trigger || 'ui', ref: o.ref, buildMode: o.buildMode, targetName: target.name, repoName: repo?.name || null, rollbackTo: o.release, planHash: o.planHash, ai: o.ai, force: o.force });
    attachRun(run);
    if (mode !== 'plan') targetLocks.set(target.id, run.id);
    persistIndex(run);
    emit('runs', { active: activeIds() });
    ctx.logEvent('info', `deploy ${mode} started: ${target.name} (${run.id})`);
    // the last successful ship of this target is the baseline for the plan's change summary
    const previousShip = mode === 'rollback' ? null : list({ targetId: target.id, limit: 200 }).find((r) => r.mode === 'ship' && r.status === 'succeeded' && r.id !== run.id) || null;
    // execute asynchronously
    setImmediate(async () => {
      try { await runPipeline({ ctx, run, target, repo, stores, vault, redact, previousShip }); }
      catch (e) { if (['queued', 'running'].includes(run.status)) run.setStatus('failed', e); }
      finally {
        if (targetLocks.get(target.id) === run.id) targetLocks.delete(target.id);
        run.emit('done');
        const summary = `deploy ${mode} ${run.status}: ${target.name} (${run.id})${run.error ? `${redact(run.error)}` : ''}`;
        ctx.logEvent(run.status === 'succeeded' ? 'info' : 'warn', summary);
      }
    });
    return run;
  }

  function get(id) { return runs.get(id) || null; }
  function list({ targetId, limit = 50 } = {}) {
    const idx = stores.runs.get().runs;
    const live = new Map([...runs.values()].map((r) => [r.id, r.toJSON()]));
    const merged = idx.map((r) => live.get(r.id) ? { ...live.get(r.id), plan: undefined, planSummary: r.planSummary } : r); // the index carries the compact plan summary
    for (const [id, r] of live) if (!idx.some((x) => x.id === id)) merged.unshift({ ...r, plan: undefined });
    return merged.filter((r) => !targetId || r.targetId === targetId).slice(0, limit);
  }
  async function readLog(id, since = 0) {
    const live = runs.get(id);
    if (live && since >= (live._tail[0]?.n || 1) - 1) return { lines: live._tail.filter((e) => e.n > since), next: live.logLines, live: ['queued', 'running'].includes(live.status) };
    try {
      const txt = await fsp.readFile(path.join(stores.runsDir, `${id}.log`), 'utf8');
      const lines = txt.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e && e.n > since);
      return { lines, next: lines.length ? lines[lines.length - 1].n : since, live: !!(live && ['queued', 'running'].includes(live.status)) };
    } catch { return { lines: [], next: since, live: false }; }
  }
  function cancel(id) { const r = runs.get(id); return r ? r.cancel() : false; }
  function onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function isLocked(targetId) { return targetLocks.get(targetId) || null; }

  return { start, get, list, readLog, cancel, onEvent, activeIds, isLocked, Run };
}

module.exports = { createEngine, Run, STATUS };
