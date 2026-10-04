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

test('SGF: a handicap needs its stones; no stones or an impossible count means no handicap', () => {
  const none = Game.fromSGF('(;GM[1]SZ[9]HA[2])');
  assert.deepEqual([none.handicap, none.handicapBonus, none.recipe().komi, none.root.board.toPlay], [0, 0, 0, BLACK], 'no stones');
  const white = Game.fromSGF('(;GM[1]SZ[9]HA[2]AW[ee])');
  assert.deepEqual([white.handicap, white.handicapBonus], [0, 0], 'only White setup stones');
  const ten = Game.fromSGF('(;GM[1]SZ[9]HA[2]AB[aa][ba][ca][da][ea][fa][ga][ha][ia][ab])');
  assert.deepEqual([ten.handicap, ten.handicapBonus, ten.recipe().komi], [0, 0, 0], 'ten stones is a position, not a handicap');
  const fine = Game.fromSGF('(;GM[1]SZ[9]HA[3]AB[cc][gg][cg])');
  assert.deepEqual([fine.handicap, fine.handicapBonus, fine.root.board.toPlay], [3, 3, WHITE], 'an ordinary handicap');
});

test('SGF: every record that loads can be saved and loaded again unchanged', () => {
  const records = [
    '(;GM[1]SZ[9]HA[2])', '(;GM[1]SZ[9]HA[1]AB[ee])', '(;GM[1]SZ[9]HA[0]AB[cc][gg])',
    '(;GM[1]SZ[9]HA[5]AB[aa][ii])', '(;GM[1]SZ[9]HA[2]AB[aa][ba][ca][da][ea][fa][ga][ha][ia][ab])',
    '(;GM[1]SZ[9]HA[3]AB[cc][gg][cg]AW[ee])', '(;GM[1]SZ[9]KM[0.5]HA[4]AB[cc][gg][cg][gc];W[ee];B[dd])',
    '(;GM[1]SZ[9]PB[a\\]b]PW[c\\\\d]RE[B+2.5]EV[x];B[ee](;W[cc])(;W[gg]))',
  ];
  for (const r of records) {
    const g = Game.fromSGF(r), saved = g.toSGF();
    const back = Game.fromSGF(saved);
    assert.equal(back.toSGF(), saved, r);
    assert.deepEqual([back.handicap, back.handicapBonus, back.komi, back.root.board.toPlay], [g.handicap, g.handicapBonus, g.komi, g.root.board.toPlay], r);
  }
});

// What the player sees is "Could not load that SGF: " and then the message.
const loadError = sgf => { try { Game.fromSGF(sgf); } catch (e) { return e.message; } assert.fail(`loaded: ${sgf}`); };

test('SGF: a property with no value is a clear error, not a crash', () => {
  for (const id of ['HA', 'PL', 'SZ', 'KM', 'AB']) {
    assert.equal(loadError(`(;GM[1]SZ[9]${id})`), `the file isn't valid SGF (on line 1, the property ${id} has no value).`, id);
  }
  assert.equal(loadError('(;GM[1]SZ[9]\n;B[ee]PL;W[cc])'), 'the file isn\'t valid SGF (on line 2, the property PL has no value).');
  assert.equal(loadError('(;GM[1]SZ[])'), 'its board size, "", isn\'t a number.');
  assert.equal(loadError('(;GM[1]SZ[nine])'), 'its board size, "nine", isn\'t a number.');
});

test('SGF: the board must be 9 or 9:9; other sizes say what they are', () => {
  assert.equal(loadError('(;GM[1]SZ[9:7])'), 'it\'s a 9x7 game; only 9x9 is supported.');
  assert.equal(loadError('(;GM[1]SZ[19])'), 'it\'s a 19x19 game; only 9x9 is supported.');
  assert.equal(loadError('(;GM[1];B[ee])'), 'it\'s a 19x19 game; only 9x9 is supported.', 'no SZ means 19x19');
  assert.equal(Game.fromSGF('(;GM[1]SZ[9:9];B[ee])').root.children.length, 1);
  assert.equal(Game.fromSGF('(;GM[1]SZ[ 9 ];B[ee])').root.children.length, 1);
});

