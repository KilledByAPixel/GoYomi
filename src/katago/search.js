// PUCT search guided by the KataGo network, in the style of KataGo's own:
// policy priors, value backup, first-play urgency reduction, a small score
// utility so won games keep being played well, and batches of leaves
// gathered with virtual loss (small batches help GPUs). Returns results in
// the same shape as Search.results() in mcts.js, with playouts = visits.
import { BLACK, WHITE, EMPTY, PASS, POINTS, N as SIZE, pt, ptX, ptY, boardSymmetries } from '../board.js';
import { estimateDead } from '../coach.js';
import { AREA, PASS_MOVE } from './board.js';
import { policyProbs } from './model.js';

export const PARAMS = {
  cpuct: 1.0, cpuctLog: 0.45, cpuctBase: 500,
  fpuReduction: 0.2, rootFpuReduction: 0.1,
  staticScore: 0.1, dynamicScore: 0.3, scoreScale: 0.75 * SIZE,
  pvMinVisits: 2,
  // Utility for whoever ends the game with the second pass. Filling in your own
  // territory costs nothing under area scoring, so without it a finished game
  // could go on and on.
  endBonus: 0.1,
};

const toFlat = p => p === PASS ? PASS_MOVE : ptY(p) * SIZE + ptX(p);
const toPt = m => m === PASS_MOVE ? PASS : pt(m % SIZE, (m / SIZE) | 0);
const sign = c => c === BLACK ? 1 : -1;

function flatStones(b, out = new Uint8Array(AREA)) {
  for (let i = 0; i < AREA; i++) out[i] = b.color[POINTS[i]];
  return out;
}
const snapshot = b => ({ stones: flatStones(b), ko: b.ko ? toFlat(b.ko) : -1, hash: `${b.hashA},${b.hashB}` });

class Node {
  constructor(move, prior) {
    this.move = move;       // flat move that led here (PASS_MOVE for pass)
    this.prior = prior;
    this.n = 0; this.vl = 0;
    // Sums over visits, all from Black's view: utility, win probability, lead.
    this.u = 0; this.win = 0; this.lead = 0;
    this.moves = null;      // Int16Array of legal moves, best prior first
    this.priors = null;
    this.kids = null;       // child nodes, created on first visit
    this.own = null;        // net ownership here (Black's view), for counting after two passes
    this.terminal = null;
    this.pending = false;
  }
}

export class KataSearch {
  // root: buildPosition() result ({ board, seen, history }); opts: { komi, evaluator, batch }
  constructor(root, { komi, evaluator, batch = 8 }) {
    this.board = root.board.clone();
    this.seen = root.seen;
    this.komi = komi;
    this.evaluator = evaluator;
    this.batch = batch;
    // Recent moves (flat) and the last three positions, for the net's history features.
    const h = root.history;
    this.recent = h.slice(1).slice(-6).map(e => ({ move: toFlat(e.move), color: e.color }));
    this.snaps = h.slice(-3).map(e => snapshot(e.board));
    this.root = new Node(PASS_MOVE, 1);
    this.ownSum = new Float64Array(AREA);
    this.center = null;     // score the dynamic score utility is centred on
    this.twins = new Map();
    this.work = this.board.clone();
    this.tmp = this.board.clone();
  }

  get playouts() { return this.root.n; }

  // Utility for Black of a win probability and lead.
  utility(win, loss, lead) {
    const P = PARAMS, su = x => Math.atan(x / P.scoreScale) * (2 / Math.PI);
    return win - loss + P.staticScore * su(lead) + P.dynamicScore * su(lead - (this.center ?? lead));
  }

  // Legal moves for the side to move of b (flat, pass included), and the
  // points positional superko bans (for the net's ko feature).
  legalMoves(b, path) {
    const legal = new Uint8Array(AREA + 1), banned = new Uint8Array(AREA);
    legal[AREA] = 1;
    const c = b.toPlay, t = this.tmp;
    for (let i = 0; i < AREA; i++) {
      const p = POINTS[i];
      if (b.color[p] !== EMPTY || !b.isLegal(p, c)) continue;
      t.copyFrom(b);
      t.play(p);
      if (this.seen.has(t.hash) || path.has(t.hash)) { banned[i] = 1; continue; }
      legal[i] = 1;
    }
    return { legal, banned };
  }

