// Main-thread handle to an engine worker. search() returns a promise for the
// final results and streams progress; starting a new search cancels the old one.
import { BLACK } from './board.js';

export class Engine {
  constructor(name) {
    this.name = name;
    this.nextId = 1;
    this.pending = null;
    this.start();
  }

  // A worker that breaks is ended and marked failed, and the next search
  // starts a new one: one new worker per search asked for, so a worker that
  // can never start isn't rebuilt in a loop. Messages and errors from a
  // replaced worker are ignored.
  start() {
    const worker = this.worker = new Worker(new URL('./engine-worker.js', import.meta.url), { type: 'module' });
    this.failed = false;
    const mine = () => this.worker === worker && !this.failed;
    worker.onmessage = e => { if (mine()) this.onMessage(e.data); };
    worker.onerror = e => {
      if (!mine()) return;
      console.error(`${this.name} worker error`, e.message);
      this.failed = true;
      try { worker.terminate(); } catch { /* already gone */ }
      // Fail the running search instead of leaving the caller waiting forever.
      const job = this.pending;
      this.pending = null;
      if (job) job.resolve(null);
      if (Engine.onError) Engine.onError(this.name, e.message || 'failed to load');
    };
  }

  search(position, { playouts = 10000, maxTime = 60000, onProgress = null, reportMs = 250 } = {}) {
    this.cancel();
    if (this.failed) this.start();
    const id = this.nextId++;
    return new Promise(resolve => {
      this.pending = { id, resolve, onProgress };
      this.worker.postMessage({ type: 'search', id, position, playouts, maxTime, reportMs });
    });
  }

  cancel() {
    if (!this.pending) return;
    this.worker.postMessage({ type: 'stop' });
    this.pending.resolve(null);
    this.pending = null;
  }

  get busy() { return !!this.pending; }

  onMessage(msg) {
    const job = this.pending;
    if (!job || msg.id !== job.id) return;
    if (msg.type === 'progress') { if (job.onProgress) job.onProgress(msg.results); return; }
    if (msg.type === 'done') { this.pending = null; settle(job, msg.results); }
  }
}

// Ends a job: its last progress call, then its promise. Settled even when the
// callback throws (a UI bug), or the caller would wait forever; the bug is
// logged, as it would be uncaught.
function settle(job, results) {
  try { if (job.onProgress && results) job.onProgress(results, true); }
  catch (err) { console.error('search progress callback failed', err); }
  job.resolve(results);
}

// Combines root results from independent searches of the same position
// (root parallelism): visits add up, rates are visit-weighted.
export function mergeResults(list) {
  if (list.length === 1) return list[0];
  const playouts = list.reduce((s, r) => s + r.playouts, 0) || 1;
  const wt = r => r.playouts / playouts;
  const blackWinrate = list.reduce((s, r) => s + wt(r) * r.blackWinrate, 0);
  const score = list.reduce((s, r) => s + wt(r) * r.score, 0);
  const ownership = list[0].ownership.map((_, i) => list.reduce((s, r) => s + wt(r) * r.ownership[i], 0));
  const byMove = new Map();
  for (const r of list) {
    for (const m of r.allMoves || r.moves) {
      let e = byMove.get(m.move);
      if (!e) byMove.set(m.move, e = { move: m.move, visits: 0, wsum: 0, ssum: 0, prior: m.prior, pv: m.pv, pvVisits: -1, twins: m.twins });
      e.visits += m.visits;
      e.wsum += m.winrate * m.visits;
      e.ssum += m.score * m.visits;
      if (m.visits > e.pvVisits) { e.pv = m.pv; e.pvVisits = m.visits; }
    }
  }
  const all = [...byMove.values()]
    .map(e => ({ move: e.move, visits: e.visits, winrate: e.wsum / e.visits, score: e.ssum / e.visits, prior: e.prior, pv: e.pv, ...(e.twins && { twins: e.twins }) }))
    .sort((a, b) => b.visits - a.visits);
  const toPlay = list[0].toPlay;
  return {
    toPlay, playouts, blackWinrate, score, ownership,
    winrate: toPlay === BLACK ? blackWinrate : 1 - blackWinrate,
    moves: all.slice(0, 40), allMoves: all,
  };
}

