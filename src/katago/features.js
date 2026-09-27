// KataGo's v7 input features (cpp/neuralnet/nninputs.cpp, fillRowV7) for
// GoYomi's rules: area scoring, positional superko, no suicide, friendly pass.
//
// Ported from Web KaTrain (src/engine/katago/featuresV7Fast.ts, historyV7.ts).
// Copyright (c) 2026 Web KatRain Contributors. MIT License.
import { AREA, PASS_MOVE, EMPTY, other, libertyMap, areaMap, ladders } from './board.js';

export const SPATIAL = 22, GLOBAL = 19;

const libs = new Uint8Array(AREA), area = new Uint8Array(AREA);
const lad0 = new Uint8Array(AREA), lad1 = new Uint8Array(AREA), lad2 = new Uint8Array(AREA), working = new Uint8Array(AREA);

// How many recent moves the net sees, and whether a pass would end the game.
// With friendly passing, a pass right after the opponent's does end the game,
// but KataGo shows such positions as if it wouldn't, with no history.
export function historyFeatures(recent, pla) {
  const last = recent.length - 1;
  const afterPass = last >= 0 && recent[last].move === PASS_MOVE;
  const afterTwoPasses = afterPass && last >= 1 && recent[last - 1].move === PASS_MOVE;
  if (afterPass && !afterTwoPasses) return { turns: 0, passEnds: false };
  let cap = 5;
  // After a finished game, keep only its final pass and what came after.
  for (let k = 0; k < cap && last - k > 0; k++) {
    if (recent[last - k].move === PASS_MOVE && recent[last - k - 1].move === PASS_MOVE) { cap = k + 1; break; }
  }
  let turns = 0, expect = other(pla);
  for (let k = 0; k < cap; k++) {
    const m = recent[last - k];
    if (!m || m.color !== expect) break;
    turns++;
    expect = other(expect);
  }
  return { turns, passEnds: afterPass };
}

// pos: { stones, ko, pla, recent: [{move, color}] oldest first, komi (White's),
//        banned (Uint8Array or null: superko-illegal points),
//        prev, prevPrev ({stones, ko} of the positions 1 and 2 moves back) }
// Writes one NHWC row into spatial (at offset) and global (at gOffset).
export function fillInputs(pos, spatial, global, offset = 0, gOffset = 0) {
  const { stones, pla, recent } = pos, opp = other(pla);
  const sp = spatial, o = offset;
  sp.fill(0, o, o + AREA * SPATIAL);
  global.fill(0, gOffset, gOffset + GLOBAL);
  const set = (p, c) => { sp[o + p * SPATIAL + c] = 1; };

  libertyMap(stones, libs);
  for (let p = 0; p < AREA; p++) {
    set(p, 0);
    const c = stones[p];
    if (c === EMPTY) continue;
    set(p, c === pla ? 1 : 2);
    const l = libs[p];
    if (l >= 1 && l <= 3) set(p, 2 + l);
  }
  if (pos.ko >= 0) set(pos.ko, 6);
  if (pos.banned) for (let p = 0; p < AREA; p++) if (pos.banned[p]) set(p, 6);

  const hist = historyFeatures(recent, pla);
  const expect = [opp, pla, opp, pla, opp];
  for (let i = 0; i < hist.turns; i++) {
    const m = recent[recent.length - 1 - i];
    if (m.color !== expect[i]) break;
    if (m.move === PASS_MOVE) global[gOffset + i] = 1;
    else set(m.move, 9 + i);
  }

  // Ladders now, and on the boards one and two moves back.
  const prev = hist.turns < 1 ? pos : pos.prev || pos;
  const prevPrev = hist.turns < 2 ? prev : pos.prevPrev || prev;
  ladders(stones, pos.ko, lad0, working, opp);
  ladders(prev.stones, prev.ko, lad1);
  ladders(prevPrev.stones, prevPrev.ko, lad2);
  areaMap(stones, area);
  for (let p = 0; p < AREA; p++) {
    if (lad0[p]) set(p, 14);
    if (lad1[p]) set(p, 15);
    if (lad2[p]) set(p, 16);
    if (working[p]) set(p, 17);
    if (area[p] === pla) set(p, 18);
    else if (area[p] === opp) set(p, 19);
  }

  const g = gOffset;
  const selfKomi = pla === 2 ? pos.komi : -pos.komi;
  const bound = AREA + 20;
  const komi = Math.max(-bound, Math.min(bound, selfKomi));
  global[g + 5] = komi / 20;
  global[g + 6] = 1; global[g + 7] = 0.5;   // positional superko
  global[g + 14] = hist.passEnds ? 1 : 0;
  // Area scoring on an odd board: the komi parity wave.
  const floor = Math.floor((komi - 1) / 2) * 2 + 1;
  const delta = Math.max(0, Math.min(2, komi - floor));
  global[g + 18] = delta < 0.5 ? delta : delta < 1.5 ? 1 - delta : delta - 2;
}
