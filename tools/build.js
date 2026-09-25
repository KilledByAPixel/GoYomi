// Builds a self-contained copy of the game into dist/ for static hosts such as
// itch.io:  node tools/build.js
//
// No dependencies. The ES modules in src/ are inlined into two classic scripts
// (app.js for the page, engine-worker.js for the search worker), so the result
// does not rely on module workers. dist/goyomi.zip is ready to upload.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, 'src');
const dist = path.join(root, 'dist');

// ------------------------------------------------------------------ module inliner

const modId = file => '__' + path.basename(file, '.js').replace(/[^\w$]/g, '_');

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
      return `const { ${names.join(', ')} } = ${modId(m[2])};`;
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

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist);

const files = new Map(); // dist name -> Buffer

// The worker is created by URL; in the bundle it is a plain sibling script.
files.set('app.js', Buffer.from(bundle(path.join(src, 'app.js'), {
  'engine-client.js': { "new Worker(new URL('./engine-worker.js', import.meta.url), { type: 'module' })": "new Worker('engine-worker.js')" },
})));
files.set('engine-worker.js', Buffer.from(bundle(path.join(src, 'engine-worker.js'))));

let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const tag = '<script type="module" src="src/app.js"></script>';
if (!html.includes(tag)) throw new Error('index.html: script tag not found');
html = html.replace(tag, '<script defer src="app.js"></script>');
files.set('index.html', Buffer.from(html));
files.set('style.css', fs.readFileSync(path.join(root, 'style.css')));
files.set('LICENSE', fs.readFileSync(path.join(root, 'LICENSE')));

for (const [name, data] of files) fs.writeFileSync(path.join(dist, name), data);
fs.writeFileSync(path.join(dist, 'goyomi.zip'), zip([...files]));

const kb = n => `${(n / 1024).toFixed(1)} KB`;
for (const [name, data] of files) console.log(`  ${name.padEnd(18)} ${kb(data.length)}`);
console.log(`  goyomi.zip         ${kb(fs.statSync(path.join(dist, 'goyomi.zip')).size)}`);
console.log(`Built dist/ (${files.size} files + zip)`);
