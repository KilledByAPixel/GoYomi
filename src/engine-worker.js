// Web Worker wrapper around the MCTS. One job at a time; a new job or 'stop'
// pre-empts the current one. Progress is streamed so the UI can animate.
import { Board } from './board.js';
import { Search, seed } from './mcts.js';
import { buildPosition } from './recipe.js';

let job = null;
seed((Math.random() * 0xffffffff) >>> 0);

const channel = new MessageChannel();
channel.port1.onmessage = step;
// At most one step in flight: a new job picks up a step already queued, so a
// stale step can't start a second loop on it.
let stepQueued = false;
const yieldThen = () => { if (!stepQueued) { stepQueued = true; channel.port2.postMessage(0); } };

self.onmessage = e => {
  const msg = e.data;
  if (msg.type === 'stop') { job = null; return; }
  if (msg.type === 'search') {
    job = null;
    let board, seen;
    // A position that can't be built (a move onto a stone, say) ends that search
    // with no results, instead of a throw that takes the whole worker down.
    try { ({ board, seen } = buildPosition(msg.position)); } catch (err) {
      console.warn('Built-in engine: a position it cannot read', err && err.message);
      postMessage({ type: 'done', id: msg.id, results: null });
      return;
    }
    const tmp = new Board();
    const forbidden = p => { tmp.copyFrom(board); tmp.play(p); return seen.has(tmp.hash); };
    job = {
      id: msg.id,
      search: new Search(board, { komi: msg.position.komi, forbidden }),
      target: msg.playouts || 10000,
      maxTime: msg.maxTime || 60000,
      chunk: 250,
      started: performance.now(),
      lastReport: 0,
      reportMs: msg.reportMs ?? 250,
    };
    yieldThen();
  }
};

function step() {
  stepQueued = false;
  if (!job) return;
  const j = job;
  j.search.run(Math.min(j.chunk, j.target - j.search.playouts));
  const now = performance.now();
  const done = j.search.playouts >= j.target || now - j.started > j.maxTime;
  if (done || (j.reportMs && now - j.lastReport > j.reportMs)) {
    j.lastReport = now;
    const results = j.search.results(done ? 40 : 12);
    if (!done) delete results.allMoves;
    postMessage({ type: done ? 'done' : 'progress', id: j.id, results, elapsed: now - j.started });
  }
  if (done) { if (job === j) job = null; return; }
  yieldThen();
}
