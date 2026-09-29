// The JavaScript KataGo port against native KataGo's outputs for the same
// network (test/fixtures/katago-b6c96-reference.json), and its search on
// simple tactics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadNet } from '../tools/katago-node.js';
import { Evaluator } from '../src/katago/evaluator.js';
import { KataSearch } from '../src/katago/search.js';
import { policyProbs } from '../src/katago/model.js';
import { SPATIAL, GLOBAL, fillInputs } from '../src/katago/features.js';
import { buildPosition } from '../src/recipe.js';
import { BLACK, WHITE, PASS, POINTS, parsePt, ptX, ptY } from '../src/board.js';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/katago-b6c96-reference.json', import.meta.url)));
const flat = p => p === PASS ? 81 : ptY(p) * 9 + ptX(p);

// The fixture position as net inputs, the way the search builds them.
function inputs(f) {
  const moves = f.moves.map(([c, m]) => [parsePt(m), c === 'B' ? BLACK : WHITE]);
  const { board, history } = buildPosition({ setup: [], moves, whiteFirst: false });
  board.toPlay = f.toPlay === 'B' ? BLACK : WHITE;
  const snap = b => ({ stones: Uint8Array.from(POINTS, p => b.color[p]), ko: b.ko ? flat(b.ko) : -1 });
  const snaps = history.map(h => snap(h.board));
  return {
    ...snaps.at(-1), pla: board.toPlay, komi: f.komi, banned: null,
    recent: history.slice(1).map(h => ({ move: flat(h.move), color: h.color })),
    prev: snaps.at(-2), prevPrev: snaps.at(-3),
  };
}

test('network outputs match native KataGo on the reference positions', async () => {
  const { net } = await loadNet();
  const worst = { policy: 0, win: 0, lead: 0, own: 0 }, mean = { policy: 0, own: 0 };
  let nPolicy = 0;
  for (const f of fixtures.positions) {
    const sp = new Float32Array(81 * SPATIAL), gl = new Float32Array(GLOBAL);
    const pos = inputs(f);
    fillInputs(pos, sp, gl);
    const [o] = await net.evaluate(sp, gl, 1);
    const ref = f.output, w = pos.pla === WHITE ? 1 : -1;
    const legal = Uint8Array.from([...ref.policy.map(p => p !== null), true], Number);
    const probs = policyProbs(o.policyLogits, legal);
    for (let i = 0; i < 82; i++) {
      if (!legal[i]) continue;
      const e = Math.abs(probs[i] - (i < 81 ? ref.policy[i] : ref.policyPass));
      worst.policy = Math.max(worst.policy, e); mean.policy += e; nPolicy++;
    }
    worst.win = Math.max(worst.win, Math.abs((w > 0 ? o.win : o.loss) - ref.whiteWin));
    worst.lead = Math.max(worst.lead, Math.abs(w * o.lead - ref.whiteLead));
    for (let i = 0; i < 81; i++) {
      const e = Math.abs(w * o.ownership[i] - ref.whiteOwnership[i]);
      worst.own = Math.max(worst.own, e); mean.own += e / 81 / fixtures.positions.length;
    }
  }
  mean.policy /= nPolicy;
  // The reference is native KataGo in full precision (openclUseFP16 = false):
  // the port should match it to rounding. A wrong input feature costs far more.
  console.log(`worst: policy ${worst.policy.toExponential(2)}, win ${worst.win.toExponential(2)}, lead ${worst.lead.toExponential(2)}, ownership ${worst.own.toExponential(2)}`);
  assert.ok(worst.policy < 1e-3, `policy ${worst.policy}`);
  assert.ok(mean.policy < 1e-4, `mean policy ${mean.policy}`);
  assert.ok(worst.win < 2e-3, `win ${worst.win}`);
  assert.ok(worst.lead < 0.05, `lead ${worst.lead}`);
  assert.ok(worst.own < 5e-3, `ownership ${worst.own}`);
  assert.ok(mean.own < 1e-3, `mean ownership ${mean.own}`);
});

// Search from a list of [point name, colour] with the given side to move.
async function search(stones, toPlay, visits, { komi = 7, moves = [] } = {}) {
  const { net } = await loadNet();
  const setup = stones.map(([s, c]) => [parsePt(s), c]);
  const root = buildPosition({ setup, moves, whiteFirst: toPlay === WHITE });
  // A fixed symmetry keeps the search deterministic.
  const s = new KataSearch(root, { komi, evaluator: new Evaluator(net, { symmetry: 0 }), batch: 4 });
  await s.run(visits);
  return s.results(10);
}
const B = BLACK, W = WHITE, at = parsePt;

test('search captures a stone in atari', async () => {
  const r = await search([['D5', W], ['E6', W], ['F5', W], ['E5', B], ['C3', B], ['G3', B]], W, 150);
  assert.equal(r.playouts, 150);
  assert.equal(r.moves[0].move, at('E4'));
});

test('search saves its own stone in atari', async () => {
  const r = await search([['D5', W], ['E6', W], ['F5', W], ['E5', B], ['C3', B], ['G3', B]], B, 150);
  assert.equal(r.moves[0].move, at('E4'));
  assert.ok(r.moves[0].visits > 140);
});

