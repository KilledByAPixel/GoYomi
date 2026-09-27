import { test } from 'node:test';
import assert from 'node:assert/strict';

// Stub speech: records what would be spoken.
const spoken = [];
globalThis.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
globalThis.speechSynthesis = { speaking: true, pending: false, speak(u) { spoken.push(u); }, cancel() { spoken.length = 0; } };
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

test('announcements made together are all read (batched, not overwritten)', async () => {
  const region = { textContent: '' };
  initAnnouncer(region);
  announce('You played D4.');
  announce('Coach: Good move.');
  await tick();
  assert.equal(region.textContent, 'You played D4. Coach: Good move.');
});

test('speech: off by default; one utterance at a time; cursor readouts never pile up', () => {
  assert.equal(speechAvailable(), true);
  spoken.length = 0;
  announce('You played D4.');
  assert.equal(spoken.length, 0, 'speech is off');
  setSpeech(true);
  const texts = () => spoken.map(u => u.text);
  announce('D4, empty', { cursor: true });
  announce('D5, empty', { cursor: true });
  assert.deepEqual(texts(), ['D5, empty'], 'a cursor readout replaces the one being spoken');
  announce('AI played F5.');
  assert.deepEqual(texts(), ['D5, empty'], 'others wait their turn');
  announce('E5, empty', { cursor: true });
  assert.deepEqual(texts(), ['AI played F5.'], 'the spoken cursor readout gives way; the announcement starts');
  announce('F5, empty', { cursor: true });
  announce('G5, empty', { cursor: true });
  spoken.at(-1).onend();
  assert.deepEqual(texts(), ['AI played F5.', 'G5, empty'], 'only the latest waiting cursor readout is spoken');
  // A lost onend (some browsers) must not jam the queue.
  speechSynthesis.speaking = false;
  announce('H5, empty', { cursor: true });
  assert.equal(texts().at(-1), 'H5, empty');
  speechSynthesis.speaking = true;
  // R repeats the last announcement that wasn't a cursor readout.
  spoken.at(-1).onend();
  repeatLast();
  assert.equal(texts().at(-1), 'AI played F5.');
  setSpeech(false);
});
