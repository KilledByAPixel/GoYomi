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

// How two chains of colour c that both touch the empty point p were already
// linked around it, so whichever gap the opponent takes the other connects:
// 'diagonal' (the chains touch diagonally, the other point between them
// empty), 'bamboo' (two parallel pairs with two gaps, p one of them) or null.
export function linkThrough(board, p, c) {
  for (const d of D4) for (const e of D4) {
    if (e === d || e === -d) continue;
    const a = p + d, b = p + e;
    if (board.color[a] === c && board.color[b] === c && board.head[a] !== board.head[b] && board.color[p + d + e] === EMPTY) return 'diagonal';
    const pairs = [p - d, p + d, p - d + e, p + d + e];
    if (pairs.every(q => board.color[q] === c) && board.color[b] === EMPTY && board.head[p - d] !== board.head[p + d]) return 'bamboo';
  }
  return null;
}

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
  const via = friends.size === 2 ? linkThrough(before, move, c) : null;
  if (via) out.push({ type: 'alreadyConnected', via });
  else if (friends.size >= 2) out.push({ type: 'connect', groups: friends.size });
  // Only a candidate: whether it really cuts depends on how play goes on (lookAheadFacts).
  // Pushing into the opponent's own link is no cut: they connect at the other gap.
  if (enemies.size >= 2 && !captured.length && libs >= 2 && !(enemies.size === 2 && linkThrough(before, move, o))) {
    out.push({ type: 'separates', at: [...enemies.values()] });
  }

  if (libs === 1 && !captured.length) out.push({ type: 'selfAtari', stones: size });
  else if (libs === 2 && size >= 3 && !rescued.size) out.push({ type: 'fewLibs', stones: size });
  if (before.isEyeish(move, c)) out.push({ type: 'ownEye' });
  // Empty triangle: three stones in an L with the fourth point of their square
  // empty (and empty before the move: a capture that clears it doesn't count).
  const triangle = D4.some(d1 => D4.some(d2 => {
    if (d1 >= d2 || d1 === -d2) return false;
    const s = [move + d1, move + d2, move + d1 + d2];
    const gap = s.filter(q => after.color[q] !== c);
    return gap.length === 1 && after.color[gap[0]] === EMPTY && before.color[gap[0]] === EMPTY;
  }));
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

// Whether any two of the chains at points ps share a liberty (one move joins them).
function shareLiberty(b, ps) {
  const seen = new Set();
  for (const p of ps) {
    const libs = b.chainLibs(p);
    if (libs.some(q => seen.has(q))) return true;
    for (const q of libs) seen.add(q);
  }
  return false;
}

