// Prints ladder reader results for a few shapes so they can be checked by eye.
import { Board, BLACK, WHITE, pt, ptName, PASS } from '../src/board.js';
import { ladderCapture, ladderThreat } from '../src/ladder.js';
const play = (b, seq) => { const c = b.clone(); for (const m of seq) c.play(m); return c; };
function probe(name, rows, fn, p, toPlay) {
  const b = Board.fromRows(rows, toPlay);
  const seq = fn(b, p);
  console.log(`== ${name}: ${seq ? 'CAPTURED via ' + seq.map(ptName).join(' ') : 'escapes'}`);
  if (seq) { const c = b.clone(); c.toPlay = fn === ladderThreat ? 3 - b.color[p] : b.color[p]; for (const m of seq) c.play(m); console.log(c.toString()); }
}
const base = ['.........', '.........', '.........', '....X....', '...XO....', '.....X...', '.........', '.........', '.........'];
probe('two-lib stone, black to chase', base, ladderThreat, pt(4, 4), BLACK);
const breaker = base.slice(); breaker[8] = '.O.......';
probe('same with white stone at B1', breaker, ladderThreat, pt(4, 4), BLACK);
const breaker2 = base.slice(); breaker2[1] = '.......O.';
probe('same with white stone at H8', breaker2, ladderThreat, pt(4, 4), BLACK);
const atari = ['.........', '.........', '.........', '....X....', '...XOX...', '.........', '.........', '.........', '.........'];
probe('stone in atari (lib E4), white to run', atari, ladderCapture, pt(4, 4), WHITE);
const net = ['.........', '.........', '.........', '....X....', '...XOX...', '...X.....', '.........', '.........', '.........'];
probe('atari + extra black stone', net, ladderCapture, pt(4, 4), WHITE);
