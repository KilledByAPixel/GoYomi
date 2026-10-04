// Loads the KataGo network in node, for tests and tools. Uses TF.js's WASM
// backend when it can (several times faster than the plain-JS CPU one).
//   const { net, backend } = await loadNet({ backend: 'wasm' });
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as tf from '@tensorflow/tfjs-core';
import '@tensorflow/tfjs-backend-cpu';
import { parseModel, Net } from '../src/katago/model.js';
import { Evaluator } from '../src/katago/evaluator.js';

export const NET_FILE = fileURLToPath(new URL('../nets/b6c96.bin', import.meta.url));

// TF.js has one backend per process, so the network loads once; asking again
// with different options is an error rather than silently getting the first.
// The promise is kept, so calls made while it loads share the one load.
let loaded = null, loadedWith = '';
export async function loadNet({ backend = 'wasm', file = NET_FILE, threads = 1 } = {}) {
  const key = JSON.stringify([backend, file, threads]);
  if (loaded) {
    if (key !== loadedWith) throw new Error(`loadNet: already loaded with ${loadedWith}; one network setup per process`);
    return loaded;
  }
  loadedWith = key;
  return loaded = setUp(backend, file, threads);
}

async function setUp(backend, file, threads) {
  let used = 'cpu';
  if (backend === 'wasm') {
    try {
      const wasm = await import('@tensorflow/tfjs-backend-wasm');
      wasm.setThreadsCount?.(threads);
      if (await tf.setBackend('wasm')) used = 'wasm';
    } catch { /* fall back to cpu */ }
  }
  if (used === 'cpu') await tf.setBackend('cpu');
  await tf.ready();
  const bytes = readFileSync(file);
  const net = new Net(tf, parseModel(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length)));
  return { tf, net, backend: used };
}

export const makeEvaluator = (net, opts) => new Evaluator(net, opts);
