import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Board, BLACK, WHITE, PASS, POINTS, pt, parsePt } from '../src/board.js';
import { Game } from '../src/game.js';
import { estimateDead, gradeMove, reviewNeeded, preferUsefulMove, readRecipe, workKey, gradesMove, GRADING, chooseMove, shouldPass, isSettled, threats, earlyPass, nextLevel, keyMoments, skippedPoint, topChoices, easierMove, LEVELS } from '../src/coach.js';
import { Search, seed } from '../src/mcts.js';

const P = parsePt;

test('a stray stone inside enclosed territory is dead once the position is played out', () => {
  const rows = [
    '.........',
    '.O..X....',
    '....X....',
    '....X....',
    'XXXXX....',
    '.........',
    '.........',
    '.........',
    '.........',
  ];
  seed(5);
  // Two passes on record: the search still plays a copy out to find the dead stones.
  const finished = Board.fromRows(rows, BLACK);
  finished.passes = 2;
  const s1 = new Search(finished, { komi: 7 });
  s1.run(500);
  assert.ok(estimateDead(finished, s1.results(1).ownership).has(P('B8')), 'dead even with two passes on record');
  // Pass counter reset (what Game.recipe requests for finished games): dead.
  const playedOut = Board.fromRows(rows, BLACK);
  const s2 = new Search(playedOut, { komi: 7 });
  s2.run(2000);
  assert.ok(estimateDead(playedOut, s2.results(1).ownership).has(P('B8')));
});

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

test('gradeMove: a mirror image of the best move is the best move', () => {
  const before = analysis(BLACK, 0.5, 0, [
    { move: P('C3'), visits: 500, winrate: 0.5, score: 0, twins: [P('G3'), P('C7'), P('G7')] },
    { move: P('E5'), visits: 400, winrate: 0.49, score: -0.5 },
  ]);
  // The read after G7 happens to come out a little lower than C3's; still the same move.
  const g = gradeMove(before, analysis(WHITE, 0.53, -1, []), P('G7'));
  assert.equal(g.grade, 'best');
  assert.equal(reviewNeeded(g, before), null);
});

test('gradeMove: the side-by-side check tempers or confirms a loss', () => {
  const A = P('E5'), B = P('D4');
  const before = analysis(BLACK, 0.6, 3, [
    { move: A, visits: 800, winrate: 0.6, score: 3 },
    { move: B, visits: 10, winrate: 0.4, score: -3 },
  ]);
  const after = analysis(WHITE, 0.55, -1, []); // black: winrate 0.45, score -1 → looks 4 points worse
  const g = gradeMove(before, after, B);
  assert.equal(g.grade, 'mistake');
  assert.equal(reviewNeeded(g, before), A, 'read after the best move before saying so');
  // Read as deeply, the best move leads to the same result: not a mistake after all.
  const same = gradeMove(before, after, B, { move: A, analysis: analysis(WHITE, 0.55, -1.2, []) });
  assert.equal(same.grade, 'inaccuracy', 'averaged: 4 points and 0 → 2');
  assert.equal(reviewNeeded(same, before), null);
  GRADING.combine = 'min';
  assert.equal(gradeMove(before, after, B, { move: A, analysis: analysis(WHITE, 0.55, -1.2, []) }).grade, 'good');
  GRADING.combine = 'avg';
  // Confirmed: the best move really is better.
  const worse = gradeMove(before, after, B, { move: A, analysis: analysis(WHITE, 0.4, 3, []) });
  assert.equal(worse.grade, 'mistake');
});

