import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Board, BLACK, WHITE, PASS, pt, ptName, POINTS, N, ptX, ptY } from '../src/board.js';
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

// Finished position: the white stone at B5 is dead inside Black's area.
// Counted with it removed: B+2 at komi 7 (as the board stands: W+1).
const deadStoneRows = [
  'XXXXXOOOO',
  'XX.XXOO.O',
  'XXXXXOOOO',
  'XXXXXOOOO',
  '.OXXXOO.O',
  'XXXXXOOOO',
  'XXXXXOOOO',
  'XX.XXOO.O',
  'XXXXXOOOO',
];

test('two passes in the tree are counted with dead stones removed', () => {
  seed(11);
  const b = Board.fromRows(deadStoneRows, BLACK);
  b.play(PASS); // White can only pass back, ending the game in the tree
  const s = new Search(b, { komi: 7 });
  s.run(1000);
  const r = s.results();
  assert.ok(r.winrate < 0.05, `White winrate ${r.winrate} after Black's harmless pass`);
  assert.equal(r.score, 2);
  assert.ok(r.ownership[POINTS.indexOf(pt(1, 4))] > 0.9, 'dead B5 is Black\'s');
});

test('a finished board leaves dame neutral', () => {
  seed(12);
  const rows = [...deadStoneRows];
  rows[8] = 'XXXX.OOOO'; // E1 is dame: B+0.5 at komi 7.5, whoever would reach it first
  const b = Board.fromRows(rows, BLACK);
  b.play(PASS); b.play(PASS);
  const s = new Search(b, { komi: 7.5 });
  s.run(500);
  const r = s.results();
  assert.equal(r.blackWinrate, 1);
  assert.equal(r.score, 0.5);
  assert.equal(r.ownership[POINTS.indexOf(pt(4, 8))], 0);
});

test('symmetric root moves are searched once, with their twins listed', () => {
  seed(3);
  const s = new Search(new Board(), { komi: 7 });
  // One representative per orbit: the 15 points of a 1/8 triangle of the 9x9 board (+ pass).
  assert.equal(s.root.children.filter(ch => ch.move !== PASS).length, 15);
  const all = new Set();
  for (const ch of s.root.children) if (ch.move !== PASS) for (const p of [ch.move, ...(ch.twins || [])]) all.add(p);
  assert.equal(all.size, 81, 'every point is some move or its twin');
  const c3 = s.root.children.find(ch => [ch.move, ...(ch.twins || [])].includes(pt(2, 6)));
  assert.equal(c3.twins.length, 3, 'a 3-3 point has 4 images');
  s.run(2000);
  const r = s.results(40);
  assert.ok(r.allMoves.some(m => m.twins && m.twins.length === 7), 'results list the twins');
});
