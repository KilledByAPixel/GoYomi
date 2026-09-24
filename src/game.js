// Game record: a tree of positions (so take-backs and "what if" branches are
// never lost), rule checks with human-readable reasons, scoring and SGF.
import { Board, BLACK, WHITE, EMPTY, PASS, N, POINTS, pt, ptX, ptY, ptName } from './board.js';

let nextId = 1;

export class GameNode {
  constructor(parent, move, color, board) {
    this.id = nextId++;
    this.parent = parent;
    this.move = move;          // PASS for root / pass
    this.color = color;        // who played the move (0 at root)
    this.board = board;        // position after the move
    this.children = [];
    this.lastChild = null;     // branch to follow on redo
    this.captured = [];        // points captured by this move
    this.analysis = null;      // coach results for this position
    this.comment = '';
    this.depth = parent ? parent.depth + 1 : 0;
  }
  get isPass() { return this.parent !== null && this.move === PASS; }
}

// Standard 9x9 handicap points (star points on the 3-3 and tengen).
const HANDICAP = {
  2: [[6, 2], [2, 6]],
  3: [[6, 2], [2, 6], [6, 6]],
  4: [[6, 2], [2, 6], [6, 6], [2, 2]],
  5: [[6, 2], [2, 6], [6, 6], [2, 2], [4, 4]],
};

export class Game {
  constructor({ komi = 7, handicap = 0, setup = null } = {}) {
    this.komi = komi;
    this.handicap = handicap;
    const board = new Board();
    const stones = setup ? [...setup] : (HANDICAP[handicap] || []).map(([x, y]) => [pt(x, y), BLACK]);
    for (const [p, c] of stones) { board.toPlay = c; board.play(p); }
    // Handicap stones mean white moves first; explicit setups default to black.
    board.toPlay = stones.length && !setup ? WHITE : BLACK;
    board.ko = 0; board.lastMove = PASS; board.lastMove2 = PASS; board.passes = 0; board.moveCount = 0;
    board.captures = [0, 0, 0];
    this.setup = stones;
    this.root = new GameNode(null, PASS, 0, board);
    this.current = this.root;
  }

  get board() { return this.current.board; }
  get toPlay() { return this.current.board.toPlay; }

  // Positions seen on the way to node (inclusive), for positional superko.
  hashesTo(node = this.current) {
    const set = new Set();
    for (let n = node; n; n = n.parent) set.add(n.board.hash);
    return set;
  }

  // { ok, reason } — reason is one of 'occupied', 'ko', 'suicide', 'superko', 'over'.
  check(p, node = this.current) {
    if (p === PASS) return { ok: true };
    const b = node.board;
    if (b.color[p] !== EMPTY) return { ok: false, reason: 'occupied' };
    if (p === b.ko) return { ok: false, reason: 'ko' };
    if (!b.isLegal(p)) return { ok: false, reason: 'suicide' };
    const t = b.clone();
    t.play(p);
    if (this.hashesTo(node).has(t.hash)) return { ok: false, reason: 'superko' };
    return { ok: true };
  }

  // Plays at the current node. Re-uses an existing branch with the same move.
  play(p) {
    const node = this.current;
    const existing = node.children.find(ch => ch.move === p);
    if (existing) { node.lastChild = existing; this.current = existing; return existing; }
    const r = this.check(p, node);
    if (!r.ok) return null;
    const b = node.board.clone();
    const color = b.toPlay;
    const before = b.color.slice();
    b.play(p);
    const child = new GameNode(node, p, color, b);
    if (p !== PASS) for (const q of POINTS) if (before[q] === 3 - color && b.color[q] === EMPTY) child.captured.push(q);
    node.children.push(child);
    node.lastChild = child;
    this.current = child;
    return child;
  }

  pass() { return this.play(PASS); }
  undo() { if (this.current.parent) this.current = this.current.parent; return this.current; }
  redo() {
    const n = this.current.lastChild || this.current.children[0];
    if (n) this.current = n;
    return this.current;
  }
  goTo(node) {
    this.current = node;
    for (let n = node; n.parent; n = n.parent) n.parent.lastChild = n;
  }

