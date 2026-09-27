// Loads the KataGo network in node, for tests and tools. Uses TF.js's WASM
// backend when it can (several times faster than the plain-JS CPU one).
//   const { net, evaluator, backend } = await loadNet({ backend: 'wasm' });
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as tf from '@tensorflow/tfjs-core';
import '@tensorflow/tfjs-backend-cpu';
import { parseModel, Net } from '../src/katago/model.js';
import { Evaluator } from '../src/katago/evaluator.js';

export const NET_FILE = fileURLToPath(new URL('../nets/b6c96.bin', import.meta.url));

let loaded = null;
export async function loadNet({ backend = 'wasm', file = NET_FILE, threads = 1 } = {}) {
  if (loaded) return loaded;
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
  loaded = { tf, net, backend: used };
  return loaded;
}

export const makeEvaluator = (net, opts) => new Evaluator(net, opts);
