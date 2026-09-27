// Helpers for finding points and for playing by keyboard or screen reader.
// Pure functions — no DOM, testable in node.
import { BLACK, EMPTY, PASS, parsePt, ptName } from './board.js';

// Wraps the coordinates the coach mentions ("D4") in <span class="pt"
// data-pt>, outside tags only, so hovering one can show where it is.
export function linkPoints(html) {
  return html.split(/(<[^>]*>)/).map(part => part.startsWith('<') ? part
    : part.replace(/\b([A-HJ][1-9])\b/g, (m, c) => `<span class="pt" data-pt="${parsePt(c)}">${c}</span>`)).join('');
}

const WHY = { ko: 'ko', superko: 'it would repeat an earlier position', suicide: 'it would have no liberties', occupied: 'occupied' };

// What's at p, for the keyboard cursor.
export function pointReadout(board, p, check) {
  const name = ptName(p), c = board.color[p];
  if (c === EMPTY) {
    const r = check(p);
    return r.ok ? `${name}, empty` : `${name}, empty, can't play: ${WHY[r.reason] || r.reason}`;
  }
  const color = c === BLACK ? 'black' : 'white', size = board.chainStones(p).length, libs = board.libCount(p);
  const l = `${libs} ${libs === 1 ? 'liberty' : 'liberties'}`;
  return size === 1 ? `${name}, ${color} stone, ${l}` : `${name}, ${color} stone, group of ${size} with ${l}`;
}

// "You played D4.", "AI played F5, capturing 2 stones.", "Black passed."
export function movePhrase(who, move, captured) {
  if (move === PASS) return `${who} passed.`;
  return `${who} played ${ptName(move)}${captured ? `, capturing ${captured} ${captured === 1 ? 'stone' : 'stones'}` : ''}.`;
}

export const plainText = html => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
