// Rebuilds vendor/: TensorFlow.js (the pinned dev dependencies in package.json)
// bundled into one ES module the KataGo worker imports, plus the WASM backend's
// binaries. Vendored so the game works offline and on itch.io.
//   npm install && node tools/vendor-tf.js
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'vendor');
const version = JSON.parse(readFileSync(join(root, 'node_modules/@tensorflow/tfjs-core/package.json'), 'utf8')).version;
mkdirSync(out, { recursive: true });

await build({
  stdin: {
    contents: [
      "export * from '@tensorflow/tfjs-core';",
      "import '@tensorflow/tfjs-backend-cpu';",
      "import '@tensorflow/tfjs-backend-webgl';",
      "import '@tensorflow/tfjs-backend-webgpu';",
      "export { setWasmPaths } from '@tensorflow/tfjs-backend-wasm';",
    ].join('\n'),
    resolveDir: root,
  },
  bundle: true, format: 'esm', platform: 'browser', minify: true, legalComments: 'eof',
  banner: { js: `// TensorFlow.js ${version} (Apache-2.0), built by tools/vendor-tf.js. Do not edit.` },
  outfile: join(out, 'tf.js'),
  logLevel: 'warning',
});
// The threaded build needs cross-origin isolation, which the worker turns off.
for (const f of ['tfjs-backend-wasm.wasm', 'tfjs-backend-wasm-simd.wasm']) {
  copyFileSync(join(root, 'node_modules/@tensorflow/tfjs-backend-wasm/dist', f), join(out, f));
}
writeFileSync(join(out, 'README.md'), `TensorFlow.js ${version} (Apache License 2.0, https://github.com/tensorflow/tfjs),\nbundled by tools/vendor-tf.js for the KataGo worker. Don't edit; rebuild.\n`);
for (const f of ['tf.js', 'tfjs-backend-wasm.wasm', 'tfjs-backend-wasm-simd.wasm']) {
  console.log(`  vendor/${f.padEnd(28)} ${(statSync(join(out, f)).size / 1024).toFixed(0)} KB`);
}
