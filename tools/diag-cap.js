// Diagnose the "capture 6 stones" position: node tools/diag-cap.js [playouts]
import { Board, BLACK, POINTS, ptName, pt } from '../src/board.js';
import { Search, seed } from '../src/mcts.js';
seed(7);
const b = Board.fromRows(['.........','.........','...X.....','..XOX....','..XOX....','.........','.........','.........','.........'], BLACK);
console.log(b.toString(), 'E4 legal', b.isLegal(pt(3,5)), 'inAtari', b.inAtari(b.head[pt(3,4)]));
const s = new Search(b, { komi: 7 });
const cap = s.root.children.find(c => c.move === pt(3, 5));
console.log('E4 prior', cap && (cap.pw / cap.pn).toFixed(2), cap && cap.pn);
s.run(+process.argv[2] || 3000);
const r = s.results(10);
console.log('blackWR', r.blackWinrate.toFixed(3), 'score', r.score.toFixed(1));
for (const m of r.moves) {
  const ch = s.root.children.find(c => c.move === m.move);
  console.log(ptName(m.move).padEnd(4), String(m.visits).padStart(5), 'wr', m.winrate.toFixed(3), 'val', (ch.v / ch.n).toFixed(3), 'amaf', (ch.aw / Math.max(1, ch.an)).toFixed(3), ch.an, 'score', m.score.toFixed(1), 'urg', ch.urgency(3500).toFixed(3));
}
console.log('E4:', cap.n, (cap.v / Math.max(1, cap.n)).toFixed(3), 'amaf', (cap.aw / Math.max(1, cap.an)).toFixed(3), cap.an, 'urg', cap.urgency(3500).toFixed(3));
