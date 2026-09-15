// Monte-Carlo tree search with RAVE, closely following the design of
// Petr Baudis' "michi": heuristic priors instead of an exploration term,
// playouts guided by capture/atari and 3x3 pattern heuristics.
import { Board, BLACK, WHITE, EMPTY, EDGE, PASS, POINTS, D4, DIAG, W, SIZE, N, ptX, ptY } from './board.js';
import { matchesPat3 } from './patterns.js';

export const PARAMS = {
  raveEquiv: 3500,
  expandVisits: 8,
  priorEven: 10,
  priorSelfAtari: 10,
  priorCaptureOne: 15,
  priorCaptureMany: 30,
  priorPat3: 10,
  priorCfg: [24, 22, 8],
  priorEmptyArea: 10,
  probCapture: 0.9,
  probPat3: 0.95,
  probRejectHeuristicSelfAtari: 0.9,
  probRejectRandomSelfAtari: 0.5,
};

// xorshift32 — seedable so tests and self-play are reproducible.
let rs = 0x2545f491;
export function seed(s) { rs = (s >>> 0) || 1; }
export function rand() {
  rs ^= rs << 13; rs ^= rs >>> 17; rs ^= rs << 5;
  return (rs >>> 0) / 4294967296;
}
const randInt = n => (rand() * n) | 0;

// ---------------------------------------------------------------- heuristics

// Moves that capture or rescue chains in atari.
// Pushes pairs (move, kind): kind 1 = capture one stone, 2 = capture many, 3 = escape.
// Moves are not checked for legality here.
const chainMark = new Int32Array(SIZE);
let chainStamp = 0;

function atariChain(b, q, st, out) {
  const color = b.color, cq = color[q];
  if (cq !== BLACK && cq !== WHITE) return;
  const head = b.head, h = head[q];
  if (chainMark[h] === st) return;
  chainMark[h] = st;
  if (!b.inAtari(h)) return;
  const lib = b.atariLib(h);
  if (cq !== b.toPlay) { out.push(lib, b.size[h] > 1 ? 2 : 1); return; }
  // Our chain in atari: capture an adjacent enemy chain in atari, or extend if that helps.
  const o = 3 - cq, next = b.next;
  let s = h;
  do {
    for (let j = 0; j < 4; j++) {
      const r = s + D4[j];
      if (color[r] === o) {
        const hr = head[r];
        if (b.inAtari(hr)) out.push(b.atariLib(hr), b.size[hr] > 1 ? 2 : 1);
      }
    }
    s = next[s];
  } while (s !== h);
  if (b.libsAfter(lib, cq, 2) >= 2) out.push(lib, 3);
}

// Chains at p and orthogonally next to it: exactly the chains a move at p
// can have put into atari (or left in atari).
function atariMovesNear(b, p, out) {
  if (p === PASS) return;
  const st = ++chainStamp;
  atariChain(b, p, st, out);
  for (let i = 0; i < 4; i++) atariChain(b, p + D4[i], st, out);
}

function atariMovesAll(b, out) {
  const st = ++chainStamp;
  for (const p of POINTS) atariChain(b, p, st, out);
}

// Empty points around the last move matching a 3x3 pattern.
function pat3Moves(b, out) {
  const last = b.lastMove;
  if (last === PASS) return;
  const color = b.color;
  const start = randInt(8);
  for (let k = 0; k < 8; k++) {
    const i = (start + k) % 8;
    const p = last + (i < 4 ? D4[i] : DIAG[i - 4]);
    if (color[p] === EMPTY && matchesPat3(color, p)) out.push(p);
  }
}

// ---------------------------------------------------------------- playouts

const tmp = [];

function tryMove(b, p, rejectProb) {
  const c = b.toPlay;
  if (!b.isLegal(p, c) || b.isEyeish(p, c)) return false;
  if (rejectProb > 0 && rand() < rejectProb && b.isSelfAtari(p, c, 2)) return false;
  return true;
}

// Chooses a playout move for b.toPlay (PASS if nothing sensible).
export function playoutMove(b) {
  const P = PARAMS;
  if (rand() < P.probCapture) {
    tmp.length = 0;
    atariMovesNear(b, b.lastMove, tmp);
    atariMovesNear(b, b.lastMove2, tmp);
    const n = tmp.length / 2;
    if (n) {
      const s = randInt(n);
      for (let k = 0; k < n; k++) {
        const p = tmp[((s + k) % n) * 2];
        if (tryMove(b, p, P.probRejectHeuristicSelfAtari)) return p;
      }
    }
  }
  if (rand() < P.probPat3) {
    tmp.length = 0;
    pat3Moves(b, tmp);
    for (const p of tmp) if (tryMove(b, p, P.probRejectHeuristicSelfAtari)) return p;
  }
  const n = b.emptyCount, s = randInt(n), empty = b.empty;
  for (let k = 0; k < n; k++) {
    const p = empty[(s + k) % n];
    if (tryMove(b, p, P.probRejectRandomSelfAtari)) return p;
  }
  return PASS;
}

