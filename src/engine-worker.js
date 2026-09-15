// Web Worker wrapper around the MCTS. One job at a time; a new job or 'stop'
// pre-empts the current one. Progress is streamed so the UI can animate.
import { Board, BLACK, WHITE, PASS } from './board.js';
import { Search, seed } from './mcts.js';

let job = null;
seed((Math.random() * 0xffffffff) >>> 0);

const channel = new MessageChannel();
channel.port1.onmessage = step;
const yieldThen = () => channel.port2.postMessage(0);

// Rebuild the position (and superko history) from a recipe.
function build({ setup, moves, whiteFirst, resetPasses }) {
  const b = new Board();
  for (const [p, c] of setup) { b.toPlay = c; b.play(p); }
  b.toPlay = whiteFirst ? WHITE : BLACK;
  b.ko = 0; b.lastMove = PASS; b.lastMove2 = PASS; b.passes = 0; b.moveCount = 0;
  const seen = new Set([b.hash]);
  for (const m of moves) {
    if (Array.isArray(m)) { b.toPlay = m[1]; b.play(m[0]); } else b.play(m);
    seen.add(b.hash);
  }
  if (resetPasses) b.passes = 0;
  return { board: b, seen };
}

self.onmessage = e => {
  const msg = e.data;
  if (msg.type === 'stop') { job = null; return; }
  if (msg.type === 'search') {
    const { board, seen } = build(msg.position);
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