  // Root → current, then onward along remembered branches.
  line(node = this.current) {
    const path = [];
    for (let n = node; n; n = n.parent) path.unshift(n);
    let n = node;
    while (n.lastChild || n.children[0]) { n = n.lastChild || n.children[0]; path.push(n); }
    return path;
  }

  isOver(node = this.current) { return node.board.passes >= 2; }

  deleteBranch(node) {
    const parent = node.parent;
    if (!parent) return;
    parent.children = parent.children.filter(c => c !== node);
    if (parent.lastChild === node) parent.lastChild = parent.children[0] || null;
    let inside = false;
    for (let n = this.current; n; n = n.parent) if (n === node) inside = true;
    if (inside) this.current = parent;
  }

  // Area (Chinese) scoring with a set of dead stones. Also reports the
  // territory (Japanese-style) count for comparison.
  score(dead = new Set(), node = this.current) {
    const b = node.board;
    const { black, white, owner } = b.areaScore(dead);
    let deadB = 0, deadW = 0, terrB = 0, terrW = 0;
    for (const p of POINTS) {
      if (dead.has(p)) { if (b.color[p] === BLACK) deadB++; else if (b.color[p] === WHITE) deadW++; }
      const isEmptyNow = b.color[p] === EMPTY || dead.has(p);
      if (isEmptyNow) { if (owner[p] === BLACK) terrB++; else if (owner[p] === WHITE) terrW++; }
    }
    const margin = black - white - this.komi;
    const japB = terrB + b.captures[BLACK] + deadW;
    const japW = terrW + b.captures[WHITE] + deadB;
    return {
      black, white, komi: this.komi, margin, owner,
      winner: margin > 0 ? BLACK : margin < 0 ? WHITE : 0,
      text: margin === 0 ? 'Draw (jigo)' : `${margin > 0 ? 'B' : 'W'}+${Math.abs(margin)}`,
      territory: { black: terrB, white: terrW, capturesB: b.captures[BLACK] + deadW, capturesW: b.captures[WHITE] + deadB,
        margin: japB - japW - this.komi },
    };
  }

  // Moves (and setup) needed to recreate a node's position elsewhere, e.g. in a worker.
  recipe(node = this.current) {
    const moves = [];
    for (let n = node; n.parent; n = n.parent) moves.unshift([n.move, n.color]);
    return { setup: this.setup, whiteFirst: this.root.board.toPlay === WHITE, moves, komi: this.komi };
  }

  // ------------------------------------------------------------------ SGF

