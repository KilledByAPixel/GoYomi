// KataGo's board helpers for its neural-net inputs: liberty counts, pass-alive
// area (Benson) and ladder search, on a flat 9x9 array (index y*9+x; 0 empty,
// 1 black, 2 white). The net was trained on exactly these features, so they
// follow KataGo's C++ (cpp/game/board.cpp) step for step rather than reusing
// GoYomi's own board and ladder code.
//
// Ported from Web KaTrain (src/engine/katago/fastBoard.ts).
// Copyright (c) 2026 Web KatRain Contributors. MIT License.

export const S = 9, AREA = S * S, PASS_MOVE = AREA;
export const EMPTY = 0, BLACK = 1, WHITE = 2;
export const other = c => 3 - c;

// Neighbour lists: NB[NS[p] .. NS[p] + NC[p]).
export const NS = new Int16Array(AREA), NC = new Int8Array(AREA), NB = new Int16Array(AREA * 4);
{
  let k = 0;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const p = y * S + x;
    NS[p] = k;
    if (x > 0) NB[k++] = p - 1;
    if (x < S - 1) NB[k++] = p + 1;
    if (y > 0) NB[k++] = p - S;
    if (y < S - 1) NB[k++] = p + S;
    NC[p] = k - NS[p];
  }
}

// ---------------------------------------------------------------- chains

const VISITED = new Int32Array(AREA), LIB_VISITED = new Int32Array(AREA);
let bfsStamp = 0;
const GROUP = new Int16Array(AREA), STACK = new Int16Array(AREA);
let groupLen = 0;

// Flood-fills the chain at start into GROUP (length groupLen); returns its
// liberties, counting at most max of them.
function chain(stones, start, color, max, libBuf = null, libAt = 0) {
  const st = ++bfsStamp;
  let sp = 0, libs = 0;
  groupLen = 0;
  VISITED[start] = st;
  STACK[sp++] = start;
  while (sp > 0) {
    const p = STACK[--sp];
    GROUP[groupLen++] = p;
    for (let i = NS[p], e = i + NC[p]; i < e; i++) {
      const n = NB[i], c = stones[n];
      if (c === EMPTY) {
        if (libs < max && LIB_VISITED[n] !== st) {
          LIB_VISITED[n] = st;
          if (libBuf) libBuf[libAt + libs] = n;
          libs++;
        }
      } else if (c === color && VISITED[n] !== st) {
        VISITED[n] = st;
        STACK[sp++] = n;
      }
    }
  }
  return libs;
}

const libsCapped = (stones, p, cap) => stones[p] === EMPTY ? 0 : chain(stones, p, stones[p], cap);

// Liberties per stone, capped at 4 (0 on empty points).
const SEEN = new Int32Array(AREA);
let seenStamp = 0;
export function libertyMap(stones, out = new Uint8Array(AREA)) {
  out.fill(0);
  const st = ++seenStamp;
  for (let p = 0; p < AREA; p++) {
    const c = stones[p];
    if (c === EMPTY || SEEN[p] === st) continue;
    const libs = Math.min(4, chain(stones, p, c, 4));
    for (let i = 0; i < groupLen; i++) { out[GROUP[i]] = libs; SEEN[GROUP[i]] = st; }
  }
  return out;
}

// Plays move for player on a {stones, ko} position. Returns false (leaving it
// untouched) if illegal; captured stones go on caps for undo().
const PROCESSED = new Int32Array(AREA);
let processedStamp = 0;
export function play(pos, move, player, caps, undo, at) {
  undo.ko[at] = pos.ko;
  undo.capStart[at] = caps.length;
  if (move === PASS_MOVE) { pos.ko = -1; return true; }
  const stones = pos.stones;
  if (stones[move] !== EMPTY || pos.ko === move) return false;
  const opp = other(player);
  stones[move] = player;
  let total = 0, single = -1;
  const st = ++processedStamp;
  for (let i = NS[move], e = i + NC[move]; i < e; i++) {
    const n = NB[i];
    if (stones[n] !== opp || PROCESSED[n] === st) continue;
    const libs = chain(stones, n, opp, 1);
    for (let j = 0; j < groupLen; j++) PROCESSED[GROUP[j]] = st;
    if (libs) continue;
    for (let j = 0; j < groupLen; j++) { stones[GROUP[j]] = EMPTY; caps.push(GROUP[j]); }
    total += groupLen;
    single = total === 1 && groupLen === 1 ? GROUP[0] : -1;
  }
  const libs = chain(stones, move, player, 2);
  if (libs === 0) { unplay(pos, move, player, undo.ko[at], undo.capStart[at], caps); return false; }
  pos.ko = total === 1 && single >= 0 && groupLen === 1 && libs === 1 ? single : -1;
  return true;
}

