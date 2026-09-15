// Fast 9x9 Go board used by both the game and the Monte-Carlo search.
//
// Points are indices into a padded (N+2)x(N+2) array so neighbours never
// need bounds checks. Stones are grouped into chains stored as circular
// linked lists. Each chain tracks *pseudo-liberties* (one per stone/empty
// adjacency, duplicates allowed) plus their sum and sum of squares: a chain
// is in atari exactly when all its pseudo-liberties are the same point,
// i.e. when sum^2 == count * sumSq (Cauchy-Schwarz equality).

export const N = 9;
export const W = N + 2;
export const SIZE = W * W;
export const EMPTY = 0, BLACK = 1, WHITE = 2, EDGE = 3;
export const PASS = -1;
export const D4 = [-W, -1, 1, W];
export const DIAG = [-W - 1, -W + 1, W - 1, W + 1];

export const pt = (x, y) => (y + 1) * W + (x + 1);
export const ptX = p => (p % W) - 1;
export const ptY = p => ((p / W) | 0) - 1;
export const opp = c => 3 - c;

// All on-board points, in row order.
export const POINTS = [];
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) POINTS.push(pt(x, y));

// Human coordinates: columns A..J skipping I, row 1 at the bottom.
const COLS = 'ABCDEFGHJ';
export function ptName(p) {
  if (p === PASS) return 'pass';
  return COLS[ptX(p)] + (N - ptY(p));
}
export function parsePt(s) {
  s = s.trim().toUpperCase();
  if (s === 'PASS') return PASS;
  const x = COLS.indexOf(s[0]), row = parseInt(s.slice(1), 10);
  if (x < 0 || !(row >= 1 && row <= N)) return null;
  return pt(x, N - row);
}

// Zobrist keys from a fixed-seed PRNG so hashes are reproducible.
let seed = 0x9e3779b9;
const rand32 = () => {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  return seed >>> 0;
};
const ZA = [null, new Uint32Array(SIZE), new Uint32Array(SIZE)];
const ZB = [null, new Uint32Array(SIZE), new Uint32Array(SIZE)];
for (let c = 1; c <= 2; c++) for (let p = 0; p < SIZE; p++) { ZA[c][p] = rand32(); ZB[c][p] = rand32(); }

export class Board {
  constructor() {
    this.color = new Uint8Array(SIZE);
    this.head = new Int16Array(SIZE);
    this.next = new Int16Array(SIZE);
    this.size = new Int16Array(SIZE);
    this.libs = new Int32Array(SIZE);
    this.libSum = new Int32Array(SIZE);
    this.libSumSq = new Int32Array(SIZE);
    this.mark = new Int32Array(SIZE);
    this.stamp = 0;
    this.ko = 0;            // point that is illegal for toPlay because of ko (0 = none)
    this.toPlay = BLACK;
    this.lastMove = PASS;   // PASS also means "none"
    this.lastMove2 = PASS;
    this.passes = 0;
    this.moveCount = 0;
    this.captures = [0, 0, 0]; // stones captured BY each colour
    this.hashA = 0; this.hashB = 0;
    // Unordered list of empty points, for fast random move picks.
    this.empty = new Int16Array(N * N);
    this.emptyIdx = new Int16Array(SIZE);
    this.emptyCount = 0;
    this.color.fill(EDGE);
    for (const p of POINTS) {
      this.color[p] = EMPTY;
      this.emptyIdx[p] = this.emptyCount;
      this.empty[this.emptyCount++] = p;
    }
  }

  clone() { const b = new Board(); b.copyFrom(this); return b; }

