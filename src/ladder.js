// Simple ladder reader: can a chain be chased into capture by repeated ataris?
// Standard shortcut reading — the defender escapes by extending to 3+
// liberties or by capturing an attacking chain that is itself in atari.
import { BLACK, WHITE, EMPTY } from './board.js';

// The chain at p is in atari and its owner is to move. Is it lost to a ladder?
// Returns the attacker's winning sequence (array of moves, possibly empty when
// the chain simply can't extend), or null if it escapes.
export function ladderCapture(board, p, maxDepth = 40) {
  const c = board.color[p];
  if (c !== BLACK && c !== WHITE) return null;
  const b = board.clone();
  b.toPlay = c;
  b.ko = 0;
  if (!b.inAtari(b.head[p])) return null;
  const seq = [];
  return defenderLoses(b, p, maxDepth, seq) ? seq : null;
}

// The chain at p has two liberties and the attacker is to move. Can the
// attacker start a ladder that captures it? Returns the sequence or null.
export function ladderThreat(board, p, maxDepth = 40) {
  const c = board.color[p];
  if (c !== BLACK && c !== WHITE) return null;
  const b = board.clone();
  b.toPlay = 3 - c;
  b.ko = 0;
  const libs = b.chainLibs(p);
  if (libs.length !== 2) return null;
  for (const a of libs) {
    if (!b.isLegal(a) || b.isSelfAtari(a, 3 - c, 1)) continue;
    const d = b.clone();
    d.play(a);
    const seq = [a];
    if (d.color[p] === EMPTY || defenderLoses(d, p, maxDepth, seq)) return seq;
  }
  return null;
}

function defenderLoses(b, p, depth, seq) {
  const h = b.head[p];
  if (!b.inAtari(h)) return false;
  if (depth <= 0) return false;
  for (const e of b.adjacentEnemyChains(h)) if (b.inAtari(e)) return false;
  const lib = b.atariLib(h);
  if (!b.isLegal(lib)) return true;
  const c = b.clone();
  c.play(lib);
  const libs = c.chainLibs(p);
  if (libs.length >= 3) return false;
  if (libs.length <= 1) { seq.push(lib); return true; }
  for (const a of libs) {
    if (!c.isLegal(a)) continue;
    const d = c.clone();
    d.play(a);
    const mark = seq.length;
    seq.push(lib, a);
    if (d.color[p] === EMPTY) return true;
    if (d.inAtari(d.head[p]) && defenderLoses(d, p, depth - 1, seq)) return true;
    seq.length = mark;
  }
  return false;
}
