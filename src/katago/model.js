// A KataGo network (model versions 8-14) run with TensorFlow.js. Reads
// KataGo's text and binary (@BIN@) formats, plus @F16@: our own half-size
// variant of @BIN@ that tools/convert-net.js writes for the browser.
//
// Ported from Web KaTrain (src/engine/katago/binModelParser.ts,
// loadModelV8.ts, modelV8.ts, evalV8.ts).
// Copyright (c) 2026 Web KatRain Contributors. MIT License.
import { AREA } from './board.js';
import { SPATIAL, GLOBAL } from './features.js';

const isSpace = b => b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09;

function halfToFloat(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}
const HALF = new Float32Array(65536);
for (let i = 0; i < 65536; i++) HALF[i] = halfToFloat(i);

function floatToHalf(f) {
  const buf = new DataView(new ArrayBuffer(4));
  buf.setFloat32(0, f);
  const x = buf.getUint32(0), s = (x >>> 16) & 0x8000;
  let e = ((x >>> 23) & 0xff) - 127 + 15;
  let m = x & 0x7fffff;
  if (e >= 31) return s | 0x7c00;
  if (e <= 0) {
    if (e < -10) return s;
    m = (m | 0x800000) >> (1 - e);
    return s | ((m + 0x1000) >> 13);
  }
  const h = s | (e << 10) | (m >> 13);
  return (m & 0x1000) ? h + 1 : h;   // round half up; carries into the exponent correctly
}

// Token reader. With record set, it also writes the model back out with every
// float array as @F16@ (see tools/convert-net.js).
export class Parser {
  constructor(bytes, record = false) {
    this.data = bytes; this.i = 0;
    this.out = record ? [] : null;
  }
  skip() { while (this.i < this.data.length && isSpace(this.data[this.i])) this.i++; }
  token() {
    this.skip();
    const start = this.i;
    while (this.i < this.data.length && !isSpace(this.data[this.i])) this.i++;
    if (this.i === start) throw new Error('Unexpected end of network file');
    const t = String.fromCharCode.apply(null, this.data.subarray(start, this.i));
    if (this.out) this.out.push(new TextEncoder().encode(t + '\n'));
    return t;
  }
  int() { const v = parseInt(this.token(), 10); if (!Number.isFinite(v)) throw new Error('Bad int in network'); return v; }
  float() { const v = parseFloat(this.token()); if (!Number.isFinite(v)) throw new Error('Bad float in network'); return v; }
  marker(m) {
    for (let k = 0; k < 5; k++) if (this.data[this.i + k] !== m.charCodeAt(k)) return false;
    this.i += 5;
    return true;
  }
  floats(count) {
    this.skip();
    let a;
    if (this.marker('@BIN@')) {
      const bytes = this.data.slice(this.i, this.i + count * 4);
      this.i += count * 4;
      a = new Float32Array(bytes.buffer);
    } else if (this.marker('@F16@')) {
      const dv = new DataView(this.data.buffer, this.data.byteOffset + this.i, count * 2);
      this.i += count * 2;
      a = new Float32Array(count);
      for (let k = 0; k < count; k++) a[k] = HALF[dv.getUint16(k * 2, true)];
    } else {
      const saved = this.out;
      this.out = null;
      a = new Float32Array(count);
      for (let k = 0; k < count; k++) a[k] = this.float();
      this.out = saved;
    }
    if (this.out) {
      const h = new Uint8Array(5 + count * 2 + 1);
      h.set([0x40, 0x46, 0x31, 0x36, 0x40]);
      const dv = new DataView(h.buffer, 5, count * 2);
      for (let k = 0; k < count; k++) dv.setUint16(k * 2, floatToHalf(a[k]), true);
      h[h.length - 1] = 0x0a;
      this.out.push(h);
    }
    return a;
  }
  bytes() {
    const n = this.out.reduce((s, b) => s + b.length, 0), all = new Uint8Array(n);
    let at = 0;
    for (const b of this.out) { all.set(b, at); at += b.length; }
    return all;
  }
}

// ---------------------------------------------------------------- structure

function batchNorm(p) {
  p.token();
  const c = p.int(), eps = p.float(), hasScale = p.int() !== 0, hasBias = p.int() !== 0;
  const mean = p.floats(c), variance = p.floats(c);
  const scale = hasScale ? p.floats(c) : new Float32Array(c).fill(1);
  const bias = hasBias ? p.floats(c) : new Float32Array(c);
  const s = new Float32Array(c), b = new Float32Array(c);
  for (let i = 0; i < c; i++) { s[i] = scale[i] / Math.sqrt(variance[i] + eps); b[i] = bias[i] - s[i] * mean[i]; }
  return { kind: 'bn', c, scale: s, bias: b };
}
function activation(p, version) {
  p.token();
  if (version < 11) return 'relu';
  const k = p.token();
  if (k === 'ACTIVATION_IDENTITY') return 'identity';
  if (k === 'ACTIVATION_RELU') return 'relu';
  if (k === 'ACTIVATION_MISH') return 'mish';
  throw new Error(`Unsupported activation ${k}`);
}
function conv(p) {
  p.token();
  const ky = p.int(), kx = p.int(), cin = p.int(), cout = p.int(), dy = p.int(), dx = p.int();
  return { kind: 'conv', ky, kx, cin, cout, dy, dx, w: p.floats(ky * kx * cin * cout) };
}
function matmul(p) {
  p.token();
  const cin = p.int(), cout = p.int();
  return { kind: 'mm', cin, cout, w: p.floats(cin * cout) };
}
function matbias(p) {
  p.token();
  const c = p.int();
  return { kind: 'bias', c, w: p.floats(c) };
}

