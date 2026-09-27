// Main-thread handle to an engine worker. search() returns a promise for the
// final results and streams progress; starting a new search cancels the old one.
import { BLACK } from './board.js';

export class Engine {
  constructor(name) {
    this.name = name;
    this.worker = new Worker(new URL('./engine-worker.js', import.meta.url), { type: 'module' });
    this.nextId = 1;
    this.pending = null;
    this.worker.onmessage = e => this.onMessage(e.data);
    this.worker.onerror = e => {
      console.error(`${name} worker error`, e.message);
      // Fail the running search instead of leaving the caller waiting forever.
      const job = this.pending;
      this.pending = null;
      if (job) job.resolve(null);
      if (Engine.onError) Engine.onError(name, e.message || 'failed to load');
    };
  }

  search(position, { playouts = 10000, maxTime = 60000, onProgress = null, reportMs = 250 } = {}) {
    this.cancel();
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
    if (msg.type === 'done') {
      this.pending = null;
      if (job.onProgress) job.onProgress(msg.results, true);
      job.resolve(msg.results);
    }
  }
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
        const merged = ok.length ? mergeResults(ok) : null;
        if (merged && onProgress) onProgress(merged, true);
        resolve(merged);
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
  constructor({ startupMs = 60000 } = {}) {
    this.worker = new Worker(new URL('./katago-worker.js', import.meta.url), { type: 'module' });
    this.engines = new Map();
    this.info = null;
    this.dead = false;       // failed: searches end at once
    this.onFail = null;      // called when KataGo stops working after it had started
    this.startupMs = startupMs;
    this.ready = new Promise(resolve => { this.resolveReady = resolve; });
    this.worker.onmessage = e => {
      const msg = e.data;
      if (this.dead) return;   // a late message from a worker we've given up on
      if (msg.type === 'ready') {
        clearTimeout(this.timer);
        this.info = { ok: true, backend: msg.backend, rate: msg.rate, batch: msg.batch };
        this.resolveReady(this.info);
        return;
      }
      if (msg.type === 'failed' || msg.type === 'fatal') { this.fail(msg.message); return; }
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
    this.info = { ok: false, message };
    this.resolveReady(this.info);
    try { this.worker.terminate(); } catch { /* already gone */ }
    for (const eng of this.engines.values()) eng.fail();
    // A failed start is reported by load(); only a failure in play needs its own call.
    if (started && this.onFail) this.onFail(message);
  }

  post(msg) { if (!this.dead) this.worker.postMessage(msg); }

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

  search(position, { playouts = 10000, visits = 0, maxTime = 60000, onProgress = null, reportMs = 250 } = {}) {
    this.cancel();
    if (this.host.dead) return Promise.resolve(null);
    const id = this.nextId++;
    return new Promise(resolve => {
      this.pending = { id, resolve, onProgress };
      this.host.post({ type: 'search', engine: this.name, id, position, playouts: visits || this.host.visits(playouts), maxTime, reportMs, priority: this.priority });
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
    if (msg.type === 'done') {
      this.pending = null;
      if (job.onProgress && msg.results) job.onProgress(msg.results, true);
      job.resolve(msg.results);
    }
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
