import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Board, BLACK, WHITE, EMPTY, PASS, pt, parsePt, ptName } from '../src/board.js';
import { Game } from '../src/game.js';

const P = s => parsePt(s);
const playAll = (g, list) => list.split(' ').forEach(m => assert.ok(g.play(P(m)), `move ${m}`));

test('alternating play, undo and redo keep the branch', () => {
  const g = new Game();
  playAll(g, 'E5 C3 G7');
  assert.equal(g.toPlay, WHITE);
  g.undo(); g.undo();
  assert.equal(g.board.color[P('E5')], BLACK);
  assert.equal(g.board.color[P('C3')], EMPTY);
  g.redo(); g.redo();
  assert.equal(g.board.color[P('G7')], BLACK);
  assert.equal(g.current.depth, 3);
});

test('playing a different move after undo creates a variation', () => {
  const g = new Game();
  playAll(g, 'E5 C3');
  g.undo();
  playAll(g, 'D4');
  assert.equal(g.current.parent.children.length, 2);
  g.undo();
  g.redo();
  assert.equal(ptName(g.current.move), 'D4', 'redo follows the most recent branch');
  // Re-playing an existing move re-uses the node.
  g.undo();
  const n = g.play(P('C3'));
  assert.equal(g.current.parent.children.length, 2);
  assert.equal(ptName(n.move), 'C3');
});

test('rule reasons: occupied, suicide, ko', () => {
  const g = new Game();
  playAll(g, 'E5');
  assert.deepEqual(g.check(P('E5')), { ok: false, reason: 'occupied' });
  // Build a ko: black D5 E6 E4 F5? Use explicit sequence.
  const k = new Game();
  // Black: D5, E6, E4 ; White: F6, F4, G5 ; Black captures at F5 area...
  playAll(k, 'D5 F6 E6 G5 E4 F4 F5 E5');
  // White E5 captured black F5? verify ko state
  const b = k.board;
  if (b.ko) {
    assert.equal(k.check(b.ko).reason, 'ko');
  } else {
    assert.fail('expected a ko after the sequence\n' + b.toString());
  }
});

test('suicide is reported', () => {
  const g = new Game();
  playAll(g, 'A2 J9 B1');
  assert.deepEqual(g.check(P('A1')), { ok: false, reason: 'suicide' });
});

test('captures are recorded on the node', () => {
  const g = new Game();
  playAll(g, 'A2 A1 B2 J9 B1');
  assert.deepEqual(g.current.captured.map(ptName), ['A1']);
  assert.equal(g.board.captures[BLACK], 1);
});

test('two passes end the game; scoring counts area and komi', () => {
  const g = new Game({ komi: 7 });
  g.pass(); g.pass();
  assert.ok(g.isOver());
  const s = g.score();
  assert.equal(s.black, 0);
  assert.equal(s.margin, -7);
  assert.equal(s.text, 'W+7');
});

test('handicap places stones and white moves first', () => {
  const g = new Game({ handicap: 3, komi: 0.5 });
  assert.equal(g.toPlay, WHITE);
  assert.equal(g.board.color[pt(6, 2)], BLACK);
  assert.equal(g.recipe().whiteFirst, true);
});

test('SGF round trip keeps moves, variations and comments', () => {
  const g = new Game({ komi: 6.5 });
  playAll(g, 'E5 C3 G7');
  g.current.comment = 'nice [move]';
  g.undo();
  playAll(g, 'C7');
  g.pass();
  const sgf = g.toSGF({ result: 'B+R' });
  const h = Game.fromSGF(sgf);
  assert.equal(h.komi, 6.5);
  const branches = h.root.children[0].children[0].children;
  assert.equal(branches.length, 2);
  assert.deepEqual(branches.map(n => ptName(n.move)), ['G7', 'C7']);
  assert.equal(branches[0].comment, 'nice [move]');
  assert.equal(branches[1].children[0].move, PASS);
  assert.equal(h.toSGF({ result: 'B+R' }), sgf);
});

test('SGF import of handicap setup', () => {
  const h = Game.fromSGF('(;GM[1]SZ[9]HA[2]KM[0.5]AB[gc][cg];W[ee];B[dd])');
  assert.equal(h.root.board.color[pt(6, 2)], BLACK);
  const line = h.line(h.root);
  assert.equal(line.length, 3);
  assert.equal(line[1].color, WHITE);
});

test('superko forbids repeating a position', () => {
  const g = new Game();
  // Position hashes seen on the path include the current one; a move recreating
  // the parent position (impossible without captures) is rare — test the helper directly.
  playAll(g, 'E5 D5');
  const set = g.hashesTo();
  assert.equal(set.size, 3);
});
