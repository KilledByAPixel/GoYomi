import { test } from 'node:test';
import assert from 'node:assert/strict';

// Stub Web Workers: tests drive their messages and errors by hand.
const stubs = [];
globalThis.Worker = class { constructor() { stubs.push(this); } postMessage(m) { if (m.type === 'search') this.sent = m; } terminate() { this.terminated = true; } };
const { EnginePool, KataWorker, KataEngine } = await import('../src/engine-client.js');

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

// KataGo's shared worker, once it has started.
async function startedHost() {
  stubs.length = 0;
  const host = new KataWorker(), failures = [];
  host.onFail = m => failures.push(m);
  const ready = host.load();
  stubs[0].onmessage({ data: { type: 'ready', backend: 'wasm', rate: 60, batch: 4 } });
  assert.equal((await ready).ok, true);
  return { host, failures, w: stubs[0] };
}

test('KataWorker: a crash after starting fails every engine, stays failed and says so', { timeout: 2000 }, async () => {
  const { host, failures, w } = await startedHost();
  const eng = new KataEngine('kopponent', host);
  const p = eng.search({}, { visits: 128 });
  w.onerror({ message: 'worker crashed' });
  assert.equal(await p, null);
  assert.equal(host.info.ok, false);
  assert.equal(w.terminated, true);
  assert.deepEqual(failures, ['worker crashed']);
  assert.equal(await eng.search({}, { visits: 8 }), null, 'later searches end at once');
});

test('KataWorker: a fatal network error reported by the worker is handled the same way', { timeout: 2000 }, async () => {
  const { host, failures, w } = await startedHost();
  const p = new KataEngine('kcoach0', host).search({}, { visits: 50 });
  w.onmessage({ data: { type: 'fatal', message: 'GPU device lost' } });
  assert.equal(await p, null);
  assert.deepEqual(failures, ['GPU device lost']);
});

test('KataWorker: a start that never finishes times out, and a late answer changes nothing', { timeout: 2000 }, async () => {
  stubs.length = 0;
  const host = new KataWorker({ startupMs: 50 }), failures = [];
  host.onFail = m => failures.push(m);
  const info = await host.load();
  assert.equal(info.ok, false);
  assert.match(info.message, /too long/);
  assert.equal(stubs[0].terminated, true);
  stubs[0].onmessage({ data: { type: 'ready', backend: 'wasm', rate: 60, batch: 4 } });
  assert.equal(host.info.ok, false);
  assert.deepEqual(failures, [], 'a failed start is reported by load(), not as a runtime failure');
});

test('KataEngine: a search can cap its batch (AI levels read as they were calibrated)', { timeout: 2000 }, async () => {
  const { host, w } = await startedHost();
  const eng = new KataEngine('kopponent', host, { priority: 1 });
  const p = eng.search({}, { visits: 12, batch: 4 });
  assert.equal(w.sent.batch, 4);
  eng.cancel();
  assert.equal(await p, null);
});
