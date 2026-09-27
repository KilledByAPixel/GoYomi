// Announcements for screen readers (a polite live region, silent for everyone
// else) and, when the player turns it on, the browser's own speech.
let region = null, speaking = false, lastText = '';
let pending = []; // utterances queued or being spoken: { utt, cursor }

export const speechAvailable = () => typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';

export function initAnnouncer(el) { region = el; }

export function setSpeech(on) {
  speaking = !!on && speechAvailable();
  if (!speaking && speechAvailable()) { speechSynthesis.cancel(); pending = []; }
}

export function speak(text, cursor = false) {
  if (!speaking || !text) return;
  // A new cursor readout replaces cursor readouts still waiting; anything else queues.
  if (cursor && pending.length && pending.every(x => x.cursor)) { speechSynthesis.cancel(); pending = []; }
  const utt = new SpeechSynthesisUtterance(text), entry = { utt, cursor };
  utt.onend = utt.onerror = () => { pending = pending.filter(x => x !== entry); };
  pending.push(entry);
  speechSynthesis.speak(utt);
}

export function announce(text, { cursor = false } = {}) {
  if (!text) return;
  if (!cursor) lastText = text;
  if (region) {
    // Clear first so the same words are read again.
    region.textContent = '';
    setTimeout(() => { region.textContent = text; }, 30);
  }
  speak(text, cursor);
}

export function repeatLast() { if (lastText) announce(lastText); }
