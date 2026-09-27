# Coach Explanations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The coach's move explanations only claim what stays true once play goes on, explain a move's threat and purpose, never praise attacks on dead stones, and speak at the level the player picks.

**Architecture:** A new `src/explain.js` works out facts about a move as plain data, from the boards and whatever coach reads are done. A new `src/wording.js` turns facts and grades into sentences for a level (beginner / improving / strong). `src/app.js` gains two read kinds (threat, baseline) in its coach queue, two settings ("Coach explains for", "Grade AI moves"), and renders everything through the wording layer. `explainMove` in `coach.js` is retired.

**Tech Stack:** Plain ES modules in the browser, no build step. Node's built-in test runner (`node --test test/*.test.js`). Web Workers for search (`src/engine-worker.js`). Headless Chromium via the Playwright copy in the npx cache for the browser check.

**Spec:** `docs/superpowers/specs/2026-09-26-coach-explanations-design.md`

## Global Constraints

- Setting label "Coach explains for"; options *Match AI strength* (default, key `auto`), *Beginners* (`beginner`), *Improving players* (`improving`), *Strong players* (`strong`). Help text: "Changes what the coach says, not how the AI plays."
- Match AI strength: AI levels 1–3 (index 0–2) → beginner, 4–5 (3–4) → improving, 6–8 (5–7) → strong.
- Setting "Grade AI moves", checkbox, off by default. In study mode (`settings.human === 0`) both colours are graded.
- Beginners: labels "Good move" / "Mistake" / "Big mistake"; no point values or percentages anywhere in their text; a move that loses stones is a Mistake. Improving: "Best move" / "Good" / "Mistake" / "Blunder", inaccuracies shown as Good. Strong: all five labels, as today.
- Threat and baseline reads only for graded moves shown in the coach panel (the current move and the one before it). Results cached on the node.
- Threats carry no point value. Purpose value = after-read score − baseline score from the mover's side, reported when ≥ 2.
- No first-launch prompt. No new dependencies. The README stays player-focused (one short line about the new setting).
- Match the surrounding code: short comments that say why, terse helpers, no TypeScript, no classes where functions do.
- Commit after each task; messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A pass on the board** (the player passes, or moves right after the AI passed): the threat and baseline reads insert an imaginary pass and must never end the game or crash; play continues and the explanation arrives. Pinned by the `readRecipe` test in Task 7 (resetPasses on every pass read) and the pass scenario in Task 9.
2. **Handicap games, where White moves first**: the pass in the threat/baseline read must be for the right colour. Pinned by the handicap `readRecipe` test in Task 7.
3. **Switching "Coach explains for" mid-game**: the pill, board ring, graph dots and review summary all relabel at once, with no stale labels. Pinned by the level-switch scenario in Task 9.
4. **Turning "Grade AI moves" on mid-game**: earlier AI moves get graded (and off again hides them). Pinned by `gradesMove` tests in Task 7 and the toggle scenario in Task 9.
5. **Stepping back and forth quickly while explanation reads run**: no console errors, and returning to a move shows its explanation. Pinned by the take-back scenario in Task 9.

---

### Task 1: Board facts in `src/explain.js`

Ports today's `explainMove` rules into facts. The cut becomes only a candidate (`separates`); Task 2 confirms it.

**Files:**
- Create: `src/explain.js`
- Create: `test/explain.test.js`

**Interfaces:**
- Produces: `boardFacts(before: Board, after: Board, move: number) → Fact[]`, `ownOf(an, p, c) → number`, `dist(a, b) → number`, `regionOf(p) → 0..8`.
- Fact shapes from this task: `{type:'pass'}`, `{type:'capture', stones:number[], ko:boolean}`, `{type:'rescue', stones:number[], libs:number, ladder:boolean}`, `{type:'atari', double:boolean, stones:number[], trapped:null|'ladder'|'net'}`, `{type:'connect', groups:number}`, `{type:'separates', at:number[]}`, `{type:'selfAtari', stones:number}`, `{type:'fewLibs', stones:number}`, `{type:'ownEye'}`, `{type:'shape', shape:'contact'|'block'|'extend'|'diagonal'|'opening'|'lowOpening'|'open'}`, `{type:'firstLine'}`.

- [ ] **Step 1: Write the failing tests**

Create `test/explain.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/explain.test.js`
Expected: FAIL, `Cannot find module ... src/explain.js`.

- [ ] **Step 3: Write `src/explain.js`**

```js
// What is true about a move, as plain data; wording.js turns it into words.
// Board facts need only the stones. Look-ahead facts need the coach's read of
// the position after the move; threat and purpose facts need the threat and
// baseline reads (docs/superpowers/specs/2026-09-26-coach-explanations-design.md).
// Facts whose reads aren't ready yet are simply left out.
import { BLACK, EMPTY, PASS, POINTS, D4, DIAG, N, ptX, ptY } from './board.js';
import { ladderCapture, ladderThreat } from './ladder.js';

const sign = c => c === BLACK ? 1 : -1;
// Ownership of point p in a read, from colour c's side (+1: c owns it).
export const ownOf = (an, p, c) => an.ownership[ptY(p) * N + ptX(p)] * sign(c);
export const dist = (a, b) => Math.abs(ptX(a) - ptX(b)) + Math.abs(ptY(a) - ptY(b));
// The board in nine 3×3 regions, row by row from the top left (4 is the centre).
export const regionOf = p => ((ptY(p) / 3) | 0) * 3 + ((ptX(p) / 3) | 0);

// Facts readable from the stones alone.
export function boardFacts(before, after, move) {
  if (move === PASS) return [{ type: 'pass' }];
  const out = [];
  const c = before.toPlay, o = 3 - c;
  const x = ptX(move), y = ptY(move);
  const height = Math.min(x, y, N - 1 - x, N - 1 - y);

  const captured = POINTS.filter(p => before.color[p] === o && after.color[p] === EMPTY);
  if (captured.length) out.push({ type: 'capture', stones: captured, ko: captured.length === 1 && !!after.ko });

  // Friendly chains that were in atari next to the move.
  const rescued = new Set();
  for (const d of D4) {
    const q = move + d;
    if (before.color[q] === c && before.inAtari(before.head[q])) rescued.add(before.head[q]);
  }
  const libs = after.libCount(move), size = after.size[after.head[move]];
  if (rescued.size) {
    const stones = [...rescued].flatMap(h => before.chainStones(h));
    out.push({ type: 'rescue', stones, libs, ladder: libs === 2 && !!ladderThreat(after, move) });
  }

  // Enemy chains now in atari (that weren't before).
  const seen = new Set(), ataris = [];
  for (const d of D4) {
    const q = move + d;
    if (after.color[q] !== o || seen.has(after.head[q])) continue;
    seen.add(after.head[q]);
    if (after.inAtari(after.head[q]) && !before.inAtari(before.head[q])) ataris.push(q);
  }
  if (ataris.length > 1) out.push({ type: 'atari', double: true, stones: ataris.flatMap(q => after.chainStones(q)), trapped: null });
  else if (ataris.length) {
    const seq = ladderCapture(after, ataris[0]);
    out.push({ type: 'atari', double: false, stones: after.chainStones(ataris[0]), trapped: !seq ? null : seq.length >= 3 ? 'ladder' : 'net' });
  }

  const friends = new Set(), enemies = new Map();
  for (const d of D4) {
    const q = move + d;
    if (before.color[q] === c) friends.add(before.head[q]);
    if (before.color[q] === o && !enemies.has(before.head[q])) enemies.set(before.head[q], q);
  }
  if (friends.size >= 2) out.push({ type: 'connect', groups: friends.size });
  // Only a candidate: whether it really cuts depends on how play goes on (lookAheadFacts).
  if (enemies.size >= 2 && !captured.length && libs >= 2) out.push({ type: 'separates', at: [...enemies.values()] });

  if (libs === 1 && !captured.length) out.push({ type: 'selfAtari', stones: size });
  else if (libs === 2 && size >= 3 && !rescued.size) out.push({ type: 'fewLibs', stones: size });
  if (before.isEyeish(move, c)) out.push({ type: 'ownEye' });

  if (!out.some(f => f.type !== 'separates')) {
    let shape;
    if (enemies.size && !friends.size) shape = 'contact';
    else if (friends.size && enemies.size) shape = 'block';
    else if (friends.size) shape = 'extend';
    else if (DIAG.some(d => before.color[move + d] === c)) shape = 'diagonal';
    else if (before.moveCount < 6) shape = height >= 2 ? 'opening' : 'lowOpening';
    else shape = 'open';
    out.push({ type: 'shape', shape });
  }
  if (height === 0 && before.moveCount < 20 && !captured.length && !rescued.size && !ataris.length) out.push({ type: 'firstLine' });
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/explain.test.js`
Expected: PASS (5 tests). If the eye test fails on `ownEye`, check `Board.isEyeish(p, c)` for how it treats corner points (it may need both diagonal-free neighbours); adjust the test position, not the rule.

