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
  // Pairs of orthogonal neighbours at right angles: q1 and q2 are diagonal to
  // each other, and far is the fourth corner of their 2×2 square with the move.
  const corners = [];
  for (const d1 of D4) for (const d2 of D4) if (d1 < d2 && d1 !== -d2) corners.push([move + d1, move + d2, move + d1 + d2]);
  // Two groups touching diagonally with the other point between them empty were
  // connected already: whichever side the opponent pushes in, the other connects.
  const diagonalLink = friends.size === 2 && corners.some(([q1, q2, far]) =>
    before.color[q1] === c && before.color[q2] === c && before.head[q1] !== before.head[q2] && before.color[far] === EMPTY);
  // Bamboo joint: two parallel pairs with two gaps between them, the move filling one.
  const bambooLink = friends.size === 2 && D4.some(d => D4.some(e => e !== d && e !== -d &&
    [move - d, move + d, move - d + e, move + d + e].every(q => before.color[q] === c) &&
    before.color[move + e] === EMPTY && before.head[move - d] !== before.head[move + d]));
  const via = diagonalLink ? 'diagonal' : bambooLink ? 'bamboo' : null;
  if (via) out.push({ type: 'alreadyConnected', via });
  else if (friends.size >= 2) out.push({ type: 'connect', groups: friends.size });
  // Only a candidate: whether it really cuts depends on how play goes on (lookAheadFacts).
  if (enemies.size >= 2 && !captured.length && libs >= 2) out.push({ type: 'separates', at: [...enemies.values()] });

  if (libs === 1 && !captured.length) out.push({ type: 'selfAtari', stones: size });
  else if (libs === 2 && size >= 3 && !rescued.size) out.push({ type: 'fewLibs', stones: size });
  if (before.isEyeish(move, c)) out.push({ type: 'ownEye' });
  // Empty triangle: three stones in an L with the fourth point of their square empty.
  const triangle = corners.some(qs => {
    const s = qs.map(q => after.color[q]);
    return s.filter(v => v === c).length === 2 && s.includes(EMPTY);
  });
  if (triangle) out.push({ type: 'emptyTriangle' });

  if (!out.some(f => f.type !== 'separates' && f.type !== 'emptyTriangle')) {
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
      const attacked = after.color[q] !== o || after.libCount(q) <= 2;
      if (attacked && avg(stones.map(p => ownOf(pre, p, c))) > 0.6) targets.push(...stones);
    }
    if (targets.length) out.push({ type: 'deadTarget', stones: targets });
  }
  if (an && pre) {
    const lost = POINTS.filter(p => before.color[p] === c && after.color[p] === c && ownOf(pre, p, c) > 0.3 && ownOf(an, p, c) < -0.5);
    if (lost.length) out.push({ type: 'losesStones', stones: lost });
  }
  return out;
}

// What the move threatens: the most-read follow-up near it that captures,
// ataris or cuts, if the opponent ignored the move (reads.threat), and
// whether the opponent is expected to answer it (sente). No point value: on
// an open board any second move is worth ~10 points, so a number misleads.
export function threatFacts(after, move, mover, reads) {
  const an = reads.after, th = reads.threat;
  if (!an || !th || move === PASS) return [];
  const list = th.allMoves || th.moves || [];
  const top = list.length ? list[0].visits : 0;
  const tb = after.clone();
  tb.play(PASS);
  for (const m of list) {
    if (m.move === PASS || dist(m.move, move) > 3 || m.visits < top * 0.05 || !tb.isLegal(m.move)) continue;
    const t2 = tb.clone();
    t2.play(m.move);
    const what = boardFacts(tb, t2, m.move).find(f => f.type === 'capture' || f.type === 'atari' || f.type === 'separates');
    if (!what) continue;
    const reply = an.moves && an.moves[0];
    const wanted = reads.baseline && reads.baseline.moves && reads.baseline.moves.find(x => x.move !== PASS);
    const anyway = !!wanted && wanted.move !== move && reply && reply.move !== PASS && dist(reply.move, wanted.move) <= 1;
    const sente = !!reply && reply.move !== PASS && !anyway && (dist(reply.move, move) <= 2 || dist(reply.move, m.move) <= 1);
    return [{ type: 'threat', move: m.move, what }, { type: 'initiative', sente, reply: reply ? reply.move : PASS }];
  }
  return [];
}

// What the move is for: where it gains against not playing it (reads.baseline,
// the mover passing instead), whether that protects, reduces or claims area
// (by who owned it in reads.before), how much the move is worth, and what the
// opponent would otherwise have played. Ownership gains are spread thin, so
// the regions say where and the score difference says how much.
export function purposeFacts(move, mover, reads) {
  const an = reads.after, base = reads.baseline, pre = reads.before, out = [];
  if (!an || !base || !pre || move === PASS) return out;
  const s = sign(mover);
  const gain = new Array(9).fill(0), owned = new Array(9).fill(0);
  POINTS.forEach((p, i) => {
    const r = regionOf(p);
    gain[r] += (an.ownership[i] - base.ownership[i]) * s / 2;
    owned[r] += pre.ownership[i] * s / 9;
  });
  const order = [...gain.keys()].filter(r => gain[r] >= 1).sort((a, b) => gain[b] - gain[a]);
  const regions = order.filter((r, k) => k === 0 || (k === 1 && gain[r] >= gain[order[0]] / 2))
    .map(r => ({ region: r, points: gain[r], kind: owned[r] > 0.3 ? 'protects' : owned[r] < -0.3 ? 'reduces' : 'claims' }));
  const value = (an.score - base.score) * s;
  if (regions.length) out.push({ type: 'purpose', regions, value });
  const other = base.moves && base.moves.find(m => m.move !== PASS);
  if (other && value >= 2) out.push({ type: 'otherwise', move: other.move });
  return out;
}

// Everything the coach can say about a move with the reads it has so far.
export function moveFacts({ before, after, move, reads = {} }) {
  const facts = boardFacts(before, after, move);
  if (move === PASS) return facts;
  const mover = before.toPlay;
  const all = [
    ...facts.filter(f => f.type !== 'separates'),
    ...lookAheadFacts(before, after, move, facts, reads),
    ...threatFacts(after, move, mover, reads),
    ...purposeFacts(move, mover, reads),
  ];
  // Stones the opponent is expected to rescue weren't dead after all: the
  // deeper read of the position after the move outranks the one before it.
  const dead = all.find(f => f.type === 'deadTarget'), threat = all.find(f => f.type === 'threat');
  const sente = all.some(f => f.type === 'initiative' && f.sente);
  if (dead && threat && sente && threat.what.stones && threat.what.stones.some(p => dead.stones.includes(p))) return all.filter(f => f !== dead);
  return all;
}

// moveFacts for a game-tree node, cached until one of the reads it used is
// replaced (a deeper re-read after a Coach depth change is a new object).
export function cachedFacts(node, reads) {
  const used = [reads.before, reads.after, reads.threat, reads.baseline];
  if (node.facts && node.factsReads && used.every((r, i) => r === node.factsReads[i])) return node.facts;
  node.factsReads = used;
  return node.facts = moveFacts({ before: node.parent.board, after: node.board, move: node.move, reads });
}
