import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLACK, WHITE, parsePt } from '../src/board.js';
import { resolveLevel, levelGrade, verdict, describe, describeNote, atariWarnings, ignoreNote, hintReason, regionName, hideAnswer, mistakeLines, missedLine } from '../src/wording.js';
import { Game } from '../src/game.js';

const P = parsePt;
const KEYS = ['best', 'good', 'inaccuracy', 'mistake', 'blunder'];

test('resolveLevel follows the AI level when set to match it', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map(i => resolveLevel('auto', i)),
    ['beginner', 'beginner', 'beginner', 'improving', 'improving', 'strong', 'strong', 'strong']);
  assert.equal(resolveLevel('strong', 0), 'strong');
  assert.equal(resolveLevel('beginner', 7), 'beginner');
});

test('levelGrade: each level has its own labels and flags', () => {
  const at = level => KEYS.map(grade => levelGrade({ grade }, level));
  assert.deepEqual(at('beginner').map(s => s.label), ['Good move', 'Good move', 'Good move', 'Mistake', 'Big mistake']);
  assert.deepEqual(at('improving').map(s => s.label), ['Best move', 'Good', 'Good', 'Mistake', 'Blunder']);
  assert.deepEqual(at('strong').map(s => s.label), ['Best move', 'Good', 'Inaccuracy', 'Mistake', 'Blunder']);
  assert.deepEqual(at('improving').map(s => s.flagged), [false, false, false, true, true]);
  assert.deepEqual(at('strong').map(s => s.flagged), [false, false, true, true, true]);
  // Beginners: losing stones is a mistake even when the points lost are few.
  assert.equal(levelGrade({ grade: 'good', ptLoss: 2 }, 'beginner', [{ type: 'losesStones', stones: [P('C3')] }]).label, 'Mistake');
  // ...but not when nothing better was available.
  assert.equal(levelGrade({ grade: 'best', ptLoss: 0 }, 'beginner', [{ type: 'losesStones', stones: [P('C3')] }]).label, 'Good move');
  assert.equal(levelGrade({ grade: 'good', ptLoss: 0.4 }, 'beginner', [{ type: 'losesStones', stones: [P('C3')] }]).label, 'Good move');
  assert.equal(levelGrade({ grade: 'good' }, 'improving', [{ type: 'losesStones', stones: [P('C3')] }]).label, 'Good');
});

test('verdict: numbers only above beginner level', () => {
  const g = { grade: 'mistake', ptLoss: 6.2, wrLoss: 0.12, bestMove: P('D4') };
  assert.equal(verdict(g, 'beginner', levelGrade(g, 'beginner')), 'The coach would have played <b>D4</b>.');
  assert.equal(verdict(g, 'improving', levelGrade(g, 'improving')), 'About <b>6.2 points</b> worse than <b>D4</b>.');
  assert.equal(verdict(g, 'strong', levelGrade(g, 'strong')), 'About <b>6.2 points</b> worse than <b>D4</b> (win chance −12%).');
  const close = { grade: 'good', ptLoss: 0.2, wrLoss: 0.01, bestMove: P('D4') };
  assert.equal(verdict(close, 'beginner', levelGrade(close, 'beginner')), 'About as good as the coach\'s choice, <b>D4</b>.');
  const small = { grade: 'inaccuracy', ptLoss: 2.5, wrLoss: 0.06, bestMove: P('D4') };
  assert.equal(verdict(small, 'improving', levelGrade(small, 'improving')), 'A fine move. The coach slightly preferred <b>D4</b>.');
  assert.equal(verdict({ grade: 'best', bestMove: P('D4') }, 'beginner', levelGrade({ grade: 'best' }, 'beginner')), 'Exactly the coach\'s choice.');
});

// The tester's G3 example as facts (see test/explain.test.js for how they arise).
const G3_FACTS = [
  { type: 'atari', double: false, stones: [P('G4')], trapped: null },
  { type: 'threat', move: P('G5'), what: { type: 'capture', stones: [P('G4')], ko: false } },
  { type: 'initiative', sente: true, reply: P('G5') },
  { type: 'purpose', regions: [{ region: 7, kind: 'protects', points: 3.6 }], value: 8 },
  { type: 'otherwise', move: P('G3') },
];
const ctx = (level, extra = {}) => ({ level, mover: BLACK, you: BLACK, shown: { key: 'good', flagged: false }, ...extra });

