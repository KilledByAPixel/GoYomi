// The published build (tools/build.js): every file the page loads carries a
// stamp of its contents, and the page checks it's the latest version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = mkdtempSync(join(tmpdir(), 'goyomi-build-'));
execFileSync(process.execPath, ['tools/build.js', '--out', out, '--no-zip'], { stdio: 'pipe' });
const read = f => readFileSync(join(out, f));
const text = f => read(f).toString('utf8');
const stamp = f => createHash('sha256').update(read(f)).digest('hex').slice(0, 10);
process.on('exit', () => rmSync(out, { recursive: true, force: true }));

test('build: the page and its code are stamped with their contents', () => {
  const html = text('index.html');
  assert.ok(html.includes(`app.js?v=${stamp('app.js')}`), 'app.js');
  assert.ok(html.includes(`style.css?v=${stamp('style.css')}`), 'style.css');
  const app = text('app.js');
  assert.ok(app.includes(`katago-worker.js?v=${stamp('katago-worker.js')}`), 'KataGo worker');
  assert.ok(app.includes(`engine-worker.js?v=${stamp('engine-worker.js')}`), 'built-in engine worker');
  const worker = text('katago-worker.js');
  assert.ok(worker.includes(`tf.js?v=${stamp('vendor/tf.js')}`), 'tf.js');
  assert.ok(worker.includes(`b6c96.bin?v=${stamp('nets/b6c96.bin')}`), 'network');
  assert.ok(worker.includes(`tfjs-backend-wasm-simd.wasm?v=${stamp('vendor/tfjs-backend-wasm-simd.wasm')}`), 'WASM backend');
});

test('build: the page knows its version and checks for a newer one', () => {
  const html = text('index.html');
  const v = JSON.parse(text('version.json')).version;
  assert.match(v, /^[0-9a-f]{10}$/);
  assert.ok(html.includes(`<meta name="goyomi-version" content="${v}">`));
  assert.ok(html.includes("fetch('version.json', { cache: 'no-store' })"));
  assert.ok(!html.includes('src/app.js'), 'no unbuilt module script');
});

test('build: everything the page needs is there, and no zip when asked not to', () => {
  for (const f of ['social.png', 'LICENSE', 'THIRD_PARTY_NOTICES.txt', 'nets/LICENSE.txt', 'vendor/tfjs-backend-wasm.wasm']) assert.ok(existsSync(join(out, f)), f);
  assert.ok(!existsSync(join(out, 'goyomi.zip')));
});