// Several workers searching the same position; same interface as Engine.
// The engines can also be given separate jobs directly (pool.engines[i]).
export class EnginePool {
  constructor(name, size) {
    this.engines = Array.from({ length: size }, (_, i) => new Engine(`${name}${i}`));
    this.pending = null;
    this.nextId = 1;
  }

  search(position, { playouts = 10000, maxTime = 60000, onProgress = null, reportMs = 250 } = {}) {
    this.cancel();
    const id = this.nextId++, n = this.engines.length;
    const latest = new Array(n).fill(null);
    return new Promise(resolve => {
      this.pending = { id, resolve };
      const live = () => this.pending && this.pending.id === id;
      const runs = this.engines.map((engine, i) => engine.search(position, {
        playouts: Math.ceil(playouts / n), maxTime, reportMs,
        onProgress: (res, fin) => {
          if (!live() || fin) return;
          latest[i] = res;
          if (onProgress) onProgress(mergeResults(latest.filter(Boolean)), false);
        },
      }));
      // Settle once every engine has finished, failed or been cancelled: a
      // worker that dies must not leave the pool waiting forever.
      Promise.all(runs).then(results => {
        if (!live()) return;
        this.pending = null;
        const ok = results.filter(Boolean);
        settle({ resolve, onProgress }, ok.length ? mergeResults(ok) : null);
      });
    });
  }

  // Stops the pooled search and any separate jobs on the engines.
  cancel() {
    const p = this.pending;
    this.pending = null;
    for (const e of this.engines) e.cancel();
    if (p) p.resolve(null);
  }

  get busy() { return !!this.pending; }
}

// ------------------------------------------------------------------ KataGo

// Built-in playouts per KataGo visit when a caller asks for a read "worth" so
// many playouts: 48k (the coach's Normal depth) becomes 400 visits. At that
// ratio the net's reads grade at least as well as the built-in ones (see
// tools/coach-audit.js).
export const PLAYOUTS_PER_VISIT = 120;
// Below this many evaluations per second a device can't give the coach a
// Quick read (133 visits) in about 5 seconds, so the built-in engine is used.
export const MIN_RATE = 25;
// At this speed or better a read gets its full visits; slower devices get
// proportionally fewer.
export const FULL_RATE = 150;

// The one worker that runs the network for every KataGo engine.
export class KataWorker {
  // startupMs: how long loading may take (a stalled download or GPU set-up) before giving up.
  // stallMs: how long the network may stay silent with a search waiting (a lost GPU
  // context can leave a run that never ends) before KataGo counts as failed. The
  // worker's heartbeat keeps searches that report nothing from looking silent,
  // so in normal play the longest silence is one network run.
  constructor({ startupMs = 60000, stallMs = 30000 } = {}) {
    this.worker = new Worker(new URL('./katago-worker.js', import.meta.url), { type: 'module' });
    this.engines = new Map();
    this.info = null;
    this.dead = false;       // failed: searches end at once
    this.onFail = null;      // called when KataGo stops working after it had started
    this.startupMs = startupMs;
    this.stallMs = stallMs;
    // When the worker last said anything (it sends a heartbeat while searching,
    // even for reads that report no progress), or last got work while idle.
    this.heard = 0;
    this.ready = new Promise(resolve => { this.resolveReady = resolve; });
    this.worker.onmessage = e => {
      const msg = e.data;
      if (this.dead) return;   // a late message from a worker we've given up on
      this.heard = performance.now();
      if (msg.type === 'ready') {
        clearTimeout(this.timer);
        this.info = { ok: true, backend: msg.backend, rate: msg.rate, batch: msg.batch };
        this.watchdog = setInterval(() => {
          if (this.busy && performance.now() - this.heard > this.stallMs) this.fail('KataGo stopped responding');
        }, this.stallMs / 4);
        if (this.watchdog.unref) this.watchdog.unref(); // node (tests): don't hold the process open
        this.resolveReady(this.info);
        return;
      }
      if (msg.type === 'failed' || msg.type === 'fatal') { this.fail(msg.message); return; }
      if (msg.type === 'alive') return;   // the heartbeat: heard, nothing more
      if (msg.type === 'error') { console.warn('KataGo worker:', msg.message); return; }
      const eng = this.engines.get(msg.engine);
      if (eng) eng.onMessage(msg);
    };
    this.worker.onerror = e => this.fail(e.message || 'failed to load');
  }