export function unplay(pos, move, player, ko, capStart, caps) {
  const opp = other(player);
  if (move !== PASS_MOVE) pos.stones[move] = EMPTY;
  for (let i = capStart; i < caps.length; i++) pos.stones[caps[i]] = opp;
  caps.length = capStart;
  pos.ko = ko;
}

// ---------------------------------------------------------------- area

// Board::calculateArea with nonPassAliveStones, safeBigTerritories and
// unsafeBigTerritories all true, as KataGo feeds its v7 inputs: pass-alive
// groups and the territory they enclose, then big empty regions, then any
// other stones as they stand.
const GROUP_OF = new Int16Array(AREA), G_COLOR = new Uint8Array(AREA);
const G_START = new Int16Array(AREA), G_LEN = new Int16Array(AREA), G_FLAT = new Int16Array(AREA);
const REGION_OF = new Int16Array(AREA), NEXT_IN_REGION = new Int16Array(AREA);
const BORDERS_NPA = new Uint8Array(AREA);
const MAX_REGIONS = AREA;
const R_HEAD = new Int16Array(MAX_REGIONS), V_START = new Uint16Array(MAX_REGIONS), V_LEN = new Uint8Array(MAX_REGIONS);
const R_INTERNAL = new Uint8Array(MAX_REGIONS), R_OPP = new Uint8Array(MAX_REGIONS);
const V_LIST = new Int16Array(MAX_REGIONS * 4), QUEUE = new Int16Array(AREA);
const PLA_GROUPS = new Int16Array(AREA), KILLED = new Uint8Array(AREA), VITAL_COUNT = new Int16Array(AREA);

function buildGroups(stones) {
  GROUP_OF.fill(-1);
  let num = 0, flat = 0;
  for (let p = 0; p < AREA; p++) {
    const c = stones[p];
    if (c === EMPTY || GROUP_OF[p] !== -1) continue;
    const g = num++;
    G_COLOR[g] = c; G_START[g] = flat;
    let sp = 0, len = 0;
    STACK[sp++] = p; GROUP_OF[p] = g;
    while (sp > 0) {
      const cur = STACK[--sp];
      G_FLAT[flat++] = cur; len++;
      for (let i = NS[cur], e = i + NC[cur]; i < e; i++) {
        const n = NB[i];
        if (stones[n] === c && GROUP_OF[n] === -1) { GROUP_OF[n] = g; STACK[sp++] = n; }
      }
    }
    G_LEN[g] = len;
  }
  return num;
}

function touchesColor(stones, p, color) {
  for (let i = NS[p], e = i + NC[p]; i < e; i++) if (stones[NB[i]] === color) return true;
  return false;
}
function touchesGroup(stones, p, color, g) {
  for (let i = NS[p], e = i + NC[p]; i < e; i++) { const n = NB[i]; if (stones[n] === color && GROUP_OF[n] === g) return true; }
  return false;
}

