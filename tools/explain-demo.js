// Prints the coach's grade and explanation at each level for a quick
// self-play game (QA for wording): node tools/explain-demo.js [movePlayouts] [readPlayouts]
import { BLACK, PASS, ptName } from '../src/board.js';
import { Search, seed, rand } from '../src/mcts.js';
import { Game } from '../src/game.js';
import { LEVELS, chooseMove, shouldPass, gradeMove, preferUsefulMove } from '../src/coach.js';
import { moveFacts } from '../src/explain.js';
import { levelGrade, verdict, describe } from '../src/wording.js';

seed(42);
const moveP = +process.argv[2] || 600, readP = +process.argv[3] || 3000;
// A coach read of board, optionally after one more move (a pass for the threat/baseline reads).
const read = (board, extra) => {
  const b = board.clone();
  if (extra !== undefined) { b.play(extra); b.passes = 0; }
  const s = new Search(b, { komi: 7 });
  s.run(readP);
  return preferUsefulMove(s.results(40));
};
const plain = html => html.replace(/<[^>]+>/g, '');
const game = new Game({ komi: 7 });
game.root.analysis = read(game.root.board);
while (!game.isOver() && game.current.depth < 40) {
  const parent = game.current, c = game.toPlay;
  const s = new Search(parent.board, { komi: 7, forbidden: p => !game.check(p).ok });
  s.run(moveP);
  let move = shouldPass(game, parent.analysis, c) ? PASS : chooseMove(s.results(40), LEVELS[1], rand);
  if (!game.check(move).ok) move = PASS;
  const node = game.play(move);
  node.analysis = read(node.board);
  const g = gradeMove(parent.analysis, node.analysis, move);
  const reads = { before: parent.analysis, after: node.analysis, threat: read(node.board, PASS), baseline: read(parent.board, PASS) };
  const facts = moveFacts({ before: parent.board, after: node.board, move, reads });
  console.log(`${String(node.depth).padStart(2)} ${c === BLACK ? 'B' : 'W'} ${ptName(move)}`);
  for (const level of ['beginner', 'improving', 'strong']) {
    const shown = g && levelGrade(g, level, facts);
    const text = describe(facts, { level, mover: c, you: BLACK, shown }).join(' ');
    console.log(`   ${level.padEnd(9)} ${shown ? `${shown.label}: ${plain(verdict(g, level, shown))} ` : ''}${plain(text)}`);
  }
}
console.log(game.board.toString());
