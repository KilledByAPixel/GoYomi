// Converts a KataGo network (.txt.gz or .bin.gz) to the compact file the
// browser loads: the same format with every weight array stored as float16,
// about half the size of KataGo's own binary and fast to parse.
//   node tools/convert-net.js nets/kata1-b6c96-....txt.gz nets/b6c96.bin
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseModel } from '../src/katago/model.js';

const [src, dst] = process.argv.slice(2);
if (!src || !dst) { console.error('usage: node tools/convert-net.js <in.txt.gz|in.bin.gz> <out.bin>'); process.exit(1); }
let bytes = readFileSync(src);
if (src.endsWith('.gz')) bytes = gunzipSync(bytes);
const model = parseModel(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length), true);
writeFileSync(dst, model.bytes);
console.log(`${model.name} (model v${model.version}): ${(bytes.length / 1e6).toFixed(1)} MB -> ${(model.bytes.length / 1e6).toFixed(2)} MB`);
