// Web Worker running the KataGo network and its searches. Speaks the same
// protocol as engine-worker.js ('search', 'stop', then 'progress' and 'done'),
// but serves several engines at once (each message carries an `engine` name):
// their searches take turns filling shared batches for the net.
//
// On the first message it loads TensorFlow.js and the network, trying WebGPU,
// WebGL, WASM and plain JS in that order, and reports { type: 'ready', backend,
// rate } (evaluations per second from a short benchmark) or { type: 'failed' }.
import { parseModel, Net } from './katago/model.js';
import { Evaluator } from './katago/evaluator.js';
import { KataSearch } from './katago/search.js';
import { buildPosition } from './recipe.js';

const VENDOR = new URL('../vendor/', import.meta.url).href;
const NET = new URL('../nets/b6c96.bin', import.meta.url).href;
const BACKENDS = ['webgpu', 'webgl', 'wasm', 'cpu'];

let evaluator = null, loading = null;
const jobs = new Map();   // engine name -> job

async function load(only) {
  const tf = await import(VENDOR + 'tf.js');
  tf.setWasmPaths(VENDOR);
  // Threaded WASM needs cross-origin isolation, which static hosts rarely give.
  tf.env().set('WASM_HAS_MULTITHREAD_SUPPORT', false);
  const res = await fetch(NET);
  if (!res.ok) throw new Error(`network file: HTTP ${res.status}`);
  const parsed = parseModel(new Uint8Array(await res.arrayBuffer()));
  let best = null;
  for (const b of only ? [only] : BACKENDS) {
    if (b === 'webgpu' && !(self.navigator && navigator.gpu)) continue;
    let ok = false;
    try { ok = await tf.setBackend(b); if (ok) await tf.ready(); } catch { ok = false; }
    if (!ok) continue;
    const gpu = b === 'webgpu' || b === 'webgl';
    const net = new Net(tf, parsed);
    const rate = await benchmark(net, gpu ? 16 : 4);
    if (!best || rate > best.rate) { if (best) best.net.dispose(); best = { backend: b, net, rate, batch: gpu ? 16 : 4 }; }
    else net.dispose();
    // A weak GPU can be slower than WASM on the CPU: then try that too.
    if (!gpu || rate >= 150) break;
  }
  if (!best) throw new Error('no TensorFlow.js backend works here');
  await tf.setBackend(best.backend);
  evaluator = new Evaluator(best.net, { maxBatch: best.batch });
  return { backend: best.backend, rate: best.rate, batch: best.batch };
}

// Evaluations per second in real searches, after a warm-up (GPU backends
// compile their shaders on first use).
async function benchmark(net, batch) {
  const ev = new Evaluator(net, { maxBatch: batch, cacheSize: 0 });
  const search = new KataSearch(buildPosition({ setup: [], moves: [], whiteFirst: false }), { komi: 7, evaluator: ev, batch });
  await search.run(batch + 1);
  const t0 = performance.now(), n0 = ev.evals;
  while (performance.now() - t0 < 600) await search.run(batch);
  return (ev.evals - n0) / ((performance.now() - t0) / 1000);
}

self.onmessage = async e => {
  const msg = e.data;
  if (msg.type === 'load' || !loading) {
    loading = loading || load(msg.backend).then(
      info => { postMessage({ type: 'ready', ...info }); return true; },
      err => { postMessage({ type: 'failed', message: String(err && err.message || err) }); return false; });
  }
  if (msg.type === 'stop') { jobs.delete(msg.engine); return; }
  if (msg.type !== 'search') return;
  jobs.delete(msg.engine);
  if (!await loading) { postMessage({ type: 'done', engine: msg.engine, id: msg.id, results: null }); return; }
  const position = buildPosition(msg.position);
  jobs.set(msg.engine, {
    engine: msg.engine, id: msg.id,
    search: new KataSearch(position, { komi: msg.position.komi, evaluator, batch: evaluator.maxBatch }),
    target: msg.playouts || 100,
    maxTime: msg.maxTime || 60000,
    reportMs: msg.reportMs ?? 250,
    started: performance.now(), lastReport: 0,
  });
  pump();
};

// One loop serves all jobs: each round, every job adds its share of leaves to
// one batch; after the net runs, each gets its outputs back.
let pumping = false;
const tick = () => new Promise(r => { const c = new MessageChannel(); c.port1.onmessage = r; c.port2.postMessage(0); });
async function pump() {
  if (pumping) return;
  pumping = true;
  while (jobs.size) {
    const live = [...jobs.values()];
    const share = Math.max(1, Math.floor(evaluator.maxBatch / live.length));
    const parts = live.map(j => ({ j, sels: j.search.gather(Math.min(share, j.target - j.search.playouts)) }));
    const all = parts.flatMap(p => p.sels);
    const outs = all.length ? await evaluator.evaluate(all.map(s => s.pos)) : [];
    let at = 0;
    const now = performance.now();
    for (const { j, sels } of parts) {
      const mine = outs.slice(at, at += sels.length);
      if (jobs.get(j.engine) !== j) continue;   // stopped or replaced while the net ran
      j.search.apply(sels, mine);
      const done = j.search.playouts >= j.target || now - j.started > j.maxTime;
      if (done || (j.reportMs && now - j.lastReport > j.reportMs)) {
        j.lastReport = now;
        const results = j.search.results(done ? 40 : 12);
        results.engine = 'katago';
        if (!done) delete results.allMoves;
        postMessage({ type: done ? 'done' : 'progress', engine: j.engine, id: j.id, results, elapsed: now - j.started });
      }
      if (done) jobs.delete(j.engine);
    }
    await tick();   // let 'stop' and new searches in
  }
  pumping = false;
}
