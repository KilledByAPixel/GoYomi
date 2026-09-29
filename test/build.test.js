// The published build (tools/build.js): every file the page loads carries a
// stamp of its contents, and the page checks it's the latest version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

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
  for (const f of ['social.png', 'icon.png', 'icon-32.png', 'icon-180.png', 'LICENSE', 'THIRD_PARTY_NOTICES.txt', 'nets/LICENSE.txt', 'vendor/tfjs-backend-wasm.wasm']) assert.ok(existsSync(join(out, f)), f);
  assert.ok(!existsSync(join(out, 'goyomi.zip')));
});

// The built page's start-up script, run with a fake network, clock and page.
const loader = (() => {
  const html = text('index.html');
  const at = html.indexOf('<script>\n(function () {');
  return html.slice(at + '<script>'.length, html.indexOf('</script>', at));
})();
const VERSION = JSON.parse(text('version.json')).version;
const flush = () => new Promise(r => setImmediate(r));
function boot(fetchImpl, stored = null) {
  const started = [], timers = [];
  let reloads = 0, saved = stored;
  vm.runInNewContext(loader, {
    fetch: fetchImpl,
    document: { readyState: 'complete', createElement: () => ({}), head: { appendChild: s => started.push(s.src) }, addEventListener: (e, f) => f() },
    sessionStorage: { getItem: () => saved, setItem: (k, v) => { saved = v; } },
    location: { reload: () => { reloads++; } },
    setTimeout: f => { timers.push(f); return timers.length; },
    clearTimeout: id => { timers[id - 1] = null; },
  });
  return { started, reloads: () => reloads, expire: () => timers.forEach(f => f && f()) };
}
const answer = version => () => Promise.resolve({ json: () => Promise.resolve({ version }) });
const never = () => new Promise(() => {});

test('build: the page starts once when the version check answers, fails, or never finishes', async () => {
  const ok = boot(answer(VERSION)); await flush();
  assert.equal(ok.started.length, 1, 'latest version');
  assert.match(ok.started[0], /^app\.js\?v=/);
  const failed = boot(() => Promise.reject(new Error('offline'))); await flush();
  assert.equal(failed.started.length, 1, 'request failed');
  const stalled = boot(never); await flush();
  assert.equal(stalled.started.length, 0, 'waits a little first');
  stalled.expire(); await flush();
  assert.equal(stalled.started.length, 1, 'no answer: starts after the deadline');
  const body = boot(() => Promise.resolve({ json: never })); await flush();
  body.expire(); await flush();
  assert.equal(body.started.length, 1, 'answer without a body: starts after the deadline');
});

test('build: an older page reloads once; a late answer after starting changes nothing', async () => {
  const stale = boot(answer('0123456789')); await flush();
  assert.equal(stale.reloads(), 1);
  assert.equal(stale.started.length, 0);
  const again = boot(answer('0123456789'), '0123456789'); await flush();
  assert.equal(again.reloads(), 0, 'already reloaded for that version: start instead');
  assert.equal(again.started.length, 1);
  let arrive;
  const late = boot(() => new Promise(r => { arrive = r; })); await flush();
  late.expire(); await flush();
  arrive({ json: () => Promise.resolve({ version: '0123456789' }) }); await flush();
  assert.equal(late.started.length, 1, 'started once');
  assert.equal(late.reloads(), 0, 'no reload once the game is running');
});
