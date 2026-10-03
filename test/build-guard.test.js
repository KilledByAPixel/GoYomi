// The build's delete guard (tools/build-guard.js): the build empties its
// output directory, so it refuses one that isn't its own to clear. Checked on a
// throwaway repository in a temporary folder, and the real build is only ever
// pointed at temporary folders: a guard that failed would delete test files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { outputRefusal, MARKER, INPUT_DIRS } from '../tools/build-guard.js';

const temps = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'goyomi-guard-')); temps.push(d); return d; };
process.on('exit', () => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

// A pretend repository: <tmp>/parent/repo with the input directories in it.
function fakeRepo() {
  const parent = join(temp(), 'parent'), repo = join(parent, 'repo');
  for (const d of INPUT_DIRS) mkdirSync(join(repo, d), { recursive: true });
  writeFileSync(join(repo, 'index.html'), '');
  return { parent, repo };
}

test('build guard: the repository, anything above it, a drive root and the input directories are refused', () => {
  const { parent, repo } = fakeRepo();
  assert.match(outputRefusal(repo, repo), /repository itself/);
  assert.match(outputRefusal(repo, parent), /repository is inside it/);
  assert.match(outputRefusal(repo, parse(repo).root), /root of a drive/);
  for (const d of INPUT_DIRS) assert.equal(outputRefusal(repo, join(repo, d)), `it is in ${d}/, which is not the build's to clear`, d);
  assert.match(outputRefusal(repo, join(repo, 'src', 'built')), /in src\//, 'inside an input directory too');
});

test('build guard: a file, or a folder holding other files, is refused; empty, new, marked and dist/ are fine', () => {
  const { repo } = fakeRepo();
  const file = join(repo, 'notes.txt');
  writeFileSync(file, 'mine');
  assert.match(outputRefusal(repo, file), /not a directory/);
  const other = join(temp(), 'other');
  mkdirSync(other);
  writeFileSync(join(other, 'keep.txt'), 'mine');
  assert.match(outputRefusal(repo, other), /holds other files/);
  const empty = temp();
  assert.equal(outputRefusal(repo, empty), null, 'empty');
  assert.equal(outputRefusal(repo, join(temp(), 'new')), null, 'not there yet');
  const marked = temp();
  writeFileSync(join(marked, MARKER), '');
  writeFileSync(join(marked, 'app.js'), '');
  assert.equal(outputRefusal(repo, marked), null, 'made by the build');
  mkdirSync(join(repo, 'dist'));
  writeFileSync(join(repo, 'dist', 'old.js'), '');
  assert.equal(outputRefusal(repo, join(repo, 'dist')), null, 'dist/ is always the build\'s, marker or not');
});

test('build: a folder holding someone else\'s file is refused, with a plain message, and left alone', () => {
  const out = temp();
  writeFileSync(join(out, 'keep.txt'), 'mine');
  const r = spawnSync(process.execPath, ['tools/build.js', '--out', out, '--no-zip'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^Not building into .*: it holds other files/);
  assert.doesNotMatch(r.stderr, /at .*\.js:\d+/, 'no stack trace');
  assert.equal(readFileSync(join(out, 'keep.txt'), 'utf8'), 'mine');
});

test('build: its output gets the marker, so building there again is allowed', () => {
  const out = join(temp(), 'site');
  const build = () => spawnSync(process.execPath, ['tools/build.js', '--out', out, '--no-zip'], { encoding: 'utf8' });
  assert.equal(build().status, 0);
  assert.ok(existsSync(join(out, MARKER)));
  assert.equal(build().status, 0, 'a second build into the same folder');
  assert.ok(existsSync(join(out, 'index.html')));
});
