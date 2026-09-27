import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Board, BLACK, WHITE, PASS, POINTS, parsePt, ptName } from '../src/board.js';
import { Game } from '../src/game.js';
import { boardFacts, moveFacts, threatFacts, purposeFacts, regionOf, cachedFacts } from '../src/explain.js';
import { Search, seed } from '../src/mcts.js';

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
  for (const m of 'A2 J9 C2 J8'.split(' ')) g.play(P(m));
  const before = g.board;
  g.play(P('B2'));
  assert.equal(boardFacts(before, g.board, P('B2')).find(f => f.type === 'connect').groups, 2);
});

test('boardFacts: filling a diagonal connection is an empty triangle, not a connection', () => {
  // Black D5 and E6 touch diagonally; E5 fills one of the two points between them.
  const diag = Board.fromRows(['.........', '.........', '.........', '....X....', '...X.....', '.........', '.........', '.........', '.........'], BLACK);
  const facts = types(boardFacts(diag, played(diag, 'E5'), P('E5')));
  assert.ok(facts.includes('alreadyConnected') && facts.includes('emptyTriangle'), facts.join());
  assert.ok(!facts.includes('connect'));
  // With White already on D6 the diagonal was cut: E5 is a real connection, and a solid shape.
  const cut = Board.fromRows(['.........', '.........', '.........', '...OX....', '...X.....', '.........', '.........', '.........', '.........'], BLACK);
  const real = boardFacts(cut, played(cut, 'E5'), P('E5'));
  assert.equal(real.find(f => f.type === 'connect').groups, 2);
  assert.deepEqual(types(real).filter(t => t === 'alreadyConnected' || t === 'emptyTriangle'), []);
});

test('boardFacts: filling a bamboo joint', () => {
  // Black pairs D5-D6 and F5-F6 with gaps at E5 and E6.
  const joint = Board.fromRows(['.........', '.........', '.........', '...X.X...', '...X.X...', '.........', '.........', '.........', '.........'], BLACK);
  const facts = boardFacts(joint, played(joint, 'E5'), P('E5'));
  assert.equal(facts.find(f => f.type === 'alreadyConnected').via, 'bamboo');
  assert.ok(types(facts).includes('emptyTriangle') && !types(facts).includes('connect'));
  // With White in the other gap, E5 is a real connection.
  const pushed = Board.fromRows(['.........', '.........', '.........', '...XOX...', '...X.X...', '.........', '.........', '.........', '.........'], BLACK);
  const real = types(boardFacts(pushed, played(pushed, 'E5'), P('E5')));
  assert.ok(real.includes('connect') && !real.includes('alreadyConnected') && !real.includes('emptyTriangle'), real.join());
});

