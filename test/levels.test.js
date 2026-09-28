// AI levels on KataGo: the move chooser that weakens them, the pass rule on
// 1-visit reads, and the shape of the level table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PASS, parsePt, ptName } from '../src/board.js';
import { LEVELS, chooseKataMove, shouldPass } from '../src/coach.js';
import { Game } from '../src/game.js';
import { Evaluator } from '../src/katago/evaluator.js';
import { loadNet } from '../tools/katago-node.js';
import { levelMove } from '../tools/play-level.js';

const P = parsePt;
// A seeded random stream, so draws are repeatable.
const seeded = (s = 7) => () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
const draws = (res, kata, n = 1000) => { const rand = seeded(), seen = new Map(); for (let i = 0; i < n; i++) { const m = ptName(chooseKataMove(res, kata, rand)); seen.set(m, (seen.get(m) || 0) + 1); } return seen; };
const RES = {
  allMoves: [{ move: P('E5'), visits: 90, prior: 0.5 }, { move: P('D4'), visits: 8, prior: 0.3 }, { move: P('A1'), visits: 2, prior: 0.001 }],
  policy: [{ move: P('E5'), prior: 0.5 }, { move: P('D4'), prior: 0.3 }, { move: P('C3'), prior: 0.199 }, { move: P('A1'), prior: 0.001 }, { move: PASS, prior: 0 }],
};

test('chooseKataMove: temperature 0 plays the most-visited move', () => {
  assert.equal(ptName(chooseKataMove(RES, { visits: 100, temp: 0 })), 'E5');
});

test('chooseKataMove: a searched level draws by visits, above the floor', () => {
  const seen = draws(RES, { visits: 100, temp: 1, floor: 0.05 });
  assert.ok(seen.get('D4') > 0 && seen.get('E5') > seen.get('D4'));
  assert.ok(!seen.has('A1'), 'A1 is below the floor (2 < 90 × 0.05)');
  assert.ok(!seen.has('C3'), 'a searched level only picks moves the search visited');
});

test('chooseKataMove: a 1-visit level draws from the network\'s instinct', () => {
  const seen = draws(RES, { visits: 1, temp: 1, floor: 0.1 });
  assert.ok(seen.get('C3') > 0, 'C3 was never visited but is a plausible instinct');
  assert.ok(!seen.has('A1'), 'A1 is below the floor');
  assert.ok(!seen.has('pass'));
});

test('chooseKataMove: a miss can be any legal move', () => {
  const seen = draws(RES, { visits: 1, temp: 0.5, floor: 0.5, miss: 1 });
  assert.ok(seen.get('A1') > 0, 'even a very unlikely move turns up');
  assert.ok(!seen.has('pass'));
});

test('chooseKataMove: mirror images vary; nothing to play means pass', () => {
  const sym = { allMoves: [{ move: P('C3'), visits: 50, prior: 0.2, twins: [P('G3'), P('C7'), P('G7')] }], policy: [] };
  assert.equal(draws(sym, { visits: 50, temp: 0 }).size, 4);
  assert.equal(chooseKataMove({ allMoves: [], policy: [{ move: PASS, prior: 1 }] }, { visits: 1, temp: 1 }), PASS);
});

test('chooseKataMove: passes when passing is the top instinct or the most-visited move', () => {
  const done = { allMoves: [], policy: [{ move: PASS, prior: 0.9 }, { move: P('A1'), prior: 0.1 }] };
  assert.equal(chooseKataMove(done, { visits: 1, temp: 1.5, floor: 0.002, miss: 0 }), PASS);
  const searched = { allMoves: [{ move: PASS, visits: 40, prior: 0.6 }, { move: P('A1'), visits: 5, prior: 0.1 }], policy: [] };
  assert.equal(chooseKataMove(searched, { visits: 48, temp: 0.2, floor: 0.01 }), PASS);
});

test('shouldPass: a 1-visit read (no visited moves) decides by the network\'s instinct', () => {
  const game = new Game({ komi: 7 });
  const own = new Array(81).fill(0);
  assert.equal(shouldPass(game, { allMoves: [], policy: [{ move: P('E5'), prior: 0.4 }, { move: PASS, prior: 0.01 }], ownership: own, score: 0 }, game.toPlay), false);
  assert.equal(shouldPass(game, { allMoves: [], policy: [{ move: PASS, prior: 0.9 }], ownership: own, score: 0 }, game.toPlay), true);
});

test('LEVELS: nine levels on KataGo, Dragon at 128 visits, Phoenix thinking longer with a cap', () => {
  assert.deepEqual(LEVELS.map(l => l.name), ['Pebble', 'Seedling', 'Sprout', 'Reed', 'Stream', 'River', 'Mountain', 'Dragon', 'Phoenix']);
  for (const l of LEVELS) {
    assert.ok(l.kata && l.kata.visits >= 1, `${l.name} has a KataGo recipe`);
    assert.ok(l.playouts > 0, `${l.name} keeps its built-in fallback`);
  }
  const dragon = LEVELS[7], phoenix = LEVELS[8];
  assert.deepEqual([dragon.kata.visits, dragon.kata.temp], [128, 0]);
  assert.ok(phoenix.kata.visits > 128 && phoenix.maxTime === 10000);
  assert.equal(phoenix.playouts, dragon.playouts, 'Phoenix falls back to built-in Dragon');
  for (let i = 1; i < LEVELS.length; i++) assert.ok(LEVELS[i].kata.visits >= LEVELS[i - 1].kata.visits, 'stronger levels read at least as much');
});

test('levelMove plays a legal move for a KataGo level and for its built-in fallback', async () => {
  const evaluator = new Evaluator((await loadNet()).net);
  const game = new Game({ komi: 7 });
  for (const lv of [LEVELS[0], LEVELS[5]]) {
    const { move, results } = await levelMove(game, lv, { engine: 'katago', evaluator });
    assert.ok(game.check(move).ok, `${lv.name}: ${ptName(move)}`);
    assert.ok(results.policy.length > 1, 'a KataGo read carries the instinct for every move');
  }
  const { move } = await levelMove(game, LEVELS[0], { engine: 'builtin' });
  assert.ok(game.check(move).ok);
});

test('two Pebbles finish a game by passing', async () => {
  const evaluator = new Evaluator((await loadNet()).net);
  const rand = seeded(11), game = new Game({ komi: 7 });
  while (!game.isOver() && game.current.depth < 200) game.play((await levelMove(game, LEVELS[0], { engine: 'katago', evaluator, rand })).move);
  assert.ok(game.isOver(), `still playing after ${game.current.depth} moves`);
  assert.ok(game.current.depth > 30, `passed too early (${game.current.depth} moves)`);
});