// Plays b out to the end. Records first-player-per-point into amaf.
// Returns black-minus-white area score (no komi); fills owner (Int8Array(81)).
export function playout(b, amaf, owner, maxMoves = 3 * N * N) {
  const limit = b.moveCount + maxMoves;
  while (b.passes < 2 && b.moveCount < limit) {
    const p = playoutMove(b);
    if (p !== PASS && amaf[p] === 0) amaf[p] = b.toPlay;
    b.play(p);
  }
  return b.playoutScore(owner);
}

// ---------------------------------------------------------------- tree

class Node {
  constructor(move, color) {
    this.move = move;     // move that led here
    this.color = color;   // player who made it; stats are from their perspective
    this.children = null;
    this.n = 0; this.w = 0;       // real visits / wins
    this.pn = 0; this.pw = 0;     // prior pseudo-visits / wins
    this.an = 0; this.aw = 0;     // AMAF visits / wins
    this.scoreSum = 0;            // sum of final scores (black - white - komi)
  }
  urgency(raveEquiv) {
    const v = this.n + this.pn;
    const expectation = (this.w + this.pw) / v;
    if (this.an === 0) return expectation;
    const beta = this.an / (this.an + v + v * this.an / raveEquiv);
    return beta * (this.aw / this.an) + (1 - beta) * expectation;
  }
}

// Common-fate-graph distance from the last move (stones in one chain count as one node).
function cfgDistances(b, from, maxDist) {
  const dist = new Int8Array(SIZE).fill(-1);
  if (from === PASS) return dist;
  const color = b.color;
  dist[from] = 0;
  let frontier = [from];
  const spread = (list, d) => {
    // Flood through same-colour stones at equal distance (0-cost edges).
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (color[p] !== BLACK && color[p] !== WHITE) continue;
      for (const dd of D4) {
        const q = p + dd;
        if (dist[q] === -1 && color[q] === color[p]) { dist[q] = d; list.push(q); }
      }
    }
    return list;
  };
  spread(frontier, 0);
  for (let d = 1; d <= maxDist; d++) {
    const nextF = [];
    for (const p of frontier) for (const dd of D4) {
      const q = p + dd;
      if (dist[q] === -1 && color[q] !== EDGE) { dist[q] = d; nextF.push(q); }
    }
    frontier = spread(nextF, d);
  }
  return dist;
}

// Is there no stone within Manhattan distance 3 of p?
function emptyArea(b, p) {
  const x0 = ptX(p), y0 = ptY(p), color = b.color;
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    if (Math.abs(dx) + Math.abs(dy) > 3) continue;
    const x = x0 + dx, y = y0 + dy;
    if (x < 0 || y < 0 || x >= N || y >= N) continue;
    const c = color[(y + 1) * W + x + 1];
    if (c === BLACK || c === WHITE) return false;
  }
  return true;
}

const lineHeight = p => Math.min(ptX(p), ptY(p), N - 1 - ptX(p), N - 1 - ptY(p));

function expand(node, b, forbidden) {
  const P = PARAMS, c = b.toPlay;
  const children = [];
  const byMove = new Map();
  for (const p of POINTS) {
    if (!b.isLegal(p, c) || b.isEyeish(p, c)) continue;
    const child = new Node(p, c);
    if (forbidden && forbidden(p)) continue;
    child.pn = P.priorEven; child.pw = P.priorEven / 2;
    children.push(child);
    byMove.set(p, child);
  }
  const t = [];
  atariMovesAll(b, t);
  for (let i = 0; i < t.length; i += 2) {
    const ch = byMove.get(t[i]);
    if (!ch) continue;
    const bonus = t[i + 1] === 2 ? P.priorCaptureMany : P.priorCaptureOne;
    ch.pn += bonus; ch.pw += bonus;
  }
  if (b.lastMove !== PASS) {
    const t3 = [];
    for (const p of POINTS) if (b.color[p] === EMPTY && matchesPat3(b.color, p)) t3.push(p);
    for (const p of t3) { const ch = byMove.get(p); if (ch) { ch.pn += P.priorPat3; ch.pw += P.priorPat3; } }
  }
  const cfg = cfgDistances(b, b.lastMove, P.priorCfg.length);
  for (const ch of children) {
    const p = ch.move;
    const d = cfg[p];
    if (d >= 1 && d <= P.priorCfg.length) { ch.pn += P.priorCfg[d - 1]; ch.pw += P.priorCfg[d - 1]; }
    const h = lineHeight(p);
    if (h <= 2 && emptyArea(b, p)) {
      ch.pn += P.priorEmptyArea;
      if (h === 2) ch.pw += P.priorEmptyArea;
    }
    if (b.isSelfAtari(p, c, 1)) ch.pn += P.priorSelfAtari;
  }
  if (!children.length) children.push(Object.assign(new Node(PASS, c), { pn: 1, pw: 0.5 }));
  node.children = children;
}