test('search sees whether a ladder works', async () => {
  // White E5-E4 has two liberties. Atari from below at E3 chases it down and
  // to the left in a ladder that works, unless White has a stone at C3.
  const stones = [['D5', B], ['E6', B], ['F5', B], ['F4', B], ['E5', W], ['E4', W], ['G7', W], ['C7', W]];
  const works = await search(stones, B, 150);
  assert.equal(works.moves[0].move, at('E3'));
  assert.ok(works.winrate > 0.8);
  const broken = await search([...stones, ['C3', W]], B, 150);
  assert.notEqual(broken.moves[0].move, at('E3'));
  assert.ok(broken.winrate < works.winrate - 0.3);
});

test('search passes at the end of a finished game', async () => {
  // Black owns the left five columns, White the right four; White has passed.
  const stones = [];
  for (let y = 1; y <= 9; y++) stones.push([`E${y}`, B], [`F${y}`, W]);
  const r = await search(stones, W, 100, { komi: 0.5, moves: [[PASS, WHITE]] });
  assert.equal(r.toPlay, BLACK);
  assert.equal(r.moves[0].move, PASS);
  assert.ok(r.winrate > 0.95);
});

test('a failed network run leaves no tensors behind', async () => {
  const { tf, net } = await loadNet();
  const forward = net.forward;
  const run = () => net.evaluate(new Float32Array(81 * SPATIAL), new Float32Array(GLOBAL), 1);
  try {
    const before = tf.memory().numTensors;
    net.forward = () => { throw new Error('backend failed'); };
    await assert.rejects(run(), /backend failed/);
    assert.equal(tf.memory().numTensors, before, 'inputs disposed when the run fails');
    net.forward = () => { const t = tf.zeros([1, 1]); t.data = () => Promise.reject(new Error('readback failed')); return t; };
    await assert.rejects(run(), /readback failed/);
    assert.equal(tf.memory().numTensors, before, 'inputs and outputs disposed when reading back fails');
  } finally { net.forward = forward; }
});

test('the evaluation cache tells apart histories that differ only in who moved', () => {
  const key = moves => new KataSearch(buildPosition({ setup: [], moves, whiteFirst: false }), { komi: 7, evaluator: null, batch: 1 }).gather(1)[0].pos.key;
  const E5 = parsePt('E5');
  assert.notEqual(key([[PASS, BLACK], [E5, WHITE]]), key([[PASS, WHITE], [E5, WHITE]]));
});

test('results include the network\'s instinct for every legal move', async () => {
  const { net } = await loadNet();
  const s = new KataSearch(buildPosition({ setup: [], moves: [], whiteFirst: false }), { komi: 7, evaluator: new Evaluator(net), batch: 1 });
  await s.run(1);
  const r = s.results();
  const onBoard = r.policy.filter(m => m.move !== PASS);
  // Mirror images are folded on the empty board: each entry plus its twins covers the board once.
  assert.equal(onBoard.reduce((n, m) => n + 1 + (m.twins ? m.twins.length : 0), 0), 81);
  assert.ok(Math.abs(r.policy.reduce((t, m) => t + m.prior, 0) - 1) < 1e-4, 'priors sum to 1');
  assert.ok(r.policy.length > r.allMoves.length, 'more than the moves the search visited');
});

test('a fixed batch pads every run to one size and gives the same results', async () => {
  const { net } = await loadNet();
  const run = async fixed => {
    net.fixedBatch = fixed;
    const sizes = new Set(), forward = net.forward;
    net.forward = (s, g) => { sizes.add(s.shape[0]); return forward.call(net, s, g); };
    try {
      const s = new KataSearch(buildPosition({ setup: [], moves: [[parsePt('E5'), BLACK]], whiteFirst: false }), { komi: 7, evaluator: new Evaluator(net, { symmetry: 0, maxBatch: 8, cacheSize: 0 }), batch: 3 });
      await s.run(10);
      return { sizes: [...sizes], moves: s.results(5).moves.map(m => [m.move, m.visits, m.winrate.toFixed(4)]) };
    } finally { net.forward = forward; net.fixedBatch = 0; }
  };
  const plain = await run(0), padded = await run(8);
  assert.ok(plain.sizes.length > 1, `unpadded runs vary in size: ${plain.sizes}`);
  assert.deepEqual(padded.sizes, [8], 'padded runs are always 8 rows (one GPU program)');
  assert.deepEqual(padded.moves, plain.moves);
});

test('a network output that isn\'t a number is an error, not a move', async () => {
  const { Net } = await import('../src/katago/model.js');
  const net = Object.assign(Object.create(Net.prototype), { scoreChannels: 4, post: { scoreMean: 20, lead: 20 } });
  const row = new Float32Array(82 + 3 + 4 + 81);
  assert.doesNotThrow(() => net.decode(row));
  row[83] = NaN;
  assert.throws(() => net.decode(row), /invalid/);
});

test('a position with a move onto a stone is refused, not built', () => {
  const recipe = { setup: [], moves: [[parsePt('E5'), BLACK], [parsePt('C3'), WHITE], [parsePt('E5'), BLACK]], whiteFirst: false };
  assert.throws(() => buildPosition(recipe), /E5 is already taken/);
});