  copyFrom(o) {
    this.color.set(o.color); this.head.set(o.head); this.next.set(o.next);
    this.size.set(o.size); this.libs.set(o.libs); this.libSum.set(o.libSum);
    this.libSumSq.set(o.libSumSq);
    this.ko = o.ko; this.toPlay = o.toPlay; this.lastMove = o.lastMove;
    this.lastMove2 = o.lastMove2; this.passes = o.passes; this.moveCount = o.moveCount;
    this.captures[1] = o.captures[1]; this.captures[2] = o.captures[2];
    this.hashA = o.hashA; this.hashB = o.hashB;
    this.empty.set(o.empty); this.emptyIdx.set(o.emptyIdx); this.emptyCount = o.emptyCount;
  }

  // 53-bit positional hash (stones only).
  get hash() { return this.hashA * 2097152 + (this.hashB >>> 11); }

  inAtari(h) {
    const n = this.libs[h];
    return n > 0 && this.libSum[h] * this.libSum[h] === n * this.libSumSq[h];
  }
  // Only valid when inAtari(h).
  atariLib(h) { return this.libSum[h] / this.libs[h]; }

  isLegal(p, c = this.toPlay) {
    if (p === PASS) return true;
    const color = this.color;
    if (color[p] !== EMPTY || p === this.ko && c === this.toPlay) return false;
    for (let i = 0; i < 4; i++) {
      const q = p + D4[i], cq = color[q];
      if (cq === EMPTY) return true;
      if (cq === EDGE) continue;
      const atari = this.inAtari(this.head[q]);
      if (cq === c ? !atari : atari) return true;
    }
    return false;
  }

  // Plays a move for toPlay. Caller must ensure legality. Returns stones captured.
  play(p) {
    const c = this.toPlay, o = 3 - c;
    this.ko = 0;
    this.lastMove2 = this.lastMove;
    this.lastMove = p;
    this.toPlay = o;
    this.moveCount++;
    if (p === PASS) { this.passes++; return 0; }
    this.passes = 0;

    const { color, head, next, size, libs, libSum, libSumSq } = this;
    const ei = this.emptyIdx[p], moved = this.empty[--this.emptyCount];
    this.empty[ei] = moved; this.emptyIdx[moved] = ei;
    color[p] = c; head[p] = p; next[p] = p; size[p] = 1;
    libs[p] = 0; libSum[p] = 0; libSumSq[p] = 0;
    this.hashA ^= ZA[c][p]; this.hashB ^= ZB[c][p];
    const pp = p * p;

    for (let i = 0; i < 4; i++) {
      const q = p + D4[i], cq = color[q];
      if (cq === EMPTY) { libs[p]++; libSum[p] += q; libSumSq[p] += q * q; }
      else if (cq !== EDGE) { const h = head[q]; libs[h]--; libSum[h] -= p; libSumSq[h] -= pp; }
    }
    for (let i = 0; i < 4; i++) {
      const q = p + D4[i];
      if (color[q] === c && head[q] !== head[p]) this.merge(head[p], head[q]);
    }
    let captured = 0, capPoint = 0;
    for (let i = 0; i < 4; i++) {
      const q = p + D4[i];
      if (color[q] === o && libs[head[q]] === 0) {
        captured += size[head[q]];
        capPoint = q;
        this.removeChain(head[q]);
      }
    }
    if (captured) {
      this.captures[c] += captured;
      const h = head[p];
      if (captured === 1 && size[h] === 1 && libs[h] === 1) this.ko = capPoint;
    }
    return captured;
  }

  merge(a, b) {
    const { head, next, size, libs, libSum, libSumSq } = this;
    if (size[a] < size[b]) { const t = a; a = b; b = t; }
    let s = b;
    do { head[s] = a; s = next[s]; } while (s !== b);
    const t = next[a]; next[a] = next[b]; next[b] = t;
    size[a] += size[b]; libs[a] += libs[b];
    libSum[a] += libSum[b]; libSumSq[a] += libSumSq[b];
  }