export function parseModel(bytes, record = false) {
  const p = new Parser(bytes, record);
  const name = p.token(), version = p.int();
  if (version < 8 || version > 14) throw new Error(`Unsupported model version ${version}`);
  const numIn = p.int(), numGlobal = p.int();
  if (numIn !== SPATIAL || numGlobal !== GLOBAL) throw new Error('Unexpected network inputs');
  // Output multipliers: td score, score mean, stdev, lead, then three we don't use.
  const m = version >= 13 ? Array.from({ length: 7 }, () => p.float()) : [20, 20, 20, 20];
  const post = { scoreMean: m[1], lead: m[3] };
  p.token();   // trunk
  const numBlocks = p.int();
  p.int(); p.int(); p.int(); p.int(); p.int();   // trunk, mid, regular, dilated, gpool channels
  const trunk = { conv1: conv(p), ginput: matmul(p), blocks: [] };
  const block = () => {
    const kind = p.token();
    p.token();
    if (kind === 'ordinary_block') {
      return { kind, preBN: batchNorm(p), preAct: activation(p, version), w1: conv(p),
        midBN: batchNorm(p), midAct: activation(p, version), w2: conv(p) };
    }
    if (kind === 'gpool_block') {
      return { kind, preBN: batchNorm(p), preAct: activation(p, version), w1a: conv(p), w1b: conv(p),
        gpoolBN: batchNorm(p), gpoolAct: activation(p, version), w1r: matmul(p),
        midBN: batchNorm(p), midAct: activation(p, version), w2: conv(p) };
    }
    throw new Error(`Unsupported block ${kind}`);
  };
  for (let i = 0; i < numBlocks; i++) trunk.blocks.push(block());
  trunk.tipBN = batchNorm(p); trunk.tipAct = activation(p, version);
  p.token();
  const policy = { p1: conv(p), g1: conv(p), g1BN: batchNorm(p), g1Act: activation(p, version),
    gpoolToBias: matmul(p), p1BN: batchNorm(p), p1Act: activation(p, version), p2: conv(p), pass: matmul(p) };
  p.token();
  const value = { v1: conv(p), v1BN: batchNorm(p), v1Act: activation(p, version),
    v2: matmul(p), v2Bias: matbias(p), v2Act: activation(p, version),
    v3: matmul(p), v3Bias: matbias(p), sv3: matmul(p), sv3Bias: matbias(p), ownership: conv(p) };
  return { name, version, post, trunk, policy, value, bytes: record ? p.bytes() : null };
}

// ---------------------------------------------------------------- network

export class Net {
  constructor(tf, parsed) {
    this.tf = tf;
    this.name = parsed.name;
    this.version = parsed.version;
    this.post = parsed.post;
    this.scoreChannels = parsed.value.sv3.cout;
    this.tensors = [];
    // Turn every array into a tensor of the right shape, in place.
    const make = x => {
      if (Array.isArray(x)) return x.map(make);
      if (!x || typeof x !== 'object' || x instanceof Uint8Array) return x;
      const keep = t => { this.tensors.push(t); return t; };
      if (x.kind === 'conv') return { ...x, w: keep(tf.tensor4d(x.w, [x.ky, x.kx, x.cin, x.cout])) };
      if (x.kind === 'mm') return { ...x, w: keep(tf.tensor2d(x.w, [x.cin, x.cout])) };
      if (x.kind === 'bias') return { ...x, w: keep(tf.tensor2d(x.w, [1, x.c])) };
      if (x.kind === 'bn') return { ...x, scale: keep(tf.tensor4d(x.scale, [1, 1, 1, x.c])), bias: keep(tf.tensor4d(x.bias, [1, 1, 1, x.c])) };
      const out = {};
      for (const [k, v] of Object.entries(x)) out[k] = make(v);
      return out;
    };
    this.trunk = make(parsed.trunk);
    this.policy = make(parsed.policy);
    this.value = make(parsed.value);
  }

