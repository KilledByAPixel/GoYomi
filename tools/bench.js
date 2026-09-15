// Playout speed + a quick search sanity check: node tools/bench.js [playouts]
import { Board, POINTS, SIZE, ptName } from '../src/board.js';
import { playout, Search, seed } from '../src/mcts.js';

seed(1);
const b0 = new Board();
const work = new Board();
const amaf = new Uint8Array(SIZE), owner = new Int8Array(POINTS.length);
let t = performance.now(), n = 0, moves = 0;
while (performance.now() - t < 2000) {
  work.copyFrom(b0); amaf.fill(0);
  playout(work, amaf, owner);
  moves += work.moveCount; n++;
}
const dt = (performance.now() - t) / 1000;
console.log(`raw playouts: ${(n / dt).toFixed(0)}/s, avg length ${(moves / n).toFixed(1)} moves`);

const count = +process.argv[2] || 20000;
const s = new Search(new Board(), { komi: 7 });
t = performance.now();
s.run(count);
const r = s.results(8);
console.log(`search ${count}: ${((performance.now() - t) / 1000).toFixed(2)}s, black winrate ${r.blackWinrate.toFixed(3)}, score ${r.score.toFixed(1)}`);
for (const m of r.moves) console.log(`  ${ptName(m.move).padEnd(5)} visits ${String(m.visits).padStart(6)}  wr ${m.winrate.toFixed(3)}  score ${m.score.toFixed(1)}`);