  removeChain(h) {
    const { color, head, next, libs, libSum, libSumSq } = this;
    const c = color[h];
    let s = h;
    do {
      color[s] = EMPTY;
      this.hashA ^= ZA[c][s]; this.hashB ^= ZB[c][s];
      this.emptyIdx[s] = this.emptyCount; this.empty[this.emptyCount++] = s;
      s = next[s];
    } while (s !== h);
    s = h;
    do {
      for (let i = 0; i < 4; i++) {
        const q = s + D4[i], cq = color[q];
        if (cq === BLACK || cq === WHITE) {
          const hq = head[q]; libs[hq]++; libSum[hq] += s; libSumSq[hq] += s * s;
        }
      }
      s = next[s];
    } while (s !== h);
  }

  // Stones of the chain containing p.
  chainStones(p) {
    const out = [], h = this.head[p];
    let s = h;
    do { out.push(s); s = this.next[s]; } while (s !== h);
    return out;
  }

  // Distinct liberties of the chain containing p.
  chainLibs(p) {
    const out = [], st = ++this.stamp, h = this.head[p];
    let s = h;
    do {
      for (let i = 0; i < 4; i++) {
        const q = s + D4[i];
        if (this.color[q] === EMPTY && this.mark[q] !== st) { this.mark[q] = st; out.push(q); }
      }
      s = this.next[s];
    } while (s !== h);
    return out;
  }

  libCount(p) { return this.chainLibs(p).length; }

  // Heads of distinct enemy chains adjacent to the chain containing p.
  adjacentEnemyChains(p) {
    const out = [], st = ++this.stamp, h = this.head[p], o = 3 - this.color[p];
    let s = h;
    do {
      for (let i = 0; i < 4; i++) {
        const q = s + D4[i];
        if (this.color[q] === o) {
          const hq = this.head[q];
          if (this.mark[hq] !== st) { this.mark[hq] = st; out.push(hq); }
        }
      }
      s = this.next[s];
    } while (s !== h);
    return out;
  }

  // Number of distinct liberties (capped at max) the chain at p would have
  // after colour c plays there. Assumes p is empty.
  libsAfter(p, c, max = 2) {
    const color = this.color, mark = this.mark, head = this.head, next = this.next;
    const st = ++this.stamp, o = 3 - c;
    let n = 0;
    mark[p] = st;
    for (let i = 0; i < 4; i++) {
      const q = p + D4[i];
      if (color[q] === EMPTY) { mark[q] = st; if (++n >= max) return n; }
    }
    // Liberties of friendly chains that merge with p. Chain heads are stones,
    // never liberties, so marking them with the same stamp is safe.
    for (let i = 0; i < 4; i++) {
      const q = p + D4[i];
      if (color[q] !== c) continue;
      const h = head[q];
      if (mark[h] === st) continue;
      mark[h] = st;
      let s = h;
      do {
        for (let j = 0; j < 4; j++) {
          const r = s + D4[j];
          if (color[r] === EMPTY && mark[r] !== st) { mark[r] = st; if (++n >= max) return n; }
        }
        s = next[s];
      } while (s !== h);
    }
    // Captured enemy stones become liberties where they touch the new chain.
    for (let i = 0; i < 4; i++) {
      const q = p + D4[i];
      if (color[q] !== o) continue;
      const h = head[q];
      if (!this.inAtari(h)) continue;
      let s = h;
      do {
        if (mark[s] !== st) {
          let touches = false;
          for (let j = 0; j < 4 && !touches; j++) {
            const r = s + D4[j];
            touches = r === p || color[r] === c && mark[head[r]] === st;
          }
          if (touches) { mark[s] = st; if (++n >= max) return n; }
        }
        s = next[s];
      } while (s !== h);
    }
    return n;
  }

  // Would c playing at p form a chain of `minSize`+ stones in atari (or dead)?
  isSelfAtari(p, c, minSize = 1) {
    if (this.libsAfter(p, c, 2) >= 2) return false;
    if (minSize <= 1) return true;
    let sz = 1;
    const st = ++this.stamp;
    for (let i = 0; i < 4; i++) {
      const q = p + D4[i];
      if (this.color[q] !== c) continue;
      const h = this.head[q];
      if (this.mark[h] !== st) { this.mark[h] = st; sz += this.size[h]; }
    }
    return sz >= minSize;
  }

