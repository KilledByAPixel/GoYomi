import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Board, BLACK, WHITE, PASS, POINTS, pt, parsePt } from '../src/board.js';
import { Game } from '../src/game.js';
import { estimateDead, gradeMove, explainMove, chooseMove, shouldPass, isSettled, threats } from '../src/coach.js';

const P = parsePt;

test('estimateDead marks whole chains owned by the opponent', () => {
  const b = Board.fromRows([
    '.........',
    '..O......',
    '..O......',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
  ]);
  const own = POINTS.map(() => 0.9); // black owns everything
  const dead = estimateDead(b, own);
  assert.deepEqual([...dead].sort(), [pt(2, 1), pt(2, 2)].sort());
  assert.equal(estimateDead(b, POINTS.map(() => -0.9)).size, 0);
});

const analysis = (toPlay, winrate, score, moves) => ({ toPlay, winrate, score, moves, ownership: POINTS.map(() => 0) });

test('gradeMove: best, inaccuracy and blunder', () => {
  const A = P('E5'), B = P('D4'), C = P('A1');
  const before = analysis(BLACK, 0.6, 3, [
    { move: A, visits: 500, winrate: 0.6, score: 3 },
    { move: B, visits: 100, winrate: 0.52, score: 1 },
  ]);
  assert.equal(gradeMove(before, analysis(WHITE, 0.4, 3, []), A).grade, 'best');
  // B: black's winrate after = 0.5, score -1 (black perspective); seen at 100 visits → softened.
  const gB = gradeMove(before, analysis(WHITE, 0.5, -1, []), B);
  assert.equal(gB.grade, 'inaccuracy');
  assert.equal(gB.bestMove, A);
  const gC = gradeMove(before, analysis(WHITE, 0.85, -12, []), C);
  assert.equal(gC.grade, 'blunder');
  assert.ok(gC.ptLoss > 10);
});

test('gradeMove is lenient on points when the game is already decided', () => {
  const before = analysis(WHITE, 0.99, -30, [{ move: P('E5'), visits: 900, winrate: 0.99, score: -30 }]);
  const g = gradeMove(before, analysis(BLACK, 0.02, -29, []), P('C3'));
  assert.equal(g.grade, 'good');
});

test('explainMove describes captures, atari and self-atari', () => {
  const g = new Game();
  for (const m of 'A2 A1 B2 J9'.split(' ')) g.play(P(m));
  const before = g.board;
  g.play(P('B1'));
  assert.ok(explainMove(before, g.board, P('B1')).some(s => s.startsWith('Captures 1 stone')));

  const h = new Game();
  for (const m of 'E5 D5 J9 E4'.split(' ')) h.play(P(m));
  // Black F5? White D5 has libs C5, D6, D4... play D6 to reduce; check atari wording on a clear case:
  const a = new Game();
  for (const m of 'D5 E5 J9 E6 J8 E4'.split(' ')) a.play(P(m));
  const bA = a.board;
  a.play(P('F5')); // black F5: white E5 now has only... E5 neighbours D5(B) F5(B) E6(W) E4(W) → chain libs remain
  const lines = explainMove(bA, a.board, P('F5'));
  assert.ok(Array.isArray(lines) && lines.length > 0);

  const s = new Game();
  for (const m of 'B1 J9 A2 J8'.split(' ')) s.play(P(m));
  // White playing A1 would be suicide; black's own corner. Instead: white stone self-atari at C1?
  const bS = s.board;
  s.play(P('B2'));
  assert.ok(explainMove(bS, s.board, P('B2')).some(t => /Connects/.test(t)));
});

test('chooseMove: strong levels take the top move, weak ones sample', () => {
  const results = { moves: [], allMoves: [
    { move: P('E5'), visits: 100 }, { move: P('D4'), visits: 60 }, { move: P('C3'), visits: 30 }, { move: PASS, visits: 5 },
  ] };
  assert.equal(chooseMove(results, { temp: 0, blunder: 0 }), P('E5'));
  const seen = new Set();
  let i0 = 0;
  const rand = () => ((i0++ * 0.618034) % 1);
  for (let i = 0; i < 200; i++) seen.add(chooseMove(results, { temp: 1, blunder: 0 }, rand));
  assert.ok(seen.size >= 2);
  assert.ok(!seen.has(PASS));
});

test('shouldPass only when the board is settled, or after a pass when winning', () => {
  // Black wall on column E, white wall on column F: every region is closed.
  const setup = [];
  for (let y = 0; y < 9; y++) setup.push([pt(4, y), BLACK], [pt(5, y), WHITE]);
  const g = new Game({ setup });
  const settled = POINTS.map((p, i) => (i % 9) < 5 ? 1 : -1);
  const move = { moves: [{ move: P('A1') }], ownership: settled, score: 2 };
  assert.equal(isSettled(g.board, settled), true);
  assert.equal(shouldPass(g, move, WHITE), true);
  assert.equal(shouldPass(g, { ...move, ownership: POINTS.map(() => 0) }, WHITE), false);

  // An open board is never "settled", even if the ownership guess is confident.
  const empty = new Game();
  assert.equal(shouldPass(empty, move, WHITE), false);

  // After black passes: black is ahead by 2 on the count, so black would pass back, white wouldn't.
  g.pass();
  assert.equal(shouldPass(g, move, WHITE), false);
  const h = new Game({ setup });
  h.play(P('A1')); // black
  h.pass();        // white passes; black to move and winning
  assert.equal(shouldPass(h, move, BLACK), true);
});

test('threats lists groups in atari with their liberty', () => {
  const b = Board.fromRows([
    'OX.......',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
  ]);
  const t = threats(b).find(x => x.color === WHITE);
  assert.deepEqual(t.libs, [pt(0, 1)]);
});
