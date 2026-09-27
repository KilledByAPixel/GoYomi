import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLACK, WHITE, parsePt } from '../src/board.js';
import { resolveLevel, levelGrade, verdict, describe, describeNote } from '../src/wording.js';

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
    'Puts White\'s stone at G4 in atari: it has only 1 liberty left.',
    'White has to save it.',
    'After White answers, this guards the bottom of the board.',
  ]);
  assert.deepEqual(describe(G3_FACTS, ctx('improving')), [
    'Threatens to capture White\'s stone at G4.',
    'Once White answers at G5, it secures your lower side (worth about 8 points), and you get to play elsewhere next (sente).',
    'Otherwise White would play G3.',
  ]);
  assert.deepEqual(describe(G3_FACTS, ctx('strong')), [
    'Sente: threatens to capture White\'s stone at G4.',
    'After G5 it secures your lower side (+8).',
    'Otherwise White plays G3.',
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
  const taken = describe([{ type: 'capture', stones: [P('D6')], ko: false }, { type: 'deadTarget', stones: [P('D6')] }], ctx('improving'));
  assert.deepEqual(taken, ['Captures 1 stone that was already dead.']);
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
    'It claims the upper side and the upper-left corner (worth about 10 points).',
    'It secures your right side and upper-right corner (worth about 9 points).',
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