  // Follows the tree to a leaf, adding virtual loss. Returns { path, leaf, pos } where
  // pos is the leaf's net input (null for a finished game).
  select() {
    const b = this.work;
    b.copyFrom(this.board);
    const path = [this.root], hashes = new Set();
    const recent = this.recent.slice(), snaps = this.snaps.slice();
    let node = this.root;
    node.vl++;
    while (node.kids && !node.terminal) {
      const child = this.pick(node, b.toPlay, node === this.root);
      recent.push({ move: child.move, color: b.toPlay });
      b.play(toPt(child.move));
      hashes.add(b.hash);
      snaps.push(snapshot(b));
      if (snaps.length > 3) snaps.shift();
      path.push(child);
      child.vl++;
      node = child;
      // A finished game never gets kids: count it on the first visit only.
      if (!node.kids && !node.terminal && b.passes >= 2) node.terminal = this.finish(b, path[path.length - 2]);
    }
    if (node.terminal || node.pending) return { path, leaf: node, pos: null };
    const { legal, banned } = this.legalMoves(b, hashes);
    const cur = snaps[snaps.length - 1];
    const tail = recent.slice(-6);
    // Everything the inputs depend on: the recent moves with their colours (history
    // features) and the two boards before this one (ladder features), not just the stones.
    const prev = snaps[snaps.length - 2], prevPrev = snaps[snaps.length - 3];
    const key = `${b.hashA},${b.hashB},${b.toPlay},${cur.ko},${this.komi},${tail.map(m => m.move + ':' + m.color).join('.')},${prev ? prev.hash : ''},${prevPrev ? prevPrev.hash : ''}` +
      (banned.some(Boolean) ? ',' + banned.join('') : '');
    const pos = {
      stones: cur.stones, ko: cur.ko, pla: b.toPlay, recent: tail, komi: this.komi, banned,
      prev: snaps[snaps.length - 2], prevPrev: snaps[snaps.length - 3], key,
    };
    return { path, leaf: node, pos, legal, toPlay: b.toPlay };
  }

  pick(node, c, isRoot) {
    const P = PARAMS, s = sign(c);
    const total = node.n + node.vl;
    const cpuct = P.cpuct + P.cpuctLog * Math.log((total + P.cpuctBase) / P.cpuctBase);
    const sq = Math.sqrt(total + 0.01);
    let visitedPolicy = 0;
    for (let i = 0; i < node.moves.length; i++) { const k = node.kids[i]; if (k && k.n + k.vl > 0) visitedPolicy += node.priors[i]; }
    const parentU = node.n ? s * node.u / node.n : 0;
    const fpu = parentU - (isRoot ? P.rootFpuReduction : P.fpuReduction) * Math.sqrt(visitedPolicy);
    let best = -1, bestV = -Infinity;
    for (let i = 0; i < node.moves.length; i++) {
      const k = node.kids[i], n = k ? k.n + k.vl : 0;
      // Virtual loss counts as a loss for the mover.
      const q = n > 0 ? (s * k.u - k.vl) / n : fpu;
      const v = q + cpuct * node.priors[i] * sq / (1 + n);
      if (v > bestV) { bestV = v; best = i; }
    }
    return node.kids[best] || (node.kids[best] = new Node(node.moves[best], node.priors[best]));
  }

  // Both players passed: count the board with the stones the net thinks dead removed.
  finish(b, parent) {
    const own = parent.own || new Float32Array(AREA);
    const dead = estimateDead(b, own);
    const a = b.areaScore(dead);
    const score = a.black - a.white - this.komi;
    const ownership = new Float32Array(AREA);
    for (let i = 0; i < AREA; i++) { const o = a.owner[POINTS[i]]; ownership[i] = o === BLACK ? 1 : o === WHITE ? -1 : 0; }
    const win = score > 0 ? 1 : score < 0 ? 0 : 0.5;
    const bonus = -sign(b.toPlay) * PARAMS.endBonus;
    return { win, loss: score < 0 ? 1 : score > 0 ? 0 : 0.5, lead: score, ownership, bonus };
  }

  // Leaf results into the leaf (expanding it) and up the path.
  backup({ path, leaf }, value, expand = null) {
    if (expand) {
      const { out, legal, toPlay } = expand;
      const probs = policyProbs(out.policyLogits, legal);
      const order = [];
      for (let i = 0; i <= AREA; i++) if (legal[i]) order.push(i);
      order.sort((a, b) => probs[b] - probs[a]);
      leaf.moves = Int16Array.from(order);
      leaf.priors = Float32Array.from(order, i => probs[i]);
      leaf.kids = new Array(order.length);
      leaf.own = Float32Array.from(out.ownership, x => sign(toPlay) * x);
      if (leaf === this.root) this.foldRoot();
    }
    const u = this.utility(value.win, value.loss, value.lead) + (value.bonus || 0);
    for (const nd of path) {
      nd.vl--;
      nd.n++; nd.u += u; nd.win += value.win; nd.lead += value.lead;
    }
    for (let i = 0; i < AREA; i++) this.ownSum[i] += value.ownership[i];
    leaf.pending = false;
  }

