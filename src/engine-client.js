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
    this.worker.onerror = e => console.error(`${name} worker error`, e.message);
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
      if (!e) byMove.set(m.move, e = { move: m.move, visits: 0, wsum: 0, ssum: 0, prior: m.prior, pv: m.pv, pvVisits: -1 });
      e.visits += m.visits;
      e.wsum += m.winrate * m.visits;
      e.ssum += m.score * m.visits;
      if (m.visits > e.pvVisits) { e.pv = m.pv; e.pvVisits = m.visits; }
    }
  }
  const all = [...byMove.values()]
    .map(e => ({ move: e.move, visits: e.visits, winrate: e.wsum / e.visits, score: e.ssum / e.visits, prior: e.prior, pv: e.pv }))
    .sort((a, b) => b.visits - a.visits);
  const toPlay = list[0].toPlay;
  return {
    toPlay, playouts, blackWinrate, score, ownership,
    winrate: toPlay === BLACK ? blackWinrate : 1 - blackWinrate,
    moves: all.slice(0, 40), allMoves: all,
  };
}

// Several workers searching the same position; same interface as Engine.
export class EnginePool {
  constructor(name, size) {
    this.engines = Array.from({ length: size }, (_, i) => new Engine(`${name}${i}`));
    this.pending = null;
    this.nextId = 1;
  }

  search(position, { playouts = 10000, maxTime = 60000, onProgress = null, reportMs = 250 } = {}) {
    this.cancel();
    const id = this.nextId++, n = this.engines.length;
    const latest = new Array(n).fill(null), done = new Array(n).fill(false);
    return new Promise(resolve => {
      this.pending = { id, resolve };
      this.engines.forEach((engine, i) => {
        engine.search(position, {
          playouts: Math.ceil(playouts / n), maxTime, reportMs,
          onProgress: (res, fin) => {
            if (!this.pending || this.pending.id !== id) return;
            latest[i] = res;
            if (fin) done[i] = true;
            const finished = done.every(Boolean);
            if (!finished && !onProgress) return;
            const merged = mergeResults(latest.filter(Boolean));
            if (onProgress) onProgress(merged, finished);
            if (finished) { this.pending = null; resolve(merged); }
          },
        });
      });
    });
  }

  cancel() {
    if (!this.pending) return;
    const p = this.pending;
    this.pending = null;
    for (const e of this.engines) e.cancel();
    p.resolve(null);
  }

  get busy() { return !!this.pending; }
}
