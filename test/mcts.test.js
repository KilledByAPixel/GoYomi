import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Board, BLACK, WHITE, pt, ptName, POINTS, N, ptX, ptY } from '../src/board.js';
import { Search, seed } from '../src/mcts.js';

const best = (b, playouts, komi = 7) => {
  const s = new Search(b, { komi });
  s.run(playouts);
  return { move: s.bestMove(), r: s.results() };
};

test('captures a group in atari that could otherwise escape', () => {
  seed(7);
  // White D6/D5 has one liberty at D4; if black doesn't take it, white runs into open space.
  const b = Board.fromRows([
    '.........',
    '.........',
    '...X.....',
    '..XOX....',
    '..XOX....',
    '.........',
    '.........',
    '.........',
    '.........',
  ], BLACK);
  const { move } = best(b, 4000);
  assert.equal(ptName(move), ptName(pt(3, 5)));
});

test('escapes from atari when it can', () => {
  seed(8);
  const b = Board.fromRows([
    '.........',
    '.........',
    '.........',
    '...O.....',
    '..OXO....',
    '..OXO....',
    '.........',
    '.........',
    '.........',
  ], BLACK);
  const { move } = best(b, 6000);
  assert.equal(ptName(move), ptName(pt(3, 6)));
});

test('opening move is not on the first two lines', () => {
  seed(9);
  const { move, r } = best(new Board(), 4000);
  const h = Math.min(ptX(move), ptY(move), N - 1 - ptX(move), N - 1 - ptY(move));
  assert.ok(h >= 2, `opened at ${ptName(move)}`);
  assert.ok(r.blackWinrate > 0.3 && r.blackWinrate < 0.7);
  assert.equal(r.ownership.length, POINTS.length);
});

test('ownership reflects a clearly won area', () => {
  seed(10);
  // Black wall on column E (x=4); white wall on column F (x=5). Left side black, right white.
  const rows = Array.from({ length: 9 }, () => '....XO...');
  const s = new Search(Board.fromRows(rows, BLACK), { komi: 7 });
  s.run(2000);
  const r = s.results();
  assert.ok(r.ownership[POINTS.indexOf(pt(0, 0))] > 0.5, 'top-left owned by black');
  assert.ok(r.ownership[POINTS.indexOf(pt(8, 8))] < -0.5, 'bottom-right owned by white');
  // Black has 45 points, white 36 + 7 komi = 43 → black should be winning.
  assert.ok(r.blackWinrate > 0.6, `black winrate ${r.blackWinrate}`);
});