test('boardFacts: an empty triangle from a single group', () => {
  // Black D5 and D6; E5 makes an L with E6 empty.
  const pair = Board.fromRows(['.........', '.........', '.........', '...X.....', '...X.....', '.........', '.........', '.........', '.........'], BLACK);
  assert.deepEqual(types(boardFacts(pair, played(pair, 'E5'), P('E5'))), ['emptyTriangle', 'shape']);
  // Extending in a straight line is not one.
  assert.deepEqual(types(boardFacts(pair, played(pair, 'D4'), P('D4'))), ['shape']);
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

test('boardFacts: pushing into the opponent\'s diagonal or bamboo link is no cut candidate', () => {
  // White D5 and E6 touch diagonally; Black E5 pushes in, and White connects at D6.
  const diag = Board.fromRows(['.........', '.........', '.........', '....O....', '...O.....', '.........', '.........', '.........', '.........'], BLACK);
  assert.ok(!types(boardFacts(diag, played(diag, 'E5'), P('E5'))).includes('separates'));
  const joint = Board.fromRows(['.........', '.........', '.........', '...O.O...', '...O.O...', '.........', '.........', '.........', '.........'], BLACK);
  assert.ok(!types(boardFacts(joint, played(joint, 'E5'), P('E5'))).includes('separates'));
});

test('boardFacts: a capture that clears the fourth point is no empty triangle', () => {
  // Black E5 captures White F5 next to Black E6 and F6.
  const b = Board.fromRows(['.........', '.........', '.........', '....XX...', '.....OX..', '.....X...', '.........', '.........', '.........'], BLACK);
  const t = types(boardFacts(b, played(b, 'E5'), P('E5')));
  assert.ok(t.includes('capture') && !t.includes('emptyTriangle'), t.join());
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

// A hand-made coach read: ownership from { point: value } (black positive, 0
// elsewhere); moves as [name, score, pv names, visits].
const read = (toPlay, { own = {}, moves = [], score = 0 } = {}) => {
  const ms = moves.map(([name, sc = 0, pv = [], visits = 100]) => ({ move: P(name), score: sc, winrate: 0.5, visits, pv: pv.map(P) }));
  return { toPlay, score, winrate: 0.5, ownership: POINTS.map(p => own[ptName(p)] ?? 0), moves: ms, allMoves: ms };
};
const SPLIT = ['.........', '.........', '.........', '.........', '...O.O...', '.........', '.........', '.........', '.........'];

test('a stone between two groups that gets captured is a sacrifice, not a cut', () => {
  const before = Board.fromRows(SPLIT, BLACK), after = played(before, 'E5');
  // White ataris at E4 and captures at E6: the E5 stone dies.
  const reads = { after: read(WHITE, { own: { E5: -0.9 }, moves: [['E4', 0, ['J1', 'E6']]] }) };
  const facts = moveFacts({ before, after, move: P('E5'), reads });
  assert.ok(!types(facts).includes('cut'));
  assert.ok(!types(facts).includes('separates'));
  assert.equal(facts.find(f => f.type === 'stoneLost').stones, 1);
});

test('a stone between two groups that lives and keeps them apart is a cut', () => {
  const before = Board.fromRows(SPLIT, BLACK), after = played(before, 'E5');
  const reads = { after: read(WHITE, { own: { E5: 0.8 }, moves: [['E6', 0, ['E4']]] }) };
  const facts = moveFacts({ before, after, move: P('E5'), reads });
  assert.equal(facts.find(f => f.type === 'cut').groups, 2);
  assert.ok(!types(facts).includes('stoneLost'));
});

test('no cut when the chains can still join in one move', () => {
  // Black E5 splits White's two walls, but they share E3 below Black E4.
  const walls = Board.fromRows(['.........', '.........', '.........', '.........', '...O.O...', '...OXO...', '...O.O...', '.........', '.........'], BLACK);
  const reads = { after: read(WHITE, { own: { E5: 0.8 }, moves: [['J1', 0, ['J9']]] }) };
  const facts = moveFacts({ before: walls, after: played(walls, 'E5'), move: P('E5'), reads });
  assert.ok(types(boardFacts(walls, played(walls, 'E5'), P('E5'))).includes('separates'));
  assert.ok(!types(facts).includes('cut'));
});

test('no cut is claimed before the position after the move has been read', () => {
  const before = Board.fromRows(SPLIT, BLACK);
  assert.ok(!types(moveFacts({ before, after: played(before, 'E5'), move: P('E5') })).includes('cut'));
});

const WALL = ['.........', '.........', '..XXXX...', '..XOOX...', '..X..X...', '.........', '.........', '.........', '.........'];

test('an atari on stones that were already dead is a dead target', () => {
  const before = Board.fromRows(WALL, BLACK), after = played(before, 'D5');
  const dead = { D6: 0.8, E6: 0.8 };
  const reads = { before: read(BLACK, { own: dead }), baseline: read(WHITE, { own: dead }), after: read(WHITE, { own: { D6: 0.9, E6: 0.9, D5: 0.9 } }) };
  const facts = moveFacts({ before, after, move: P('D5'), reads });
  assert.ok(types(facts).includes('atari'));
  assert.deepEqual(facts.find(f => f.type === 'deadTarget').stones.map(ptName).sort(), ['D6', 'E6']);
  // Dead only because Black is to move (they live if Black passes): not a dead target.
  const race = { ...reads, baseline: read(WHITE, { own: { D6: -0.4, E6: -0.4 } }) };
  assert.ok(!types(moveFacts({ before, after, move: P('D5'), reads: race })).includes('deadTarget'));
  // Nor before the baseline read is in.
  assert.ok(!types(moveFacts({ before, after, move: P('D5'), reads: { ...reads, baseline: undefined } })).includes('deadTarget'));
});

test('the coach reads stones inside a wall as dead (real search)', () => {
  seed(1);
  const before = Board.fromRows(WALL, BLACK);
  const run = b => { const s = new Search(b, { komi: 7 }); s.run(6000); return s.results(10); };
  const base = before.clone();
  base.play(PASS);
  base.passes = 0;
  const facts = moveFacts({ before, after: played(before, 'D5'), move: P('D5'), reads: { before: run(before), baseline: run(base) } });
  assert.ok(types(facts).includes('deadTarget'));
});

test('saving stones the coach expects to die anyway is a hopeless rescue', () => {
  const before = Board.fromRows(['.........', '.........', '.........', '.........', '.O.......', 'OX.......', '.O.......', '.........', '.........'], BLACK);
  const after = played(before, 'C4');
  assert.equal(boardFacts(before, after, P('C4')).find(f => f.type === 'rescue').libs, 3);
  const facts = moveFacts({ before, after, move: P('C4'), reads: { after: read(WHITE, { own: { B4: -0.8, C4: -0.8 } }) } });
  assert.deepEqual(facts.find(f => f.type === 'hopelessRescue').stones.map(ptName), ['B4']);
});

test('stones the coach expected to live but now expects to die are lost', () => {
  const before = Board.fromRows(['.........', '.........', '.........', '.........', '.........', '.........', '..X......', '.........', '.........'], BLACK);
  const after = played(before, 'J9');
  const reads = { before: read(BLACK, { own: { C3: 0.5 } }), after: read(WHITE, { own: { C3: -0.8, J9: 0.5 } }) };
  assert.deepEqual(moveFacts({ before, after, move: P('J9'), reads }).find(f => f.type === 'losesStones').stones.map(ptName), ['C3']);
});

// The tester's example: G3 ataris White's G4, whose only liberty is then G5.
const G3 = ['.........', '.........', '.........', '.........', '.........', '.....XOX.', '.........', '.........', '.........'];
const LOWER = ['D3', 'E3', 'F3', 'D2', 'E2', 'F2', 'D1', 'E1', 'F1'];
const ownAll = (names, v) => Object.fromEntries(names.map(n => [n, v]));
const g3Reads = (threatMoves = [['C7', 3, [], 800], ['G5', 4, [], 500]]) => ({
  before: read(BLACK, { own: ownAll(LOWER, 0.5) }),
  after: read(WHITE, { score: -2, own: ownAll(LOWER, 0.8), moves: [['G5', -2]] }),
  threat: read(BLACK, { moves: threatMoves }),
  baseline: read(WHITE, { score: -10, moves: [['G3']] }),
});

test('threatFacts: the best local follow-up that captures, and sente when they answer', () => {
  const before = Board.fromRows(G3, BLACK), after = played(before, 'G3');
  const facts = threatFacts(before, after, P('G3'), BLACK, g3Reads());
  const threat = facts.find(f => f.type === 'threat');
  assert.equal(ptName(threat.move), 'G5');
  assert.equal(threat.what.type, 'capture');
  assert.deepEqual(threat.what.stones.map(ptName), ['G4']);
  assert.deepEqual(facts.find(f => f.type === 'initiative'), { type: 'initiative', sente: true, reply: P('G5') });
});

test('threatFacts: no threat from a quiet or distant follow-up', () => {
  const before = Board.fromRows(G3, BLACK), after = played(before, 'G3');
  assert.deepEqual(threatFacts(before, after, P('G3'), BLACK, g3Reads([['G2', 4, [], 500]])), []);
  assert.deepEqual(threatFacts(before, after, P('G3'), BLACK, g3Reads([['C7', 3, [], 800]])), []);
});

test('purposeFacts: which regions the move gains, and what the opponent would otherwise play', () => {
  const facts = purposeFacts(P('G3'), BLACK, g3Reads());
  const purpose = facts.find(f => f.type === 'purpose');
  assert.equal(purpose.regions.length, 1);
  assert.equal(purpose.regions[0].region, regionOf(P('E2')));
  assert.equal(purpose.regions[0].kind, 'protects');
  assert.ok(Math.abs(purpose.regions[0].points - 3.6) < 1e-9);
  assert.equal(purpose.value, 8);
  assert.deepEqual(facts.find(f => f.type === 'otherwise'), { type: 'otherwise', move: P('G3') });
});

test('moveFacts includes threat and purpose once their reads are in', () => {
  const before = Board.fromRows(G3, BLACK), after = played(before, 'G3');
  const t = types(moveFacts({ before, after, move: P('G3'), reads: g3Reads() }));
  for (const k of ['atari', 'threat', 'initiative', 'purpose', 'otherwise']) assert.ok(t.includes(k), k);
});

test('a corner move claims that corner (real search)', () => {
  const before = Board.fromRows(['.........', '.........', '.........', '.........', '.........', '.........', '..X......', '.........', '.........'], BLACK);
  const run = b => { const s = new Search(b, { komi: 7 }); s.run(6000); return s.results(20); };
  seed(1);
  const base = before.clone();
  base.play(PASS);
  base.passes = 0;
  const reads = { before: run(before), after: run(played(before, 'G3')), baseline: run(base) };
  const purpose = purposeFacts(P('G3'), BLACK, reads).find(f => f.type === 'purpose');
  assert.equal(purpose.regions[0].region, regionOf(P('G3')));
  assert.equal(purpose.regions[0].kind, 'claims');
  assert.ok(purpose.value >= 2, `value ${purpose.value}`);
});

test('stones the opponent is expected to save are not called dead', () => {
  // The before read counts G4 as black's, but after G3 White is expected to answer at G5.
  const before = Board.fromRows(G3, BLACK), after = played(before, 'G3');
  const reads = { ...g3Reads(), before: read(BLACK, { own: { ...ownAll(LOWER, 0.5), G4: 0.8 } }) };
  const t = types(moveFacts({ before, after, move: P('G3'), reads }));
  assert.ok(t.includes('threat'));
  assert.ok(!t.includes('deadTarget'));
});

test('a move next to dead stones that does not attack them is not a dead target', () => {
  // A lone dead White stone at E5 keeps 3 liberties after Black D5.
  const before = Board.fromRows(['.........', '.........', '..XXXXX..', '..X...X..', '..X.O.X..', '..X...X..', '..XXXXX..', '.........', '.........'], BLACK);
  const reads = { before: read(BLACK, { own: { E5: 0.8 } }), after: read(WHITE, { own: { E5: 0.9 } }) };
  assert.ok(!types(moveFacts({ before, after: played(before, 'D5'), move: P('D5'), reads })).includes('deadTarget'));
});

test('no sente or gote when the answer is where the opponent wanted to play anyway', () => {
  const before = Board.fromRows(G3, BLACK), after = played(before, 'G3');
  const reads = { ...g3Reads(), baseline: read(WHITE, { score: -10, moves: [['G5']] }) };
  const facts = threatFacts(before, after, P('G3'), BLACK, reads);
  assert.ok(facts.some(f => f.type === 'threat'));
  assert.ok(!facts.some(f => f.type === 'initiative'));
});

test('gote when the expected reply leaves the threat in place', () => {
  const before = Board.fromRows(G3, BLACK), after = played(before, 'G3');
  const reads = { ...g3Reads(), after: read(WHITE, { score: -2, own: ownAll(LOWER, 0.8), moves: [['C7', -2]] }) };
  assert.deepEqual(threatFacts(before, after, P('G3'), BLACK, reads).find(f => f.type === 'initiative'), { type: 'initiative', sente: false, reply: P('C7') });
});

test('a threat that was already there before the move is not credited to it', () => {
  // G4 already had one liberty-short neighbour: Black could atari at G5 before G2 too.
  const before = Board.fromRows(G3, BLACK), after = played(before, 'G2');
  const reads = { ...g3Reads([['G5', 4, [], 500]]), after: read(WHITE, { moves: [['G5']] }) };
  assert.deepEqual(threatFacts(before, after, P('G2'), BLACK, reads), []);
});

test('cachedFacts recomputes when any read is replaced, even by one of the same kind', () => {
  const before = Board.fromRows(SPLIT, BLACK);
  const node = { parent: { board: before }, board: played(before, 'E5'), move: P('E5') };
  const dies = read(WHITE, { own: { E5: -0.9 }, moves: [['E4', 0, ['J1', 'E6']]] });
  const lives = read(WHITE, { own: { E5: 0.8 }, moves: [['E6', 0, ['E4']]] });
  const a = cachedFacts(node, { after: dies });
  assert.equal(cachedFacts(node, { after: dies }), a, 'same reads: cached');
  const b = cachedFacts(node, { after: lives });
  assert.notEqual(b, a);
  assert.ok(types(b).includes('cut') && !types(a).includes('cut'));
});