test('describe: the G3 example at each level', () => {
  assert.deepEqual(describe(G3_FACTS, ctx('beginner')), [
    'Puts the AI\'s stone at G4 in atari: it has only 1 liberty left.',
    'The AI has to save it.',
    'After the AI answers, this guards the bottom of the board.',
    'The AI wanted to play here too.',
  ]);
  assert.deepEqual(describe(G3_FACTS, ctx('improving')), [
    'Threatens to capture the AI\'s stone at G4.',
    'Once the AI answers at G5, it secures your lower side, and you get to play elsewhere next (sente).',
    'The AI wanted to play here too.',
  ]);
  assert.deepEqual(describe(G3_FACTS, ctx('strong')), [
    'Sente: threatens to capture the AI\'s stone at G4.',
    'After G5 it secures your lower side (+8).',
    "The AI's key point too.",
  ]);
});

test('describe: beginner lines never quote points or percentages', () => {
  const all = [...G3_FACTS, { type: 'capture', stones: [P('A1'), P('B1')], ko: false }, { type: 'fewLibs', stones: 3 },
    { type: 'losesStones', stones: [P('C3')] }, { type: 'initiative', sente: false, reply: P('J9') }];
  for (const line of describe(all, ctx('beginner'))) assert.doesNotMatch(line, /point|%|≈|\+\d/);
});

test('describe: a lost stone is a sacrifice only when the move was good', () => {
  const f = [{ type: 'stoneLost', stones: 1 }];
  assert.match(describe(f, ctx('improving'))[0], /Sacrifices this stone/);
  assert.match(describe(f, ctx('improving', { shown: { key: 'mistake', flagged: true } }))[0], /likely to be captured/);
  assert.deepEqual(describe(f, ctx('improving', { shown: undefined })), [], 'not until the grade is known');
});

test('describe: attacks on dead stones are not praised', () => {
  const f = [{ type: 'atari', double: false, stones: [P('D6'), P('E6')], trapped: 'net' }, { type: 'deadTarget', stones: [P('D6'), P('E6')] }];
  const lines = describe(f, ctx('improving', { shown: { key: 'mistake', flagged: true } }));
  assert.ok(!lines.some(l => /Atari/.test(l)), lines.join(' | '));
  assert.match(lines.join(' '), /already dead/);
  // A good move next to dead stones is neither praised nor scolded for it.
  assert.deepEqual(describe(f, ctx('improving')), []);
  const taken = [{ type: 'capture', stones: [P('D6')], ko: false }, { type: 'deadTarget', stones: [P('D6')] }];
  assert.deepEqual(describe(taken, ctx('improving', { shown: { key: 'mistake', flagged: true } })), ['Captures 1 stone that was already dead.']);
  assert.deepEqual(describe(taken, ctx('improving')), ['Captures 1 stone.']);
});

test('describe: shape lines give way to a tactical point', () => {
  const flagged = ctx('strong', { shown: { key: 'inaccuracy', flagged: true } });
  const f = [{ type: 'atari', double: false, stones: [P('A8'), P('A7')], trapped: null }, { type: 'alreadyConnected', via: 'diagonal' }, { type: 'emptyTriangle' }];
  assert.deepEqual(describe(f, flagged), ['Atari: threatens to capture 2 stones next move.']);
  assert.deepEqual(describe(f, ctx('strong')), ['Atari: threatens to capture 2 stones next move.']);
});

test('describe: lost stones are a sacrifice when the move was good', () => {
  const f = [{ type: 'losesStones', stones: [P('C3'), P('C4')] }];
  assert.deepEqual(describe(f, ctx('improving')), ['Gives up your 2 stones at C3 as a sacrifice.']);
  assert.deepEqual(describe(f, ctx('improving', { shown: { key: 'mistake', flagged: true } })), ['Leaves your 2 stones at C3 to be captured.']);
  assert.deepEqual(describe([{ type: 'hopelessRescue', stones: [P('B4')] }, { type: 'rescue', stones: [P('B4')], libs: 3 }], ctx('improving')), []);
});

test('describe: "Their idea" gives no careful-advice about the opponent\'s own stones', () => {
  const f = [{ type: 'selfAtari', stones: 1 }, { type: 'fewLibs', stones: 3 }, { type: 'ownEye' }];
  assert.deepEqual(describe(f, { level: 'improving', mover: WHITE, you: BLACK, intent: true }), []);
});

