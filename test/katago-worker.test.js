// The KataGo worker's scheduling and backend choice, with fake networks and searches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { Scheduler } from '../src/katago/scheduler.js';
import { chooseBackend } from '../src/katago/backends.js';
import { parsePt, BLACK, WHITE } from '../src/board.js';

// A search that just counts the leaves it's given.
const fakeSearch = owner => ({ playouts: 0, gather(n) { return Array.from({ length: n }, () => ({ pos: { owner } })); },
  apply(sels) { this.playouts += sels.length; }, results() { return { playouts: this.playouts }; } });
const job = (engine, target, priority = 0) => ({ engine, id: 1, search: fakeSearch(engine), target, maxTime: 1e9, reportMs: 0, priority, started: 0, lastReport: 0 });
const setup = evaluate => {
  const posted = [];
  const s = new Scheduler({ post: m => posted.push(m), yieldFn: () => Promise.resolve() });
  s.evaluator = { maxBatch: 4, evaluate };
  return { s, posted };
};
// add() starts the loop; this waits until it has run out of work.
const idle = async s => { while (s.pumping) await new Promise(r => setTimeout(r, 0)); };

test('Scheduler: a failed network ends every search and reports it, instead of stalling', async () => {
  const { s, posted } = setup(async () => { throw new Error('GPU device lost'); });
  s.add(job('kopponent', 128, 1));
  s.add(job('kcoach0', 100));
  await idle(s);
  assert.equal(s.pumping, false);
  assert.equal(s.jobs.size, 0);
  assert.deepEqual(posted.filter(m => m.type === 'done').map(m => [m.engine, m.results]).sort(), [['kcoach0', null], ['kopponent', null]]);
  assert.deepEqual(posted.find(m => m.type === 'fatal'), { type: 'fatal', message: 'GPU device lost' });
  // Later searches end at once rather than waiting forever.
  posted.length = 0;
  s.add(job('kscout', 50));
  await idle(s);
  assert.deepEqual(posted, [{ type: 'done', engine: 'kscout', id: 1, results: null }]);
});

test('Scheduler: a search that throws ends alone; the network and the other searches go on', async () => {
  const { s, posted } = setup(async ps => ps.map(() => ({})));
  const badApply = job('kcoach0', 20), badGather = job('kcoach1', 20), badResults = job('kcoach2', 20);
  badApply.search.apply = () => { throw new Error('odd position'); };
  badGather.search.gather = () => { throw new Error('odd position'); };
  badResults.search.results = () => { throw new Error('odd position'); };
  const warn = console.warn;
  console.warn = () => {};
  try {
    for (const j of [badApply, badGather, badResults, job('kcoach3', 20)]) s.add(j);
    await idle(s);
  } finally { console.warn = warn; }
  const ends = posted.filter(m => m.type === 'done').map(m => [m.engine, m.results && m.results.playouts]).sort();
  assert.deepEqual(ends, [['kcoach0', null], ['kcoach1', null], ['kcoach2', null], ['kcoach3', 20]]);
  assert.equal(posted.some(m => m.type === 'fatal'), false, 'not taken for a dead network');
  assert.equal(s.broken, null);
  s.add(job('kscout', 8));
  await idle(s);
  assert.equal(posted.find(m => m.type === 'done' && m.engine === 'kscout').results.playouts, 8, 'later searches still run');
});

test('Scheduler: a long read that reports nothing still sends a heartbeat', async () => {
  const { s, posted } = clocked({ ms: () => 1500 });
  s.add({ ...job('kopponent', 40, 1), started: 0 });   // 10 rounds of 1.5 s, no progress reports
  await idle(s);
  // At most one per 2 s, so here every second round: well inside the page's 30 s limit, and cheap.
  assert.equal(posted.filter(m => m.type === 'alive').length, 5, 'heartbeats in 15 s');
  assert.equal(posted.filter(m => m.type === 'progress').length, 0);
});

