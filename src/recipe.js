// Rebuilds a position (and its superko history) from Game.recipe(), for the
// engine workers.
import { Board, BLACK, WHITE, PASS } from './board.js';

// Returns { board, seen: hashes of every position so far, history: [{ move, color, board }]
// for each move (board = the position after it) }.
export function buildPosition({ setup, moves, whiteFirst, resetPasses }) {
  const b = new Board();
  for (const [p, c] of setup) { b.toPlay = c; b.play(p); }
  b.toPlay = whiteFirst ? WHITE : BLACK;
  b.ko = 0; b.lastMove = PASS; b.lastMove2 = PASS; b.passes = 0; b.moveCount = 0;
  const seen = new Set([b.hash]);
  const history = [{ move: PASS, color: 0, board: b.clone() }];
  for (const m of moves) {
    if (Array.isArray(m)) b.toPlay = m[1];
    const color = b.toPlay, move = Array.isArray(m) ? m[0] : m;
    b.play(move);
    seen.add(b.hash);
    history.push({ move, color, board: b.clone() });
  }
  if (resetPasses) b.passes = 0;
  return { board: b, seen, history };
}