function areaForPla(stones, numGroups, pla, result) {
  const opp = other(pla);
  REGION_OF.fill(-1);
  BORDERS_NPA.fill(0);
  let numRegions = 0, vitalTotal = 0, anyPla = false;

  // Regions are the connected empty-or-opponent areas. A pla group is vital to
  // a region if it touches every empty point of it.
  const buildRegion = (start, r) => {
    let tail = start, qh = 0, qt = 1;
    QUEUE[0] = start; REGION_OF[start] = r;
    while (qh !== qt) {
      const p = QUEUE[qh++];
      if (V_LEN[r] > 0 && stones[p] === EMPTY) {
        const vs = V_START[r];
        let len = 0;
        for (let i = 0; i < V_LEN[r]; i++) {
          const g = V_LIST[vs + i];
          if (touchesGroup(stones, p, pla, g)) V_LIST[vs + len++] = g;
        }
        V_LEN[r] = len;
      }
      if (R_INTERNAL[r] < 2 && !touchesColor(stones, p, pla)) R_INTERNAL[r]++;
      if (stones[p] === opp) R_OPP[r] = 1;
      NEXT_IN_REGION[p] = tail; tail = p;
      for (let i = NS[p], e = i + NC[p]; i < e; i++) {
        const n = NB[i], c = stones[n];
        if (c === pla || REGION_OF[n] !== -1) continue;
        REGION_OF[n] = r; QUEUE[qt++] = n;
      }
    }
    return tail;
  };

  for (let p = 0; p < AREA; p++) {
    if (REGION_OF[p] !== -1) continue;
    const c = stones[p];
    if (c !== EMPTY) { if (c === pla) anyPla = true; continue; }
    const r = numRegions++;
    R_HEAD[r] = p; V_START[r] = vitalTotal; V_LEN[r] = 0; R_INTERNAL[r] = 0; R_OPP[r] = 0;
    let len = 0;
    for (let i = NS[p], e = i + NC[p]; i < e; i++) {
      const n = NB[i];
      if (stones[n] !== pla) continue;
      const g = GROUP_OF[n];
      let dup = false;
      for (let j = 0; j < len; j++) if (V_LIST[vitalTotal + j] === g) { dup = true; break; }
      if (!dup) V_LIST[vitalTotal + len++] = g;
    }
    V_LEN[r] = len;
    NEXT_IN_REGION[p] = buildRegion(p, r);
    vitalTotal += V_LEN[r];
  }

  let numPla = 0;
  for (let g = 0; g < numGroups; g++) {
    if (G_COLOR[g] !== pla) continue;
    PLA_GROUPS[numPla++] = g; KILLED[g] = 0; VITAL_COUNT[g] = 0;
  }
  for (let r = 0; r < numRegions; r++)
    for (let j = 0; j < V_LEN[r]; j++) VITAL_COUNT[V_LIST[V_START[r] + j]]++;

  // Benson: repeatedly kill groups with fewer than two vital regions; a killed
  // group's regions stop counting for everyone else.
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < numPla; i++) {
      const g = PLA_GROUPS[i];
      if (KILLED[g] || VITAL_COUNT[g] >= 2) continue;
      KILLED[g] = 1; changed = true;
      for (let t = 0; t < G_LEN[g]; t++) {
        const cur = G_FLAT[G_START[g] + t];
        for (let k = NS[cur], e = k + NC[cur]; k < e; k++) {
          const r = REGION_OF[NB[k]];
          if (r < 0) continue;
          const head = R_HEAD[r];
          if (BORDERS_NPA[head]) continue;
          BORDERS_NPA[head] = 1;
          for (let u = 0; u < V_LEN[r]; u++) VITAL_COUNT[V_LIST[V_START[r] + u]]--;
        }
      }
    }
  }

  for (let i = 0; i < numPla; i++) {
    const g = PLA_GROUPS[i];
    if (!KILLED[g]) for (let t = 0; t < G_LEN[g]; t++) result[G_FLAT[G_START[g] + t]] = pla;
  }
  for (let r = 0; r < numRegions; r++) {
    const head = R_HEAD[r];
    const safe = anyPla && !BORDERS_NPA[head] && (R_INTERNAL[r] <= 1 || !R_OPP[r]);
    if (safe) {
      let cur = head;
      do { result[cur] = pla; cur = NEXT_IN_REGION[cur]; } while (cur !== head);
    } else if (anyPla && !R_OPP[r]) {
      let cur = head;
      do { if (result[cur] === EMPTY) result[cur] = pla; cur = NEXT_IN_REGION[cur]; } while (cur !== head);
    }
  }
}

export function areaMap(stones, out = new Uint8Array(AREA)) {
  out.fill(EMPTY);
  const numGroups = buildGroups(stones);
  areaForPla(stones, numGroups, BLACK, out);
  areaForPla(stones, numGroups, WHITE, out);
  for (let p = 0; p < AREA; p++) if (out[p] === EMPTY) out[p] = stones[p];
  return out;
}

