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

test('engine worker: a new search with a step still queued runs one loop', async () => {
  // Run the worker in-process; the test delivers its step messages by hand.
  let port1;
  const queued = [], posted = [];
  globalThis.MessageChannel = class { constructor() { this.port1 = port1 = {}; this.port2 = { postMessage: () => queued.push(0) }; } };
  globalThis.self = {};
  globalThis.postMessage = m => posted.push(m);
  await import('../src/engine-worker.js');
  const position = { setup: [], moves: [], whiteFirst: false, komi: 7 };
  const send = data => self.onmessage({ data });
  send({ type: 'search', id: 1, position, playouts: 500, reportMs: 0 });
  send({ type: 'stop' });
  send({ type: 'search', id: 2, position, playouts: 500, reportMs: 0 });
  assert.equal(queued.length, 1, 'the queued step serves the new job');
  while (queued.length) {
    queued.pop();
    port1.onmessage();
    assert.ok(queued.length <= 1, 'one step in flight');
  }
  assert.deepEqual(posted.map(m => m.type + m.id), ['done2']);
  assert.equal(posted[0].results.playouts, 500);
});