test('describe: empty triangles and first-line moves are only criticised when the grade agrees', () => {
  const flagged = level => ctx(level, { shown: { key: 'mistake', flagged: true } });
  const filled = [{ type: 'alreadyConnected' }, { type: 'emptyTriangle' }];
  assert.deepEqual(describe(filled, flagged('improving')), ['Your stones were already connected diagonally, so connecting here makes an empty triangle.']);
  assert.match(describe(filled, flagged('beginner'))[0], /already safely connected diagonally/);
  assert.deepEqual(describe(filled, ctx('improving')), ['Makes the diagonal connection solid.']);
  assert.deepEqual(describe(filled, ctx('improving', { shown: undefined })), [], 'not until the grade is known');
  const joint = [{ type: 'alreadyConnected', via: 'bamboo' }, { type: 'emptyTriangle' }];
  assert.deepEqual(describe(joint, flagged('improving')), ['Your stones were already connected by a bamboo joint, so connecting here makes an empty triangle.']);
  assert.match(describe(joint, flagged('beginner'))[0], /two gaps between them, and if the AI plays in one, you can fill the other/);
  assert.deepEqual(describe(joint, ctx('improving')), ['Makes the bamboo joint solid.']);
  const bent = [{ type: 'emptyTriangle' }, { type: 'shape', shape: 'extend' }];
  assert.deepEqual(describe(bent, flagged('improving')), ['Makes an empty triangle, an inefficient shape.']);
  assert.deepEqual(describe(bent, ctx('improving')), ['Extends solidly from its own stones.']);
  const edge = [{ type: 'shape', shape: 'block' }, { type: 'firstLine' }];
  assert.deepEqual(describe(edge, ctx('improving')), ['Plays against the opponent\'s stones.']);
  assert.equal(describe(edge, flagged('improving')).length, 2);
});

test('describe: study mode names both colours', () => {
  const lines = describe([{ type: 'atari', double: false, stones: [P('G4')], trapped: null }], { level: 'beginner', mover: BLACK, you: 0 });
  assert.deepEqual(lines, ['Puts White\'s stone at G4 in atari: it has only 1 liberty left.']);
});

test('describeNote: AI moves get only the urgent facts', () => {
  const f = [{ type: 'atari', double: false, stones: [P('C3'), P('C4')], trapped: null }, { type: 'shape', shape: 'extend' },
    { type: 'capture', stones: [P('J1')], ko: false }];
  assert.deepEqual(describeNote(f, { mover: WHITE, you: BLACK }), ['Your 2 stones at C3 are now in atari.', 'Captures your stone at J1.']);
});

test('describe: regions of the same kind share one verb', () => {
  const f = [{ type: 'purpose', regions: [{ region: 1, kind: 'claims', points: 3 }, { region: 0, kind: 'claims', points: 2 }], value: 10 },
    { type: 'purpose', regions: [{ region: 5, kind: 'protects', points: 3 }, { region: 2, kind: 'protects', points: 2 }], value: 9 }];
  assert.deepEqual(describe(f, ctx('improving')), [
    'It claims the upper side and the upper-left corner.',
    'It secures your right side and upper-right corner.',
  ]);
  assert.equal(describe([f[0]], ctx('beginner'))[0], 'This claims the top of the board and the top-left corner.');
});

test('verdict: a flagged move that keeps the score is about win chance', () => {
  const g = { grade: 'mistake', ptLoss: 0.02, wrLoss: 0.07, bestMove: P('D4') };
  assert.equal(verdict(g, 'strong', levelGrade(g, 'strong')), 'Keeps about the same score as <b>D4</b>, but the win chance drops 7%.');
  assert.equal(verdict(g, 'improving', levelGrade(g, 'improving')), 'About the same score as <b>D4</b>, but riskier.');
  assert.equal(verdict(g, 'beginner', levelGrade(g, 'beginner')), 'The coach would have played <b>D4</b>.');
});

test('describe: the mover\'s own group is named for AI moves', () => {
  assert.deepEqual(describe([{ type: 'ownEye' }], { level: 'improving', mover: WHITE, you: BLACK }), ['Fills its own eye — usually a waste, and can kill its own group.']);
  assert.deepEqual(describe([{ type: 'ownEye' }], { level: 'improving', mover: BLACK, you: BLACK }), ['Fills its own eye — usually a waste, and can kill your own group.']);
});

test('describe: with intent, a cut candidate is worded as an aim', () => {
  const f = [{ type: 'separates', at: [P('D5'), P('F5')] }, { type: 'shape', shape: 'contact' }];
  assert.deepEqual(describe(f, { level: 'improving', mover: WHITE, you: BLACK, intent: true }), ['Aims to cut your stones apart.']);
  assert.deepEqual(describe(f, { level: 'improving', mover: WHITE, you: BLACK }), ['Attaches to an enemy stone (contact play).']);
});

const NAMES = { whose: c => c === BLACK ? 'Your' : 'White\'s', who: c => c === BLACK ? 'You' : 'White' };

