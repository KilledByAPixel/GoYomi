// The game graph: mistake dots sit on the win-rate line, or on the score line
// in handicap games, where the win chance hardly moves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderGraph } from '../src/graph.js';

const line = [
  { analysis: { blackWinrate: 0.99, score: 20 } },
  { analysis: { blackWinrate: 0.98, score: 12 }, flagged: true },
];
const mark = n => n.flagged ? { color: 'red' } : null;
const dotY = html => +html.match(/<circle cx="[^"]+" cy="([^"]+)"/)[1];

test('mistake dots go on the win-rate line by default, the score line when asked', () => {
  const el = {};
  renderGraph(el, line, line[1], () => {}, mark);
  const onWr = dotY(el.innerHTML);
  renderGraph(el, line, line[1], () => {}, mark, { dotsOnScore: true });
  const onScore = dotY(el.innerHTML);
  // H 150, PAD 6: win rate 0.98 → 6 + 0.02 * 138; score +12 → 6 + (0.5 - 12 / 60) * 138.
  assert.ok(Math.abs(onWr - (6 + 0.02 * 138)) < 0.01, `win-rate dot at ${onWr}`);
  assert.ok(Math.abs(onScore - (6 + 0.3 * 138)) < 0.01, `score dot at ${onScore}`);
});
