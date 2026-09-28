// Builds the published game into dist/:  node tools/build.js [--out dir] [--no-zip]
// GitHub Pages runs this on every push (.github/workflows/pages.yml).
//
// No dependencies. The ES modules in src/ are inlined into classic scripts
// (app.js for the page, engine-worker.js and katago-worker.js for the search
// workers), so the result does not rely on module workers. The KataGo network
// and the vendored TensorFlow.js are copied alongside, and every file is
// addressed with a stamp of its contents (see "build" below). dist/goyomi.zip
// is the same thing for hosts that take an upload, such as itch.io.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, 'src');
// --out <dir>: build somewhere else (tests); --no-zip: skip the ZIP (the website doesn't need it).
const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const dist = path.resolve(arg('--out') || path.join(root, 'dist'));
const noZip = process.argv.includes('--no-zip');

// ------------------------------------------------------------------ module inliner

const modId = file => '__' + path.relative(src, file).replace(/\.js$/, '').replace(/[^\w$]/g, '_');

// Splits a declaration list on top-level commas: "A = 0, B = [1, 2]" -> ["A = 0", "B = [1, 2]"].
function splitTopLevel(s) {
  const out = []; let depth = 0, cur = '';
  for (const ch of s) {
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map(x => x.trim()).filter(Boolean);
}

// Turns one ES module into a plain-script block that assigns its exports to an object.
function transform(file, code) {
  const deps = [];
  const exportsList = [];
  const lines = code.replace(/\r\n?/g, '\n').split('\n').map(line => {
    let m;
    if ((m = line.match(/^import\s*\{([^}]*)\}\s*from\s*'([^']+)';?\s*$/))) {
      deps.push(m[2]);
      const names = m[1].split(',').map(s => s.trim()).filter(Boolean)
        .map(s => s.replace(/\s+as\s+/, ': '));
      return `const { ${names.join(', ')} } = ${modId(path.resolve(path.dirname(file), m[2]))};`;
    }
    if (/^import\b/.test(line)) throw new Error(`${file}: unsupported import form: ${line}`);
    if ((m = line.match(/^export\s*\{([^}]*)\};?\s*$/))) {
      for (const s of m[1].split(',').map(x => x.trim()).filter(Boolean)) {
        const [local, alias] = s.split(/\s+as\s+/);
        exportsList.push([alias || local, local]);
      }
      return '';
    }
    if ((m = line.match(/^export\s+(?:async\s+)?(?:function\*?|class)\s+([A-Za-z_$][\w$]*)/))) {
      exportsList.push([m[1], m[1]]);
      return line.replace(/^export\s+/, '');
    }
    if ((m = line.match(/^export\s+(const|let|var)\s+(.*)$/))) {
      for (const decl of splitTopLevel(m[2])) {
        const name = decl.match(/^([A-Za-z_$][\w$]*)/);
        if (name) exportsList.push([name[1], name[1]]);
      }
      return line.replace(/^export\s+/, '');
    }
    if (/^export\b/.test(line)) throw new Error(`${file}: unsupported export form: ${line}`);
    return line;
  });
  const body = lines.join('\n');
  const assigns = exportsList.map(([name, local]) => `${modId(file)}.${name} = ${local};`).join(' ');
  return { deps, code: `// ---- ${path.basename(file)}\nconst ${modId(file)} = {};\n(() => {\n${body}\n${assigns}\n})();\n` };
}

// Bundles an entry module and everything it imports, in dependency order.
function bundle(entryFile, patches = {}) {
  const done = new Map(); // file -> code
  const visiting = new Set();
  const visit = file => {
    if (done.has(file)) return;
    if (visiting.has(file)) throw new Error(`import cycle at ${file}`);
    visiting.add(file);
    let code = fs.readFileSync(file, 'utf8');
    for (const [from, to] of Object.entries(patches[path.basename(file)] || {})) {
      if (!code.includes(from)) throw new Error(`${file}: expected to find ${from}`);
      code = code.split(from).join(to);
    }
    const t = transform(file, code);
    for (const d of t.deps) visit(path.resolve(path.dirname(file), d));
    visiting.delete(file);
    done.set(file, t.code);
  };
  visit(entryFile);
  return `'use strict';\n// Built from src/ by tools/build.js. Edit the sources, not this file.\n` + [...done.values()].join('\n');
}

// ------------------------------------------------------------------ zip writer (stored + deflate)

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = buf => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function zip(entries) {
  const parts = [], central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(useDeflate ? 8 : 0, 8); header.writeUInt16LE(dosTime, 10); header.writeUInt16LE(dosDate, 12);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(body.length, 18); header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26); header.writeUInt16LE(0, 28);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x800, 8);
    cd.writeUInt16LE(useDeflate ? 8 : 0, 10); cd.writeUInt16LE(dosTime, 12); cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));
    parts.push(header, nameBuf, body);
    offset += header.length + nameBuf.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

// ------------------------------------------------------------------ build