test('gradeMove: when the coach agreed with a move that then looks bad, the runner-up is checked', () => {
  const A = P('F1'), B = P('E5');
  const before = analysis(WHITE, 0.6, -3, [
    { move: A, visits: 800, winrate: 0.6, score: -3 },
    { move: B, visits: 300, winrate: 0.55, score: -2 },
  ]);
  // After F1 black is doing well: the first read missed something.
  const after = analysis(BLACK, 0.7, 5, []);
  const g = gradeMove(before, after, A);
  assert.equal(g.grade, 'best');
  assert.equal(reviewNeeded(g, before), B);
  const checked = gradeMove(before, after, A, { move: B, analysis: analysis(BLACK, 0.35, -4, []) });
  assert.equal(checked.grade, 'blunder');
  assert.equal(checked.bestMove, B);
  assert.ok(checked.ptLoss >= 8);
  // The runner-up is no better: F1 stays the best move.
  const fine = gradeMove(before, after, A, { move: B, analysis: analysis(BLACK, 0.72, 6, []) });
  assert.equal(fine.grade, 'best');
  // No surprise, no check.
  assert.equal(reviewNeeded(gradeMove(before, analysis(BLACK, 0.41, -2.5, []), A), before), null);
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

test('preferUsefulMove: a move inside settled territory gives way to an equal real move', () => {
  const settled = POINTS.map(p => p === P('A1') ? 0.9 : 0);
  const an = { toPlay: BLACK, ownership: settled, moves: [
    { move: P('A1'), visits: 500, winrate: 0.6, score: 3 },
    { move: P('E5'), visits: 400, winrate: 0.59, score: 2.8 },
  ] };
  an.allMoves = an.moves.slice();
  preferUsefulMove(an);
  assert.equal(an.moves[0].move, P('E5'));
  assert.equal(an.allMoves[0].move, P('E5'));
  // Clearly better, or not inside settled territory: left alone.
  const better = { toPlay: BLACK, ownership: settled, moves: [{ move: P('A1'), visits: 500, winrate: 0.7, score: 6 }, { move: P('E5'), visits: 100, winrate: 0.6, score: 3 }] };
  assert.equal(preferUsefulMove(better).moves[0].move, P('A1'));
  const open = { toPlay: BLACK, ownership: POINTS.map(() => 0), moves: [{ move: P('A1'), visits: 500, winrate: 0.6, score: 3 }, { move: P('E5'), visits: 400, winrate: 0.6, score: 3 }] };
  assert.equal(preferUsefulMove(open).moves[0].move, P('A1'));
  // White's view: ownership and scores are black-positive.
  const white = { toPlay: WHITE, ownership: POINTS.map(p => p === P('A1') ? -0.9 : 0), moves: [
    { move: P('A1'), visits: 500, winrate: 0.6, score: -3 },
    { move: P('E5'), visits: 400, winrate: 0.6, score: -2.8 },
  ] };
  assert.equal(preferUsefulMove(white).moves[0].move, P('E5'));
});

test('gradesMove: the player\'s moves, and AI moves only when asked', () => {
  const g = new Game();
  const b = g.play(P('E5')), w = g.play(P('C3'));
  assert.equal(gradesMove(b, BLACK, false), true);
  assert.equal(gradesMove(w, BLACK, false), false);
  assert.equal(gradesMove(w, BLACK, true), true);
  assert.equal(gradesMove(w, 0, false), true, 'study mode: both colours');
  assert.equal(gradesMove(g.root, BLACK, true), false);
});

test('readRecipe: an after-read is the same position as the child it is for', () => {
  const g = new Game({ handicap: 2 }); // white moves first; C3 and G7 hold the handicap stones
  const w = g.play(P('E5')), b = g.play(P('D3'));
  assert.deepEqual(readRecipe(g, { kind: 'after', base: w, move: P('D3') }), g.recipe(b));
  assert.deepEqual(readRecipe(g, { kind: 'root', node: b }), g.recipe(b));
  // After a real pass, reading the position after a second pass is a finished game: played out.
  const p = g.play(PASS), pp = g.play(PASS);
  assert.deepEqual(readRecipe(g, { kind: 'after', base: p, move: PASS }), g.recipe(pp));
});

test('readRecipe: threat and baseline reads add a pass for the right side and never end the game', () => {
  const g = new Game({ handicap: 2 });
  g.play(P('E5'));
  const b = g.play(P('D3'));
  const threat = readRecipe(g, { kind: 'threat', node: b });
  assert.deepEqual(threat.moves.at(-1), [PASS, WHITE]);
  assert.equal(threat.moves.length, 3);
  assert.equal(threat.resetPasses, true);
  const base = readRecipe(g, { kind: 'baseline', node: b });
  assert.deepEqual(base.moves.at(-1), [PASS, BLACK]);
  assert.equal(base.moves.length, 2);
  assert.equal(base.resetPasses, true);
  const p = g.play(PASS), m = g.play(P('F6'));
  assert.equal(readRecipe(g, { kind: 'baseline', node: m }).resetPasses, true);
  assert.equal(readRecipe(g, { kind: 'threat', node: p }).resetPasses, true);
});

test('workKey: a node\'s own read, a check read and a pre-read of the same position share one key', () => {
  const g = new Game();
  const b = g.play(P('E5')), w = g.play(P('C3'));
  const own = workKey({ kind: 'after', base: b, move: P('C3') });
  assert.equal(own, workKey({ kind: 'after', base: w.parent, move: w.move }));
  assert.notEqual(own, workKey({ kind: 'after', base: b, move: P('D4') }));
  assert.notEqual(workKey({ kind: 'threat', node: w }), workKey({ kind: 'baseline', node: w }));
  assert.notEqual(workKey({ kind: 'root', node: g.root }), workKey({ kind: 'after', base: g.root, move: P('E5') }));
});

test('readRecipe: an after-read plays the child\'s colour when variations differ (imported SGFs)', () => {
  const g = Game.fromSGF('(;GM[1]SZ[9];B[ee](;W[cc])(;B[gg]))');
  const ee = g.root.children[0], cc = ee.children.find(c => c.move === P('C7'));
  assert.equal(cc.color, WHITE);
  assert.deepEqual(readRecipe(g, { kind: 'after', base: ee, move: cc.move }), g.recipe(cc));
});

test('earlyPass: open points left means too early; a pass-first read or a settled board doesn\'t', () => {
  const g = new Game();
  g.play(parsePt('E5'));
  const open = { moves: [{ move: parsePt('C3') }], ownership: new Array(81).fill(0) };
  const e = earlyPass(g.board, open);
  assert.equal(e.move, parsePt('C3'));
  assert.equal(e.undecided, 80);
  assert.equal(earlyPass(g.board, { ...open, moves: [{ move: -1 }] }), null, 'the coach would pass');
  const settled = { moves: [{ move: parsePt('C3') }], ownership: new Array(81).fill(0.9) };
  settled.ownership[0] = settled.ownership[1] = settled.ownership[2] = 0; // 3 undecided < 4
  assert.equal(earlyPass(g.board, settled), null, 'fewer than 4 undecided');
  assert.equal(earlyPass(g.board, null), null, 'no read');
});

test('earlyPass: a read that has only just started still warns, pointing at the most unsettled area', () => {
  const g = new Game();
  g.play(parsePt('E5'));
  // Nothing searched yet; only the lower-right area is unsettled.
  const own = new Array(81).fill(0.9);
  for (const n of ['G1', 'H1', 'J1', 'G2', 'H2', 'J2']) own[POINTS.indexOf(parsePt(n))] = 0;
  const e = earlyPass(g.board, { moves: [], ownership: own });
  assert.equal(e.undecided, 6);
  assert.ok(['G1', 'H1', 'J1', 'G2', 'H2', 'J2'].map(parsePt).includes(e.move), 'a point in that area');
});

test('nextLevel: a win moves up one level, a loss down one, a draw stays; the ends hold', () => {
  const top = LEVELS.length - 1;
  assert.deepEqual(nextLevel(2, 1), { level: 3, step: 'up' });
  assert.deepEqual(nextLevel(2, -1), { level: 1, step: 'down' });
  assert.deepEqual(nextLevel(2, 0), { level: 2, step: 'same' });
  assert.deepEqual(nextLevel(top, 1), { level: top, step: 'top' });
  assert.deepEqual(nextLevel(0, -1), { level: 0, step: 'bottom' });
});

test('keyMoments: up to 3 flagged moves, ranked by capped loss times how findable the better move was, in move order', () => {
  const m = (depth, ptLoss, prior) => ({ depth, ptLoss, prior });
  const moves = [m(10, 30, 0.5), m(20, 12, 0.5), m(30, 14, 0.01), m(40, 4, 0.5), m(50, 2, 0.5)];
  const km = keyMoments(moves, 'beginner');
  assert.deepEqual(km.map(k => k.depth), [10, 20, 40], 'the hard-to-see move at 30 is left out for beginners');
  assert.deepEqual(km.map(k => !!k.turning), [true, false, false], 'the biggest is the turning point');
  // A strong player is shown the subtler one: 14 points at a third of full weight beats 4 and 2.
  assert.deepEqual(keyMoments(moves, 'strong').map(k => k.depth), [10, 20, 30]);
  // The loss is capped: a lost group doesn't outweigh an easy-to-find big mistake.
  assert.equal(keyMoments([m(10, 40, 0.05), m(20, 12, 0.5)], 'improving').find(k => k.turning).depth, 20);
});

test('keyMoments: picks stay apart, a missing prior counts as findable, and none flagged gives none', () => {
  const m = (depth, ptLoss, prior) => ({ depth, ptLoss, prior });
  assert.deepEqual(keyMoments([m(10, 8, 0.5), m(12, 9, 0.5), m(20, 3, 0.5)], 'improving').map(k => k.depth), [12, 20], 'one fight, one pick');
  assert.deepEqual(keyMoments([m(10, 8)], 'beginner').map(k => k.depth), [10]);
  assert.equal(keyMoments([m(10, 8)], 'beginner')[0].turning, false, 'a single moment is not called the turning point');
  assert.deepEqual(keyMoments([], 'strong'), []);
});

test("skippedPoint: a point among the coach's top choices passed over move after move", () => {
  const D3 = parsePt('D3'), C7 = parsePt('C7');
  // top: the coach's choices within a point of its best; bestMove: its first choice.
  const m = (move, bestMove, ptLoss, top = [bestMove]) => ({ move, bestMove, ptLoss, top });
  const a = parsePt('A1'), b = parsePt('B1'), c = parsePt('J9');
  assert.deepEqual(skippedPoint([m(a, D3, 3), m(b, D3, 2), m(c, D3, 5)]), { point: D3, count: 3 });
  assert.deepEqual(skippedPoint([m(a, C7, 3, [C7, D3]), m(b, D3, 2), m(c, D3, 5)]), { point: D3, count: 3 }, 'a close second still counts');
  assert.deepEqual(skippedPoint([m(a, C7, 3), m(a, D3, 3), m(b, D3, 2), m(c, D3, 5)]), { point: D3, count: 3 }, 'counts only the run');
  assert.equal(skippedPoint([m(a, D3, 3), m(b, D3, 2)]), null, 'two is not yet a pattern');
  assert.equal(skippedPoint([m(a, D3, 3), m(b, D3, 0.5), m(c, D3, 5)]), null, 'a near-equal move breaks the run');
  assert.equal(skippedPoint([m(a, D3, 3), m(b, C7, 4), m(c, D3, 5)]), null, 'a move where it was no top choice breaks it');
  assert.equal(skippedPoint([m(a, PASS, 3), m(b, PASS, 2), m(c, PASS, 5)]), null, 'passing is not a point');
  assert.equal(skippedPoint([]), null);
});

test('topChoices: well-searched moves within a point of the best, with their mirror images', () => {
  const D3 = parsePt('D3'), C7 = parsePt('C7'), G7 = parsePt('G7'), J1 = parsePt('J1'), F3 = parsePt('F3');
  const an = { toPlay: WHITE, moves: [
    { move: D3, visits: 100, score: -5 }, { move: C7, visits: 40, score: -4.2, twins: [G7] },
    { move: J1, visits: 3, score: -5 }, { move: F3, visits: 50, score: -2 }, { move: PASS, visits: 30, score: -5 }] };
  assert.deepEqual(topChoices(an).sort(), [D3, C7, G7].sort(), 'J1 barely searched, F3 3 points worse (White: lower is better), no pass');
});

test('easierMove: a findable move nearly as good as a hard-to-see best one', () => {
  const G3 = parsePt('G3'), C4 = parsePt('C4'), D6 = parsePt('D6'), J1 = parsePt('J1');
  const an = (bestPrior, c4Score = -5.5) => ({ toPlay: WHITE, moves: [
    { move: G3, visits: 100, score: -6, prior: bestPrior },
    { move: C4, visits: 40, score: c4Score, prior: 0.3 },
    { move: D6, visits: 30, score: -5.8, prior: 0.1 }] });
  assert.equal(easierMove(an(0.02), G3, J1, 'improving'), C4, 'the most natural of the close ones');
  assert.equal(easierMove(an(0.2), G3, J1, 'improving'), null, 'the best move was easy to see already');
  assert.equal(easierMove(an(0.02, -4.9), G3, J1, 'improving'), D6, 'C4 is a point worse (White: lower is better)');
  assert.equal(easierMove(an(0.02), G3, C4, 'improving'), D6, 'not the move played');
  assert.equal(easierMove(an(0.05), G3, J1, 'beginner'), C4, 'beginners have a higher bar');
  assert.equal(easierMove(an(0.05), G3, J1, 'strong'), null, 'strong players are expected to see 5%');
  assert.equal(easierMove({ toPlay: WHITE, moves: [{ move: G3, visits: 100, score: -6 }] }, G3, J1, 'improving'), null, 'no priors');
});