  load(backend) {
    if (!this.timer && !this.info) this.timer = setTimeout(() => this.fail('KataGo took too long to start'), this.startupMs);
    this.worker.postMessage({ type: 'load', backend });
    return this.ready;
  }

  // KataGo can't be used any more (it failed to load, timed out, crashed, or its
  // network stopped working): end every search and stop the worker.
  fail(message) {
    if (this.dead) return;
    const started = !!(this.info && this.info.ok);
    this.dead = true;
    clearTimeout(this.timer);
    clearInterval(this.watchdog);
    this.info = { ok: false, message };
    this.resolveReady(this.info);
    try { this.worker.terminate(); } catch { /* already gone */ }
    for (const eng of this.engines.values()) eng.fail();
    // A failed start is reported by load(); only a failure in play needs its own call.
    if (started && this.onFail) this.onFail(message);
  }

  post(msg) { if (!this.dead) this.worker.postMessage(msg); }

  // Whether any engine has a search waiting (the watchdog only minds silence then).
  get busy() { return [...this.engines.values()].some(e => e.busy); }

  // Visits for a read worth `playouts` built-in playouts on this device.
  visits(playouts) {
    const speed = this.info && this.info.ok ? Math.min(1, this.info.rate / FULL_RATE) : 1;
    return Math.max(8, Math.round(playouts / PLAYOUTS_PER_VISIT * speed));
  }
}

// A KataGo search handle with the same interface as Engine. `playouts` asks
// for a read worth that many built-in playouts (see KataWorker.visits); pass
// `visits` to set the count directly. Results have playouts = visits.
export class KataEngine {
  // priority: searches with a higher one go first (the AI's move over coach reads).
  constructor(name, host, { priority = 0 } = {}) {
    this.name = name;
    this.host = host;
    this.priority = priority;
    this.nextId = 1;
    this.pending = null;
    host.engines.set(name, this);
  }

  // batch: most leaves per round for this search (0: whatever the network batch holds).
  search(position, { playouts = 10000, visits = 0, batch = 0, maxTime = 60000, onProgress = null, reportMs = 250 } = {}) {
    this.cancel();
    if (this.host.dead) return Promise.resolve(null);
    const id = this.nextId++;
    // Work for an idle worker starts the silence clock afresh (checked before
    // this search counts as waiting, or the worker never looks idle).
    if (!this.host.busy) this.host.heard = performance.now();
    return new Promise(resolve => {
      this.pending = { id, resolve, onProgress };
      this.host.post({ type: 'search', engine: this.name, id, position, playouts: visits || this.host.visits(playouts), batch, maxTime, reportMs, priority: this.priority });
    });
  }

  cancel() {
    if (!this.pending) return;
    this.host.post({ type: 'stop', engine: this.name });
    this.pending.resolve(null);
    this.pending = null;
  }

  fail() { const job = this.pending; this.pending = null; if (job) job.resolve(null); }

  get busy() { return !!this.pending; }

  onMessage(msg) {
    const job = this.pending;
    if (!job || msg.id !== job.id) return;
    if (msg.type === 'progress') { if (job.onProgress) job.onProgress(msg.results); return; }
    if (msg.type === 'done') { this.pending = null; settle(job, msg.results); }
  }
}

// Same interface as EnginePool. The network already shares one worker, so a
// pooled search is a single deeper search rather than several merged ones.
export class KataPool {
  constructor(name, size, host) {
    this.engines = Array.from({ length: size }, (_, i) => new KataEngine(`${name}${i}`, host));
  }
  search(position, opts) { this.cancel(); return this.engines[0].search(position, opts); }
  cancel() { for (const e of this.engines) e.cancel(); }
  get busy() { return this.engines.some(e => e.busy); }
}

// How much reading went into results, in built-in playouts, so thresholds
// such as "at least 1500 playouts" mean the same for both engines.
export const effort = r => r ? (r.engine === 'katago' ? r.playouts * PLAYOUTS_PER_VISIT : r.playouts) : 0;
