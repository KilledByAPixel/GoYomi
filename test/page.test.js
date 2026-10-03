// The page (index.html) against the code that drives it: every element id the
// code looks up exists, and no id is used twice. A renamed or deleted element
// fails here, in node, instead of as a null in the browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const code = readdirSync(new URL('../src/', import.meta.url)).filter(f => f.endsWith('.js'))
  .map(f => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')).join('\n');
const pageIds = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);

test('page: every id the code looks up is in the page', () => {
  const used = new Set();
  // $('#id …'), querySelector('#id …'), getElementById('id'): literal ids only.
  for (const m of code.matchAll(/(?:\$|querySelector(?:All)?)\(\s*['"`]#([\w-]+)/g)) used.add(m[1]);
  for (const m of code.matchAll(/getElementById\(\s*['"`]([\w-]+)['"`]/g)) used.add(m[1]);
  assert.ok(used.size > 30, `only ${used.size} ids found: has the pattern stopped matching?`);
  const missing = [...used].filter(id => !pageIds.includes(id));
  assert.deepEqual(missing, [], 'looked up but not in index.html');
});

test('page: no id is used twice', () => {
  const twice = pageIds.filter((id, i) => pageIds.indexOf(id) !== i);
  assert.deepEqual(twice, []);
});
