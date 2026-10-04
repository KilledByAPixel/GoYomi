import { test } from 'node:test';
import assert from 'node:assert/strict';

// Stub Web Workers: tests drive their messages and errors by hand.
const stubs = [];
globalThis.Worker = class { constructor() { stubs.push(this); } postMessage(m) { if (m.type === 'search') this.sent = m; } terminate() { this.terminated = true; } };
const { Engine, EnginePool, KataWorker, KataEngine } = await import('../src/engine-client.js');
const { parsePt, BLACK, WHITE } = await import('../src/board.js');

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

// The built-in engine's worker, run in-process; the tests deliver its step
// messages by hand (and leave none queued).
let ew = null;
async function engineWorker() {
  if (!ew) {
    ew = { queued: [], posted: [], send: data => self.onmessage({ data }) };
    globalThis.MessageChannel = class { constructor() { this.port1 = ew.port1 = {}; this.port2 = { postMessage: () => ew.queued.push(0) }; } };
    globalThis.self = {};
    globalThis.postMessage = m => ew.posted.push(m);
    await import('../src/engine-worker.js');
  }
  ew.posted.length = 0;
  return ew;
}
const emptyBoard = { setup: [], moves: [], whiteFirst: false, komi: 7 };

test('engine worker: a new search with a step still queued runs one loop', async () => {
  const { queued, posted, port1, send } = await engineWorker();
  const position = emptyBoard;
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

test('engine worker: a position it can\'t build ends that search empty; the next one runs', async () => {
  const { queued, posted, port1, send } = await engineWorker();
  const warn = console.warn;
  console.warn = () => {};
  try {
    const E5 = parsePt('E5'), C3 = parsePt('C3');
    send({ type: 'search', id: 3, position: { ...emptyBoard, moves: [[E5, BLACK], [C3, WHITE], [E5, BLACK]] }, playouts: 100, reportMs: 0 });
  } finally { console.warn = warn; }
  assert.deepEqual(posted, [{ type: 'done', id: 3, results: null }]);
  assert.equal(queued.length, 0, 'nothing left running');
  send({ type: 'search', id: 4, position: emptyBoard, playouts: 300, reportMs: 0 });
  while (queued.length) { queued.pop(); port1.onmessage(); }
  assert.deepEqual(posted.map(m => m.type + m.id), ['done3', 'done4']);
  assert.equal(posted[1].results.playouts, 300);
});

test('Engine: a done with no results settles with null, and without a last progress call', { timeout: 2000 }, async () => {
  stubs.length = 0;
  const calls = [];
  const e = new Engine('t');
  const p = e.search({}, { onProgress: (...a) => calls.push(a) });
  done(stubs[0], null);
  assert.equal(await p, null);
  assert.deepEqual(calls, []);
});

// Throws from the UI's last progress call, as a bug in it would; returns what got logged.
const brokenUI = (res, fin) => { if (fin) throw new Error('UI bug'); };
async function logged(run) {
  const errors = [], error = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try { await run(); } finally { console.error = error; }
  return errors;
}

test('Engine, KataEngine and EnginePool: a progress callback that throws still settles the search', { timeout: 2000 }, async () => {
  const errors = await logged(async () => {
    stubs.length = 0;
    const e = new Engine('t');
    const p = e.search({}, { onProgress: brokenUI });
    done(stubs[0], result(10));
    assert.equal((await p).playouts, 10);
    assert.equal(e.busy, false);

    stubs.length = 0;
    const pool = new EnginePool('t', 2);
    const q = pool.search({}, { playouts: 100, onProgress: brokenUI });
    done(stubs[0], result(50));
    done(stubs[1], result(50));
    assert.equal((await q).playouts, 100);
    assert.equal(pool.busy, false);

    const { host, w } = await startedHost();
    const k = new KataEngine('kopponent', host);
    const r = k.search({}, { visits: 12, onProgress: brokenUI });
    w.onmessage({ data: { type: 'done', engine: 'kopponent', id: w.sent.id, results: result(12) } });
    assert.equal((await r).playouts, 12);
    assert.equal(k.busy, false);
    host.fail('test over');
  });
  assert.equal(errors.length, 3);
  assert.ok(errors.every(m => /UI bug/.test(m)), 'the bug still shows');
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

test('KataWorker: when the network fails, KataGo is marked failed before the AI\'s search ends', { timeout: 2000 }, async () => {
  const { Scheduler } = await import('../src/katago/scheduler.js');
  const { host, w } = await startedHost();
  const eng = new KataEngine('kopponent', host, { priority: 1 });
  let ended = false;
  eng.search({}, { visits: 128 }).then(() => { ended = true; });
  // The app retries the move from onFail only while that search is still open.
  let endedAtFail = null;
  host.onFail = () => { endedAtFail = ended; };
  // What the worker's scheduler really posts when the network throws mid-search.
  const posted = [];
  const s = new Scheduler({ post: m => posted.push(m), yieldFn: () => Promise.resolve() });
  s.evaluator = { maxBatch: 4, evaluate: async () => { throw new Error('GPU device lost'); } };
  s.add({ engine: 'kopponent', id: w.sent.id, search: { playouts: 0, gather: n => Array.from({ length: n }, () => ({ pos: {} })) }, target: 128, maxTime: 1e9, reportMs: 0, priority: 1, started: 0, lastReport: 0 });
  while (s.pumping) await new Promise(r => setTimeout(r, 0));
  // Delivered as separate events, as postMessage does.
  for (const m of posted) { w.onmessage({ data: m }); await new Promise(r => setTimeout(r, 0)); }
  assert.equal(endedAtFail, false, `messages ${posted.map(m => m.type)}`);
});

// A host with a short stall limit, started.
async function stallHost(stallMs) {
  stubs.length = 0;
  const host = new KataWorker({ stallMs }), failures = [];
  host.onFail = m => failures.push(m);
  const ready = host.load();
  stubs[0].onmessage({ data: { type: 'ready', backend: 'webgl', rate: 300, batch: 16 } });
  await ready;
  return { host, failures, w: stubs[0] };
}
const wait = ms => new Promise(r => setTimeout(r, ms));

test('KataWorker: a network that stops answering mid-search is treated as a failure', { timeout: 3000 }, async () => {
  const { host, failures } = await stallHost(100);
  const p = new KataEngine('kopponent', host, { priority: 1 }).search({}, { visits: 128 });
  await wait(400);
  assert.deepEqual(failures, ['KataGo stopped responding']);
  assert.equal(await p, null);
  assert.equal(host.dead, true);
});

test('KataWorker: a busy network that keeps answering, and an idle one, are left alone', { timeout: 3000 }, async () => {
  const { host, failures, w } = await stallHost(500);
  const eng = new KataEngine('kcoach0', host);
  const p = eng.search({}, { visits: 400 });
  for (let i = 0; i < 8; i++) { await wait(50); w.onmessage({ data: { type: 'progress', engine: 'kcoach0', id: w.sent.id, results: result(10) } }); }
  w.onmessage({ data: { type: 'done', engine: 'kcoach0', id: w.sent.id, results: result(400) } });
  assert.ok(await p);
  await wait(800); // nothing pending: silence (longer than the limit) is fine
  assert.deepEqual(failures, []);
  assert.equal(host.dead, false);
  host.fail('test over');
});

test('KataWorker: a long read with no progress reports is kept alive by the heartbeat', { timeout: 3000 }, async () => {
  const { host, failures, w } = await stallHost(300);
  const eng = new KataEngine('kcoach0', host);
  const p = eng.search({}, { visits: 400, reportMs: 0 });
  for (let i = 0; i < 8; i++) { await wait(100); w.onmessage({ data: { type: 'alive' } }); }
  assert.deepEqual(failures, [], 'not taken for a hang');
  assert.equal(eng.busy, true, 'the heartbeat is heard, nothing more');
  w.onmessage({ data: { type: 'done', engine: 'kcoach0', id: w.sent.id, results: result(400) } });
  assert.ok(await p);
  host.fail('test over');
});

test('KataWorker: a search after a quiet spell starts the silence clock afresh', { timeout: 3000 }, async () => {
  const { host, failures, w } = await stallHost(500);
  const eng = new KataEngine('kopponent', host, { priority: 1 });
  const first = eng.search({}, { visits: 12 });
  w.onmessage({ data: { type: 'done', engine: 'kopponent', id: w.sent.id, results: result(12) } });
  assert.ok(await first);
  await wait(800); // idle, longer than the stall limit: the player is thinking
  const second = eng.search({}, { visits: 12 });
  await wait(150); // the new search is under way, well within the limit
  assert.deepEqual(failures, [], 'a healthy worker isn\'t treated as stalled');
  w.onmessage({ data: { type: 'done', engine: 'kopponent', id: w.sent.id, results: result(12) } });
  assert.ok(await second);
  host.fail('test over');
});

test('Engine: a worker that broke before any search is replaced by the next search', { timeout: 2000 }, async () => {
  stubs.length = 0;
  const errors = [];
  Engine.onError = (name, msg) => errors.push(msg);
  const e = new Engine('t');
  stubs[0].onerror({ message: 'failed to load' });
  assert.ok(stubs[0].terminated, 'the broken worker is ended');
  const p = e.search({}, { playouts: 10 });
  assert.equal(stubs.length, 2, 'a new worker');
  done(stubs[1], result(10));
  assert.equal((await p).playouts, 10);
  assert.deepEqual(errors, ['failed to load']);
  Engine.onError = null;
});

test('Engine: one that breaks mid-search answers it with null, and the next search is answered', { timeout: 2000 }, async () => {
  stubs.length = 0;
  Engine.onError = null;
  const e = new Engine('t');
  const first = e.search({}, { playouts: 10 });
  stubs[0].onerror({ message: 'boom' });
  assert.equal(await first, null);
  const second = e.search({}, { playouts: 10 });
  // A late message from the replaced worker is nobody's.
  stubs[0].onmessage({ data: { type: 'done', id: stubs[1].sent.id, results: result(99) } });
  done(stubs[1], result(10));
  assert.equal((await second).playouts, 10);
});

test('Engine: two failures in a row give null each and one report each, nothing left waiting', { timeout: 2000 }, async () => {
  stubs.length = 0;
  const errors = [];
  Engine.onError = (name, msg) => errors.push(msg);
  const e = new Engine('t');
  const a = e.search({}, { playouts: 10 });
  stubs[0].onerror({ message: 'one' });
  stubs[0].onerror({ message: 'again from the dead worker' });
  const b = e.search({}, { playouts: 10 });
  stubs[1].onerror({ message: 'two' });
  assert.deepEqual([await a, await b], [null, null]);
  assert.deepEqual(errors, ['one', 'two']);
  assert.equal(e.busy, false);
  assert.equal(stubs.length, 2, 'one new worker per search asked for, no more');
  Engine.onError = null;
});

test('EnginePool: each engine recovers by itself', { timeout: 2000 }, async () => {
  stubs.length = 0;
  Engine.onError = null;
  const pool = new EnginePool('t', 2);
  stubs[0].onerror({ message: 'boom' });
  const p = pool.search({}, { playouts: 100 });
  assert.equal(stubs.length, 3, 'only the broken engine gets a new worker');
  done(stubs[2], result(50));
  done(stubs[1], result(50));
  assert.equal((await p).playouts, 100);
});