test('Scheduler: the AI\'s move goes first; background reads wait for it', async () => {
  const log = [];
  const { s } = setup(async ps => { log.push(ps.map(p => p.owner)); return ps.map(() => ({})); });
  s.add(job('kopponent', 128, 1));
  for (const j of ['kcoach0', 'kcoach1', 'kcoach2', 'kcoach3']) s.add(job(j, 167));
  await idle(s);
  const aiRounds = log.findIndex(r => !r.includes('kopponent'));
  assert.ok(aiRounds > 0 && log.slice(0, aiRounds).every(r => r.every(o => o === 'kopponent')), 'only the AI move runs until it is done');
  assert.equal(aiRounds, 32, '128 visits in batches of 4');
});

test('Scheduler: never more leaves than one batch holds; jobs take turns', async () => {
  const sizes = [];
  const { s } = setup(async ps => { sizes.push(ps.length); return ps.map(() => ({})); });
  for (let i = 0; i < 6; i++) s.add(job(`kcoach${i}`, 20));
  await idle(s);
  assert.ok(sizes.every(n => n <= 4), `batch sizes ${[...new Set(sizes)]}`);
  assert.equal(s.jobs.size, 0, 'every job finished');
});

test('chooseBackend: a backend failing at any step moves on to the next', async () => {
  const tried = [], disposed = [];
  const attempt = async b => {
    tried.push(b);
    if (b === 'webgpu') throw new Error('shader compile failed'); // set up fine, failed in warm-up
    if (b === 'webgl') return null;                                // not available
    return { backend: b, rate: 60, gpu: false, dispose: () => disposed.push(b) };
  };
  const best = await chooseBackend(['webgpu', 'webgl', 'wasm', 'cpu'], attempt);
  assert.equal(best.backend, 'wasm');
  assert.deepEqual(tried, ['webgpu', 'webgl', 'wasm'], 'a working CPU-side backend ends the search');
});

test('chooseBackend: a slow GPU that worked is kept when the next backend fails', async () => {
  const disposed = [];
  const attempt = async b => {
    if (b === 'webgpu') return { backend: b, rate: 90, gpu: true, dispose: () => disposed.push(b) };
    throw new Error(`${b} broke while benchmarking`);
  };
  const best = await chooseBackend(['webgpu', 'webgl', 'wasm', 'cpu'], attempt);
  assert.equal(best.backend, 'webgpu');
  assert.deepEqual(disposed, []);
  assert.equal(await chooseBackend(['wasm'], async () => { throw new Error('x'); }), null);
});

test('Scheduler: a search with its own batch takes no more leaves a round than that', async () => {
  const sizes = [];
  const { s } = setup(async ps => { sizes.push(ps.length); return ps.map(() => ({})); });
  s.evaluator.maxBatch = 16;
  s.add({ ...job('kopponent', 12, 1), batch: 4 });
  await idle(s);
  // A level's move reads as it was calibrated: 12 visits in rounds of 4, not one round of 12.
  assert.deepEqual(sizes, [4, 4, 4]);
});

// A scheduler on a fake clock: each evaluation moves time on by `ms(round)`,
// and `during(round)` runs while that evaluation is still in flight.
function clocked({ ms = () => 20, during = () => {} } = {}) {
  const posted = [], clock = { t: 0 };
  const s = new Scheduler({ post: m => posted.push(m), yieldFn: () => Promise.resolve(), now: () => clock.t });
  let round = 0;
  s.evaluator = { maxBatch: 4, evaluate: async ps => { const r = round++; clock.t += ms(r) / 2; during(r); clock.t += ms(r) / 2; return ps.map(() => ({})); } };
  return { s, posted, clock };
}

