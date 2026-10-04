// Regenerates test/fixtures/katago-b6c96-reference.json with native KataGo (the
// positions stay; each one's outputs are read again with kata-raw-nn 0).
//   node tools/katago-fixtures.js --katago path/katago.exe --model path/net.txt.gz --config path/gtp.cfg [--fp16] [--out file]
// Without --fp16 the GPU runs in full precision (openclUseFP16 = false): half
// precision moves the outputs by about 1% and hides port errors.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? resolve(process.argv[i + 1]) : d; };
const KATA = arg('katago', 'katago'), CFG = arg('config'), MODEL = arg('model');
if (!CFG || !MODEL) { console.log('Usage: node tools/katago-fixtures.js --katago katago.exe --model net.txt.gz --config gtp.cfg [--fp16] [--out file]'); process.exit(1); }
const fp16 = process.argv.includes('--fp16');
const oi = process.argv.indexOf('--out');
const out = oi > 0 ? process.argv[oi + 1] : 'test/fixtures/katago-b6c96-reference.json';
const fixture = JSON.parse(readFileSync('test/fixtures/katago-b6c96-reference.json', 'utf8'));

const args = ['gtp', '-model', MODEL, '-config', CFG];
if (!fp16) args.push('-override-config', 'openclUseFP16=false');
const proc = spawn(KATA, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: dirname(KATA) }); // KataGo's logs go in its own folder
let buf = '';
const waiting = [];
proc.stdout.setEncoding('utf8');
proc.stdout.on('data', d => {
  buf += d.replace(/\r/g, '');
  let i;
  while (waiting.length && (i = buf.indexOf('\n\n')) >= 0) {
    const reply = buf.slice(0, i); buf = buf.slice(i + 2);
    const w = waiting.shift();
    reply.startsWith('=') ? w.resolve(reply.slice(1).trim()) : w.reject(new Error(`${w.cmd}: ${reply}`));
  }
});
// KataGo logs to stderr: read it all (a full pipe would stall KataGo), keeping
// the end for the error if it stops.
let log = '';
proc.stderr.setEncoding('utf8');
proc.stderr.on('data', d => { log = (log + d).slice(-4000); });
// If KataGo can't start or exits early, every command still waiting fails instead of hanging.
let gone = null;
const abort = why => {
  gone = gone || why;
  for (const w of waiting.splice(0)) w.reject(new Error(`${w.cmd}: ${gone}\n${log.trim()}`));
};
proc.on('error', err => abort(`could not run ${KATA}: ${err.message}`));
// 'close', not 'exit': it comes after the last of KataGo's output has been read.
proc.on('close', (code, signal) => abort(`KataGo exited (${signal || `code ${code}`})`));
proc.stdin.on('error', () => {}); // writing after it exited: reported by 'close'
const send = cmd => new Promise((resolve, reject) => {
  waiting.push({ cmd, resolve, reject });
  if (gone) abort(gone); else proc.stdin.write(cmd + '\n');
});

// kata-raw-nn prints "name value" lines, and grids after "policy" / "whiteOwnership".
function parseRaw(text) {
  const tok = text.split(/\s+/).filter(Boolean), o = {};
  const num = t => (t === 'NAN' || t === 'nan' ? null : +t);
  for (let i = 0; i < tok.length; i++) {
    const k = tok[i];
    if (k === 'policy' || k === 'whiteOwnership') { o[k] = tok.slice(i + 1, i + 82).map(num); i += 81; }
    else if (/^[a-zA-Z]+$/.test(k) && i + 1 < tok.length && !isNaN(+tok[i + 1])) { o[k] = +tok[i + 1]; i++; }
  }
  return o;
}

await send('boardsize 9');
await send('kata-set-rules chinese');
for (const r of ['ko POSITIONAL', 'whiteHandicapBonus 0']) await send('kata-set-rule ' + r);
const rules = await send('kata-get-rules');
const positions = [];
for (const f of fixture.positions) {
  await send('clear_board');
  await send(`komi ${f.komi}`);
  for (const [c, m] of f.moves) await send(`play ${c} ${m}`);
  const raw = parseRaw(await send('kata-raw-nn 0'));
  const output = {};
  for (const k of Object.keys(f.output)) output[k] = raw[k];
  positions.push({ ...f, output });
}
await send('quit').catch(() => {});
// The precision note is replaced, not appended again, when the fixture is regenerated.
const about = fixture.about.replace(/, FP32 \(openclUseFP16 = false\)/g, '')
  .replace(/Native KataGo v[\d.]+ kata-raw-nn outputs/, m => `${m}${fp16 ? '' : ', FP32 (openclUseFP16 = false)'}`);
writeFileSync(out, JSON.stringify({ ...fixture, about, positions }, null, 1) + '\n');
console.log(`rules ${rules}`);
console.log(`wrote ${positions.length} positions to ${out}`);
