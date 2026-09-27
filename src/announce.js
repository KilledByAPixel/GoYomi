// Announcements for screen readers (a polite live region, silent for everyone
// else) and, when the player turns it on, the browser's own speech.
let region = null, speaking = false, lastText = '';
let batch = null;               // texts announced in the same moment, read together
let queue = [], current = null; // speech: items waiting, and the one being spoken ({ text, cursor })

export const speechAvailable = () => typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';

export function initAnnouncer(el) { region = el; }

export function setSpeech(on) {
  speaking = !!on && speechAvailable();
  if (!speaking && speechAvailable()) { speechSynthesis.cancel(); queue = []; current = null; }
}

// Hands the synthesiser one utterance at a time, so the queue stays ours to edit.
function next() {
  if (current || !queue.length) return;
  const item = current = queue.shift();
  const utt = new SpeechSynthesisUtterance(item.text);
  utt.onend = utt.onerror = () => { if (current === item) { current = null; next(); } };
  speechSynthesis.speak(utt);
}

export function speak(text, cursor = false) {
  if (!speaking || !text) return;
  // Some browsers lose onend: an idle synthesiser means nothing is really being spoken.
  if (current && !speechSynthesis.speaking && !speechSynthesis.pending) current = null;
  if (cursor) {
    // A new cursor readout replaces older ones, waiting or being spoken; other announcements keep their place.
    queue = queue.filter(x => !x.cursor);
    if (current && current.cursor) { current = null; speechSynthesis.cancel(); }
  }
  queue.push({ text, cursor });
  next();
}

export function announce(text, { cursor = false } = {}) {
  if (!text) return;
  if (!cursor) lastText = text;
  if (region) {
    // Clear first so the same words are read again; things said together are read together.
    if (batch) batch.push(text);
    else {
      batch = [text];
      region.textContent = '';
      setTimeout(() => { region.textContent = batch.join(' '); batch = null; }, 30);
    }
  }
  speak(text, cursor);
}

export function repeatLast() { if (lastText) announce(lastText); }