  // Picks up to max leaves for the net (fewer if they collide), with virtual
  // loss on their paths. Finished-game leaves are counted at once.
  gather(max) {
    const out = [];
    if (!this.root.kids && (this.root.pending || max < 1)) return out;
    const size = this.root.kids ? max : 1;
    for (let i = 0; i < size; i++) {
      const sel = this.select();
      if (sel.leaf.terminal) { this.backup(sel, sel.leaf.terminal); continue; }
      if (sel.leaf.pending) {
        // Collided with a leaf already waiting: take the virtual loss back and stop.
        for (const nd of sel.path) nd.vl--;
        break;
      }
      sel.leaf.pending = true;
      out.push(sel);
    }
    return out;
  }

  // Backs up the net's outputs for leaves from gather().
  apply(sels, outs) {
    sels.forEach((sel, i) => {
      const out = outs[i], s = sign(sel.toPlay);
      const win = s > 0 ? out.win : out.loss, loss = s > 0 ? out.loss : out.win;
      if (this.center === null) this.center = s * out.lead;
      const value = { win: win + out.noResult / 2, loss: loss + out.noResult / 2, lead: s * out.lead,
        ownership: Float32Array.from(out.ownership, x => s * x) };
      this.backup(sel, value, { out, legal: sel.legal, toPlay: sel.toPlay });
    });
  }

  // Runs until `visits` more visits are done, in batches.
  async run(visits) {
    const target = this.root.n + visits;
    while (this.root.n < target) {
      const sels = this.gather(Math.min(this.batch, target - this.root.n));
      if (sels.length) this.apply(sels, await this.evaluator.evaluate(sels.map(e => e.pos)));
    }
  }

  // On a symmetric board, search one move of each set of mirror images and
  // list the rest as its twins (with their priors added in), like mcts.js.
  foldRoot() {
    const syms = boardSymmetries(this.board);
    if (!syms.length) return;
    const r = this.root, idx = new Map();
    r.moves.forEach((m, i) => idx.set(m, i));
    const keep = [], taken = new Set();
    for (let i = 0; i < r.moves.length; i++) {
      const m = r.moves[i];
      if (taken.has(m)) continue;
      let prior = r.priors[i];
      const twins = new Set();
      if (m !== PASS_MOVE) {
        for (const map of syms) {
          const t = toFlat(map[toPt(m)]);
          if (t !== m && idx.has(t) && !taken.has(t)) { twins.add(t); taken.add(t); prior += r.priors[idx.get(t)]; }
        }
      }
      keep.push([m, prior]);
      if (twins.size) this.twins.set(m, [...twins].map(toPt));
    }
    r.moves = Int16Array.from(keep, k => k[0]);
    r.priors = Float32Array.from(keep, k => k[1]);
    r.kids = new Array(keep.length);
  }

  pv(node, max = 8) {
    const out = [];
    let n = node;
    while (n.kids && out.length < max) {
      let best = null;
      for (const k of n.kids) if (k && (!best || k.n > best.n)) best = k;
      if (!best || best.n < PARAMS.pvMinVisits) break;
      out.push(toPt(best.move));
      n = best;
    }
    return out;
  }

  results(maxMoves = 12) {
    const r = this.root, n = Math.max(1, r.n), toPlay = this.board.toPlay;
    const moves = [];
    if (r.kids) r.kids.forEach((k, i) => {
      if (!k || !k.n) return;
      const bw = k.win / k.n;
      moves.push({
        move: toPt(k.move), visits: k.n,
        winrate: toPlay === BLACK ? bw : 1 - bw,
        score: k.lead / k.n,
        prior: r.priors[i],
        pv: this.pv(k),
        ...(this.twins.has(k.move) && { twins: this.twins.get(k.move) }),
      });
    });
    moves.sort((a, b) => b.visits - a.visits || b.prior - a.prior);
    const blackWinrate = r.win / n;
    return {
      toPlay, playouts: r.n,
      winrate: toPlay === BLACK ? blackWinrate : 1 - blackWinrate,
      blackWinrate,
      score: r.lead / n,
      ownership: Array.from(this.ownSum, v => v / n),
      moves: moves.slice(0, maxMoves),
      allMoves: moves,
      // The network's instinct for every legal move, searched or not (weak levels choose from it).
      policy: r.moves ? Array.from(r.moves, (m, i) => ({
        move: toPt(m), prior: r.priors[i],
        ...(this.twins.has(m) && { twins: this.twins.get(m) }),
      })) : [],
    };
  }
}
