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
import { Scheduler } from './katago/scheduler.js';
import { chooseBackend } from './katago/backends.js';

const VENDOR = new URL('../vendor/', import.meta.url).href;
const NET = new URL('../nets/b6c96.bin', import.meta.url).href;
const BACKENDS = ['webgpu', 'webgl', 'wasm', 'cpu'];

let loading = null;

async function load(only) {
  // Both downloads at once: on a slow connection they're most of the start-up time.
  const netBytes = fetch(NET).then(res => {
    if (!res.ok) throw new Error(`network file: HTTP ${res.status}`);
    return res.arrayBuffer();
  });
  netBytes.catch(() => {}); // reported below; not an unhandled rejection if tf.js fails first
  const tf = await import(VENDOR + 'tf.js');
  tf.setWasmPaths(VENDOR);
  // Threaded WASM needs cross-origin isolation, which static hosts rarely give.
  tf.env().set('WASM_HAS_MULTITHREAD_SUPPORT', false);
  const parsed = parseModel(new Uint8Array(await netBytes));
  // Setting a backend up, building the net, warming up and benchmarking are one
  // attempt: if any step fails, the next backend gets its turn.
  const best = await chooseBackend(only ? [only] : BACKENDS, async b => {
    if (b === 'webgpu' && !(self.navigator && navigator.gpu)) return null;
    if (!await tf.setBackend(b)) return null;
    await tf.ready();
    const gpu = b === 'webgpu' || b === 'webgl', batch = gpu ? 16 : 4;
    const net = new Net(tf, parsed);
    // On a GPU every run is one size, so its programs are built once, here in the warm-up.
    if (gpu) net.fixedBatch = batch;
    try {
      const rate = await benchmark(net, batch);
      return { backend: b, net, rate, batch, gpu, dispose: () => net.dispose() };
    } catch (err) { net.dispose(); throw err; }
  });
  if (!best) throw new Error('no TensorFlow.js backend works here');
  if (!await tf.setBackend(best.backend)) throw new Error(`can't switch back to ${best.backend}`);
  // About 1.9 KB a cached position: 15k is ~30 MB, fine on phones, and still covers a game's reads.
  sched.evaluator = new Evaluator(best.net, { maxBatch: best.batch, cacheSize: 15000 });
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

// One reusable channel to yield between rounds (a new one per round would pile up ports).
const channel = new MessageChannel();
let wake = null;
channel.port1.onmessage = () => { const w = wake; wake = null; if (w) w(); };
const tick = () => new Promise(r => { wake = r; channel.port2.postMessage(0); });

const sched = new Scheduler({ post: m => postMessage(m), yieldFn: tick });
// Per engine, which request is current: a stop or a newer search cancels one
// still waiting for the network to load.
const current = new Map();

self.onmessage = async e => {
  const msg = e.data;
  if (msg.type === 'load' || !loading) {
    loading = loading || load(msg.backend).then(
      info => { postMessage({ type: 'ready', ...info }); return true; },
      err => { postMessage({ type: 'failed', message: String(err && err.message || err) }); return false; });
  }
  if (msg.type !== 'stop' && msg.type !== 'search') return;
  const req = {};
  current.set(msg.engine, req);
  sched.stop(msg.engine);
  if (msg.type === 'stop') return;
  if (!await loading) { postMessage({ type: 'done', engine: msg.engine, id: msg.id, results: null }); return; }
  if (current.get(msg.engine) !== req) return;   // stopped or replaced while loading
  const ev = sched.evaluator;
  // A position that can't be built (a move onto a stone, say) gets an empty
  // answer at once: the job mustn't vanish unanswered or loop forever.
  let search;
  try {
    search = new KataSearch(buildPosition(msg.position), { komi: msg.position.komi, evaluator: ev, batch: ev.maxBatch });
  } catch (err) {
    console.warn('KataGo: a position it cannot read', err && err.message, msg.position);
    postMessage({ type: 'done', engine: msg.engine, id: msg.id, results: null });
    return;
  }
  sched.add({
    engine: msg.engine, id: msg.id, priority: msg.priority || 0,
    search,
    target: msg.playouts || 100,
    batch: msg.batch || 0,
    maxTime: msg.maxTime || 60000,
    reportMs: msg.reportMs ?? 250,
    started: performance.now(), lastReport: 0,
  });
};
