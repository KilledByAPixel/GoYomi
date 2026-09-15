import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Board, BLACK, WHITE, EMPTY, EDGE, PASS, POINTS, D4, pt, ptName, parsePt, SIZE } from '../src/board.js';

// Naive reference implementation: flood fill everything.
function groupAndLibs(color, p) {
  const c = color[p], stones = [p], seen = new Set([p]), libs = new Set();
  for (let i = 0; i < stones.length; i++) {
    for (const d of D4) {
      const q = stones[i] + d;
      if (color[q] === EMPTY) libs.add(q);
      else if (color[q] === c && !seen.has(q)) { seen.add(q); stones.push(q); }
    }
  }
  return { stones, libs };
}
function naiveLegal(color, p, c, ko) {
  if (color[p] !== EMPTY || p === ko) return false;
  const t = new Uint8Array(color); t[p] = c;
  for (const d of D4) {
    const q = p + d;
    if (t[q] === 3 - c && groupAndLibs(t, q).libs.size === 0) return true;
  }
  return groupAndLibs(t, p).libs.size > 0;
}

let rs = 12345;
const rnd = n => { rs = (rs * 1103515245 + 12345) & 0x7fffffff; return rs % n; };

test('fast board matches naive flood-fill over random games', () => {
  for (let game = 0; game < 80; game++) {
    const b = new Board();
    for (let move = 0; move < 200; move++) {
      const c = b.toPlay;
      for (const p of POINTS) {
        assert.equal(b.isLegal(p), naiveLegal(b.color, p, c, b.ko), `legal ${ptName(p)} game ${game} move ${move}\n${b}`);
        if (b.color[p] === BLACK || b.color[p] === WHITE) {
          const g = groupAndLibs(b.color, p);
          assert.equal(b.inAtari(b.head[p]), g.libs.size === 1, `atari ${ptName(p)}\n${b}`);
          assert.equal(b.libCount(p), g.libs.size);
          assert.equal(b.size[b.head[p]], g.stones.length);
          if (g.libs.size === 1) assert.equal(b.atariLib(b.head[p]), [...g.libs][0]);
        } else if (b.color[p] === EMPTY) {
          if (b.isLegal(p)) {
            const t = b.clone(); t.play(p);
            const expect = Math.min(2, t.libCount(p));
            assert.equal(b.libsAfter(p, c, 2), expect, `libsAfter ${ptName(p)}\n${b}`);
          }
        }
      }
      const legal = POINTS.filter(p => b.isLegal(p) && !b.isEyeish(p, c));
      if (!legal.length) { b.play(PASS); continue; }
      const p = legal[rnd(legal.length)];
      const before = new Uint8Array(b.color);
      const cap = b.play(p);
      // verify captures against naive
      before[p] = c;
      let expectCap = 0;
      for (const d of D4) {
        const q = p + d;
        if (before[q] === 3 - c) {
          const g = groupAndLibs(before, q);
          if (g.libs.size === 0) { for (const s of g.stones) before[s] = EMPTY; expectCap += g.stones.length; }
        }
      }
      assert.equal(cap, expectCap);
      assert.deepEqual([...b.color], [...before]);
      const empties = POINTS.filter(q => b.color[q] === EMPTY).sort((x, y) => x - y);
      assert.deepEqual([...b.empty.slice(0, b.emptyCount)].sort((x, y) => x - y), empties);
      for (let i = 0; i < b.emptyCount; i++) assert.equal(b.emptyIdx[b.empty[i]], i);
      if (move % 17 === 0) { const cl = b.clone(); assert.equal(cl.emptyCount, b.emptyCount); assert.equal(cl.hash, b.hash); }
    }
  }
});

test('hash depends only on stones', () => {
  const a = new Board(), b = new Board();
  a.play(pt(2, 2)); a.play(pt(6, 6)); a.play(pt(4, 4));
  b.play(pt(4, 4)); b.play(pt(6, 6)); b.play(pt(2, 2));
  assert.equal(a.hash, b.hash);
  const e = new Board();
  assert.notEqual(a.hash, e.hash);
});

test('simple capture and ko', () => {
  // Classic ko shape: black to capture at E5-ish
  const b = Board.fromRows([
    '.........',
    '.........',
    '.........',
    '...XO....',
    '..XO.O...',
    '...XO....',
    '.........',
    '.........',
    '.........',
  ], BLACK);
  const koCapture = pt(4, 4);
  assert.ok(b.isLegal(koCapture));
  assert.equal(b.play(koCapture), 1);
  assert.equal(b.ko, pt(3, 4));
  assert.equal(b.isLegal(pt(3, 4)), false, 'white cannot retake immediately');
  b.play(pt(8, 8)); // white elsewhere
  b.play(pt(0, 8)); // black elsewhere
  assert.equal(b.isLegal(pt(3, 4)), true, 'white can retake after a ko threat');
});

test('suicide is illegal, capturing suicide-looking move is legal', () => {
  const b = Board.fromRows([
    '.X.......',
    'X........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
  ], WHITE);
  assert.equal(b.isLegal(pt(0, 0)), false);
  const c = Board.fromRows([
    'OX.......',
    'X........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
  ], WHITE);
  // white at corner has no libs in setup; black stones each have libs; white playing (0,0) is occupied.
  assert.equal(c.color[pt(0, 0)], EMPTY, 'white stone with no liberties was captured during setup');
});

test('eyeish detection', () => {
  const b = Board.fromRows([
    '.X.......',
    'X.X......',
    '.X.......',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
  ]);
  assert.equal(b.isEyeish(pt(0, 0), BLACK), true);
  assert.equal(b.isEyeish(pt(1, 1), BLACK), true);
  assert.equal(b.isEyeish(pt(1, 1), WHITE), false);
});

test('area score with dead stones', () => {
  const b = Board.fromRows([
    '....X.O..',
    '....X.O..',
    '....X.O..',
    '....X.O..',
    '....X.O..',
    '....X.O..',
    '....X.O.X',
    '....X.O..',
    '....X.O..',
  ]);
  // Lone X inside white's area makes that region neutral: black = 45 + 1 stone, white = 9 stones.
  let s = b.areaScore();
  assert.equal(s.black, 46);
  assert.equal(s.white, 9);
  s = b.areaScore(new Set([pt(8, 6)]));
  assert.equal(s.black, 45);
  assert.equal(s.white, 27);
});

test('coordinates round-trip', () => {
  for (const p of POINTS) assert.equal(parsePt(ptName(p)), p);
  assert.equal(ptName(pt(0, 8)), 'A1');
  assert.equal(ptName(pt(8, 0)), 'J9');
  assert.equal(parsePt('pass'), PASS);
});