// ---------------------------------------------------------------- ladders

// Board::searchIsLadderCaptured, as an explicit stack. A work budget stops
// pathological searches (KataGo's own is similar).
const LADDER_BUDGET = 25000;
const STACK_SIZE = (AREA * 3 / 2 + 2) | 0;
const L = {
  moves: new Int16Array(8192),
  starts: new Int32Array(STACK_SIZE), lens: new Int32Array(STACK_SIZE), cur: new Int32Array(STACK_SIZE),
  recMove: new Int16Array(STACK_SIZE), recPla: new Uint8Array(STACK_SIZE),
  undo: { ko: new Int16Array(STACK_SIZE), capStart: new Int32Array(STACK_SIZE) },
  caps: [],
};
const GROUP_COPY = new Int16Array(AREA), OPP_SEEN = new Int32Array(AREA), CONNECT_SEEN = new Int32Array(AREA);
const CAPTURED = new Int32Array(AREA);
let oppSeenStamp = 0, connectStamp = 0, capturedStamp = 0;

function isAdjacent(a, b) {
  const d = a - b;
  if (d === 1 || d === -1) return ((a / S) | 0) === ((b / S) | 0);
  return d === S || d === -S;
}

function immediateLibs(stones, p) {
  let n = 0;
  for (let i = NS[p], e = i + NC[p]; i < e; i++) if (stones[NB[i]] === EMPTY) n++;
  return n;
}

function wouldBeKoCapture(stones, p, pla) {
  if (stones[p] !== EMPTY) return false;
  const opp = other(pla);
  let capLoc = -1;
  for (let i = NS[p], e = i + NC[p]; i < e; i++) {
    const n = NB[i];
    if (stones[n] !== opp) return false;
    if (libsCapped(stones, n, 2) === 1) {
      if (capLoc !== -1) return false;
      capLoc = n;
    }
  }
  if (capLoc === -1) return false;
  return chain(stones, capLoc, opp, 2) === 1 && groupLen === 1;
}

function hasLibertyGainingCaptures(stones, p) {
  const pla = stones[p], opp = other(pla);
  chain(stones, p, pla, 2);
  const len = groupLen;
  GROUP_COPY.set(GROUP.subarray(0, len));
  for (let i = 0; i < len; i++) {
    const s = GROUP_COPY[i];
    for (let k = NS[s], e = k + NC[s]; k < e; k++) {
      const n = NB[k];
      if (stones[n] === opp && libsCapped(stones, n, 2) === 1) return true;
    }
  }
  return false;
}

function connectionLibsX2(stones, p, pla) {
  let n = 0;
  for (let i = NS[p], e = i + NC[p]; i < e; i++) {
    const q = NB[i];
    if (stones[q] !== pla) continue;
    const libs = libsCapped(stones, q, 20);
    if (libs > 1) n += libs * 2 - 3;
  }
  return n;
}

function boundLibsAfterPlay(stones, p, pla) {
  const opp = other(pla);
  let imm = 0, caps = 0, capLibs = 0, connLibs = 0, maxConn = 0;
  for (let i = NS[p], e = i + NC[p]; i < e; i++) {
    const n = NB[i], c = stones[n];
    if (c === EMPTY) imm++;
    else if (c === opp) {
      if (chain(stones, n, opp, 2) === 1) { caps++; capLibs += groupLen; }
    } else {
      const l = libsCapped(stones, n, 20) - 1;
      connLibs += l;
      if (l > maxConn) maxConn = l;
    }
  }
  return { lower: caps + Math.max(maxConn, imm), upper: imm + capLibs + connLibs };
}