// Facts that depend on how play is expected to go on. reads.after confirms or
// rejects cuts and spots stones that will die; reads.before and reads.baseline
// spot attacks on stones that were already dead, and reads.before (with
// reads.after) stones the move loses.
export function lookAheadFacts(before, after, move, facts, reads) {
  const out = [], an = reads.after, pre = reads.before, base = reads.baseline;
  if (move === PASS) return out;
  const c = before.toPlay, o = 3 - c;
  if (an) {
    const alive = ownOf(an, move, c);
    const sep = facts.find(f => f.type === 'separates');
    if (sep && alive > 0.3) {
      const b = playOut(after, expectedLine(an));
      const apart = sep.at.every(p => b.color[p] === o) && new Set(sep.at.map(p => b.head[p])).size === sep.at.length &&
        !shareLiberty(b, sep.at);
      if (apart) out.push({ type: 'cut', groups: sep.at.length });
    }
    if (alive < -0.5) out.push({ type: 'stoneLost', stones: after.size[after.head[move]] });
    const res = facts.find(f => f.type === 'rescue');
    if (res && avg(res.stones.map(p => ownOf(an, p, c))) < -0.5) out.push({ type: 'hopelessRescue', stones: res.stones });
  }
  // Dead with either side to move: in the read before the move (the mover to
  // play) stones can look dead only because it's the mover's turn, like a
  // chain in atari or a capturing race the mover wins by moving first.
  if (pre && base) {
    const targets = [], seen = new Set();
    for (const d of D4) {
      const q = move + d;
      if (before.color[q] !== o || seen.has(before.head[q])) continue;
      seen.add(before.head[q]);
      const stones = before.chainStones(q);
      const attacked = after.color[q] !== o || after.libCount(q) <= 2;
      if (attacked && avg(stones.map(p => Math.min(ownOf(pre, p, c), ownOf(base, p, c)))) > 0.6) targets.push(...stones);
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
export function threatFacts(before, after, move, mover, reads) {
  const an = reads.after, th = reads.threat;
  if (!an || !th || move === PASS) return [];
  const list = th.allMoves || th.moves || [];
  const top = list.length ? list[0].visits : 0;
  const tb = after.clone();
  tb.play(PASS);
  // What a move at p does on board b, with the mover to play: a capture, an atari, a cut candidate or nothing.
  const does = (b, p) => {
    if (!b.isLegal(p)) return null;
    const b2 = b.clone();
    b2.play(p);
    return boardFacts(b, b2, p).find(f => f.type === 'capture' || f.type === 'atari' || f.type === 'separates') || null;
  };
  const same = (a, b) => !!a && !!b && a.type === b.type && (a.stones || a.at).some(p => (b.stones || b.at).includes(p));
  for (const m of list) {
    if (m.move === PASS || dist(m.move, move) > 3 || m.visits < top * 0.05) continue;
    const what = does(tb, m.move);
    // Not a threat the move made if the mover could already do the same before it.
    if (!what || same(what, does(before, m.move))) continue;
    const reply = an.moves && an.moves[0] ? an.moves[0].move : PASS;
    // Sente when the expected reply takes the threat away.
    let answered = false;
    if (reply !== PASS && after.isLegal(reply)) {
      const rb = after.clone();
      rb.play(reply);
      answered = !same(what, does(rb, m.move));
    }
    // An answer where the opponent wanted to play anyway says nothing about sente or gote.
    const wanted = reads.baseline && reads.baseline.moves && reads.baseline.moves.find(x => x.move !== PASS);
    const anyway = answered && !!wanted && wanted.move !== move && dist(reply, wanted.move) <= 1;
    const out = [{ type: 'threat', move: m.move, what }];
    if (!anyway) out.push({ type: 'initiative', sente: answered, reply });
    return out;
  }
  return [];
}

// What the move is for: the area where it gains most against not playing it
// (reads.baseline, the mover passing instead), whether that protects, reduces
// or claims area, how much the move is worth, and whether the opponent would
// otherwise have played the same point. Ownership gains are spread thin and
// noisy, so only the biggest gain counts, and only when it's around the move
// (a gain far away is read noise, not what the move is for). By who owned the
// area in reads.before: protects (the mover's), reduces (the opponent's), else
// claims when the mover is expected to own it after the move, builds when not
// yet: early on a move only works towards an area.
export function purposeFacts(move, mover, reads) {
  const an = reads.after, base = reads.baseline, pre = reads.before, out = [];
  if (!an || !base || !pre || move === PASS) return out;
  const s = sign(mover);
  const gain = new Array(9).fill(0), owned = new Array(9).fill(0), after = new Array(9).fill(0);
  POINTS.forEach((p, i) => {
    const r = regionOf(p);
    gain[r] += (an.ownership[i] - base.ownership[i]) * s / 2;
    owned[r] += pre.ownership[i] * s / 9;
    after[r] += an.ownership[i] * s / 9;
  });
  const top = [...gain.keys()].reduce((a, r) => gain[r] > gain[a] ? r : a, 0);
  const home = regionOf(move), near = Math.abs(((top / 3) | 0) - ((home / 3) | 0)) <= 1 && Math.abs(top % 3 - home % 3) <= 1;
  const value = (an.score - base.score) * s;
  if (gain[top] >= 1 && near) {
    const kind = owned[top] > 0.3 ? 'protects' : owned[top] < -0.3 ? 'reduces' : after[top] > 0.5 ? 'claims' : 'builds';
    out.push({ type: 'purpose', regions: [{ region: top, points: gain[top], kind }], value });
  }
  // The opponent's own best move, when it's this point: a key point for both sides.
  const other = base.moves && base.moves.find(m => m.move !== PASS);
  if (other && value >= 2 && (other.move === move || (other.twins && other.twins.includes(move)))) out.push({ type: 'otherwise', move });
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
    ...threatFacts(before, after, move, mover, reads),
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
