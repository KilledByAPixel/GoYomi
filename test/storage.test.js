// The page's storage (src/storage.js): the browser's when it can be had, a
// stand-in in memory when not, and whether what's written will still be there
// after a reload (durable).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeStorage } from '../src/storage.js';

// A browser storage that can be told to refuse writes.
const fakeStorage = () => {
  const m = new Map();
  return {
    full: false,
    getItem: k => m.has(k) ? m.get(k) : null,
    setItem(k, v) { if (this.full) throw new Error('QuotaExceededError'); m.set(k, String(v)); },
    removeItem: k => { m.delete(k); },
  };
};

test('storage: a working browser storage is used, and durable', () => {
  const real = fakeStorage();
  const s = safeStorage(() => real);
  assert.equal(s.durable, true);
  s.setItem('a', '1');
  assert.equal(real.getItem('a'), '1');
  assert.equal(real.getItem('goYomi.probe'), null, 'the probe leaves nothing behind');
});

test('storage: one that can\'t be had at all is kept in memory, never durable, and never throws', () => {
  const s = safeStorage(() => { throw new Error('SecurityError'); });
  assert.equal(s.durable, false);
  s.setItem('a', '1');
  assert.equal(s.getItem('a'), '1');
  s.removeItem('a');
  assert.equal(s.getItem('a'), null);
  assert.equal(s.durable, false);
});

test('storage: one that reads but refuses writes is still read, and not durable', () => {
  const real = fakeStorage();
  real.setItem('game', 'saved before');
  real.full = true;
  const s = safeStorage(() => real);
  assert.equal(s.durable, false, 'the probe write failed');
  assert.equal(s.getItem('game'), 'saved before');
  assert.throws(() => s.setItem('game', 'new'), 'the caller still sees a failed write');
});

test('storage: durable follows the last write', () => {
  const real = fakeStorage();
  const s = safeStorage(() => real);
  real.full = true;
  assert.throws(() => s.setItem('a', '1'));
  assert.equal(s.durable, false);
  real.full = false;
  s.setItem('a', '1');
  assert.equal(s.durable, true);
});