const libsTmp = new Int16Array(16);
function libsAfterPlay(stones, p, pla, max) {
  if (stones[p] !== EMPTY) return 0;
  const opp = other(pla), cst = ++capturedStamp;
  let n = 0;
  const add = q => { for (let i = 0; i < n; i++) if (libsTmp[i] === q) return; libsTmp[n++] = q; };
  for (let i = NS[p], e = i + NC[p]; i < e; i++) {
    const q = NB[i], c = stones[q];
    if (c === EMPTY) { add(q); if (n >= max) return max; }
    else if (c === opp && chain(stones, q, opp, 2) === 1) {
      add(q); if (n >= max) return max;
      for (let j = 0; j < groupLen; j++) CAPTURED[GROUP[j]] = cst;
    }
  }
  const st = ++connectStamp;
  for (let i = NS[p], e = i + NC[p]; i < e; i++) {
    const q = NB[i];
    if (stones[q] !== pla || CONNECT_SEEN[q] === st) continue;
    chain(stones, q, pla, max);
    for (let j = 0; j < groupLen; j++) CONNECT_SEEN[GROUP[j]] = st;
    for (let j = 0; j < groupLen; j++) {
      const s = GROUP[j];
      for (let k = NS[s], e2 = k + NC[s]; k < e2; k++) {
        const r = NB[k];
        if (r === p) continue;
        const c = stones[r];
        if (c === EMPTY || c === opp && CAPTURED[r] === cst) { add(r); if (n >= max) return max; }
      }
    }
  }
  return n;
}

function libertyGainingCaptures(stones, p, buf, at) {
  const pla = stones[p], opp = other(pla), st = ++oppSeenStamp;
  chain(stones, p, pla, 2);
  const len = groupLen;
  GROUP_COPY.set(GROUP.subarray(0, len));
  let found = 0;
  for (let i = 0; i < len; i++) {
    const s = GROUP_COPY[i];
    for (let k = NS[s], e = k + NC[s]; k < e; k++) {
      const n = NB[k];
      if (stones[n] !== opp || OPP_SEEN[n] === st) continue;
      const libs = chain(stones, n, opp, 2, buf, at + found);
      for (let j = 0; j < groupLen; j++) OPP_SEEN[GROUP[j]] = st;
      if (libs === 1) found++;
    }
  }
  return found;
}

function searchIsLadderCaptured(pos, loc, defenderFirst) {
  const stones = pos.stones, c = stones[loc];
  if (c === EMPTY) return false;
  const libs0 = libsCapped(stones, loc, 3);
  if (libs0 > 2 || defenderFirst && libs0 > 1) return false;
  const pla = c, opp = other(pla);
  const koSaved = pos.ko;
  if (defenderFirst) pos.ko = -1;
  const { moves, starts, lens, cur, recMove, recPla, undo, caps } = L;
  let sp = 0, nodes = 0, ret = false, fromDeeper = false;
  cur[0] = -1; starts[0] = 0; lens[0] = 0;
  const pop = v => { ret = v; fromDeeper = true; sp--; };

  for (;;) {
    if (sp <= -1) { pos.ko = koSaved; return ret; }
    if (sp >= STACK_SIZE - 1) { pop(true); continue; }
    if (nodes >= LADDER_BUDGET) {
      for (let i = sp - 1; i >= 0; i--) unplay(pos, recMove[i], recPla[i], undo.ko[i], undo.capStart[i], caps);
      pos.ko = koSaved;
      return false;
    }
    const isDefender = defenderFirst ? (sp & 1) === 0 : (sp & 1) === 1;

    if (cur[sp] === -1) {
      const libs = libsCapped(stones, loc, 3);
      if (!isDefender && libs <= 1) { pop(true); continue; }
      if (!isDefender && libs >= 3) { pop(false); continue; }
      if (isDefender && libs >= 2) { pop(false); continue; }
      if (isDefender && pos.ko !== -1) { pop(false); continue; }
      const start = starts[sp];
      let len = 0;
      if (isDefender) {
        len = libertyGainingCaptures(stones, loc, moves, start);
        len += chain(stones, loc, pla, 1, moves, start + len);
        if (len <= 0) { pop(true); continue; }
        const b = boundLibsAfterPlay(stones, moves[start + len - 1], pla);
        if (b.lower >= 3) { pop(false); continue; }
        if (len === 1 && b.upper <= 1) { pop(true); continue; }
      } else {
        len = chain(stones, loc, pla, 2, moves, start);
        if (len !== 2) { pop(false); continue; }
        let a = immediateLibs(stones, moves[start]), b = immediateLibs(stones, moves[start + 1]);
        if (a === 0 && b === 0 && wouldBeKoCapture(stones, moves[start], opp) && wouldBeKoCapture(stones, moves[start + 1], opp) &&
            libsAfterPlay(stones, moves[start], pla, 3) <= 2 && libsAfterPlay(stones, moves[start + 1], pla, 3) <= 2 &&
            !hasLibertyGainingCaptures(stones, loc)) { pop(true); continue; }
        if (!isAdjacent(moves[start], moves[start + 1])) {
          if (a >= 3 && b >= 3) { pop(false); continue; }
          if (a >= 3) len = 1;
          else if (b >= 3) { moves[start] = moves[start + 1]; len = 1; }
        }
        if (len > 1) {
          a = a * 2 + connectionLibsX2(stones, moves[start], pla);
          b = b * 2 + connectionLibsX2(stones, moves[start + 1], pla);
          if (b > a) { const t = moves[start]; moves[start] = moves[start + 1]; moves[start + 1] = t; }
        }
      }
      lens[sp] = len;
      cur[sp] = 0;
    } else {
      if (fromDeeper) unplay(pos, recMove[sp], recPla[sp], undo.ko[sp], undo.capStart[sp], caps);
      if (isDefender && !ret || !isDefender && ret) { fromDeeper = true; sp--; continue; }
      cur[sp]++;
    }

    if (cur[sp] >= lens[sp]) { pop(isDefender); continue; }
    const move = moves[starts[sp] + cur[sp]], p = isDefender ? pla : opp;
    recMove[sp] = move; recPla[sp] = p;
    if (!play(pos, move, p, caps, undo, sp)) { ret = isDefender; fromDeeper = false; continue; }
    nodes++;
    sp++;
    cur[sp] = -1; starts[sp] = starts[sp - 1] + lens[sp - 1]; lens[sp] = 0;
  }
}

