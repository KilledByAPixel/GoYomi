// Prints the coach's grade and explanation at each level for a quick
// self-play game (QA for wording): node tools/explain-demo.js [movePlayouts] [readPlayouts]
// With --katago [visits] the coach reads with KataGo's network (default 400 visits).
import { BLACK, PASS, ptName } from '../src/board.js';
import { Search, seed, rand } from '../src/mcts.js';
import { Game } from '../src/game.js';
import { LEVELS, chooseMove, shouldPass, gradeMove, preferUsefulMove } from '../src/coach.js';
import { moveFacts } from '../src/explain.js';
import { levelGrade, verdict, describe } from '../src/wording.js';
import { buildPosition } from '../src/recipe.js';
import { KataSearch } from '../src/katago/search.js';
import { Evaluator } from '../src/katago/evaluator.js';
import { loadNet } from './katago-node.js';

seed(42);
const ki = process.argv.indexOf('--katago');
const kataVisits = ki > 0 ? +process.argv[ki + 1] || 400 : 0;
const args = process.argv.slice(2).filter((a, i, all) => a !== '--katago' && all[i - 1] !== '--katago');
const moveP = +args[0] || 600, readP = +args[1] || 3000;
const evaluator = kataVisits ? new Evaluator((await loadNet()).net) : null;
// A coach read of node's position, optionally after a pass (the threat/baseline reads).
const read = async (node, pass = false) => {
  if (evaluator) {
    const recipe = game.recipe(node);
    if (pass) { recipe.moves = [...recipe.moves, [PASS, node.board.toPlay]]; recipe.resetPasses = true; }
    const s = new KataSearch(buildPosition(recipe), { komi: 7, evaluator, batch: 4 });
    await s.run(kataVisits);
    return preferUsefulMove(s.results(40));
  }
  const b = node.board.clone();
  if (pass) { b.play(PASS); b.passes = 0; }
  const s = new Search(b, { komi: 7 });
  s.run(readP);
  return preferUsefulMove(s.results(40));
};
const plain = html => html.replace(/<[^>]+>/g, '');
const game = new Game({ komi: 7 });
game.root.analysis = await read(game.root);
while (!game.isOver() && game.current.depth < 40) {
  const parent = game.current, c = game.toPlay;
  const s = new Search(parent.board, { komi: 7, forbidden: p => !game.check(p).ok });
  s.run(moveP);
  let move = shouldPass(game, parent.analysis, c) ? PASS : chooseMove(s.results(40), LEVELS[1], rand);
  if (!game.check(move).ok) move = PASS;
  const node = game.play(move);
  node.analysis = await read(node);
  const g = gradeMove(parent.analysis, node.analysis, move);
  const reads = { before: parent.analysis, after: node.analysis, threat: await read(node, true), baseline: await read(parent, true) };
  const facts = moveFacts({ before: parent.board, after: node.board, move, reads });
  console.log(`${String(node.depth).padStart(2)} ${c === BLACK ? 'B' : 'W'} ${ptName(move)}`);
  for (const level of ['beginner', 'improving', 'strong']) {
    const shown = g && levelGrade(g, level, facts);
    const text = describe(facts, { level, mover: c, you: BLACK, shown }).join(' ');
    console.log(`   ${level.padEnd(9)} ${shown ? `${shown.label}: ${plain(verdict(g, level, shown))} ` : ''}${plain(text)}`);
  }
}
console.log(game.board.toString());
