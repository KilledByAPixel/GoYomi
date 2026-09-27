import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Board, BLACK, WHITE, PASS, POINTS, parsePt, ptName } from '../src/board.js';
import { Game } from '../src/game.js';
import { boardFacts } from '../src/explain.js';

const P = parsePt;
const played = (before, name) => { const a = before.clone(); a.play(P(name)); return a; };
const types = facts => facts.map(f => f.type);

test('boardFacts: a capture', () => {
  const g = new Game();
  for (const m of 'A2 A1 B2 J9'.split(' ')) g.play(P(m));
  const before = g.board;
  g.play(P('B1'));
  const cap = boardFacts(before, g.board, P('B1')).find(f => f.type === 'capture');
  assert.deepEqual(cap.stones.map(ptName), ['A1']);
  assert.equal(cap.ko, false);
});

test('boardFacts: connecting two groups', () => {
  const g = new Game();
  for (const m of 'B1 J9 A2 J8'.split(' ')) g.play(P(m));
  const before = g.board;
  g.play(P('B2'));
  assert.equal(boardFacts(before, g.board, P('B2')).find(f => f.type === 'connect').groups, 2);
});

test('boardFacts: atari, with the ladder read', () => {
  // White E5 with black stones on E6, D5 and F4: F5 is atari, and running only leads into a ladder.
  const before = Board.fromRows(['.........', '.........', '.........', '....X....', '...XO....', '.....X...', '.........', '.........', '.........'], BLACK);
  const f = boardFacts(before, played(before, 'F5'), P('F5')).find(x => x.type === 'atari');
  assert.deepEqual(f.stones.map(ptName), ['E5']);
  assert.equal(f.double, false);
  assert.equal(f.trapped, 'ladder');
});

test('boardFacts: a stone between two enemy groups is only a cut candidate', () => {
  const before = Board.fromRows(['.........', '.........', '.........', '.........', '...O.O...', '.........', '.........', '.........', '.........'], BLACK);
  const facts = boardFacts(before, played(before, 'E5'), P('E5'));
  assert.ok(!types(facts).includes('cut'));
  assert.deepEqual(facts.find(f => f.type === 'separates').at.map(ptName).sort(), ['D5', 'F5']);
});

test('boardFacts: self-atari, own eye, opening shape and passes', () => {
  const empty = new Board();
  assert.deepEqual(boardFacts(empty, played(empty, 'E5'), P('E5')), [{ type: 'shape', shape: 'opening' }]);
  assert.deepEqual(types(boardFacts(empty, played(empty, 'A1'), P('A1'))), ['shape', 'firstLine']);
  const cornered = Board.fromRows(['.........', '.........', '.........', '.........', '.........', '.........', '.........', '.........', '.O.......'], BLACK);
  assert.deepEqual(types(boardFacts(cornered, played(cornered, 'A1'), P('A1'))), ['selfAtari', 'firstLine']);
  const eye = Board.fromRows(['.........', '.........', '.........', '.........', '.........', '.........', '.........', 'X........', '.X.......'], BLACK);
  assert.ok(types(boardFacts(eye, played(eye, 'A1'), P('A1'))).includes('ownEye'));
  assert.deepEqual(boardFacts(empty, empty, PASS), [{ type: 'pass' }]);
});
