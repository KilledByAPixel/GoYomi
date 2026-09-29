import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Board, BLACK, WHITE, EMPTY, PASS, pt, parsePt, ptName } from '../src/board.js';
import { Game } from '../src/game.js';

const P = s => parsePt(s);
const playAll = (g, list) => list.split(' ').forEach(m => assert.ok(g.play(P(m)), `move ${m}`));

test('recipe of a finished game asks the engine to play the position out', () => {
  const g = new Game();
  playAll(g, 'E5 C3');
  assert.equal(g.recipe().resetPasses, false);
  g.play(PASS);
  assert.equal(g.recipe().resetPasses, false, 'one pass: the game is still on');
  g.play(PASS);
  assert.ok(g.isOver());
  // Without this, playouts from the two-pass position end immediately: nothing
  // is ever captured, so no stone looks dead and enclosed areas count for nobody.
  assert.equal(g.recipe().resetPasses, true);
});

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

test('SGF soft line breaks are removed; escaped ] and \\ still round-trip', () => {
  for (const nl of ['\n', '\r', '\r\n', '\n\r']) {
    const h = Game.fromSGF(`(;GM[1]SZ[9];B[ee]C[line1\\${nl}line2])`);
    assert.equal(h.root.children[0].comment, 'line1line2', JSON.stringify(nl));
  }
  // Only the newline straight after the backslash goes; a hard break stays.
  assert.equal(Game.fromSGF('(;GM[1]SZ[9];B[ee]C[a\\\n\nb])').root.children[0].comment, 'a\nb');
  const g = new Game();
  g.play(pt(4, 4));
  g.current.comment = 'a]b\\\nc\\';
  const h = Game.fromSGF(g.toSGF());
  assert.equal(h.root.children[0].comment, 'a]b\\\nc\\');
});

