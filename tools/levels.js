// Plays AI level A against level B as the app plays them:
//   node tools/levels.js --a 0 --b 1 --games 10 --seed 1
// Levels count from 0 (Pebble). --a-engine builtin plays side A on the built-in
// engine (its fallback) instead of KataGo; --a-kata '{"temp":1.2}' overrides
// side A's KataGo recipe (for calibration). Same for B. --first n numbers the
// games from n, to split a match over processes.
import { BLACK, WHITE } from '../src/board.js';
import { Search, seed, rand } from '../src/mcts.js';
import { Game } from '../src/game.js';
import { LEVELS, estimateDead } from '../src/coach.js';
import { Evaluator } from '../src/katago/evaluator.js';
import { loadNet } from './katago-node.js';
import { levelMove } from './play-level.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const side = (k, d) => {
  const base = LEVELS[+arg(k, d)], engine = arg(`${k}-engine`, 'katago'), over = arg(`${k}-kata`);
  const lv = { ...base, kata: { ...base.kata, ...(over ? JSON.parse(over) : {}) } };
  return { lv, engine, label: `${base.name}${engine === 'builtin' ? '(built-in)' : ''}${over || ''}` };
};
const A = side('a', 0), B = side('b', 1), games = +arg('games', 8), first = +arg('first', 0);
seed(+arg('seed', 1) + first);
// The evaluator's random symmetries use the seeded stream too, so --seed replays the same games.
const evaluator = A.engine === 'katago' || B.engine === 'katago' ? new Evaluator((await loadNet()).net, { rand }) : null;
// Only a level that reads enough to know resigns a lost game.
const canResign = S => S.engine === 'katago' ? S.lv.kata.visits >= 16 : S.lv.playouts >= 1500;

let aWins = 0, bWins = 0;
for (let g = first; g < first + games; g++) {
  const game = new Game({ komi: 7 });
  const aColor = g % 2 ? WHITE : BLACK;
  let winner = 0, how = '';
  while (!game.isOver() && game.current.depth < 160) {
    const c = game.toPlay, S = c === aColor ? A : B;
    const { move, results } = await levelMove(game, S.lv, { engine: S.engine, evaluator, rand });
    if (game.current.depth > 20 && canResign(S) && results.winrate < 0.03) { winner = 3 - c; how = 'resign'; break; }
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
  const who = !winner ? 'nobody' : winner === aColor ? 'A' : 'B';
  console.log(`game ${g + 1}: A as ${aColor === BLACK ? 'B' : 'W'} → ${who} wins (${how}, ${game.current.depth} moves)`);
}
console.log(`RESULT ${A.label} ${aWins} - ${B.label} ${bWins}`);
