import { test } from 'node:test';
import assert from 'node:assert/strict';

// Stub Web Workers: tests drive their messages and errors by hand.
const stubs = [];
globalThis.Worker = class { constructor() { stubs.push(this); } postMessage(m) { if (m.type === 'search') this.sent = m; } };
const { EnginePool } = await import('../src/engine-client.js');

const result = playouts => ({ toPlay: 1, playouts, blackWinrate: 0.5, score: 1, ownership: new Array(81).fill(0),
  moves: [{ move: 40, visits: playouts, winrate: 0.5, score: 1, prior: 1, pv: [] }] });
const done = (w, res) => w.onmessage({ data: { type: 'done', id: w.sent.id, results: res } });

test('EnginePool: a failed worker does not leave the search hanging', { timeout: 2000 }, async () => {
  stubs.length = 0;
  const pool = new EnginePool('t', 2);
  const p = pool.search({}, { playouts: 100 });
  stubs[0].onerror({ message: 'boom' });
  done(stubs[1], result(50));
  const out = await p;
  assert.equal(out.playouts, 50);
  assert.equal(pool.busy, false);
});

test('EnginePool: every worker failing settles with null', { timeout: 2000 }, async () => {
  stubs.length = 0;
  const pool = new EnginePool('t', 2);
  const p = pool.search({}, { playouts: 100 });
  stubs[0].onerror({ message: 'a' });
  stubs[1].onerror({ message: 'b' });
  assert.equal(await p, null);
  assert.equal(pool.busy, false);
});

test('EnginePool: a cancelled search settles with null', { timeout: 2000 }, async () => {
  stubs.length = 0;
  const pool = new EnginePool('t', 2);
  const p = pool.search({}, { playouts: 100 });
  pool.cancel();
  assert.equal(await p, null);
});

test('EnginePool: finished workers merge as before', async () => {
  stubs.length = 0;
  const pool = new EnginePool('t', 2);
  const p = pool.search({}, { playouts: 100 });
  done(stubs[0], result(50));
  done(stubs[1], result(50));
  assert.equal((await p).playouts, 100);
});
