// Equal-time self-play between two MCTS parameter sets.
// node tools/selfplay.js --games 10 --ms 300 --a '{"probGlobalAtari":0.5}' --b '{"probGlobalAtari":0}' --seed 1
import { BLACK, WHITE, PASS, ptName } from '../src/board.js';
import { Search, PARAMS, seed } from '../src/mcts.js';
import { Game } from '../src/game.js';
import { shouldPass, estimateDead } from '../src/coach.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const games = +arg('games', 10), ms = +arg('ms', 300), playouts = +arg('playouts', 0);
const A = JSON.parse(arg('a', '{}')), B = JSON.parse(arg('b', '{}'));
const base = { ...PARAMS };
seed(+arg('seed', 1));

function think(game, cfg) {
  Object.assign(PARAMS, base, cfg);
  const s = new Search(game.board, { komi: game.komi, forbidden: p => !game.check(p).ok });
  if (playouts) s.run(playouts);
  else { const t = performance.now(); while (performance.now() - t < ms) s.run(100); }
  return s.results(40);
}

let aWins = 0, bWins = 0;
for (let g = 0; g < games; g++) {
  const game = new Game({ komi: 7 });
  const aColor = g % 2 ? WHITE : BLACK;
  let winner = 0, how = '';
  while (!game.isOver() && game.current.depth < 160) {
    const c = game.toPlay;
    const r = think(game, c === aColor ? A : B);
    if (game.current.depth > 16 && r.winrate < 0.04) { winner = 3 - c; how = 'resign'; break; }
    let move = shouldPass(game, r, c) ? PASS : (r.allMoves.find(m => m.move !== PASS && game.check(m.move).ok) || { move: PASS }).move;
    game.play(move);
  }
  if (!winner) {
    Object.assign(PARAMS, base);
    const s = new Search(game.board, { komi: game.komi }); s.run(4000);
    const sc = game.score(estimateDead(game.board, s.results().ownership));
    winner = sc.winner; how = sc.text;
  }
  if (winner === aColor) aWins++; else if (winner) bWins++;
  console.log(`game ${g + 1}: A=${aColor === BLACK ? 'B' : 'W'} winner=${winner === aColor ? 'A' : winner ? 'B' : '-'} (${how}, ${game.current.depth} moves)`);
}
console.log(`RESULT A ${aWins} B ${bWins}`);