test('SGF: compressed point lists (a rectangle by its corners) set up every point', () => {
  const g = Game.fromSGF('(;GM[1]SZ[9]AB[cc:ee]AW[gg][hg:hh])');
  const b = g.root.board;
  for (let x = 2; x <= 4; x++) for (let y = 2; y <= 4; y++) assert.equal(b.color[pt(x, y)], BLACK);
  assert.deepEqual(g.setup.filter(([, c]) => c === WHITE).map(([p]) => ptName(p)).sort(), ['G3', 'H2', 'H3']);
  assert.equal(g.setup.length, 12);
  // Corners in either order, and a one-point "rectangle".
  assert.equal(Game.fromSGF('(;GM[1]SZ[9]AB[ee:cc])').setup.length, 9);
  assert.equal(Game.fromSGF('(;GM[1]SZ[9]AB[ee:ee])').setup.length, 1);
  // Saved as single points, which load back the same.
  assert.equal(Game.fromSGF(g.toSGF()).toSGF(), g.toSGF());
  // The checks still apply to each point.
  assert.match(loadError('(;GM[1]SZ[9]AB[cc:ee]AW[dd])'), /starting position is invalid \(D6 is listed twice\)/);
  assert.match(loadError('(;GM[1]SZ[9]AB[aa:ii])'), /has no liberties/);
  assert.match(loadError('(;GM[1]SZ[9]AB[cc:zz])'), /invalid \("cc:zz" is not on the board\)/);
  assert.match(loadError('(;GM[1]SZ[9]AB[cc:dd:ee])'), /"cc:dd:ee" is not on the board/);
  assert.match(loadError('(;GM[1]SZ[9]AB[cc:])'), /"cc:" is not a point/);
});

test('SGF: a cut-short file or a trailing backslash says the file is cut short', () => {
  for (const sgf of ['(;GM[1]SZ[9];B[ee];W[c', '(;GM[1]SZ[9];B[ee]C[abc\\', '(;GM[1]SZ[9];B[ee]C[path\\])', '(;GM[1]SZ[9];B[ee]',
    '(;GM[1]SZ[9];B[ee](;W[cc])', '(;GM[1]SZ[9]', '(;GM[1]SZ[9];B[ee]PL', '(;']) {
    assert.equal(loadError(sgf), 'the file stops partway through the record; it may be cut short.', sgf);
  }
});

test('SGF: text before and after the record is ignored; stray text inside it is an error', () => {
  const g = Game.fromSGF('From: a friend\n(see below)\n\n(;GM[1]SZ[9];B[ee];W[cc])\n-- sent from my phone (;GM[1]SZ[19])');
  assert.deepEqual(g.line(g.root).slice(1).map(n => ptName(n.move)), ['E5', 'C7']);
  assert.equal(loadError('(;GM[1]SZ[9];B[ee]\njunk;W[cc])'), 'the file isn\'t valid SGF (on line 2, "junk" is out of place).');
  assert.equal(loadError('(;GM[1]SZ[9];B[ee]1)'), 'the file isn\'t valid SGF (on line 1, "1" is out of place).');
  assert.equal(loadError('(;GM[1]SZ[9];B[ee]];W[cc])'), 'the file isn\'t valid SGF (on line 1, "]" is out of place).');
  assert.equal(loadError('(;GM[1]SZ[9];B[ee]()(;W[cc]))'), 'the file isn\'t valid SGF (on line 1, a variation has no moves).');
  for (const text of ['', 'hello', '()', '(GM[1])']) assert.equal(loadError(text), 'the file has no SGF game record in it.', text);
});

test('SGF: an illegal move says which move and why', () => {
  assert.equal(loadError('(;GM[1]SZ[9];B[ee];W[ee])'), 'move 2, White E5, is against the rules (there is already a stone there).');
  assert.equal(loadError('(;GM[1]SZ[9];B[ba];W[ia];B[ab];W[aa])'), 'move 4, White A9, is against the rules (it is suicide).');
});

