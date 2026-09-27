// Plays AI level A vs level B (as the app would play them): node tools/levels.js --a 1 --b 2 --games 8 --seed 1
// Levels are numbered from 0 (Pebble). KataGo's level (8, Phoenix) runs its network on
// TF.js's WASM backend. --first n numbers the games from n, to split a match over processes.
import { BLACK, WHITE, PASS } from '../src/board.js';
import { Search, seed, rand } from '../src/mcts.js';
import { Game } from '../src/game.js';
import { LEVELS, chooseMove, shouldPass, estimateDead } from '../src/coach.js';
import { buildPosition } from '../src/recipe.js';
import { KataSearch } from '../src/katago/search.js';
import { Evaluator } from '../src/katago/evaluator.js';
import { loadNet } from './katago-node.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const la = +arg('a', 0), lb = +arg('b', 1), games = +arg('games', 8), first = +arg('first', 0);
seed(+arg('seed', 1) + first);
const evaluator = LEVELS[la].katago || LEVELS[lb].katago ? new Evaluator((await loadNet()).net) : null;

// The level's search of the current position, as the app runs it.
async function think(game, lv) {
  if (lv.katago) {
    const s = new KataSearch(buildPosition(game.recipe()), { komi: 7, evaluator, batch: 4 });
    await s.run(lv.visits);
    return s.results(60);
  }
  const s = new Search(game.board, { komi: 7, forbidden: p => !game.check(p).ok });
  s.run(lv.playouts);
  return s.results(60);
}

let aWins = 0, bWins = 0;
for (let g = first; g < first + games; g++) {
  const game = new Game({ komi: 7 });
  const aColor = g % 2 ? WHITE : BLACK;
  let winner = 0, how = '';
  while (!game.isOver() && game.current.depth < 160) {
    const c = game.toPlay, lv = LEVELS[c === aColor ? la : lb];
    const r = await think(game, lv);
    if (game.current.depth > 20 && lv.playouts >= 1500 && r.winrate < 0.03) { winner = 3 - c; how = 'resign'; break; }
    let move = shouldPass(game, r, c) ? PASS : chooseMove(r, lv, rand);
    if (move !== PASS && !game.check(move).ok) move = PASS;
    game.play(move);
  }
  if (!winner) {
    // Play the final position out (passes reset), or no stone ever looks dead.
    const final = game.board.clone(); final.passes = 0;
    const s = new Search(final, { komi: 7 }); s.run(4000);
    const sc = game.score(estimateDead(game.board, s.results().ownership));
    winner = sc.winner; how = sc.text;
  }
  if (winner === aColor) aWins++; else if (winner) bWins++;
  const who = !winner ? 'nobody' : winner === aColor ? `L${la + 1}` : `L${lb + 1}`;
  console.log(`game ${g + 1}: L${la + 1} as ${aColor === BLACK ? 'B' : 'W'} → ${who} wins (${how}, ${game.current.depth} moves)`);
}
console.log(`RESULT L${la + 1} ${aWins} - L${lb + 1} ${bWins}`);