  act(x, kind) {
    const tf = this.tf;
    if (kind === 'identity') return x;
    if (kind === 'relu') return tf.relu(x);
    return tf.mul(x, tf.tanh(tf.softplus(x)));
  }
  bnAct(x, bn, kind) { return this.act(this.tf.add(this.tf.mul(x, bn.scale), bn.bias), kind); }
  conv(x, c) { return this.tf.conv2d(x, c.w, 1, 'same', 'NHWC', [c.dy, c.dx]); }
  // KataGo's global pooling on a 9x9 board: mean, mean scaled by board size, max.
  gpool(x) {
    const tf = this.tf, mean = tf.mean(x, [1, 2]);
    return tf.concat([mean, tf.mul(mean, (9 - 14) * 0.1), tf.max(x, [1, 2])], 1);
  }
  valuePool(x) {
    const tf = this.tf, mean = tf.mean(x, [1, 2]), b = 9 - 14;
    return tf.concat([mean, tf.mul(mean, b * 0.1), tf.mul(mean, b * b * 0.01 - 0.1)], 1);
  }
  addBias(x, v) { return this.tf.add(x, this.tf.reshape(v, [v.shape[0], 1, 1, v.shape[1]])); }

  // One tensor [n, 81 policy + pass + 3 value + score channels + 81 ownership].
  forward(spatial, global) {
    const tf = this.tf;
    return tf.tidy(() => {
      const t = this.trunk;
      let x = this.addBias(this.conv(spatial, t.conv1), tf.matMul(global, t.ginput.w));
      for (const b of t.blocks) {
        const a = this.bnAct(x, b.preBN, b.preAct);
        let r;
        if (b.kind === 'ordinary_block') r = this.conv(a, b.w1);
        else {
          const g = this.bnAct(this.conv(a, b.w1b), b.gpoolBN, b.gpoolAct);
          r = this.addBias(this.conv(a, b.w1a), tf.matMul(this.gpool(g), b.w1r.w));
        }
        x = tf.add(x, this.conv(this.bnAct(r, b.midBN, b.midAct), b.w2));
      }
      x = this.bnAct(x, t.tipBN, t.tipAct);

      const P = this.policy, n = spatial.shape[0];
      const g1 = this.gpool(this.bnAct(this.conv(x, P.g1), P.g1BN, P.g1Act));
      const p1 = this.bnAct(this.addBias(this.conv(x, P.p1), tf.matMul(g1, P.gpoolToBias.w)), P.p1BN, P.p1Act);
      const policy = tf.reshape(tf.slice(this.conv(p1, P.p2), [0, 0, 0, 0], [n, 9, 9, 1]), [n, AREA]);
      const pass = tf.slice(tf.matMul(g1, P.pass.w), [0, 0], [n, 1]);

      const V = this.value;
      const v1 = this.bnAct(this.conv(x, V.v1), V.v1BN, V.v1Act);
      const v2 = this.act(tf.add(tf.matMul(this.valuePool(v1), V.v2.w), V.v2Bias.w), V.v2Act);
      const value = tf.add(tf.matMul(v2, V.v3.w), V.v3Bias.w);
      const score = tf.add(tf.matMul(v2, V.sv3.w), V.sv3Bias.w);
      const own = tf.reshape(this.conv(v1, V.ownership), [n, AREA]);
      return tf.concat([policy, pass, value, score, own], 1);
    });
  }

  // Runs n positions of inputs; returns raw outputs per position, from the
  // side to move's point of view.
  async evaluate(spatial, global, n) {
    const tf = this.tf;
    const s = tf.tensor4d(spatial.subarray(0, n * AREA * SPATIAL), [n, 9, 9, SPATIAL]);
    const g = tf.tensor2d(global.subarray(0, n * GLOBAL), [n, GLOBAL]);
    const out = this.forward(s, g);
    const data = await out.data();
    tf.dispose([s, g, out]);
    const w = AREA + 1 + 3 + this.scoreChannels + AREA, res = [];
    for (let i = 0; i < n; i++) res.push(this.decode(data.subarray(i * w, (i + 1) * w)));
    return res;
  }

  // Raw row -> { policyLogits (82, pass last), win, loss, noResult, lead,
  // scoreMean, ownership (81, +1 = side to move) }.
  decode(row) {
    const sc = AREA + 1 + 3;
    const v = [row[AREA + 1], row[AREA + 2], row[AREA + 3]];
    const mx = Math.max(...v), e = v.map(x => Math.exp(x - mx)), sum = e[0] + e[1] + e[2];
    const noResult = e[2] / sum;
    const ownership = new Float32Array(AREA);
    for (let i = 0; i < AREA; i++) ownership[i] = Math.tanh(row[sc + this.scoreChannels + i]);
    return {
      policyLogits: row.slice(0, AREA + 1),
      win: e[0] / sum, loss: e[1] / sum, noResult,
      scoreMean: row[sc] * this.post.scoreMean * (1 - noResult),
      lead: row[sc + 2] * this.post.lead * (1 - noResult),
      ownership,
    };
  }

  dispose() { this.tf.dispose(this.tensors); }
}

// Softmax of policy logits over the legal moves (legal: 82 flags, pass last).
export function policyProbs(logits, legal, temperature = 1) {
  const out = new Float32Array(AREA + 1);
  let mx = -Infinity;
  for (let i = 0; i <= AREA; i++) if (legal[i] && logits[i] > mx) mx = logits[i];
  let sum = 0;
  for (let i = 0; i <= AREA; i++) if (legal[i]) sum += out[i] = Math.exp((logits[i] - mx) / temperature);
  for (let i = 0; i <= AREA; i++) out[i] /= sum;
  return out;
}
