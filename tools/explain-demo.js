// Prints coach grades + explanations for a quick self-play game (QA for wording).
// node tools/explain-demo.js [movePlayouts] [analysisPlayouts]
import { PASS, ptName } from '../src/board.js';
import { Search, seed, rand } from '../src/mcts.js';
import { Game } from '../src/game.js';
import { LEVELS, chooseMove, shouldPass, gradeMove, explainMove } from '../src/coach.js';

seed(42);
const moveP = +process.argv[2] || 600, anP = +process.argv[3] || 3000;
const analyse = (game, node) => { const s = new Search(node.board, { komi: 7 }); s.run(anP); return s.results(40); };
const game = new Game({ komi: 7 });
game.root.analysis = analyse(game, game.root);
while (!game.isOver() && game.current.depth < 90) {
  const parent = game.current, c = game.toPlay;
  const s = new Search(parent.board, { komi: 7, forbidden: p => !game.check(p).ok });
  s.run(moveP);
  const r = s.results(40);
  let move = shouldPass(game, parent.analysis, c) ? PASS : chooseMove(r, LEVELS[1], rand);
  if (!game.check(move).ok) move = PASS;
  const node = game.play(move);
  node.analysis = analyse(game, node);
  const g = gradeMove(parent.analysis, node.analysis, move);
  const ex = explainMove(parent.board, node.board, move, parent.analysis.ownership, node.analysis.ownership);
  console.log(`${String(node.depth).padStart(2)} ${c === 1 ? 'B' : 'W'} ${ptName(move).padEnd(4)} ${g ? g.grade.padEnd(10) + ' -' + g.ptLoss.toFixed(1).padStart(4) + 'pt best ' + ptName(g.bestMove).padEnd(4) : ''} | ${ex.join(' / ')}`);
}
console.log(game.board.toString());