  // Single-point eye-like shape for c: all orthogonal neighbours are c (or edge)
  // and the diagonals don't make it a false eye.
  isEyeish(p, c) {
    const color = this.color;
    for (let i = 0; i < 4; i++) {
      const cq = color[p + D4[i]];
      if (cq !== c && cq !== EDGE) return false;
    }
    let bad = 0, edge = 0;
    const o = 3 - c;
    for (let i = 0; i < 4; i++) {
      const cq = color[p + DIAG[i]];
      if (cq === o) bad++; else if (cq === EDGE) edge = 1;
    }
    return bad + edge < 2;
  }

  // Area score (black minus white, no komi) of a position where every empty
  // point is surrounded by one colour — i.e. the end of a playout.
  playoutScore(owner) {
    const color = this.color;
    let s = 0;
    for (let i = 0; i < POINTS.length; i++) {
      const p = POINTS[i];
      let c = color[p];
      if (c === EMPTY) {
        let b = 0, w = 0;
        for (let j = 0; j < 4; j++) { const q = color[p + D4[j]]; if (q === BLACK) b = 1; else if (q === WHITE) w = 1; }
        c = b && !w ? BLACK : w && !b ? WHITE : 0;
      }
      if (c === BLACK) { s++; if (owner) owner[i] = 1; }
      else if (c === WHITE) { s--; if (owner) owner[i] = -1; }
      else if (owner) owner[i] = 0;
    }
    return s;
  }

  // Tromp-Taylor area: stones plus empty regions reaching only one colour.
  // dead (optional Set of points) are treated as removed and credited to the other side.
  areaScore(dead) {
    const color = new Uint8Array(this.color);
    if (dead) for (const p of dead) color[p] = EMPTY;
    const owner = new Int8Array(SIZE); // 1 black, 2 white, 0 neutral
    const seen = new Uint8Array(SIZE);
    let black = 0, white = 0;
    for (const p of POINTS) {
      if (color[p] === BLACK) { black++; owner[p] = BLACK; continue; }
      if (color[p] === WHITE) { white++; owner[p] = WHITE; continue; }
      if (seen[p]) continue;
      const region = [p], stack = [p];
      seen[p] = 1;
      let touch = 0;
      while (stack.length) {
        const q = stack.pop();
        for (const d of D4) {
          const r = q + d, cr = color[r];
          if (cr === EMPTY) { if (!seen[r]) { seen[r] = 1; region.push(r); stack.push(r); } }
          else if (cr !== EDGE) touch |= cr;
        }
      }
      if (touch === BLACK || touch === WHITE) {
        for (const q of region) owner[q] = touch;
        if (touch === BLACK) black += region.length; else white += region.length;
      }
    }
    return { black, white, owner };
  }

  toString() {
    let s = '';
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) s += '.XO'[this.color[pt(x, y)]];
      s += '\n';
    }
    return s;
  }

  // Build from rows like ['X.O......', ...]; X = black, O = white.
  static fromRows(rows, toPlay = BLACK) {
    const b = new Board();
    const stones = [];
    rows.forEach((row, y) => [...row].forEach((ch, x) => {
      if (ch === 'X' || ch === 'x') stones.push([pt(x, y), BLACK]);
      else if (ch === 'O' || ch === 'o') stones.push([pt(x, y), WHITE]);
    }));
    for (const [p, c] of stones) { b.toPlay = c; b.play(p); }
    b.toPlay = toPlay; b.ko = 0; b.lastMove = PASS; b.lastMove2 = PASS;
    b.moveCount = 0; b.passes = 0; b.captures = [0, 0, 0];
    return b;
  }
}