export class Search {
  // opts: { komi, forbidden(p) => bool for root superko, seed }
  constructor(board, opts = {}) {
    this.root = new Node(board.lastMove, 3 - board.toPlay);
    this.board = board.clone();
    this.komi = opts.komi ?? 7;
    this.forbidden = opts.forbidden || null;
    this.work = new Board();
    this.amaf = new Uint8Array(SIZE);
    this.owner = new Int8Array(POINTS.length);
    this.ownerSum = new Float64Array(POINTS.length);
    this.scoreSum = 0;
    this.blackWins = 0;
    this.playouts = 0;
    this.path = [];
    expand(this.root, this.board, this.forbidden);
    // Passing is always an option at the root; its value is learned like any move.
    if (!this.root.children.some(ch => ch.move === PASS)) {
      const pass = new Node(PASS, board.toPlay);
      pass.pn = 10; pass.pw = 1;
      this.root.children.push(pass);
    }
  }

  run(count) {
    const P = PARAMS, b = this.work, amaf = this.amaf, path = this.path;
    for (let it = 0; it < count; it++) {
      b.copyFrom(this.board);
      amaf.fill(0);
      path.length = 0;
      let node = this.root;
      node.n++;
      path.push(node);
      while (node.children && b.passes < 2) {
        const kids = node.children;
        let best = null, bestU = -1;
        const s = randInt(kids.length);
        for (let k = 0; k < kids.length; k++) {
          const ch = kids[(s + k) % kids.length];
          const u = ch.urgency(P.raveEquiv);
          if (u > bestU) { bestU = u; best = ch; }
        }
        node = best;
        if (node.move !== PASS && amaf[node.move] === 0) amaf[node.move] = b.toPlay;
        b.play(node.move);
        node.n++;
        path.push(node);
        if (!node.children && node.n >= P.expandVisits && b.passes < 2) expand(node, b, null);
      }
      const raw = playout(b, amaf, this.owner);
      const score = raw - this.komi;
      const winner = score > 0 ? BLACK : score < 0 ? WHITE : 0;
      this.playouts++;
      this.scoreSum += score;
      if (winner === BLACK) this.blackWins++; else if (winner === 0) this.blackWins += 0.5;
      const owner = this.owner, os = this.ownerSum;
      for (let i = 0; i < os.length; i++) os[i] += owner[i];

      for (let i = path.length - 1; i >= 0; i--) {
        const nd = path[i];
        nd.w += winner === nd.color ? 1 : winner === 0 ? 0.5 : 0;
        nd.scoreSum += score;
        if (nd.children) {
          const toPlay = 3 - nd.color; // colour choosing among children
          const win = winner === toPlay ? 1 : winner === 0 ? 0.5 : 0;
          for (const ch of nd.children) {
            if (ch.move !== PASS && amaf[ch.move] === toPlay) { ch.an++; ch.aw += win; }
          }
        }
      }
    }
  }

  // Summary for UI / move choice. Winrates are for the root player to move.
  results(maxMoves = 12) {
    const root = this.root, n = Math.max(1, this.playouts);
    const toPlay = this.board.toPlay;
    const moves = root.children
      .filter(ch => ch.n > 0)
      .map(ch => ({
        move: ch.move,
        visits: ch.n,
        winrate: ch.w / ch.n,
        score: ch.scoreSum / ch.n,  // black perspective
        prior: (ch.pw / ch.pn),
      }))
      .sort((a, b) => b.visits - a.visits);
    return {
      toPlay,
      playouts: this.playouts,
      winrate: toPlay === BLACK ? this.blackWins / n : 1 - this.blackWins / n,
      blackWinrate: this.blackWins / n,
      score: this.scoreSum / n,
      ownership: Array.from(this.ownerSum, v => v / n),
      moves: moves.slice(0, maxMoves),
      allMoves: moves,
    };
  }

  bestMove() {
    let best = null;
    for (const ch of this.root.children) if (!best || ch.n > best.n) best = ch;
    return best ? best.move : PASS;
  }
}
