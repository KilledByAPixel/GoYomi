import { test } from 'node:test';
import assert from 'node:assert/strict';

// Stub speech: records what would be spoken.
const spoken = [];
globalThis.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
globalThis.speechSynthesis = { speak(u) { spoken.push(u); }, cancel() { spoken.length = 0; } };
const { initAnnouncer, announce, setSpeech, repeatLast, speechAvailable } = await import('../src/announce.js');
const tick = () => new Promise(r => setTimeout(r, 50));

test('announce updates the live region, clearing it first so repeats are read', async () => {
  const region = { textContent: '' };
  initAnnouncer(region);
  announce('D4, empty');
  assert.equal(region.textContent, '');
  await tick();
  assert.equal(region.textContent, 'D4, empty');
  announce('D4, empty');
  assert.equal(region.textContent, '', 'cleared again');
  await tick();
  assert.equal(region.textContent, 'D4, empty');
});

test('speech: off by default; cursor readouts replace waiting ones; others queue', () => {
  assert.equal(speechAvailable(), true);
  spoken.length = 0;
  announce('You played D4.');
  assert.equal(spoken.length, 0, 'speech is off');
  setSpeech(true);
  announce('D4, empty', { cursor: true });
  announce('D5, empty', { cursor: true });
  assert.deepEqual(spoken.map(u => u.text), ['D5, empty']);
  announce('AI played F5.');
  announce('E5, empty', { cursor: true });
  assert.deepEqual(spoken.map(u => u.text), ['D5, empty', 'AI played F5.', 'E5, empty'], 'a queued announcement is never dropped');
  spoken.length = 0;
  repeatLast();
  assert.deepEqual(spoken.map(u => u.text), ['AI played F5.'], 'R repeats the last non-cursor announcement');
  setSpeech(false);
});
