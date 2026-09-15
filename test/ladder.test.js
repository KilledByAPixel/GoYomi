import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Board, BLACK, WHITE, pt } from '../src/board.js';
import { ladderCapture, ladderThreat } from '../src/ladder.js';
import { explainMove } from '../src/coach.js';

// White E5 with black stones on E6, D5 and F4: a textbook ladder start.
const START = ['.........', '.........', '.........', '....X....', '...XO....', '.....X...', '.........', '.........', '.........'];
// Adds single stones ([x, y, 'X'|'O']) to the START shape.
const withStones = (...stones) => {
  const r = START.map(row => [...row]);
  for (const [x, y, ch] of stones) r[y][x] = ch;
  return r.map(row => row.join(''));
};

test('a ladder on an empty board works', () => {
  const seq = ladderThreat(Board.fromRows(START, BLACK), pt(4, 4));
  assert.ok(seq && seq.length > 6, 'black captures by chasing');
});

test('breakers on both ladder paths let the stones escape', () => {
  // Black can chase towards the lower left (starting F5) or the upper right (starting E4).
  const one = Board.fromRows(withStones([1, 6, 'O']), BLACK);
  assert.ok(ladderThreat(one, pt(4, 4)), 'one breaker: the other direction still works');
  const both = Board.fromRows(withStones([1, 6, 'O'], [6, 2, 'O']), BLACK);
  assert.equal(ladderThreat(both, pt(4, 4)), null);
});

test('a stone far from both paths does not break the ladder', () => {
  assert.ok(ladderThreat(Board.fromRows(withStones([0, 0, 'O']), BLACK), pt(4, 4)));
});

test('atari with room to run is not a ladder', () => {
  const b = Board.fromRows(['.........', '.........', '.........', '....X....', '...XOX...', '.........', '.........', '.........', '.........'], WHITE);
  assert.equal(ladderCapture(b, pt(4, 4)), null);
});

test('escaping by capturing an attacker in atari', () => {
  // White E5 in atari (lib E4) but black F5 is itself in atari: white captures instead of running.
  const b = Board.fromRows(['.........', '.........', '.........', '....XO...', '...XOXO..', '.....O...', '.........', '.........', '.........'], WHITE);
  assert.equal(ladderCapture(b, pt(4, 4)), null);
});

test('explanations mention the ladder', () => {
  const before = Board.fromRows(START, BLACK);
  const after = before.clone();
  after.play(pt(5, 4)); // F5 — atari, white can only run into the ladder
  const text = explainMove(before, after, pt(5, 4)).join(' ');
  assert.match(text, /ladder/);
});