// Every file the page loads is addressed with a stamp of its contents
// ("app.js?v=3f2a1c9e0b"): a changed file gets a new address, so browsers can't
// mix a cached old file with new ones; an unchanged file keeps its stamp and
// its cached copy. Stamps nest: the worker's stamp covers the network and
// tf.js stamps inside it, app.js covers the workers', the page covers app.js.
const stamp = buf => createHash('sha256').update(buf).digest('hex').slice(0, 10);

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const files = new Map(); // dist name -> Buffer
for (const f of fs.readdirSync(path.join(root, 'vendor'))) files.set(`vendor/${f}`, fs.readFileSync(path.join(root, 'vendor', f)));
for (const f of ['b6c96.bin', 'LICENSE.txt']) files.set(`nets/${f}`, fs.readFileSync(path.join(root, 'nets', f)));
const v = name => `${name.split('/').pop()}?v=${stamp(files.get(name))}`;

// tf.js asks for its WebAssembly files by name; it needs an entry for the threaded one we never use.
const wasm = ['tfjs-backend-wasm.wasm', 'tfjs-backend-wasm-simd.wasm', 'tfjs-backend-wasm-threaded-simd.wasm']
  .map(f => `'${f}': VENDOR + '${files.has(`vendor/${f}`) ? v(`vendor/${f}`) : f}'`).join(', ');
files.set('katago-worker.js', Buffer.from(bundle(path.join(src, 'katago-worker.js'), {
  'katago-worker.js': {
    "new URL('../vendor/', import.meta.url)": "new URL('vendor/', self.location.href)",
    "new URL('../nets/b6c96.bin', import.meta.url)": `new URL('nets/${v('nets/b6c96.bin')}', self.location.href)`,
    "import(VENDOR + 'tf.js')": `import(VENDOR + '${v('vendor/tf.js')}')`,
    'tf.setWasmPaths(VENDOR);': `tf.setWasmPaths({ ${wasm} });`,
  },
})));
files.set('engine-worker.js', Buffer.from(bundle(path.join(src, 'engine-worker.js'))));
// The workers are created by URL; in the bundle they are plain sibling scripts.
files.set('app.js', Buffer.from(bundle(path.join(src, 'app.js'), {
  'engine-client.js': {
    "new Worker(new URL('./engine-worker.js', import.meta.url), { type: 'module' })": `new Worker('${v('engine-worker.js')}')`,
    "new Worker(new URL('./katago-worker.js', import.meta.url), { type: 'module' })": `new Worker('${v('katago-worker.js')}')`,
  },
})));
files.set('style.css', fs.readFileSync(path.join(root, 'style.css')));
for (const f of ['social.png', 'LICENSE', 'THIRD_PARTY_NOTICES.txt']) files.set(f, fs.readFileSync(path.join(root, f)));

let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const swap = (from, to) => {
  if (!html.includes(from)) throw new Error(`index.html: ${from} not found`);
  html = html.replace(from, to);
};
swap('<link rel="stylesheet" href="style.css">', `<link rel="stylesheet" href="${v('style.css')}">`);
// The page's version stamps everything it loads. A page kept in the browser's
// cache (GitHub Pages lets browsers keep files for 10 minutes) can be older than
// the files on the server: it reloads once to get the new page, then starts.
const version = stamp(Buffer.from(html + v('app.js')));
swap('<script type="module" src="src/app.js"></script>', `<meta name="goyomi-version" content="${version}">
<script>
(function () {
  var version = '${version}';
  function start() {
    var s = document.createElement('script');
    s.src = '${v('app.js')}';
    document.head.appendChild(s);
  }
  function startWhenParsed() {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }
  // Decided once: a check that stalls (no answer, or a body that never ends)
  // mustn't keep the game from starting, and a late answer changes nothing.
  var decided = false;
  function go() { if (!decided) { decided = true; startWhenParsed(); } }
  var timer = setTimeout(go, 3000);
  fetch('version.json', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (latest) {
    clearTimeout(timer);
    if (decided) return;
    var tried = null;
    try { tried = sessionStorage.getItem('goyomi-reload'); } catch (e) { /* storage blocked */ }
    if (latest.version !== version && tried !== latest.version) {
      decided = true;
      try { sessionStorage.setItem('goyomi-reload', latest.version); } catch (e) { /* storage blocked */ }
      location.reload();
    } else go();
  }).catch(function () { clearTimeout(timer); go(); });
})();
</script>`);
files.set('index.html', Buffer.from(html));
files.set('version.json', Buffer.from(JSON.stringify({ version }) + '\n'));

for (const [name, data] of files) {
  fs.mkdirSync(path.dirname(path.join(dist, name)), { recursive: true });
  fs.writeFileSync(path.join(dist, name), data);
}
const kb = n => `${(n / 1024).toFixed(1)} KB`;
for (const [name, data] of files) console.log(`  ${name.padEnd(36)} ${kb(data.length)}`);
if (!noZip) {
  fs.writeFileSync(path.join(dist, 'goyomi.zip'), zip([...files]));
  console.log(`  ${'goyomi.zip'.padEnd(36)} ${kb(fs.statSync(path.join(dist, 'goyomi.zip')).size)}`);
}
console.log(`Built ${path.relative(root, dist) || dist} (${files.size} files${noZip ? '' : ' + zip'}), version ${version}`);