- [ ] **Step 5: Commit**

```bash
git add src/explain.js test/explain.test.js
git commit -m "explain.js: board facts for a move (today's explanation rules as data)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Look-ahead facts and `moveFacts`

**Files:**
- Modify: `src/explain.js` (append)
- Modify: `test/explain.test.js` (append)

**Interfaces:**
- Consumes: `boardFacts`, `ownOf` (Task 1). A *read* is a coach search result: `{ toPlay, score (black's view), winrate, ownership: number[81] (black positive, POINTS order), moves: [{ move, visits, winrate, score, pv: number[] }], allMoves? }`.
- Produces: `expectedLine(an) → number[]`, `lookAheadFacts(before, after, move, facts, reads) → Fact[]`, `moveFacts({ before, after, move, reads }) → Fact[]` where `reads = { before?, after?, threat?, baseline? }`. New fact shapes: `{type:'cut', groups}`, `{type:'stoneLost', stones:number}`, `{type:'hopelessRescue', stones:number[]}`, `{type:'deadTarget', stones:number[]}`, `{type:'losesStones', stones:number[]}`. `moveFacts` never returns `separates`.

- [ ] **Step 1: Write the failing tests**

Change the import line of `test/explain.test.js` to:

```js
import { boardFacts, moveFacts, regionOf } from '../src/explain.js';
import { Search, seed } from '../src/mcts.js';
```

Append:

```js
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

test('no cut is claimed before the position after the move has been read', () => {
  const before = Board.fromRows(SPLIT, BLACK);
  assert.ok(!types(moveFacts({ before, after: played(before, 'E5'), move: P('E5') })).includes('cut'));
});

const WALL = ['.........', '.........', '..XXXX...', '..XOOX...', '..X..X...', '.........', '.........', '.........', '.........'];

test('an atari on stones that were already dead is a dead target', () => {
  const before = Board.fromRows(WALL, BLACK), after = played(before, 'D5');
  const reads = { before: read(BLACK, { own: { D6: 0.8, E6: 0.8 } }), after: read(WHITE, { own: { D6: 0.9, E6: 0.9, D5: 0.9 } }) };
  const facts = moveFacts({ before, after, move: P('D5'), reads });
  assert.ok(types(facts).includes('atari'));
  assert.deepEqual(facts.find(f => f.type === 'deadTarget').stones.map(ptName).sort(), ['D6', 'E6']);
});

test('the coach reads stones inside a wall as dead (real search)', () => {
  seed(1);
  const before = Board.fromRows(WALL, BLACK);
  const s = new Search(before, { komi: 7 });
  s.run(6000);
  const facts = moveFacts({ before, after: played(before, 'D5'), move: P('D5'), reads: { before: s.results(10) } });
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/explain.test.js`
Expected: FAIL, `moveFacts` is not exported.

- [ ] **Step 3: Append the look-ahead code to `src/explain.js`**

```js
// The expected continuation after a read's position: its best move and that move's line.
export function expectedLine(an) {
  const m = an && an.moves && an.moves[0];
  return m ? [m.move, ...(m.pv || [])] : [];
}

// Plays a line on a copy of the board, stopping at the first illegal move.
function playOut(board, line, max = 8) {
  const b = board.clone();
  for (const m of line.slice(0, max)) {
    if (m !== PASS && !b.isLegal(m)) break;
    b.play(m);
  }
  return b;
}

const avg = xs => xs.reduce((s, v) => s + v, 0) / xs.length;

// Facts that depend on how play is expected to go on. reads.after confirms or
// rejects cuts and spots stones that will die; reads.before spots attacks on
// stones that were already dead, and (with reads.after) stones the move loses.
export function lookAheadFacts(before, after, move, facts, reads) {
  const out = [], an = reads.after, pre = reads.before;
  if (move === PASS) return out;
  const c = before.toPlay, o = 3 - c;
  if (an) {
    const alive = ownOf(an, move, c);
    const sep = facts.find(f => f.type === 'separates');
    if (sep && alive > 0.3) {
      const b = playOut(after, expectedLine(an));
      const apart = sep.at.every(p => b.color[p] === o) && new Set(sep.at.map(p => b.head[p])).size === sep.at.length;
      if (apart) out.push({ type: 'cut', groups: sep.at.length });
    }
    if (alive < -0.5) out.push({ type: 'stoneLost', stones: after.size[after.head[move]] });
    const res = facts.find(f => f.type === 'rescue');
    if (res && avg(res.stones.map(p => ownOf(an, p, c))) < -0.5) out.push({ type: 'hopelessRescue', stones: res.stones });
  }
  if (pre) {
    const targets = [], seen = new Set();
    for (const d of D4) {
      const q = move + d;
      if (before.color[q] !== o || seen.has(before.head[q])) continue;
      seen.add(before.head[q]);
      const stones = before.chainStones(q);
      if (avg(stones.map(p => ownOf(pre, p, c))) > 0.6) targets.push(...stones);
    }
    if (targets.length) out.push({ type: 'deadTarget', stones: targets });
  }
  if (an && pre) {
    const lost = POINTS.filter(p => before.color[p] === c && after.color[p] === c && ownOf(pre, p, c) > 0.3 && ownOf(an, p, c) < -0.5);
    if (lost.length) out.push({ type: 'losesStones', stones: lost });
  }
  return out;
}

// Everything the coach can say about a move with the reads it has so far.
export function moveFacts({ before, after, move, reads = {} }) {
  const facts = boardFacts(before, after, move);
  if (move === PASS) return facts;
  return [...facts.filter(f => f.type !== 'separates'), ...lookAheadFacts(before, after, move, facts, reads)];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/explain.test.js`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add src/explain.js test/explain.test.js
git commit -m "explain.js: look-ahead facts (cuts that hold, sacrifices, dead targets, lost stones)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Threat and purpose facts

**Files:**
- Modify: `src/explain.js`
- Modify: `test/explain.test.js`

**Interfaces:**
- Consumes: `boardFacts`, `dist`, `regionOf`, `lookAheadFacts` (Tasks 1–2). `reads.threat` is a read of the position after the move with the opponent passing (mover to play); `reads.baseline` a read of the position before the move with the mover passing (opponent to play).
- Produces: `threatFacts(after, move, mover, reads) → Fact[]`, `purposeFacts(move, mover, reads) → Fact[]`; `moveFacts` now includes both. New fact shapes: `{type:'threat', move, what: <capture|atari|separates fact>}`, `{type:'initiative', sente:boolean, reply}`, `{type:'purpose', regions:[{region:0..8, kind:'protects'|'reduces'|'claims', points}], value}`, `{type:'otherwise', move}`.

- [ ] **Step 1: Write the failing tests**

Change the explain import in `test/explain.test.js` to:

```js
import { boardFacts, moveFacts, threatFacts, purposeFacts, regionOf } from '../src/explain.js';
```

Append:

```js
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
  const facts = threatFacts(after, P('G3'), BLACK, g3Reads());
  const threat = facts.find(f => f.type === 'threat');
  assert.equal(ptName(threat.move), 'G5');
  assert.equal(threat.what.type, 'capture');
  assert.deepEqual(threat.what.stones.map(ptName), ['G4']);
  assert.deepEqual(facts.find(f => f.type === 'initiative'), { type: 'initiative', sente: true, reply: P('G5') });
});

test('threatFacts: no threat from a quiet or distant follow-up', () => {
  const before = Board.fromRows(G3, BLACK), after = played(before, 'G3');
  assert.deepEqual(threatFacts(after, P('G3'), BLACK, g3Reads([['G2', 4, [], 500]])), []);
  assert.deepEqual(threatFacts(after, P('G3'), BLACK, g3Reads([['C7', 3, [], 800]])), []);
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/explain.test.js`
Expected: FAIL, `threatFacts` is not exported.

- [ ] **Step 3: Add threat and purpose to `src/explain.js`**

Append:

```js
// What the move threatens: the most-read follow-up near it that captures,
// ataris or cuts, if the opponent ignored the move (reads.threat), and
// whether the opponent is expected to answer it (sente). No point value: on
// an open board any second move is worth ~10 points, so a number misleads.
export function threatFacts(after, move, mover, reads) {
  const an = reads.after, th = reads.threat;
  if (!an || !th || move === PASS) return [];
  const list = th.allMoves || th.moves || [];
  const top = list.length ? list[0].visits : 0;
  const tb = after.clone();
  tb.play(PASS);
  for (const m of list) {
    if (m.move === PASS || dist(m.move, move) > 3 || m.visits < top * 0.05 || !tb.isLegal(m.move)) continue;
    const t2 = tb.clone();
    t2.play(m.move);
    const what = boardFacts(tb, t2, m.move).find(f => f.type === 'capture' || f.type === 'atari' || f.type === 'separates');
    if (!what) continue;
    const reply = an.moves && an.moves[0];
    const sente = !!reply && reply.move !== PASS && (dist(reply.move, move) <= 2 || dist(reply.move, m.move) <= 1);
    return [{ type: 'threat', move: m.move, what }, { type: 'initiative', sente, reply: reply ? reply.move : PASS }];
  }
  return [];
}

// What the move is for: where it gains against not playing it (reads.baseline,
// the mover passing instead), whether that protects, reduces or claims area
// (by who owned it in reads.before), how much the move is worth, and what the
// opponent would otherwise have played. Ownership gains are spread thin, so
// the regions say where and the score difference says how much.
export function purposeFacts(move, mover, reads) {
  const an = reads.after, base = reads.baseline, pre = reads.before, out = [];
  if (!an || !base || !pre || move === PASS) return out;
  const s = sign(mover);
  const gain = new Array(9).fill(0), owned = new Array(9).fill(0);
  POINTS.forEach((p, i) => {
    const r = regionOf(p);
    gain[r] += (an.ownership[i] - base.ownership[i]) * s / 2;
    owned[r] += pre.ownership[i] * s / 9;
  });
  const order = [...gain.keys()].filter(r => gain[r] >= 1).sort((a, b) => gain[b] - gain[a]);
  const regions = order.filter((r, k) => k === 0 || (k === 1 && gain[r] >= gain[order[0]] / 2))
    .map(r => ({ region: r, points: gain[r], kind: owned[r] > 0.3 ? 'protects' : owned[r] < -0.3 ? 'reduces' : 'claims' }));
  const value = (an.score - base.score) * s;
  if (regions.length) out.push({ type: 'purpose', regions, value });
  const other = base.moves && base.moves.find(m => m.move !== PASS);
  if (other && value >= 2) out.push({ type: 'otherwise', move: other.move });
  return out;
}
```

Replace `moveFacts` with:

```js
// Everything the coach can say about a move with the reads it has so far.
export function moveFacts({ before, after, move, reads = {} }) {
  const facts = boardFacts(before, after, move);
  if (move === PASS) return facts;
  const mover = before.toPlay;
  return [
    ...facts.filter(f => f.type !== 'separates'),
    ...lookAheadFacts(before, after, move, facts, reads),
    ...threatFacts(after, move, mover, reads),
    ...purposeFacts(move, mover, reads),
  ];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/explain.test.js`
Expected: PASS (17 tests). The real-search corner test was stable over seeds 1–3 when the plan was written; if it fails, print `purpose` and check whether the engine changed, before touching thresholds.

- [ ] **Step 5: Commit**

```bash
git add src/explain.js test/explain.test.js
git commit -m "explain.js: a move's threat (tactical follow-up, sente or gote) and purpose (regions, value)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The coach doesn't suggest moves inside settled territory

**Files:**
- Modify: `src/coach.js` (add after `reviewNeeded`)
- Modify: `test/coach.test.js`

**Interfaces:**
- Produces: `preferUsefulMove(an) → an` (mutates `an.moves` and `an.allMoves` order).

- [ ] **Step 1: Write the failing test**

In `test/coach.test.js`, add `preferUsefulMove` to the `../src/coach.js` import, then append:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/coach.test.js`
Expected: FAIL, `preferUsefulMove` is not exported.

- [ ] **Step 3: Implement in `src/coach.js`**

Add after `reviewNeeded`:

```js
// Under area scoring a move inside your own settled territory (say, capturing
// stones that are already dead) costs nothing, so the search can rate it best.
// As advice it's useless when a real move is as good: put the runner-up first.
// Mutates and returns the analysis.
export function preferUsefulMove(an) {
  const ms = an && an.moves;
  if (!ms || ms.length < 2 || ms[0].move === PASS || ms[1].move === PASS) return an;
  const [a, b] = ms, s = sign(an.toPlay);
  if (an.ownership[POINTS.indexOf(a.move)] * s < 0.8) return an;
  if ((a.score - b.score) * s > 0.5 || a.winrate - b.winrate > 0.02) return an;
  ms[0] = b; ms[1] = a;
  const all = an.allMoves;
  if (all && all !== ms) {
    const i = all.indexOf(a), j = all.indexOf(b);
    if (i >= 0 && j >= 0) { all[i] = b; all[j] = a; }
  }
  return an;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/coach.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/coach.js test/coach.test.js
git commit -m "Coach doesn't suggest moves inside settled territory when a real move is as good

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Levels and grades in `src/wording.js`

**Files:**
- Create: `src/wording.js`
- Create: `test/wording.test.js`

**Interfaces:**
- Consumes: `GRADES` from `coach.js` (`{ best, good, inaccuracy, mistake, blunder }` each `{ label, color }`); a grade from `gradeMove` (`{ grade, ptLoss, wrLoss, bestMove, ... }`).
- Produces: `COACH_FOR: {key, label}[]`, `resolveLevel(coachFor: string, aiLevel: number) → 'beginner'|'improving'|'strong'`, `gradeLabel(key, level) → string`, `levelGrade(g, level, facts = []) → { key, label, color, flagged }`, `verdict(g, level, shown) → string` (HTML, `<b>` only).

- [ ] **Step 1: Write the failing tests**

Create `test/wording.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLACK, WHITE, parsePt } from '../src/board.js';
import { resolveLevel, levelGrade, verdict } from '../src/wording.js';

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
  assert.equal(levelGrade({ grade: 'good' }, 'beginner', [{ type: 'losesStones', stones: [P('C3')] }]).label, 'Mistake');
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/wording.test.js`
Expected: FAIL, `Cannot find module ... src/wording.js`.

- [ ] **Step 3: Create `src/wording.js`**

```js
// What the coach says about a move, for the player's level: turns grades
// (coach.js) and move facts (explain.js) into sentences. Levels: 'beginner'
// (stones and liberties, no numbers), 'improving' (points, threats, purpose)
// and 'strong' (everything, tersely).
import { BLACK, PASS, ptName } from './board.js';
import { GRADES } from './coach.js';

export const COACH_FOR = [
  { key: 'auto', label: 'Match AI strength' },
  { key: 'beginner', label: 'Beginners' },
  { key: 'improving', label: 'Improving players' },
  { key: 'strong', label: 'Strong players' },
];

// 'auto' follows the AI level (index into LEVELS): Pebble to Sprout are for
// beginners, Reed and Stream for improving players, River and up for strong ones.
export function resolveLevel(coachFor, aiLevel) {
  if (coachFor !== 'auto') return coachFor;
  return aiLevel <= 2 ? 'beginner' : aiLevel <= 4 ? 'improving' : 'strong';
}

// The grade each level shows for each underlying grade.
const SHOWN = {
  beginner: { best: 'good', good: 'good', inaccuracy: 'good', mistake: 'mistake', blunder: 'blunder' },
  improving: { best: 'best', good: 'good', inaccuracy: 'good', mistake: 'mistake', blunder: 'blunder' },
  strong: { best: 'best', good: 'good', inaccuracy: 'inaccuracy', mistake: 'mistake', blunder: 'blunder' },
};
const BEGINNER_LABELS = { good: 'Good move', mistake: 'Mistake', blunder: 'Big mistake' };

export const gradeLabel = (key, level) => level === 'beginner' ? BEGINNER_LABELS[key] : GRADES[key].label;

// The grade as a level shows it. Flagged moves are the ones marked on the
// board, the graph and in the review.
export function levelGrade(g, level, facts = []) {
  let key = SHOWN[level][g.grade];
  // Beginners learn most from lost stones, even when few points are lost.
  if (level === 'beginner' && key === 'good' && facts.some(f => f.type === 'losesStones')) key = 'mistake';
  return { key, label: gradeLabel(key, level), color: GRADES[key].color, flagged: key !== 'best' && key !== 'good' };
}

// The sentence after the grade: how the move compares with the coach's choice.
export function verdict(g, level, shown) {
  if (g.grade === 'best') return 'Exactly the coach\'s choice.';
  const best = `<b>${ptName(g.bestMove)}</b>`;
  if (!shown.flagged) {
    return g.ptLoss < 0.5 && g.wrLoss < 0.02
      ? `About as good as the coach's choice, ${best}.`
      : `A fine move. The coach slightly preferred ${best}.`;
  }
  if (level === 'beginner') return `The coach would have played ${best}.`;
  const pts = `About <b>${g.ptLoss.toFixed(1)} points</b> worse than ${best}`;
  return level === 'strong' && g.wrLoss >= 0.01 ? `${pts} (win chance −${Math.round(g.wrLoss * 100)}%).` : `${pts}.`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/wording.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/wording.js test/wording.test.js
git commit -m "wording.js: coach levels, per-level grade labels and verdicts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Sentences for facts, per level

**Files:**
- Modify: `src/wording.js`
- Modify: `test/wording.test.js`

**Interfaces:**
- Consumes: the fact shapes from Tasks 1–3; `levelGrade` (Task 5).
- Produces: `describe(facts, ctx) → string[]` and `describeNote(facts, ctx) → string[]`, where `ctx = { level, mover: BLACK|WHITE, you: BLACK|WHITE|0, shown?: levelGrade result }`. `you` is the human's colour (0 in study mode). `describe` leaves out `stoneLost` until `ctx.shown` is known, and ignores `separates`.

- [ ] **Step 1: Write the failing tests**

Change the wording import in `test/wording.test.js` to:

```js
import { resolveLevel, levelGrade, verdict, describe, describeNote } from '../src/wording.js';
```

Append:

```js
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
  const lines = describe(f, ctx('improving'));
  assert.ok(!lines.some(l => /Atari/.test(l)), lines.join(' | '));
  assert.match(lines.join(' '), /already dead/);
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/wording.test.js`
Expected: FAIL, `describe` is not exported.

- [ ] **Step 3: Append to `src/wording.js`**

```js
const colorName = c => c === BLACK ? 'Black' : 'White';
const cap = s => s[0].toUpperCase() + s.slice(1);
const count = n => n === 1 ? '1 stone' : `${n} stones`;

// Words for the players. ctx.you is the human's colour (0 in study mode, when
// both sides are named by colour).
function words(ctx) {
  const subj = c => c === ctx.you ? 'you' : colorName(c);
  const poss = c => c === ctx.you ? 'your' : `${colorName(c)}'s`;
  const verb = (c, plain, third) => c === ctx.you ? plain : third;
  // "White's stone at G4", "your 3 stones at C3".
  const stones = (c, list) => `${poss(c)} ${list.length === 1 ? 'stone' : `${list.length} stones`} at ${ptName(list[0])}`;
  return { subj, poss, verb, stones };
}

const REGION_NAMES = {
  beginner: ['top-left corner', 'top of the board', 'top-right corner', 'left side', 'middle', 'right side',
    'bottom-left corner', 'bottom of the board', 'bottom-right corner'],
  other: ['upper-left corner', 'upper side', 'upper-right corner', 'left side', 'centre', 'right side',
    'lower-left corner', 'lower side', 'lower-right corner'],
};

function regionPhrase(r, level, w, mover) {
  const B = level === 'beginner', name = REGION_NAMES[B ? 'beginner' : 'other'][r.region];
  if (r.kind === 'protects') return B ? `guards the ${name}` : `secures ${w.poss(mover)} ${name}`;
  if (r.kind === 'reduces') return B ? `takes away some of ${w.poss(3 - mover)} area in the ${name}` : `reduces ${w.poss(3 - mover)} ${name}`;
  return `claims the ${name}`;
}

const SHAPES = {
  contact: ['Attaches to an enemy stone (contact play).', 'Plays right next to an enemy stone.'],
  block: ['Plays against the opponent\'s stones.'],
  extend: ['Extends solidly from its own stones.'],
  diagonal: ['Diagonal move — flexible shape that is hard to cut.', 'A diagonal move: flexible and hard to cut.'],
  opening: ['Opening move staking out a big area.'],
  lowOpening: ['An opening move this low claims little space.'],
  open: ['Plays in open space.'],
};

const overlaps = (a, b) => !!a && !!b && a.some(p => b.includes(p));

// The coach's explanation of a graded move: one sentence per fact, worded for
// ctx.level. ctx.shown is the grade as shown (levelGrade), once known.
export function describe(facts, ctx) {
  const { level, mover } = ctx, opp = 3 - mover, w = words(ctx);
  const B = level === 'beginner', S = level === 'strong';
  const find = t => facts.find(f => f.type === t);
  const threat = find('threat'), init = find('initiative'), purpose = find('purpose');
  const dead = find('deadTarget'), capture = find('capture'), atari = find('atari');
  const sente = !!(init && init.sente);
  const out = [];
  for (const f of facts) {
    switch (f.type) {
      case 'pass': out.push('Passes.'); break;
      case 'capture': {
        const already = overlaps(f.stones, dead && dead.stones) ? ` that ${f.stones.length === 1 ? 'was' : 'were'} already dead` : '';
        out.push(f.ko ? 'Takes the ko.' : `Captures ${count(f.stones.length)}${already}.`);
        break;
      }
      case 'rescue': {
        if (find('hopelessRescue')) break;
        const n = f.stones.length, it = n === 1 ? 'it' : 'they', thing = n === 1 ? 'a stone' : `${n} stones`;
        if (f.libs >= 3 || (f.libs === 2 && !f.ladder)) out.push(`Saves ${thing} from atari.${B ? ` ${cap(it)} now ${n === 1 ? 'has' : 'have'} ${f.libs} liberties.` : ''}`);
        else if (f.libs === 2) out.push(`Runs from atari, but with only 2 liberties ${it} can still be chased down in a ladder.`);
        else out.push(`Tries to save ${thing}, but ${it} ${n === 1 ? 'is' : 'are'} still in atari.`);
        break;
      }
      case 'hopelessRescue':
        out.push(`Tries to save ${count(f.stones.length)}, but the coach expects ${f.stones.length === 1 ? 'it' : 'them'} to be captured anyway.`);
        break;
      case 'atari': {
        if (overlaps(f.stones, dead && dead.stones)) break; // the deadTarget line says it
        if (f.double) { out.push('Double atari! Threatens two groups at once.'); break; }
        if (!B && threat && overlaps(threat.what.stones, f.stones)) break; // the threat line says it
        const n = f.stones.length;
        const esc = f.trapped === 'ladder' ? ' Running away won\'t work: it\'s a ladder.' : f.trapped ? ` ${n === 1 ? 'It' : 'They'} can't escape.` : '';
        out.push(B ? `Puts ${w.stones(opp, f.stones)} in atari: ${n === 1 ? 'it has' : 'they have'} only 1 liberty left.${esc}`
          : `Atari: threatens to capture ${count(n)} next move.${esc}`);
        break;
      }
      case 'deadTarget': {
        if (overlaps(f.stones, capture && capture.stones)) break; // the capture line says it
        const n = f.stones.length, it = n === 1 ? 'it' : 'them', was = n === 1 ? 'was' : 'were';
        out.push(B ? `${cap(w.stones(opp, f.stones))} ${was} already trapped, so capturing ${it} can wait. Look for a bigger move.`
          : `${cap(w.stones(opp, f.stones))} ${was} already dead: attacking ${it} gains little.`);
        break;
      }
      case 'connect': out.push(`Connects ${f.groups} groups into one.`); break;
      case 'cut': out.push(B ? `Cuts ${w.poss(opp)} stones into separate groups, which makes them weaker.` : `Cuts ${w.poss(opp)} stones apart.`); break;
      case 'stoneLost': {
        if (!ctx.shown) break; // sacrifice or loss depends on the grade
        const it = f.stones > 1 ? 'group' : 'stone';
        if (!ctx.shown.flagged) out.push(B ? `This ${it} will probably be captured, but giving it up helps elsewhere (a sacrifice).` : `Sacrifices this ${it}: it will be captured, but it gains elsewhere.`);
        else out.push(B ? `${cap(w.subj(opp))} can capture this ${it}.` : `This ${it} is likely to be captured.`);
        break;
      }
      case 'losesStones':
        out.push(B ? `${cap(w.subj(opp))} can now capture ${w.stones(mover, f.stones)}.` : `Leaves ${w.stones(mover, f.stones)} to be captured.`);
        break;
      case 'selfAtari': {
        const it = f.stones > 1 ? 'group' : 'stone';
        out.push(B ? `Careful: this ${it} now has only 1 liberty, so it can be captured.` : `Careful: this ${it} is now in atari — it can be captured.`);
        break;
      }
      case 'fewLibs': out.push(B ? `${cap(w.poss(mover))} group now has 2 liberties. Careful.` : 'The group has only 2 liberties — watch out for atari.'); break;
      case 'ownEye': out.push(B ? 'Fills its own eye. A group needs two eyes to live, so this can kill it.' : 'Fills its own eye — usually a waste, and can kill your own group.'); break;
      case 'shape': if (!threat && !purpose && !find('cut')) out.push(SHAPES[f.shape][B ? SHAPES[f.shape].length - 1 : 0]); break;
      case 'firstLine': out.push('First-line moves are usually small this early in the game.'); break;
      case 'threat': {
        const t = f.what;
        const what = t.type === 'capture' ? `capture ${w.stones(opp, t.stones)}`
          : t.type === 'atari' ? `put ${w.stones(opp, t.stones)} in atari` : `cut at ${ptName(f.move)}`;
        if (!B) out.push(`${S && sente ? 'Sente: t' : 'T'}hreatens to ${what}.`);
        else if (atari && overlaps(t.stones, atari.stones)) {
          if (sente) out.push(`${cap(w.subj(opp))} ${w.verb(opp, 'have', 'has')} to save ${atari.stones.length === 1 ? 'it' : 'them'}.`);
        } else out.push(`Threatens to ${what}${sente ? `, so ${w.subj(opp)} ${w.verb(opp, 'have', 'has')} to answer` : ''}.`);
        break;
      }
      case 'initiative':
        if (!f.sente && !B) out.push(S ? `Gote: ${colorName(opp)} can play elsewhere.` : `${cap(w.subj(opp))} can play elsewhere without answering (gote).`);
        else if (f.sente && !purpose && level === 'improving') {
          out.push(`${cap(w.subj(opp))} ${w.verb(opp, 'have', 'has')} to answer, so ${w.subj(mover)} ${w.verb(mover, 'keep', 'keeps')} the initiative (sente).`);
        }
        break;
      case 'purpose': {
        const what = f.regions.map(r => regionPhrase(r, level, w, mover)).join(' and ');
        const size = B || f.value < 2 ? '' : S ? ` (+${Math.round(f.value)})` : ` (worth about ${Math.round(f.value)} points)`;
        const answered = sente && init.reply !== PASS;
        if (B) out.push(answered ? `After ${w.subj(opp)} ${w.verb(opp, 'answer', 'answers')}, this ${what}.` : `This ${what}.`);
        else if (S) out.push(answered ? `After ${ptName(init.reply)} it ${what}${size}.` : `It ${what}${size}.`);
        else out.push(answered
          ? `Once ${w.subj(opp)} ${w.verb(opp, 'answer', 'answers')} at ${ptName(init.reply)}, it ${what}${size}, and ${w.subj(mover)} ${w.verb(mover, 'get', 'gets')} to play elsewhere next (sente).`
          : `It ${what}${size}.`);
        break;
      }
      case 'otherwise':
        if (!B) out.push(S ? `Otherwise ${colorName(opp)} plays ${ptName(f.move)}.` : `Otherwise ${w.subj(opp)} would play ${ptName(f.move)}.`);
        break;
    }
  }
  return out;
}

// A short note on an ungraded (AI) move: only what the player must react to.
export function describeNote(facts, ctx) {
  const opp = 3 - ctx.mover, w = words(ctx), out = [];
  for (const f of facts) {
    if (f.type === 'capture') out.push(f.ko ? 'Takes the ko.' : `Captures ${w.stones(opp, f.stones)}.`);
    else if (f.type === 'atari') out.push(f.double ? `Double atari on ${w.poss(opp)} stones!` : `${cap(w.stones(opp, f.stones))} ${f.stones.length === 1 ? 'is' : 'are'} now in atari.`);
    else if (f.type === 'cut') out.push(`Cuts ${w.poss(opp)} stones apart.`);
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/wording.test.js`
Expected: PASS (9 tests). If an expected sentence differs only in wording you believe reads better, change the test and the code together and keep the three spec examples' meaning.

- [ ] **Step 5: Commit**

```bash
git add src/wording.js test/wording.test.js
git commit -m "wording.js: explanations and AI-move notes per coach level

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Coach queue reads threat and baseline; "Grade AI moves"

**Files:**
- Modify: `src/coach.js` (add `readRecipe`, `gradesMove`)
- Modify: `test/coach.test.js`
- Modify: `src/app.js` (coach section, `DEFAULTS`, `load()`, `aiMove`)

**Interfaces:**
- Consumes: `preferUsefulMove` (Task 4); `game.recipe(node)` from `game.js` (returns `{ setup, whiteFirst, moves: [[move, color], ...], komi, resetPasses }`).
- Produces: `readRecipe(game, node, kind: 'pos'|'check'|'threat'|'baseline', move?) → recipe`; `gradesMove(node, human, gradeAI) → boolean`. In `app.js`: `isGraded(node)`, `node.reads = { threat?, baseline? }`, `settings.gradeAI` (default `false`).

- [ ] **Step 1: Write the failing tests**

In `test/coach.test.js`, add `readRecipe, gradesMove` to the `../src/coach.js` import, then append:

```js
test('readRecipe: pass reads add the pass for the right side and never end the game', () => {
  const g = new Game({ handicap: 2 }); // white moves first
  g.play(P('E5')); // white
  const b = g.play(P('C3')); // black
  const threat = readRecipe(g, b, 'threat');
  assert.deepEqual(threat.moves.at(-1), [PASS, WHITE]);
  assert.equal(threat.moves.length, 3);
  assert.equal(threat.resetPasses, true);
  const base = readRecipe(g, b, 'baseline');
  assert.deepEqual(base.moves.at(-1), [PASS, BLACK]);
  assert.equal(base.moves.length, 2);
  assert.equal(base.resetPasses, true);
  const check = readRecipe(g, b, 'check', P('D4'));
  assert.deepEqual(check.moves.at(-1), [P('D4'), BLACK]);
  assert.equal(check.resetPasses, false);
  assert.deepEqual(readRecipe(g, b, 'pos'), g.recipe(b));
  // Right after a real pass, the imagined one still resets the pass count.
  const p = g.play(PASS), m = g.play(P('G7'));
  assert.equal(readRecipe(g, m, 'baseline').resetPasses, true);
  assert.equal(readRecipe(g, p, 'threat').resetPasses, true);
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
```

Make sure the test file imports `Game` from `../src/game.js` and `PASS`, `WHITE`, `BLACK` from `../src/board.js` (it already does at the top).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/coach.test.js`
Expected: FAIL, `readRecipe` is not exported.

- [ ] **Step 3: Implement in `src/coach.js`**

Add after `preferUsefulMove`:

```js
// The position a coach read looks at, as a Game recipe, for node's move:
// 'pos' node's position; 'check' the parent position after `move` (to check
// node's grade against); 'threat' node's position with the opponent passing;
// 'baseline' the parent position with the mover passing (explain.js).
export function readRecipe(game, node, kind, move) {
  if (kind === 'pos') return game.recipe(node);
  const recipe = game.recipe(kind === 'threat' ? node : node.parent);
  const extra = kind === 'check' ? [move, node.color] : [PASS, kind === 'threat' ? 3 - node.color : node.color];
  recipe.moves = [...recipe.moves, extra];
  // An imagined pass must not end the game after a real one.
  if (kind !== 'check') recipe.resetPasses = true;
  return recipe;
}

// Which moves the coach grades: the player's, the AI's only when asked, and
// both sides in study mode (human === 0).
export const gradesMove = (node, human, gradeAI) => !!node.parent && (!human || node.color === human || gradeAI);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/coach.test.js`
Expected: PASS.

- [ ] **Step 5: Wire the reads into `src/app.js`**

(a) Import: in the `./coach.js` import add `preferUsefulMove, readRecipe, gradesMove`.

(b) `DEFAULTS`: add `gradeAI: false,` after `coachPlayouts: 48000,`. In `load()`, after the `coachPlayouts` lines, add:

```js
    settings.gradeAI = !!settings.gradeAI;
```

(c) Replace the block from `// Coach work items:` through the end of `startCoachJob` (keep `stopCoach` and `tryGrade` below it) with:

```js
// Coach work items: { node, kind, move? } (see readRecipe for the kinds).
const workKey = w => `${w.node.id}:${w.kind}:${w.move ?? ''}`;
const isGraded = node => gradesMove(node, settings.human, settings.gradeAI);
const checkRead = (node, move) => node.checks && node.checks.get(move) ||
  (node.parent.children.find(ch => ch.move === move && ch.analysisDone) || {}).analysis;

// A node's outstanding grading work, most urgent first.
function coachWork(node, out, ahead) {
  if (!node) return;
  if (!node.analysisDone) out.push({ node, kind: 'pos' });
  if (!node.parent || !isGraded(node)) return;
  if (node.checkMove != null) out.push({ node, kind: 'check', move: node.checkMove });
  // Moves other than the coach's choice often need the check read against it:
  // start it early, on a spare engine, so the grade doesn't wait for two reads.
  else if (ahead && !node.grade && node.parent.analysisDone) {
    const e = entryFor(node.parent.analysis, node.move), best = node.parent.analysis.moves[0];
    if (best && best.move !== PASS && e !== best && !checkRead(node, best.move)) out.push({ node, kind: 'check', move: best.move });
  }
}

// The threat and baseline reads behind a graded move's explanation (explain.js).
function explainWork(node, out) {
  if (!node || !node.parent || node.move === PASS || !isGraded(node)) return;
  const r = node.reads || {};
  if (!r.threat) out.push({ node, kind: 'threat' });
  if (!r.baseline) out.push({ node, kind: 'baseline' });
}

// The coach's to-do list: grading the current move and the one before it,
// explaining them (they're what the coach panel shows), then grading the rest
// of the game outwards from here.
function coachQueue(max) {
  const cur = game.current, out = [];
  coachWork(cur, out, true);
  coachWork(cur.parent, out, true);
  explainWork(cur, out);
  if (cur.parent && cur.parent.parent) explainWork(cur.parent, out);
  const line = game.line(), idx = line.indexOf(cur);
  for (let d = 1; d < line.length && out.length < max; d++) {
    coachWork(line[idx - 1 - d], out);
    coachWork(line[idx + d], out);
  }
  return out.slice(0, max);
}

// Each coach engine reads its own position in one deep search (deeper reads
// grade better than several shallow ones merged). Keeps the engines on the
// most urgent work, pre-empting background reads when something more urgent comes up.
function scheduleCoach() {
  if (!settings.coach || (scoring && scoring.pending)) return;
  const engines = coach.engines;
  const want = coachQueue(engines.length);
  const wanted = new Set(want.map(workKey));
  const running = new Set(coachJobs.filter(Boolean).map(workKey));
  for (const w of want) {
    if (running.has(workKey(w))) continue;
    let i = engines.findIndex((_, k) => !coachJobs[k]);
    if (i < 0) i = coachJobs.findIndex(j => !wanted.has(workKey(j)));
    if (i < 0) break;
    startCoachJob(i, w);
  }
}

function startCoachJob(i, w) {
  const job = coachJobs[i] = w, node = w.node;
  coach.engines[i].search(readRecipe(game, node, w.kind, w.move), {
    playouts: settings.coachPlayouts,
    // A slow device gets a shallower read rather than a long wait (desktops run ~7k playouts/s).
    maxTime: settings.coachPlayouts / 2.5,
    onProgress: (res, done) => {
      if (w.kind === 'pos') {
        node.analysis = res;
        if (done) { node.analysisDone = true; preferUsefulMove(res); }
      } else if (!done) return;
      else if (w.kind === 'check') {
        (node.checks = node.checks || new Map()).set(w.move, res);
        if (node.checkMove === w.move) node.checkMove = null;
      } else (node.reads = node.reads || {})[w.kind] = res;
      onAnalysis(node);
    },
  }).then(res => {
    if (coachJobs[i] === job) coachJobs[i] = null;
    if (res) scheduleCoach();
  });
}
```

(d) In `tryGrade`, change the guard line to:

```js
  if (!parent || node.grade || !isGraded(node) || !parent.analysisDone || !node.analysisDone) return;
```

(e) In `aiMove`, change `if (best && results && !node.analysisDone) { node.analysis = results;` to `if (best && results && !node.analysisDone) { node.analysis = preferUsefulMove(results);`.

- [ ] **Step 6: Check syntax and run all tests**

Run: `node --check src/app.js && node --test test/*.test.js`
Expected: no syntax errors; all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/coach.js src/app.js test/coach.test.js
git commit -m "Coach reads each shown move's threat and baseline; AI moves graded only on request

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The app speaks through the wording layer

**Files:**
- Modify: `src/app.js`
- Modify: `src/graph.js`
- Modify: `src/coach.js` (delete `explainMove`)
- Modify: `index.html`, `style.css`
- Modify: `test/coach.test.js`, `test/ladder.test.js`
- Modify: `tools/explain-demo.js`
- Modify: `README.md`

**Interfaces:**
- Consumes: `moveFacts`, `boardFacts` (explain.js); `COACH_FOR`, `resolveLevel`, `gradeLabel`, `levelGrade`, `verdict`, `describe`, `describeNote` (wording.js); `isGraded`, `node.reads` (Task 7).
- Produces: `settings.coachFor` (default `'auto'`); `renderGraph(el, line, current, onPick, mark)` where `mark(node) → { color, small } | null`.

- [ ] **Step 1: Retire `explainMove`**

In `src/coach.js` delete `chainLibsAfterMove` and `explainMove` (the whole `// ---- explanations` block up to `threats`). Delete the `ladder.js` import. For each remaining name in the `./board.js` import, run `grep -n "\bNAME\b" src/coach.js` and drop the ones only used in the import line.

In `test/coach.test.js` delete the test `'explainMove describes captures, atari and self-atari'` (its cases live on in `test/explain.test.js`) and remove `explainMove` from the import.

In `test/ladder.test.js` replace `import { explainMove } from '../src/coach.js';` with:

```js
import { boardFacts } from '../src/explain.js';
import { describe } from '../src/wording.js';
```

and the last test's text line with:

```js
  const text = describe(boardFacts(before, after, pt(5, 4)), { level: 'improving', mover: BLACK, you: BLACK }).join(' ');
```

Run: `node --test test/*.test.js`
Expected: PASS.

- [ ] **Step 2: Settings in `index.html`, `style.css` and `app.js`**

In `index.html`, right after the `</label>` closing the "Coach depth" label, add:

```html
        <label>Coach explains for <select id="optCoachFor"></select></label>
        <small class="muted help">Changes what the coach says, not how the AI plays.</small>
        <label class="inline"><input type="checkbox" id="optGradeAI"> Grade AI moves</label>
```

In `style.css`, after the `.settings select` rule, add:

```css
.settings .help { margin-top: -6px; font-size: 12px; }
```

In `src/app.js`:

- Imports: remove `explainMove` from the coach import; add

```js
import { boardFacts, moveFacts } from './explain.js';
import { COACH_FOR, resolveLevel, gradeLabel, levelGrade, verdict, describe, describeNote } from './wording.js';
```

- `DEFAULTS`: add `coachFor: 'auto',` after `gradeAI: false,`. In `load()` add after the `gradeAI` line:

```js
    if (!COACH_FOR.some(o => o.key === settings.coachFor)) settings.coachFor = DEFAULTS.coachFor;
```

- Helpers, after `const plural = ...`:

```js
const coachLevel = () => resolveLevel(settings.coachFor, settings.level);
```

- `syncOptions()`: add

```js
  $('#optCoachFor').value = settings.coachFor;
  $('#optGradeAI').checked = settings.gradeAI;
```

- `setupControls()`, after the `#optCoach` handler:

```js
  $('#optCoachFor').innerHTML = COACH_FOR.map(o => `<option value="${o.key}">${o.label}</option>`).join('');
  $('#optCoachFor').onchange = e => { settings.coachFor = e.target.value; save(); render(); };
  $('#optGradeAI').onchange = e => {
    settings.gradeAI = e.target.checked;
    for (const n of game.line()) tryGrade(n);
    save(); render(); scheduleCoach();
  };
```

`#optLevel`'s handler already calls `render()`, so "Match AI strength" follows a level change with no further change.

- [ ] **Step 3: Facts per node, and remove the old explanation calls**

In `src/app.js`, add below `tryGrade`:

```js
// What the coach knows about node's move so far (explain.js), from whatever
// reads are done. Cached until another read arrives.
function factsFor(node) {
  const p = node.parent;
  const reads = {
    before: p.analysisDone ? p.analysis : null,
    after: node.analysisDone ? node.analysis : null,
    threat: node.reads && node.reads.threat,
    baseline: node.reads && node.reads.baseline,
  };
  const key = ['before', 'after', 'threat', 'baseline'].map(k => reads[k] ? 1 : 0).join('');
  if (node.facts && node.factsKey === key) return node.facts;
  node.factsKey = key;
  return node.facts = moveFacts({ before: p.board, after: node.board, move: node.move, reads });
}
```

Delete `if (!node.explain) node.explain = explainMove(parent.board, node.board, move);` in `playMove`, and the `node.explain = explainMove(...)` line at the end of `tryGrade`.

In `toggleThreat`, replace `explain: explainMove(passed, after, m.move)` with:

```js
explain: describe(boardFacts(passed, after, m.move), { level: coachLevel(), mover: opp, you: settings.human })
```

- [ ] **Step 4: The move entries**

Replace `moveEntry` with:

```js
function moveEntry(node) {
  const latest = node === game.current;
  const head = pill => `<div class="fb-head">${pill}<span><b>${who(node.color)}</b> ${node.move === PASS ? 'passed' : `played <b>${ptName(node.move)}</b>`}</span></div>`;
  const wrap = html => `<div class="fb-entry${latest ? ' latest' : ''}">${html}</div>`;
  const list = lines => lines.length ? `<ul class="explain">${lines.map(t => `<li>${t}</li>`).join('')}</ul>` : '';
  if (node.move === PASS) return wrap(head(''));
  const level = coachLevel(), facts = factsFor(node);
  const ctx = { level, mover: node.color, you: settings.human };
  // Ungraded (AI) moves: just what the player has to react to.
  if (!isGraded(node)) return wrap(head('') + list(describeNote(facts, ctx)));
  const g = node.grade;
  let html;
  if (!settings.show.feedback) html = head('');
  else if (!g) html = head(`<span class="pill pending">${node.checkMove != null ? 'double-checking…' : 'grading…'}</span>`);
  else {
    ctx.shown = levelGrade(g, level, facts);
    html = head(`<span class="pill" style="--pill:${ctx.shown.color}">${ctx.shown.label}</span>`) + `<p>${verdict(g, level, ctx.shown)}</p>`;
    if (g.grade !== 'best' && g.bestMove !== PASS) {
      html += `<div class="fb-actions"><button data-act="show" data-id="${node.id}">Show ${ptName(g.bestMove)}</button>` +
        `<button data-act="try" data-id="${node.id}">Try ${ptName(g.bestMove)} instead</button></div>`;
    }
  }
  const lines = describe(facts, ctx);
  if (settings.coach && !(node.reads && node.reads.threat && node.reads.baseline)) lines.push('<span class="muted">Reading the idea behind this move…</span>');
  return wrap(html + list(lines));
}
```

In `renderCoach`, change the `#scoreEst` line to hide the expected result for beginners:

```js
  $('#scoreEst').innerHTML = an && coachLevel() !== 'beginner' ? `Expected result: <b>${describeScore(an.score)}</b> <span class="muted">(incl. komi ${game.komi})</span>` : '&nbsp;';
```

- [ ] **Step 5: Board ring, graph and review follow the level**

In `renderBoard`, replace the `s.grade = ...` line with:

```js
  if (sh.feedback && node.grade && isGraded(node)) {
    const shown = levelGrade(node.grade, coachLevel(), factsFor(node));
    if (shown.key === 'mistake' || shown.key === 'blunder') s.grade = shown.color;
  }
```

Add above `render()`:

```js
// Graph dot for a move flagged at the current coach level.
function graphMark(node) {
  if (!node.grade || node.move === PASS || !isGraded(node)) return null;
  const shown = levelGrade(node.grade, coachLevel(), factsFor(node));
  return shown.flagged ? { color: shown.color, small: shown.key === 'inaccuracy' } : null;
}
```

and in `render()` change the graph call to `renderGraph($('#graph'), game.line(), game.current, goTo, graphMark);`.

In `src/graph.js`: remove the `GRADES` import; change the signature to `export function renderGraph(el, line, current, onPick, mark = () => null) {`; replace the `const g = node.grade; if (g && (...)) { dots += ... }` block with:

```js
    const m = mark(node);
    if (m) dots += `<circle cx="${x(i)}" cy="${yWr(an.blackWinrate)}" r="${m.small ? 3.5 : 5.5}" fill="${m.color}" stroke="#fff" stroke-width="1.5"/>`;
```

Replace `renderReview` with:

```js
function renderReview() {
  const el = $('#review'), level = coachLevel();
  const stats = {};
  for (const c of [BLACK, WHITE]) stats[c] = { n: 0, loss: 0, counts: {}, worst: [] };
  for (const n of game.line()) {
    const g = n.grade;
    if (!g || n.move === PASS || !isGraded(n)) continue;
    const s = stats[n.color], shown = levelGrade(g, level, factsFor(n));
    s.n++;
    s.loss += Math.min(g.ptLoss, 30);
    if (!shown.flagged) continue;
    s.counts[shown.key] = (s.counts[shown.key] || 0) + 1;
    if (shown.key !== 'inaccuracy') s.worst.push(n);
  }
  if (!stats[BLACK].n && !stats[WHITE].n) { el.innerHTML = ''; return; }
  const row = c => {
    const s = stats[c];
    if (!s.n) return '';
    const pills = ['blunder', 'mistake', 'inaccuracy'].filter(k => s.counts[k])
      .map(k => `<span class="pill" style="--pill:${GRADES[k].color}">${plural(s.counts[k], gradeLabel(k, level).toLowerCase())}</span>`).join(' ');
    const avg = level === 'beginner' ? '' : `<span class="muted">avg −${(s.loss / s.n).toFixed(1)} pts/move</span>`;
    return `<div class="rv-row"><span class="stone-icon ${c === BLACK ? 'black' : 'white'}"></span><b>${who(c)}</b>` +
      `${avg}${pills || '<span class="muted">no mistakes yet</span>'}</div>`;
  };
  const worst = [...stats[BLACK].worst, ...stats[WHITE].worst].sort((a, b) => b.grade.ptLoss - a.grade.ptLoss).slice(0, 5);
  const chip = n => `<button class="chip" data-id="${n.id}" title="Jump to this move">#${n.depth} ${ptName(n.move)}${level === 'beginner' ? '' : ` −${n.grade.ptLoss.toFixed(0)}`}</button>`;
  el.innerHTML = row(BLACK) + row(WHITE) + (worst.length ? `<div class="rv-worst"><span class="muted">Biggest:</span>${worst.map(chip).join('')}</div>` : '');
  el.onclick = e => {
    const node = worst.find(n => n.id === +(e.target.dataset && e.target.dataset.id));
    if (node) goTo(node);
  };
}
```

(`plural` turns "big mistake" into "big mistakes" and "blunder" into "blunders", as before.)

- [ ] **Step 6: `tools/explain-demo.js`**

Replace the file with:

```js
// Prints the coach's grade and explanation at each level for a quick
// self-play game (QA for wording): node tools/explain-demo.js [movePlayouts] [readPlayouts]
import { BLACK, PASS, ptName } from '../src/board.js';
import { Search, seed, rand } from '../src/mcts.js';
import { Game } from '../src/game.js';
import { LEVELS, chooseMove, shouldPass, gradeMove, preferUsefulMove } from '../src/coach.js';
import { moveFacts } from '../src/explain.js';
import { levelGrade, verdict, describe } from '../src/wording.js';

seed(42);
const moveP = +process.argv[2] || 600, readP = +process.argv[3] || 3000;
// A coach read of board, optionally after one more move (a pass for the threat/baseline reads).
const read = (board, extra) => {
  const b = board.clone();
  if (extra !== undefined) { b.play(extra); b.passes = 0; }
  const s = new Search(b, { komi: 7 });
  s.run(readP);
  return preferUsefulMove(s.results(40));
};
const plain = html => html.replace(/<[^>]+>/g, '');
const game = new Game({ komi: 7 });
game.root.analysis = read(game.root.board);
while (!game.isOver() && game.current.depth < 40) {
  const parent = game.current, c = game.toPlay;
  const s = new Search(parent.board, { komi: 7, forbidden: p => !game.check(p).ok });
  s.run(moveP);
  let move = shouldPass(game, parent.analysis, c) ? PASS : chooseMove(s.results(40), LEVELS[1], rand);
  if (!game.check(move).ok) move = PASS;
  const node = game.play(move);
  node.analysis = read(node.board);
  const g = gradeMove(parent.analysis, node.analysis, move);
  const reads = { before: parent.analysis, after: node.analysis, threat: read(node.board, PASS), baseline: read(parent.board, PASS) };
  const facts = moveFacts({ before: parent.board, after: node.board, move, reads });
  console.log(`${String(node.depth).padStart(2)} ${c === BLACK ? 'B' : 'W'} ${ptName(move)}`);
  for (const level of ['beginner', 'improving', 'strong']) {
    const shown = g && levelGrade(g, level, facts);
    const text = describe(facts, { level, mover: c, you: BLACK, shown }).join(' ');
    console.log(`   ${level.padEnd(9)} ${shown ? `${shown.label}: ${plain(verdict(g, level, shown))} ` : ''}${plain(text)}`);
  }
}
console.log(game.board.toString());
```

Run: `node tools/explain-demo.js 400 2000 | head -60`
Expected: 40 moves, three lines each, no exceptions. Read a dozen moves: beginner lines have no point values; no line praises an atari on stones called dead; no "cut" whose stone the next lines call captured.

- [ ] **Step 7: README**

In `README.md`, in the "A coach that watches every move." bullet, after its first sentence add: `Set **Coach explains for** to match your experience: beginners hear about liberties and captures, stronger players about points, threats and plans.`

- [ ] **Step 8: Check and test**

Run: `node --check src/app.js && node --check src/graph.js && node --test test/*.test.js`
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add src/app.js src/graph.js src/coach.js index.html style.css test/coach.test.js test/ladder.test.js tools/explain-demo.js README.md
git commit -m "Coach explains moves by level: look-ahead facts, threat and purpose, notes for AI moves

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Check it in the browser

**Files:**
- Create: `local/serve.mjs`, `local/drive.mjs` (gitignored, not committed)

- [ ] **Step 1: Static server**

Create `local/serve.mjs`:

```js
// Minimal static server for the repo root (ES modules need a real HTTP origin).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
createServer(async (req, res) => {
  const path = join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
  try { res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' }); res.end(await readFile(path)); }
  catch { res.writeHead(404); res.end(); }
}).listen(8765, () => console.log('serving on 8765'));
```

Run it in the background: `node local/serve.mjs`, then `curl -sf http://localhost:8765/ >/dev/null && echo up`.

- [ ] **Step 2: Driver covering the Review Focus scenarios**

Create `local/drive.mjs` (the Playwright path is the copy in the npx cache on this machine; find it with `find ~/AppData/Local/npm-cache/_npx -maxdepth 3 -name playwright -type d`):

```js
// Plays GoYomi headless and checks the coach at each level (see the plan's Review Focus).
import { chromium } from 'file:///C:/Users/frank/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs';
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto('http://localhost:8765/');
await page.waitForFunction(() => window.dojo && window.dojo.game);
const myTurn = () => page.waitForFunction(() => !dojo.aiThinking && dojo.game.current.board.toPlay === dojo.settings.human, null, { timeout: 90000 });
const explained = () => page.waitForFunction(() => {
  const n = dojo.game.current, mine = n.color === dojo.settings.human ? n : n.parent;
  return mine && mine.grade && mine.reads && mine.reads.threat && mine.reads.baseline;
}, null, { timeout: 120000 });
const feedback = () => page.$eval('#feedback', el => el.innerText);
const shot = name => page.screenshot({ path: `local/${name}.png` });

// 1. Default: Sprout, Match AI strength → beginner wording.
for (const m of ['E5', 'C3', 'G7']) { await myTurn(); await page.evaluate(m => dojo.play(m), m); }
await myTurn(); await explained();
let text = await feedback();
console.log('--- beginner\n' + text);
if (/point|%/.test(text)) errors.push('beginner feedback quotes points');
await shot('beginner');

// 2. Level switch relabels at once.
for (const level of ['improving', 'strong']) {
  await page.selectOption('#optCoachFor', level);
  text = await feedback();
  console.log(`--- ${level}\n` + text);
  console.log(`graph dots: ${await page.$$eval('#graph circle', c => c.length)}`);
  await shot(level);
}

// 3. Grade AI moves on, then off.
await page.check('#optGradeAI');
await page.waitForFunction(() => dojo.game.line().filter(n => n.parent && n.color !== dojo.settings.human).every(n => n.grade), null, { timeout: 180000 });
console.log('AI moves graded: ok');
await page.uncheck('#optGradeAI');

// 4. Take back quickly while reads run, then return.
await myTurn(); await page.evaluate(() => dojo.play('D6'));
await page.evaluate(() => { dojo.takeBack(); dojo.takeBack(); });
await myTurn(); await page.evaluate(() => dojo.play('D6'));
await myTurn(); await explained();
console.log('after take-back:\n' + await feedback());

// 5. A pass, then a move.
await myTurn(); await page.evaluate(() => dojo.pass());
await myTurn(); await page.evaluate(() => dojo.play('F3'));
await myTurn(); await explained();
console.log('after pass:\n' + await feedback());
await shot('final');
console.log('errors:', errors.length ? '\n' + errors.join('\n') : 'none');
await browser.close();
```

- [ ] **Step 3: Run it and look**

Run: `node local/drive.mjs` (allow ~10 minutes; each read is ~10 s)
Expected: `errors: none`; the beginner section has no points or percentages; the improving and strong sections show point values; graph dot counts differ where levels flag differently; AI moves get graded when asked; explanations arrive after the take-back and after the pass. Open `local/beginner.png`, `local/strong.png` and `local/final.png` and check the coach panel reads naturally and the settings card shows the two new settings.

If `dojo.pass()` is refused because the game would end (the AI also passes), play one more move first; the scenario is about a move right after a pass.

- [ ] **Step 4: Fix what the run shows, then re-run all tests**

Any fix goes to the task that owns the code (with a test where the fix is in `explain.js`, `wording.js` or `coach.js`). Then run: `node --test test/*.test.js`
Expected: PASS.

- [ ] **Step 5: Commit any fixes**

```bash
git add -A src test
git commit -m "Coach explanations: fixes from the browser check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Skip if nothing changed. Stop the server afterwards.)
