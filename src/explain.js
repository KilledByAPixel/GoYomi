// What is true about a move, as plain data; wording.js turns it into words.
// Board facts need only the stones. Look-ahead facts need the coach's read of
// the position after the move; threat and purpose facts need the threat and
// baseline reads (docs/superpowers/specs/2026-09-26-coach-explanations-design.md).
// Facts whose reads aren't ready yet are simply left out.
import { BLACK, EMPTY, PASS, POINTS, D4, DIAG, N, ptX, ptY } from './board.js';
import { ladderCapture, ladderThreat } from './ladder.js';

const sign = c => c === BLACK ? 1 : -1;
// Ownership of point p in a read, from colour c's side (+1: c owns it).
export const ownOf = (an, p, c) => an.ownership[ptY(p) * N + ptX(p)] * sign(c);
export const dist = (a, b) => Math.abs(ptX(a) - ptX(b)) + Math.abs(ptY(a) - ptY(b));
// The board in nine 3×3 regions, row by row from the top left (4 is the centre).
export const regionOf = p => ((ptY(p) / 3) | 0) * 3 + ((ptX(p) / 3) | 0);

// Facts readable from the stones alone.
export function boardFacts(before, after, move) {
  if (move === PASS) return [{ type: 'pass' }];
  const out = [];
  const c = before.toPlay, o = 3 - c;
  const x = ptX(move), y = ptY(move);
  const height = Math.min(x, y, N - 1 - x, N - 1 - y);

  const captured = POINTS.filter(p => before.color[p] === o && after.color[p] === EMPTY);
  if (captured.length) out.push({ type: 'capture', stones: captured, ko: captured.length === 1 && !!after.ko });

  // Friendly chains that were in atari next to the move.
  const rescued = new Set();
  for (const d of D4) {
    const q = move + d;
    if (before.color[q] === c && before.inAtari(before.head[q])) rescued.add(before.head[q]);
  }
  const libs = after.libCount(move), size = after.size[after.head[move]];
  if (rescued.size) {
    const stones = [...rescued].flatMap(h => before.chainStones(h));
    out.push({ type: 'rescue', stones, libs, ladder: libs === 2 && !!ladderThreat(after, move) });
  }

  // Enemy chains now in atari (that weren't before).
  const seen = new Set(), ataris = [];
  for (const d of D4) {
    const q = move + d;
    if (after.color[q] !== o || seen.has(after.head[q])) continue;
    seen.add(after.head[q]);
    if (after.inAtari(after.head[q]) && !before.inAtari(before.head[q])) ataris.push(q);
  }
  if (ataris.length > 1) out.push({ type: 'atari', double: true, stones: ataris.flatMap(q => after.chainStones(q)), trapped: null });
  else if (ataris.length) {
    const seq = ladderCapture(after, ataris[0]);
    out.push({ type: 'atari', double: false, stones: after.chainStones(ataris[0]), trapped: !seq ? null : seq.length >= 3 ? 'ladder' : 'net' });
  }

  const friends = new Set(), enemies = new Map();
  for (const d of D4) {
    const q = move + d;
    if (before.color[q] === c) friends.add(before.head[q]);
    if (before.color[q] === o && !enemies.has(before.head[q])) enemies.set(before.head[q], q);
  }
  if (friends.size >= 2) out.push({ type: 'connect', groups: friends.size });
  // Only a candidate: whether it really cuts depends on how play goes on (lookAheadFacts).
  if (enemies.size >= 2 && !captured.length && libs >= 2) out.push({ type: 'separates', at: [...enemies.values()] });

  if (libs === 1 && !captured.length) out.push({ type: 'selfAtari', stones: size });
  else if (libs === 2 && size >= 3 && !rescued.size) out.push({ type: 'fewLibs', stones: size });
  if (before.isEyeish(move, c)) out.push({ type: 'ownEye' });

  if (!out.some(f => f.type !== 'separates')) {
    let shape;
    if (enemies.size && !friends.size) shape = 'contact';
    else if (friends.size && enemies.size) shape = 'block';
    else if (friends.size) shape = 'extend';
    else if (DIAG.some(d => before.color[move + d] === c)) shape = 'diagonal';
    else if (before.moveCount < 6) shape = height >= 2 ? 'opening' : 'lowOpening';
    else shape = 'open';
    out.push({ type: 'shape', shape });
  }
  if (height === 0 && before.moveCount < 20 && !captured.length && !rescued.size && !ataris.length) out.push({ type: 'firstLine' });
  return out;
}

// The expected continuation after a read's position: its best move and that move's line.
export function expectedLine(an) {
  const m = an && an.moves && an.moves[0];
  return m ? [m.move, ...(m.pv || [])] : [];
}

// Plays a line on a copy of the board, stopping at the first illegal move.
function playOut(board, line, max = 8) {
  const b = board.clone();
  for (const m of line.slice(0, max)) {
    if (m !== PASS && !b.isLegal(m)) break;
    b.play(m);
  }
  return b;
}

const avg = xs => xs.reduce((s, v) => s + v, 0) / xs.length;

// Facts that depend on how play is expected to go on. reads.after confirms or
// rejects cuts and spots stones that will die; reads.before spots attacks on
// stones that were already dead, and (with reads.after) stones the move loses.
export function lookAheadFacts(before, after, move, facts, reads) {
  const out = [], an = reads.after, pre = reads.before;
  if (move === PASS) return out;
  const c = before.toPlay, o = 3 - c;
  if (an) {
    const alive = ownOf(an, move, c);
    const sep = facts.find(f => f.type === 'separates');
    if (sep && alive > 0.3) {
      const b = playOut(after, expectedLine(an));
      const apart = sep.at.every(p => b.color[p] === o) && new Set(sep.at.map(p => b.head[p])).size === sep.at.length;
      if (apart) out.push({ type: 'cut', groups: sep.at.length });
    }
    if (alive < -0.5) out.push({ type: 'stoneLost', stones: after.size[after.head[move]] });
    const res = facts.find(f => f.type === 'rescue');
    if (res && avg(res.stones.map(p => ownOf(an, p, c))) < -0.5) out.push({ type: 'hopelessRescue', stones: res.stones });
  }
  if (pre) {
    const targets = [], seen = new Set();
    for (const d of D4) {
      const q = move + d;
      if (before.color[q] !== o || seen.has(before.head[q])) continue;
      seen.add(before.head[q]);
      const stones = before.chainStones(q);
      if (avg(stones.map(p => ownOf(pre, p, c))) > 0.6) targets.push(...stones);
    }
    if (targets.length) out.push({ type: 'deadTarget', stones: targets });
  }
  if (an && pre) {
    const lost = POINTS.filter(p => before.color[p] === c && after.color[p] === c && ownOf(pre, p, c) > 0.3 && ownOf(an, p, c) < -0.5);
    if (lost.length) out.push({ type: 'losesStones', stones: lost });
  }
  return out;
}

// Everything the coach can say about a move with the reads it has so far.
export function moveFacts({ before, after, move, reads = {} }) {
  const facts = boardFacts(before, after, move);
  if (move === PASS) return facts;
  return [...facts.filter(f => f.type !== 'separates'), ...lookAheadFacts(before, after, move, facts, reads)];
}
