import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Board, BLACK, PASS, parsePt } from '../src/board.js';
import { Game } from '../src/game.js';
import { linkPoints, pointReadout, movePhrase, plainText } from '../src/access.js';

const P = parsePt;
const span = n => `<span class="pt" data-pt="${P(n)}">${n}</span>`;

test('linkPoints wraps coordinates outside tags only', () => {
  assert.equal(linkPoints('<b>D4</b> and B+3.5'), `<b>${span('D4')}</b> and B+3.5`);
  assert.equal(linkPoints('<button data-pt="30">Show C3</button>'), `<button data-pt="30">Show ${span('C3')}</button>`);
  assert.equal(linkPoints('I9 is not a point; J9 is'), `I9 is not a point; ${span('J9')} is`);
});

test('pointReadout describes the cursor point', () => {
  const g = new Game();
  for (const m of 'D5 F6 E6 G5 E4 F4 F5 E5'.split(' ')) g.play(P(m));
  const read = n => pointReadout(g.board, P(n), p => g.check(p));
  assert.equal(read('A1'), 'A1, empty');
  assert.equal(read('F5'), 'F5, empty, can\'t play: ko');
  assert.equal(read('E5'), 'E5, white stone, 1 liberty');
  const b = Board.fromRows(['.........', '.........', '.........', '.........', '...XXX...', '.........', '.........', '.........', '.........'], BLACK);
  assert.equal(pointReadout(b, P('E5'), () => ({ ok: true })), 'E5, black stone, group of 3 with 8 liberties');
});

test('movePhrase and plainText', () => {
  assert.equal(movePhrase('You', P('D4'), 0), 'You played D4.');
  assert.equal(movePhrase('AI', P('F5'), 2), 'AI played F5, capturing 2 stones.');
  assert.equal(movePhrase('Black', PASS, 0), 'Black passed.');
  assert.equal(plainText('About <b>6.2 points</b>\n worse than <b>D4</b>.'), 'About 6.2 points worse than D4.');
});
