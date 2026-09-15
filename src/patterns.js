// 3x3 playout patterns (the classic MoGo set, as written up in Petr Baudis'
// "michi"). Each pattern is centred on an empty point.
//   X, O  stones of either colour (patterns are matched for both colours)
//   .     empty      #  off-board      ?  anything
//   x     not X      o  not O
import { W } from './board.js';

const SRC = [
  ['XOX', '...', '???'], // hane: enclosing hane
  ['XO.', '...', '?.?'], // hane: non-cutting hane
  ['XO?', 'X..', 'x.?'], // hane: magari
  ['.O.', 'X..', '...'], // katatsuke / diagonal attachment
  ['XO?', 'O.o', '?o?'], // cut1: unprotected cut
  ['XO?', 'O.X', '???'], // cut1: peeping cut
  ['?X?', 'O.O', 'ooo'], // cut2
  ['OX?', 'o.O', '???'], // cut keima
  ['X.?', 'O.?', '##?'], // side: chase
  ['OX?', 'X.O', '###'], // side: block side cut
  ['?X?', 'x.O', '###'], // side: block side connection
  ['?XO', 'x.x', '###'], // side: sagari
  ['?OX', 'X.O', '###'], // side: cut
];

const rot90 = p => p[6] + p[3] + p[0] + p[7] + p[4] + p[1] + p[8] + p[5] + p[2];
const vflip = p => p.slice(6, 9) + p.slice(3, 6) + p.slice(0, 3);
const hflip = p => [0, 3, 6].map(i => p[i + 2] + p[i + 1] + p[i]).join('');
const swap = p => p.replace(/[XxOo]/g, ch => ({ X: 'O', x: 'o', O: 'X', o: 'x' })[ch]);

const EXPAND = { '?': '.XO#', x: '.O#', o: '.X#' };
function wild(p) {
  const i = p.search(/[?xo]/);
  if (i < 0) return [p];
  return [...EXPAND[p[i]]].flatMap(ch => wild(p.slice(0, i) + ch + p.slice(i + 1)));
}

const VAL = { '.': 0, X: 1, O: 2, '#': 3 };
// Neighbour order used for the code: NW N NE W E SW S SE.
const ORDER = [0, 1, 2, 3, 5, 6, 7, 8];
function encode(p) {
  let code = 0;
  ORDER.forEach((idx, i) => { code |= VAL[p[idx]] << (2 * i); });
  return code;
}

export const PAT3 = new Uint8Array(65536);
for (const rows of SRC) {
  const base = rows.join('');
  const syms = [base, rot90(base), vflip(base), hflip(base),
    rot90(vflip(base)), rot90(hflip(base)), vflip(hflip(base)), rot90(vflip(hflip(base)))];
  for (const s of syms) for (const v of [s, swap(s)]) for (const full of wild(v)) PAT3[encode(full)] = 1;
}

export function pat3Code(color, p) {
  return color[p - W - 1] | color[p - W] << 2 | color[p - W + 1] << 4 | color[p - 1] << 6 |
    color[p + 1] << 8 | color[p + W - 1] << 10 | color[p + W] << 12 | color[p + W + 1] << 14;
}

export const matchesPat3 = (color, p) => PAT3[pat3Code(color, p)] === 1;
