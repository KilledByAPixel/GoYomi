// The KataGo worker's scheduling and backend choice, with fake networks and searches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../src/katago/scheduler.js';
import { chooseBackend } from '../src/katago/backends.js';

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
