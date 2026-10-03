// What the build may clear. tools/build.js empties its output directory before
// writing, so the directory must be one it is safe to empty: never the
// repository, anything above it, a filesystem root, or a directory the build
// (or the project) reads from; and, when it is not the repository's own
// dist/, only a directory that is empty or was made by this build (it holds
// the marker file every build writes). From the Backgammon app's build.
import fs from 'node:fs';
import path from 'node:path';

export const MARKER = '.goyomi-build';
// Under the repository: what the build reads, and what must never be lost.
export const INPUT_DIRS = ['src', 'tools', 'test', 'vendor', 'nets', 'docs', '.git', '.github', 'local', 'node_modules'];

// A path as the filesystem has it (links followed), also when its last parts
// don't exist yet.
function real(p) {
  let head = path.resolve(p);
  const tail = [];
  while (!fs.existsSync(head)) {
    const up = path.dirname(head);
    if (up === head) break;
    tail.unshift(path.basename(head));
    head = up;
  }
  try { head = fs.realpathSync.native(head); } catch { /* as written */ }
  return path.join(head, ...tail);
}

// a is b, or inside it (ignoring case on Windows).
const within = (a, b) => {
  const win = process.platform === 'win32';
  const rel = path.relative(win ? b.toLowerCase() : b, win ? a.toLowerCase() : a);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// Why the build mustn't use `out` as its output directory (a sentence), or
// null when it may. root: the repository.
export function outputRefusal(root, out) {
  const r = real(root), o = real(out);
  if (path.parse(o).root === o) return 'it is the root of a drive';
  if (within(o, r) && within(r, o)) return 'it is the repository itself';
  if (within(r, o)) return 'the repository is inside it';
  for (const d of INPUT_DIRS) if (within(o, path.join(r, d))) return `it is in ${d}/, which is not the build's to clear`;
  if (within(o, path.join(r, 'dist')) && within(path.join(r, 'dist'), o)) return null; // dist/ is the build's own
  let stat;
  try { stat = fs.statSync(o); } catch { return null; } // not there yet: it will be made
  if (!stat.isDirectory()) return 'it is not a directory';
  const held = fs.readdirSync(o);
  if (held.length && !held.includes(MARKER)) return `it holds other files (an output directory must be empty, or one this build made: it has a ${MARKER} file)`;
  return null;
}
