// Batched network evaluation for the search: fills the inputs, runs each
// position under a random board symmetry (as KataGo does, so the net's small
// asymmetries average out over a search), maps the outputs back and caches them.
import { AREA } from './board.js';
import { fillInputs, SPATIAL, GLOBAL } from './features.js';

// SYM[k][p]: where point p goes under symmetry k (flat 9x9 indices).
export const SYM = [];
for (let k = 0; k < 8; k++) {
  const m = new Int16Array(AREA);
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
    let a = x, b = y;
    if (k & 1) a = 8 - a;
    if (k & 2) b = 8 - b;
    if (k & 4) [a, b] = [b, a];
    m[y * 9 + x] = b * 9 + a;
  }
  SYM.push(m);
}

export class Evaluator {
  // net: a Net (model.js); opts: { maxBatch, cacheSize, symmetry: fixed k or -1 for random, rand }
  constructor(net, { maxBatch = 8, cacheSize = 50000, symmetry = -1, rand = Math.random } = {}) {
    this.net = net;
    this.maxBatch = maxBatch;
    this.symmetry = symmetry;
    this.rand = rand;
    this.spatial = new Float32Array(maxBatch * AREA * SPATIAL);
    this.global = new Float32Array(maxBatch * GLOBAL);
    this.row = new Float32Array(AREA * SPATIAL);
    this.cache = new Map();
    this.cacheSize = cacheSize;
    this.evals = 0;       // positions actually run through the net
    this.netMs = 0;
  }

  // positions: feature inputs (see fillInputs) each with a `key` for the cache.
  // Resolves to outputs: { policyLogits (82), win, loss, noResult, lead, scoreMean,
  // ownership (81) }, side to move's view, in the positions' own orientation.
  async evaluate(positions) {
    const out = new Array(positions.length), todo = [];
    for (let i = 0; i < positions.length; i++) {
      const hit = positions[i].key && this.cache.get(positions[i].key);
      if (hit) out[i] = hit; else todo.push(i);
    }
    for (let at = 0; at < todo.length; at += this.maxBatch) {
      const chunk = todo.slice(at, at + this.maxBatch), syms = [];
      chunk.forEach((i, j) => {
        const k = this.symmetry >= 0 ? this.symmetry : (this.rand() * 8) | 0;
        syms.push(k);
        fillInputs(positions[i], this.row, this.global, 0, j * GLOBAL);
        const map = SYM[k], base = j * AREA * SPATIAL;
        for (let p = 0; p < AREA; p++) this.spatial.set(this.row.subarray(p * SPATIAL, (p + 1) * SPATIAL), base + map[p] * SPATIAL);
      });
      const t0 = performance.now();
      const res = await this.net.evaluate(this.spatial, this.global, chunk.length);
      this.netMs += performance.now() - t0;
      this.evals += chunk.length;
      chunk.forEach((i, j) => {
        const r = res[j], map = SYM[syms[j]];
        const logits = new Float32Array(AREA + 1), own = new Float32Array(AREA);
        for (let p = 0; p < AREA; p++) { logits[p] = r.policyLogits[map[p]]; own[p] = r.ownership[map[p]]; }
        logits[AREA] = r.policyLogits[AREA];
        out[i] = { ...r, policyLogits: logits, ownership: own };
        const key = positions[i].key;
        if (key) {
          if (this.cache.size >= this.cacheSize) this.cache.delete(this.cache.keys().next().value);
          this.cache.set(key, out[i]);
        }
      });
    }
    return out;
  }

  // Positions per second of net time so far.
  get rate() { return this.netMs ? this.evals / (this.netMs / 1000) : 0; }
}