// A chain with two liberties: does the attacker capture it by playing either?
// Fills working with the liberties that work.
const twoLibs = new Int16Array(2);
const tmpUndo = { ko: new Int16Array(1), capStart: new Int32Array(1) };
function ladderAttackerFirst(pos, loc, working) {
  const stones = pos.stones, pla = stones[loc], opp = other(pla);
  if (chain(stones, loc, pla, 2, twoLibs, 0) !== 2) return false;
  const m0 = twoLibs[0], m1 = twoLibs[1];
  working.length = 0;
  L.caps.length = 0;
  for (const m of [m0, m1]) {
    if (!play(pos, m, opp, L.caps, tmpUndo, 0)) continue;
    const works = searchIsLadderCaptured(pos, loc, true);
    unplay(pos, m, opp, tmpUndo.ko[0], tmpUndo.capStart[0], L.caps);
    if (works) working.push(m);
  }
  return working.length > 0;
}

// Laddered stones (chains with 1 or 2 liberties that a ladder captures) and,
// if wanted, the liberties of opp's 2-liberty chains that start such a ladder.
const copy = { stones: new Uint8Array(AREA), ko: -1 };
const G_SEEN = new Int32Array(AREA), G_STONES = new Int16Array(AREA);
let gSeenStamp = 0;
export function ladders(stones, ko, outLaddered, outWorking = null, opp = 0) {
  outLaddered.fill(0);
  if (outWorking) outWorking.fill(0);
  const st = ++gSeenStamp, working = [];
  for (let p = 0; p < AREA; p++) {
    const c = stones[p];
    if (c === EMPTY || G_SEEN[p] === st) continue;
    const libs = chain(stones, p, c, 3);
    const len = groupLen;
    for (let i = 0; i < len; i++) G_SEEN[GROUP[i]] = st;
    if (libs !== 1 && libs !== 2) continue;
    G_STONES.set(GROUP.subarray(0, len));
    copy.stones.set(stones);
    copy.ko = ko;
    L.caps.length = 0;
    working.length = 0;
    const laddered = libs === 1 ? searchIsLadderCaptured(copy, p, true) : ladderAttackerFirst(copy, p, working);
    if (!laddered) continue;
    for (let i = 0; i < len; i++) outLaddered[G_STONES[i]] = 1;
    if (outWorking && libs === 2 && c === opp) for (const m of working) outWorking[m] = 1;
  }
}
