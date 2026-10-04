// Stands in for vendor/tf.js when the KataGo worker runs in node tests (see
// katago-worker.test.js): only the 'cpu' backend "works", every op gives back
// a dummy tensor, and reading one gives zeros, an even position everywhere.
const tensor = () => ({ shape: [0, 0], data: async () => new Float32Array(1 << 14) });
export const setWasmPaths = () => {};
export const env = () => ({ set() {} });
export const setBackend = async b => b === 'cpu';
export const ready = async () => {};
export const tidy = f => f();
export const dispose = () => {};
export const tensor4d = tensor, tensor2d = tensor, relu = tensor, mul = tensor, tanh = tensor, softplus = tensor,
  add = tensor, conv2d = tensor, mean = tensor, concat = tensor, max = tensor, reshape = tensor, matMul = tensor, slice = tensor;