test('SGF: a missing KM means no komi; GoYomi\'s own files always say', () => {
  assert.equal(Game.fromSGF('(;GM[1]SZ[9];B[ee])').komi, 0);
  assert.equal(Game.fromSGF('(;GM[1]SZ[9]KM[6.5];B[ee])').komi, 6.5);
  assert.equal(Game.fromSGF('(;GM[1]SZ[9]KM[6,5])').komi, 6.5);
  // The handicap bonus is kept on top: two stones, no KM.
  const h = Game.fromSGF('(;GM[1]SZ[9]HA[2]AB[gc][cg])');
  assert.deepEqual([h.komi, h.handicapBonus, h.recipe().komi], [0, 2, 2]);
  for (const komi of [7, 0, 0.5, -3]) {
    const g = new Game({ komi });
    assert.ok(g.toSGF().includes(`KM[${komi}]`), `${komi}`);
    assert.equal(Game.fromSGF(g.toSGF()).komi, komi);
  }
});

test('SGF: variations that start with the same move are merged', () => {
  const g = Game.fromSGF('(;GM[1]SZ[9];B[ee](;W[cc];B[gg])(;W[cc];B[gc]))');
  const e5 = g.root.children[0];
  assert.equal(e5.children.length, 1);
  assert.deepEqual(e5.children[0].children.map(n => ptName(n.move)), ['G3', 'G7']);
  assert.deepEqual(g.line(g.root).slice(1).map(n => ptName(n.move)), ['E5', 'C7', 'G3']);
});

// A small seeded generator, so the long game is the same every run.
const seeded = s => () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };

test('SGF: a long game with captures round-trips', () => {
  const g = new Game({ komi: 7 }), rand = seeded(12345);
  while (g.current.depth < 300) {
    let p = PASS;
    for (let k = 0; k < 30; k++) {
      const q = pt(Math.floor(rand() * 9), Math.floor(rand() * 9));
      if (g.check(q).ok) { p = q; break; }
    }
    assert.ok(g.play(p));
  }
  assert.ok(g.board.captures[BLACK] + g.board.captures[WHITE] > 10, 'stones were captured along the way');
  const saved = g.toSGF(), back = Game.fromSGF(saved);
  assert.equal(back.toSGF(), saved);
  let end = back.root;
  while (end.children.length) end = end.children[0];
  assert.equal(end.depth, 300);
  assert.equal(end.board.hash, g.board.hash);
  assert.deepEqual(end.board.captures, g.board.captures);
});

test('SGF: a very deeply nested record loads without overflowing the stack', () => {
  const depth = 10000;
  let sgf = '(;GM[1]SZ[9]KM[7]';
  for (let k = 0; k < depth; k++) sgf += `(;${k % 2 ? 'W' : 'B'}[]`;
  sgf += ')'.repeat(depth + 1);
  const g = Game.fromSGF(sgf);
  let end = g.root;
  while (end.children.length) end = end.children[0];
  assert.equal(end.depth, depth);
  assert.equal(Game.fromSGF(g.toSGF()).toSGF(), g.toSGF());
  assert.equal(loadError('(;'.repeat(100000)), 'the file stops partway through the record; it may be cut short.');
});

test('play continues after two passes (play resumes after counting)', () => {
  const g = new Game();
  playAll(g, 'E5');
  g.pass(); g.pass();
  assert.ok(g.isOver());
  assert.deepEqual(g.check(P('C3')), { ok: true });
  assert.ok(g.play(P('C3')));
  assert.equal(g.board.color[P('C3')], WHITE, 'White moves, as after any pass by Black');
  assert.equal(g.isOver(), false);
});

test('superko: a triple ko cycle can\'t return to an earlier position', () => {
  // Three kos, one above another. In each, Black takes at (3,y); White takes at (2,y).
  const ko = (y, inside) => [[pt(1, y), BLACK], [pt(2, y - 1), BLACK], [pt(2, y + 1), BLACK],
    [pt(3, y - 1), WHITE], [pt(3, y + 1), WHITE], [pt(4, y), WHITE], inside === WHITE ? [pt(2, y), WHITE] : [pt(3, y), BLACK]];
  const g = new Game({ komi: 7, setup: [...ko(1, WHITE), ...ko(4, WHITE), ...ko(7, BLACK)] });
  const start = g.board.hash;
  // Each move takes a different ko than the one just taken, so plain ko never applies.
  for (const [x, y] of [[3, 1], [2, 7], [3, 4], [2, 1], [3, 7]]) {
    assert.ok(g.play(pt(x, y)), `${x},${y}`);
    assert.notEqual(g.board.hash, start);
  }
  assert.equal(g.current.captured.length, 1);
  assert.notEqual(g.board.ko, pt(2, 4));
  // White taking the middle ko now would bring back the starting position.
  assert.ok(g.board.isLegal(pt(2, 4)));
  assert.deepEqual(g.check(pt(2, 4)), { ok: false, reason: 'superko' });
  assert.equal(g.play(pt(2, 4)), null);
});