test('atariWarnings: a capture forbidden by ko is explained, not recommended', () => {
  const g = new Game();
  for (const m of 'D5 F6 E6 G5 E4 F4 F5 E5'.split(' ')) g.play(P(m));
  const chance = atariWarnings(g.board, p => g.check(p), NAMES).find(w => w.kind === 'chance');
  assert.match(chance.text, /you can't capture at F5 right away because of ko/);
  assert.match(chance.text, /if White doesn't answer it, you can take then/);
});

test('atariWarnings: a legal capture is still recommended', () => {
  const g = new Game();
  for (const m of 'A2 A1 B2 J9'.split(' ')) g.play(P(m));
  const chance = atariWarnings(g.board, p => g.check(p), NAMES).find(w => w.kind === 'chance');
  assert.equal(chance.text, 'White\'s stone at A1 is in atari: you can capture at B1.');
});

test('verdict: when the coach would have passed, it says so in words', () => {
  const g = { grade: 'mistake', bestMove: -1, ptLoss: 4, wrLoss: 0.1 };
  assert.equal(verdict(g, 'beginner', levelGrade(g, 'beginner')), 'The coach would have <b>passed</b>.');
  assert.equal(verdict(g, 'improving', levelGrade(g, 'improving')), 'About <b>4.0 points</b> worse than <b>passing</b>.');
});

test('atariWarnings: on the AI\'s turn, its own stones in atari are described, not advised', () => {
  const g = new Game();
  for (const m of 'A2 A1 B2 J9 J1'.split(' ')) g.play(P(m));
  const AI = { whose: c => c === BLACK ? 'Your' : 'The AI\'s', who: c => c === BLACK ? 'You' : 'AI' };
  const w = atariWarnings(g.board, p => g.check(p), AI).find(x => x.kind === 'warn');
  assert.ok(w, 'a warning for the AI\'s stone');
  assert.doesNotMatch(w.text, /\. Run at|better to play elsewhere/, w.text);
  assert.match(w.text, /^The AI's stone at A1 is in atari/);
});

test('regionName: beginner and other wording', () => {
  assert.equal(regionName(P('G3'), 'beginner'), 'bottom-right corner');
  assert.equal(regionName(P('E2'), 'improving'), 'lower side');
  assert.equal(regionName(P('E5'), 'beginner'), 'middle');
});

// Black is the player, White the AI; the last move is White's.
const afterAI = moves => { const g = new Game(); for (const m of moves.split(' ')) g.play(P(m)); return g; };
const read = (...pts) => ({ moves: pts.map(p => ({ move: p === 'pass' ? -1 : P(p) })) });

test('ignoreNote: a far best reply means the AI move needn\'t be answered', () => {
  const g = afterAI('E5 A1');
  assert.equal(ignoreNote(g.board, P('A1'), read('G3'), 'beginner'),
    'You don\'t need to answer this directly. The biggest move now is around the bottom-right corner.');
});

test('ignoreNote: silent when the best reply is near, a pass, or the player is in atari', () => {
  const g = afterAI('E5 A1');
  assert.equal(ignoreNote(g.board, P('A1'), read('B2'), 'beginner'), null, 'near');
  assert.equal(ignoreNote(g.board, P('A1'), read('pass'), 'beginner'), null, 'pass');
  assert.equal(ignoreNote(g.board, P('A1'), null, 'beginner'), null, 'no read');
  const at = afterAI('A1 B1 A2 J9 E5 B2'); // White's B2 leaves Black's A1-A2 with one liberty
  assert.equal(ignoreNote(at.board, P('B2'), read('G7'), 'beginner'), null, 'atari');
});

test('hintReason: a tactical point in words, nothing for plain shape', () => {
  const g = afterAI('A2 A1 B2 J9'); // Black to move; B1 captures A1
  assert.match(hintReason(g.board, P('B1'), { level: 'beginner', you: BLACK }), /^B1: Captures 1 stone/);
  const empty = new Game();
  assert.equal(hintReason(empty.board, P('E5'), { level: 'beginner', you: BLACK }), null);
});

test('hideAnswer: drops lines that name the answer (or a mirror image of it), keeps the rest', () => {
  const lines = ['Leaves <b>2 stones</b> in atari.', 'Otherwise White would play <b>D7</b>.', 'After F3 it reduces the lower side.', 'Claims the D-file? No: D70 is not a point.'];
  assert.deepEqual(hideAnswer(lines, [P('D7')]), ['Leaves <b>2 stones</b> in atari.', 'After F3 it reduces the lower side.', 'Claims the D-file? No: D70 is not a point.']);
  assert.deepEqual(hideAnswer(lines, [P('C3'), P('F3')]), ['Leaves <b>2 stones</b> in atari.', 'Otherwise White would play <b>D7</b>.', 'Claims the D-file? No: D70 is not a point.']);
});

test('the coach calls the opponent "the AI" in games against it, and uses colours in study mode', () => {
  const atari = [{ type: 'atari', stones: [P('A1')] }];
  const vsAI = describe(atari, { level: 'beginner', mover: BLACK, you: BLACK }).join(' ');
  assert.match(vsAI, /the AI's stone at A1/);
  assert.doesNotMatch(vsAI, /White/);
  assert.match(describe(atari, { level: 'beginner', mover: BLACK, you: 0 }).join(' '), /White's stone at A1/, 'study mode keeps colours');
});

test('strong wording names the right side when the AI\'s own move is described', () => {
  const facts = [{ type: 'otherwise', move: P('C3') }];
  assert.deepEqual(describe(facts, { level: 'strong', mover: WHITE, you: BLACK }), ['Your key point too.']);
  assert.deepEqual(describe(facts, { level: 'strong', mover: BLACK, you: BLACK }), ["The AI's key point too."]);
  assert.deepEqual(describe(facts, { level: 'strong', mover: BLACK, you: 0 }), ["White's key point too."]);
});

test('mistakeLines: only the lines that say what went wrong', () => {
  const flagged = level => ctx(level, { shown: { key: 'mistake', flagged: true } });
  assert.deepEqual(mistakeLines([{ type: 'emptyTriangle' }, { type: 'shape', shape: 'extend' }], flagged('improving')), ['Makes an empty triangle, an inefficient shape.']);
  assert.deepEqual(mistakeLines([{ type: 'shape', shape: 'block' }, { type: 'firstLine' }], flagged('improving')), ['First-line moves are usually small this early in the game.']);
  assert.deepEqual(mistakeLines([{ type: 'shape', shape: 'extend' }], flagged('improving')), [], 'a plain shape line is no reason');
  assert.deepEqual(mistakeLines([{ type: 'losesStones', stones: [P('C3'), P('C4')] }], flagged('improving')), ['Leaves your 2 stones at C3 to be captured.']);
});

test('describe: an area the move only works towards "builds toward" it; no area line for a flagged move', () => {
  const f = [{ type: 'purpose', regions: [{ region: 6, kind: 'builds', points: 2 }], value: 11 }];
  assert.deepEqual(describe(f, ctx('improving')), ['It builds toward the lower-left corner.']);
  assert.deepEqual(describe(f, ctx('beginner')), ['This builds toward the bottom-left corner.']);
  assert.deepEqual(describe(f, ctx('strong')), ['It builds toward the lower-left corner (+11).'], 'points only for strong players');
  assert.deepEqual(describe(f, ctx('improving', { shown: { key: 'mistake', flagged: true } })), [], 'no praise under a Mistake');
});

test("describe: a threat that needn't be answered says so in one sentence", () => {
  const f = [{ type: 'threat', move: P('E7'), what: { type: 'cut' } }, { type: 'initiative', sente: false, reply: P('C4') }];
  assert.deepEqual(describe(f, ctx('improving')), ["Threatens to cut at E7, but the AI doesn't have to answer it yet."]);
  assert.deepEqual(describe(f, ctx('strong')), ["Threatens to cut at E7, but it's gote."]);
  assert.deepEqual(describe(f, { level: 'improving', mover: WHITE, you: BLACK }), ["Threatens to cut at E7, but you don't have to answer it yet."]);
});

test('verdict: a best move says when no other move was close', () => {
  const best = gap => ({ grade: 'best', bestMove: P('D4'), gap });
  const lv = level => levelGrade({ grade: 'best' }, level);
  assert.equal(verdict(best(3.2), 'improving', lv('improving')), "Exactly the coach's choice. No other move was close: the next best was about 3 points worse.");
  assert.equal(verdict(best(3.2), 'beginner', lv('beginner')), "Exactly the coach's choice, and no other move was close.");
  assert.equal(verdict(best(3.2), 'strong', lv('strong')), "Exactly the coach's choice; the next best is 3.2 points worse.");
  assert.equal(verdict(best(1), 'improving', lv('improving')), "Exactly the coach's choice.", 'close alternatives: nothing to add');
});

test('missedLine: the point the opponent took right after', () => {
  assert.equal(missedLine(P('B4'), { mover: BLACK, you: BLACK }), 'You missed B4, and the AI took it right away.');
  assert.equal(missedLine(P('B4'), { mover: BLACK, you: 0 }), 'Black missed B4, and White took it right away.');
});
