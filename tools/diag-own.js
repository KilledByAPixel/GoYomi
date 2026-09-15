// Prints ownership map and top moves for a position: node tools/diag-own.js
import { Board, BLACK, POINTS, ptName } from '../src/board.js';
import { Search, seed } from '../src/mcts.js';
seed(10);
const rows = Array.from({ length: 9 }, () => '....XO...');
const s = new Search(Board.fromRows(rows, BLACK), { komi: 7 });
s.run(+process.argv[2] || 2000);
const r = s.results(6);
let out = '';
POINTS.forEach((p, i) => { out += (r.ownership[i] >= 0 ? ' ' : '') + r.ownership[i].toFixed(1) + (i % 9 === 8 ? '\n' : ' '); });
console.log(out, 'blackWR', r.blackWinrate.toFixed(3), 'score', r.score.toFixed(1));
for (const m of r.moves) console.log(ptName(m.move), m.visits, m.winrate.toFixed(3), m.score.toFixed(1));
