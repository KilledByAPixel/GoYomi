// One AI move as the app plays it, for the match tools: KataGo levels by their
// recipe, built-in levels by playouts. After the opponent passes, the decision
// to pass too uses a deeper read (33 visits, or 4000 playouts), as the app does.
// Reads always run to their full budget: the app's time limits (Phoenix's 10 s)
// aren't applied, so results here are for a device fast enough to reach them.
import { PASS } from '../src/board.js';
import { Search, rand as mctsRand } from '../src/mcts.js';
import { chooseMove, chooseKataMove, shouldPass, LEVEL_BATCH } from '../src/coach.js';
import { buildPosition } from '../src/recipe.js';
import { KataSearch } from '../src/katago/search.js';

export async function levelMove(game, lv, { engine = 'katago', evaluator = null, rand = mctsRand, komi = 7 } = {}) {
  const kataRead = async visits => {
    const s = new KataSearch(buildPosition(game.recipe()), { komi, evaluator, batch: LEVEL_BATCH });
    await s.run(visits);
    return s.results(60);
  };
  const builtRead = n => {
    const s = new Search(game.board, { komi, forbidden: p => !game.check(p).ok });
    s.run(n);
    return s.results(60);
  };
  const afterPass = game.board.lastMove === PASS && !!game.current.parent;
  let results, passInfo;
  if (engine === 'katago') {
    results = await kataRead(lv.kata.visits);
    passInfo = afterPass && lv.kata.visits < 33 ? await kataRead(33) : results;
  } else {
    results = builtRead(lv.playouts);
    passInfo = afterPass && results.playouts < 4000 ? builtRead(4000) : results;
  }
  let move = shouldPass(game, passInfo, game.toPlay) ? PASS
    : engine === 'katago' ? chooseKataMove(results, lv.kata, rand) : chooseMove(results, lv, rand);
  if (move !== PASS && !game.check(move).ok) {
    move = (results.allMoves || results.moves).map(m => m.move).find(m => m !== PASS && game.check(m).ok) ?? PASS;
  }
  return { move, results };
}