test('Scheduler: a coach read queued behind the AI keeps its time for when it runs', async () => {
  const { s, posted } = clocked();
  s.add({ ...job('kopponent', 60, 1), started: 0 });        // 15 rounds of 20 ms: 300 ms
  s.add({ ...job('kcoach0', 8), maxTime: 100, started: 0 });  // 2 rounds, allowed 100 ms
  await idle(s);
  assert.equal(posted.find(m => m.engine === 'kcoach0').results.playouts, 8, 'the coach got its whole read after the AI finished');
});

test('Scheduler: a coach read arriving while the AI\'s evaluation runs keeps its time too', async () => {
  let s0, clock0;
  // The AI's first round takes 150 ms; the coach arrives halfway through it.
  const { s, posted, clock } = clocked({
    ms: r => r === 0 ? 150 : 20,
    during: r => { if (r === 0) s0.add({ ...job('kcoach0', 8), maxTime: 100, started: clock0.t }); },
  });
  s0 = s; clock0 = clock;
  s.add({ ...job('kopponent', 60, 1), started: 0 });
  await idle(s);
  assert.equal(posted.find(m => m.engine === 'kcoach0').results.playouts, 8, 'the coach got its whole read after the AI finished');
});

// The worker itself, run in-process. Its TensorFlow.js is a stand-in
// (fake-tf.js: zeros out), so this tests the message handling, not the net.
async function kataWorker() {
  const fake = new URL('./fake-tf.js', import.meta.url).href;
  register('data:text/javascript,' + encodeURIComponent(
    `export async function resolve(s, c, next) { return s.endsWith('/vendor/tf.js') ? { url: ${JSON.stringify(fake)}, shortCircuit: true } : next(s, c); }`));
  const bytes = readFileSync(new URL('../nets/b6c96.bin', import.meta.url));
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) });
  const posted = [];
  globalThis.self = { addEventListener() {} };
  globalThis.postMessage = m => posted.push(m);
  globalThis.MessageChannel = class { constructor() { const port1 = this.port1 = {}; this.port2 = { postMessage: () => setImmediate(() => port1.onmessage()) }; } };
  await import('../src/katago-worker.js');
  const until = async pred => { for (;;) { const m = posted.find(pred); if (m) return m; await new Promise(r => setTimeout(r, 5)); } };
  return { posted, send: data => self.onmessage({ data }), until };
}

test('KataGo worker: a position it can\'t read ends only that search, empty; the others run', { timeout: 20000 }, async () => {
  const { posted, send, until } = await kataWorker();
  send({ type: 'load', backend: 'cpu' });
  const ready = await until(m => m.type === 'ready' || m.type === 'failed');
  assert.equal(ready.type, 'ready', ready.message);
  const E5 = parsePt('E5'), C3 = parsePt('C3');
  const position = { setup: [], moves: [[E5, BLACK], [C3, WHITE]], whiteFirst: false, komi: 7 };
  const warn = console.warn;
  console.warn = () => {};
  try {
    send({ type: 'search', engine: 'kcoach0', id: 1, position: { ...position, moves: [...position.moves, [E5, BLACK]] }, playouts: 8 });
    send({ type: 'search', engine: 'kscout', id: 2 });   // no position at all: a throw while handling it
    send({ type: 'search', engine: 'kopponent', id: 3, position, playouts: 8, reportMs: 0, priority: 1 });
    await until(m => m.type === 'done' && m.engine === 'kopponent');
    send({ type: 'search', engine: 'kcoach0', id: 4, position, playouts: 8, reportMs: 0 });
    await until(m => m.type === 'done' && m.id === 4);
  } finally { console.warn = warn; }
  const ends = posted.filter(m => m.type === 'done').map(m => [m.engine, m.id, m.results && m.results.playouts]);
  assert.deepEqual(ends.sort(), [['kcoach0', 1, null], ['kcoach0', 4, 8], ['kopponent', 3, 8], ['kscout', 2, null]]);
  assert.equal(posted.some(m => m.type === 'fatal' || m.type === 'failed'), false, 'KataGo itself is fine');
});