  toSGF({ black = 'Black', white = 'White', result = '' } = {}) {
    const coord = p => p === PASS ? '' : String.fromCharCode(97 + ptX(p)) + String.fromCharCode(97 + ptY(p));
    const esc = s => s.replace(/\\/g, '\\\\').replace(/]/g, '\\]');
    let s = `(;GM[1]FF[4]CA[UTF-8]AP[GoDojo]SZ[${N}]KM[${this.komi}]RU[Chinese]PB[${esc(black)}]PW[${esc(white)}]`;
    if (this.handicap) s += `HA[${this.handicap}]`;
    if (result) s += `RE[${result}]`;
    const ab = this.setup.filter(([, c]) => c === BLACK), aw = this.setup.filter(([, c]) => c === WHITE);
    if (ab.length) s += 'AB' + ab.map(([p]) => `[${coord(p)}]`).join('');
    if (aw.length) s += 'AW' + aw.map(([p]) => `[${coord(p)}]`).join('');
    if (this.setup.length) s += `PL[${this.root.board.toPlay === WHITE ? 'W' : 'B'}]`;
    if (this.root.comment) s += `C[${esc(this.root.comment)}]`;
    const walk = node => {
      let out = '';
      let n = node;
      while (n.children.length === 1) {
        n = n.children[0];
        out += `;${n.color === BLACK ? 'B' : 'W'}[${coord(n.move)}]` + (n.comment ? `C[${esc(n.comment)}]` : '');
      }
      if (n.children.length > 1) {
        for (const ch of n.children) {
          out += `(;${ch.color === BLACK ? 'B' : 'W'}[${coord(ch.move)}]` + (ch.comment ? `C[${esc(ch.comment)}]` : '') + walk(ch) + ')';
        }
      }
      return out;
    };
    return s + walk(this.root) + ')';
  }

  static fromSGF(text) {
    let i = 0;
    const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };
    const parseNode = () => {
      const props = {};
      ws();
      while (i < text.length && /[A-Za-z]/.test(text[i])) {
        let id = '';
        while (i < text.length && /[A-Za-z]/.test(text[i])) { if (text[i] === text[i].toUpperCase()) id += text[i]; i++; }
        const vals = [];
        ws();
        while (text[i] === '[') {
          i++;
          let v = '';
          while (i < text.length && text[i] !== ']') { if (text[i] === '\\') i++; v += text[i++]; }
          i++;
          vals.push(v);
          ws();
        }
        props[id] = vals;
      }
      return props;
    };
    const parseTree = () => {
      ws();
      if (text[i] !== '(') throw new Error('SGF: expected (');
      i++;
      const seq = [];
      ws();
      while (text[i] === ';') { i++; seq.push(parseNode()); ws(); }
      const vars = [];
      while (text[i] === '(') { vars.push(parseTree()); ws(); }
      if (text[i] !== ')') throw new Error('SGF: expected )');
      i++;
      return { seq, vars };
    };
    const start = text.indexOf('(');
    if (start < 0) throw new Error('Not an SGF file');
    i = start;
    const tree = parseTree();
    const rootProps = tree.seq[0] || {};
    const sz = rootProps.SZ ? parseInt(rootProps.SZ[0], 10) : 19; // SGF's default size is 19
    if (sz !== N) throw new Error(`that is a ${sz}x${sz} game; only ${N}x${N} is supported`);
    const toPt = v => {
      if (!v || v === 'tt') return PASS;
      const x = v.charCodeAt(0) - 97, y = v.charCodeAt(1) - 97;
      if (v.length !== 2 || x < 0 || x >= N || y < 0 || y >= N) throw new Error(`coordinate "${v}" is outside a ${N}x${N} board`);
      return pt(x, y);
    };
    const setup = [];
    for (const v of rootProps.AB || []) setup.push([toPt(v), BLACK]);
    for (const v of rootProps.AW || []) setup.push([toPt(v), WHITE]);
    const km = parseFloat(((rootProps.KM || [])[0] || '').replace(',', '.'));
    const komi = Number.isFinite(km) ? km : 7;
    const handicap = rootProps.HA ? +rootProps.HA[0] || 0 : 0;
    const game = new Game({ komi, setup: setup.length ? setup : [] });
    game.handicap = handicap;
    const pl = rootProps.PL && rootProps.PL[0].toUpperCase();
    if (pl === 'W' || pl === 'B') game.root.board.toPlay = pl === 'W' ? WHITE : BLACK;
    else if (handicap && setup.length) game.root.board.toPlay = WHITE; // handicap: White moves first
    if (rootProps.C) game.root.comment = rootProps.C[0];
    const apply = (seq, from) => {
      let node = from;
      for (const props of seq) {
        const col = props.B ? BLACK : props.W ? WHITE : 0;
        if (!col) continue;
        game.current = node;
        node.board.toPlay = col; // trust the record about whose turn it is
        const mv = toPt((props.B || props.W)[0]);
        const child = game.play(mv);
        if (!child) throw new Error(`Illegal move in SGF: ${ptName(mv)}`);
        if (props.C) child.comment = props.C[0];
        node = child;
      }
      return node;
    };
    const walk = (t, from, skipFirst) => {
      const end = apply(skipFirst ? t.seq.slice(1) : t.seq, from);
      for (const v of t.vars) walk(v, end, false);
    };
    walk(tree, game.root, true);
    game.current = game.root;
    // Follow the first (main) variation everywhere by default.
    const stack = [game.root];
    while (stack.length) {
      const n = stack.pop();
      n.lastChild = n.children[0] || null;
      stack.push(...n.children);
    }
    return game;
  }
}

export function reasonText(reason) {
  return {
    occupied: 'There is already a stone there.',
    ko: 'Ko! You can\'t retake the ko immediately — play a move elsewhere first (a "ko threat").',
    suicide: 'Suicide is not allowed: that stone would have no liberties and capture nothing.',
    superko: 'That would repeat an earlier board position (superko rule).',
  }[reason] || '';
}

export const colorName = c => c === BLACK ? 'Black' : c === WHITE ? 'White' : '';
export { ptName };