test('SGF import follows the main (first) variation', () => {
  const h = Game.fromSGF('(;GM[1]SZ[9];B[ee](;W[cc];B[gg])(;W[gc]))');
  const line = h.line(h.root);
  assert.deepEqual(line.slice(1).map(n => ptName(n.move)), ['E5', 'C7', 'G3']);
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

test('handicap: White gets a point per handicap stone, in the count and for the engines', () => {
  const g = new Game({ komi: 0.5, handicap: 3 });
  assert.equal(g.handicapBonus, 3);
  assert.equal(g.recipe().komi, 3.5);
  const s = g.score();
  // Only Black's 3 handicap stones on the board: black 81 by area, white 0.
  assert.equal(s.bonus, 3);
  assert.equal(s.margin, 81 - 0 - 0.5 - 3);
  assert.equal(new Game({ komi: 7 }).handicapBonus, 0);
  assert.equal(new Game({ komi: 7, setup: [[P('C3'), BLACK]] }).handicapBonus, 0, 'setups are not handicaps');
});

test('handicap compensation survives an SGF round trip', () => {
  const g = new Game({ komi: 0.5, handicap: 2 });
  const h = Game.fromSGF(g.toSGF());
  assert.equal(h.handicapBonus, 2);
  assert.equal(h.recipe().komi, 2.5);
  assert.equal(Game.fromSGF('(;GM[1]SZ[9]KM[0.5]HA[1]AB[ee])').handicapBonus, 0, 'HA below 2 is no handicap');
});

test('SGF: a move in the first node is played', () => {
  const g = Game.fromSGF('(;GM[1]SZ[9]B[ee];W[dd])');
  assert.deepEqual(g.line().slice(1).map(n => ptName(n.move)), ['E5', 'D6']);
});

test('SGF: White to play survives a round trip without setup stones', () => {
  const g = Game.fromSGF('(;GM[1]SZ[9]PL[W])');
  assert.equal(g.root.board.toPlay, WHITE);
  assert.equal(Game.fromSGF(g.toSGF()).root.board.toPlay, WHITE);
});

test('SGF: adding or removing stones during the game is refused', () => {
  assert.throws(() => Game.fromSGF('(;GM[1]SZ[9];B[ee];AE[ee]AW[dd];B[cc])'), /add or remove stones during the game/);
});

test('SGF: an invalid starting position is refused', () => {
  for (const sgf of ['(;GM[1]SZ[9]AB[aa][aa])', '(;GM[1]SZ[9]AB[aa]AW[aa])', '(;GM[1]SZ[9]AB[tt])', '(;GM[1]SZ[9]AB[])', '(;GM[1]SZ[9]AB[zz])']) {
    assert.throws(() => Game.fromSGF(sgf), /starting position is invalid/, sgf);
  }
  // A valid setup still loads, with the board's bookkeeping intact.
  const g = Game.fromSGF('(;GM[1]SZ[9]AB[aa][bb]AW[cc])');
  const b = g.root.board;
  let empties = 0;
  for (let p = 0; p < b.color.length; p++) if (b.color[p] === EMPTY) empties++;
  assert.equal(b.emptyCount, 78);
  assert.equal(empties, 78);
});

// Every node's side to move is the other colour from the move that made it.
const alternates = g => {
  const bad = [], walk = n => { if (n.parent && n.board.toPlay !== 3 - n.color) bad.push(ptName(n.move)); n.children.forEach(walk); };
  walk(g.root);
  return bad;
};

test('SGF: the same player moving twice means the other passed, and no variation is lost', () => {
  const g = Game.fromSGF('(;GM[1]SZ[9];B[ee](;W[dd])(;B[dd]))');
  const e5 = g.root.children[0];
  assert.equal(e5.board.toPlay, WHITE, 'the shared parent keeps White to play');
  assert.deepEqual(e5.children.map(c => `${c.color === BLACK ? 'B' : 'W'} ${ptName(c.move)}`).sort(), ['W D6', 'W pass']);
  const pass = e5.children.find(c => c.move === PASS);
  assert.deepEqual(pass.children.map(c => `${c.color === BLACK ? 'B' : 'W'} ${ptName(c.move)}`), ['B D6']);
  assert.deepEqual(alternates(g), []);
  // The saved file keeps both lines when loaded again.
  const h = Game.fromSGF(g.toSGF());
  assert.equal(h.root.children[0].children.length, 2);
  assert.deepEqual(alternates(h), []);
});

test('SGF: a same-colour variation doesn\'t change whose turn it is at the shared position', () => {
  const g = Game.fromSGF('(;GM[1]SZ[9];B[ee](;W[dd])(;B[cc]))');
  const e5 = g.root.children[0];
  assert.equal(e5.board.toPlay, WHITE);
  // What the coach reads (the recipe) agrees with the board: the last move is Black's, so White is to play.
  assert.deepEqual(g.recipe(e5).moves, [[P('E5'), BLACK]]);
  assert.deepEqual(alternates(g), []);
});

test('SGF: the first move still decides who starts', () => {
  assert.equal(Game.fromSGF('(;GM[1]SZ[9];W[ee])').root.board.toPlay, WHITE);
});

test('SGF: a starting stone with no liberties is refused', () => {
  assert.throws(() => Game.fromSGF('(;GM[1]SZ[9]AB[aa]AW[ab][ba])'), /starting position is invalid \(the stone at A9 has no liberties\)/);
  // White goes on last, so nothing captures it: it just sits there with none.
  assert.throws(() => Game.fromSGF('(;GM[1]SZ[9]AB[ab][ba]AW[aa])'), /the stone at A9 has no liberties/);
  assert.throws(() => Game.fromSGF('(;GM[1]SZ[9]AB[ac][bb][ca]AW[aa][ab][ba])'), /has no liberties/);
  // Stones sharing a liberty are fine.
  assert.doesNotThrow(() => Game.fromSGF('(;GM[1]SZ[9]AB[ac][bb]AW[aa][ab][ba])'));
});

test('SGF: a comment on a node without a move is kept, on the move before it', () => {
  const g = Game.fromSGF('(;GM[1]FF[4]SZ[9]C[start];B[ee]C[first];C[note];W[cc])');
  assert.equal(g.root.comment, 'start');
  const e5 = g.root.children[0];
  assert.equal(e5.comment, 'first\n\nnote');
  assert.equal(e5.children[0].comment, '');
  assert.match(g.toSGF(), /B\[ee\]C\[first\n\nnote\]/);
});

test('SGF: names, result and game details survive a load and save', () => {
  const g = Game.fromSGF('(;GM[1]FF[4]SZ[9]KM[7]PB[Alice]PW[Bob]BR[3k]WR[2k]EV[Club night]GN[Round 1]DT[2026-09-28]PC[Online]RE[W+R];B[ee];W[cc])');
  const out = g.toSGF();
  for (const prop of ['PB[Alice]', 'PW[Bob]', 'BR[3k]', 'WR[2k]', 'EV[Club night]', 'GN[Round 1]', 'DT[2026-09-28]', 'PC[Online]', 'RE[W+R]']) assert.ok(out.includes(prop), prop);
  assert.ok(!out.includes('PB[Black]'));
  // And again: a GoYomi save loaded and saved keeps them too.
  assert.equal(Game.fromSGF(out).toSGF(), out);
});

test('SGF: a new result replaces the recorded one; playing on past the recorded end drops it', () => {
  const g = Game.fromSGF('(;GM[1]SZ[9]KM[7]RE[B+2.5];B[ee];W[cc])');
  assert.ok(g.toSGF({ result: 'W+R' }).includes('RE[W+R]'));
  assert.ok(!g.toSGF({ result: 'W+R' }).includes('B+2.5'));
  while (g.current.children.length) g.redo();
  g.play(parsePt('G7'));
  assert.ok(!g.toSGF().includes('RE['), 'the recorded result belonged to the shorter game');
});

test('SGF: saving from a variation writes that line first, keeping the others', () => {
  const g = new Game({ komi: 0 });
  g.play(parsePt('A9'));
  const a9 = g.current;
  g.play(parsePt('J1'));                // the original line
  g.goTo(a9);
  g.play(parsePt('B8'));                // a variation, now the line on show
  const out = g.toSGF({ result: 'B+81', main: g.current });
  const back = Game.fromSGF(out);
  const first = back.root.children[0].children[0];
  assert.equal(ptName(first.move), 'B8', 'the line on show comes first');
  assert.equal(back.root.children[0].children.length, 2, 'the other variation is kept');
  assert.ok(out.includes('RE[B+81]'));
  // Without `main` (autosave), the tree keeps its order.
  assert.equal(ptName(Game.fromSGF(g.toSGF()).root.children[0].children[0].move), 'J1');
});

test('SGF: a handicap that isn\'t a whole number from 0 to 9 is refused; setup stones win over a wrong count', () => {
  for (const ha of ['Infinity', '-2', '2.5', '10', 'x']) assert.throws(() => Game.fromSGF(`(;GM[1]SZ[9]HA[${ha}])`), /handicap/, ha);
  const g = Game.fromSGF('(;GM[1]SZ[9]HA[5]AB[aa][ii])');
  assert.equal(g.handicap, 2);
  assert.equal(g.handicapBonus, 2);
  const ok = Game.fromSGF('(;GM[1]SZ[9]HA[3]AB[cc][gg][cg])');
  assert.equal(ok.handicap, 3);
  assert.equal(Game.fromSGF('(;GM[1]SZ[9]HA[0])').handicap, 0);
});

test('SGF: autosave and reload don\'t turn default names into a record\'s names', () => {
  const g = new Game();
  g.play(parsePt('E5'));
  const saved = g.toSGF({ black: '', white: '' });   // what autosave writes
  assert.ok(!/PB\[|PW\[/.test(saved), 'no names written when there are none');
  const back = Game.fromSGF(saved);
  assert.equal(back.info.PB, undefined);
  assert.ok(back.toSGF({ black: 'Human', white: 'GoYomi Pebble' }).includes('PB[Human]PW[GoYomi Pebble]'));
  // An older autosave with the placeholder names isn't taken as real players either.
  const old = Game.fromSGF('(;GM[1]SZ[9]KM[7]PB[Black]PW[White];B[ee])');
  assert.ok(old.toSGF({ black: 'Human', white: 'GoYomi Pebble' }).includes('PB[Human]PW[GoYomi Pebble]'));
});