test('deleteBranch removes a variation and moves off it if needed', () => {
  const g = new Game();
  playAll(g, 'E5 C3 G7');
  const e5 = g.root.children[0], c3 = e5.children[0];
  g.goTo(e5);
  playAll(g, 'D4');
  const d4 = g.current;
  assert.equal(e5.lastChild, d4);
  g.deleteBranch(d4);
  assert.equal(g.current, e5, 'the current node was inside the branch');
  assert.deepEqual(e5.children, [c3]);
  assert.equal(e5.lastChild, c3, 'redo follows what is left');
  assert.equal(ptName(g.redo().move), 'C3');
  g.goTo(e5);
  g.deleteBranch(c3);
  assert.equal(g.current, e5, 'outside the branch: stays put');
  assert.deepEqual([e5.children.length, e5.lastChild], [0, null]);
  g.deleteBranch(g.root);
  assert.equal(g.root.children.length, 1, 'the root is never deleted');
  playAll(g, 'C3 G7');
  g.deleteBranch(e5.children[0]);
  assert.equal(g.current, e5, 'from deep inside');
});

test('goTo remembers the path to the node, so redo and line() follow it', () => {
  const g = new Game();
  playAll(g, 'E5 C3 G7');
  const e5 = g.root.children[0], g7 = g.current;
  g.goTo(e5);
  playAll(g, 'D4 F6');
  const f6 = g.current;
  const names = () => g.line(g.root).slice(1).map(n => ptName(n.move));
  assert.deepEqual(names(), ['E5', 'D4', 'F6']);
  g.goTo(g7);
  assert.equal(e5.lastChild, e5.children[0]);
  assert.equal(g.root.lastChild, e5);
  assert.deepEqual(names(), ['E5', 'C3', 'G7']);
  g.goTo(g.root);
  g.redo(); g.redo(); g.redo();
  assert.equal(g.current, g7);
  g.goTo(f6);
  assert.deepEqual(names(), ['E5', 'D4', 'F6']);
  // Going to a node part way along keeps what lies beyond it.
  g.goTo(e5);
  assert.deepEqual(names(), ['E5', 'D4', 'F6']);
});

test('score: dead stones count for the other side, by area and by territory', () => {
  // Black wall on column D, White wall on column F, a lone White stone in Black's area.
  const setup = [];
  for (let y = 0; y < 9; y++) setup.push([pt(3, y), BLACK], [pt(5, y), WHITE]);
  setup.push([pt(1, 4), WHITE]);
  const g = new Game({ komi: 0.5, setup });
  const alive = g.score();
  assert.deepEqual([alive.black, alive.white], [9, 37], 'Black\'s area touches the white stone, so it is no one\'s');
  const s = g.score(new Set([pt(1, 4)]));
  assert.deepEqual([s.black, s.white, s.margin, s.text, s.winner], [36, 36, -0.5, 'W+0.5', WHITE]);
  assert.equal(s.owner[pt(1, 4)], BLACK);
  assert.equal(s.owner[pt(4, 4)], 0, 'the column between is neutral');
  // Territory: 27 points each, the dead stone a prisoner for Black.
  assert.deepEqual(s.territory, { black: 27, white: 27, capturesB: 1, capturesW: 0, margin: 0.5 });
  // Captures during play are prisoners too.
  const c = new Game({ komi: 7 });
  playAll(c, 'A2 A1 B2 J9 B1');
  assert.equal(c.score().territory.capturesB, 1);
  assert.equal(c.score().territory.capturesW, 0);
});
