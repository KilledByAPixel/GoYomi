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

// The nicest voice for the page's language: "Natural"/neural voices (Edge) and
// Chrome's Google voices sound far better than the default system voice.
// Returns null when no voice speaks the language (the browser default stays).
export function pickVoice(voices, lang = 'en') {
  const want = lang.toLowerCase(), base = want.split('-')[0];
  const score = v => {
    const l = (v.lang || '').toLowerCase().replace('_', '-');
    if (l.split('-')[0] !== base) return -1;
    return (l === want ? 2 : 1) + (/natural|neural/i.test(v.name) ? 8 : 0) + (/google/i.test(v.name) ? 4 : 0)
      + (/online|enhanced|premium/i.test(v.name) ? 2 : 0) + (v.default ? 1 : 0);
  };
  let best = null, top = -1;
  for (const v of voices) { const s = score(v); if (s > top) { best = v; top = s; } }
  return best;
}

let voice; // undefined until the browser has listed its voices
function bestVoice() {
  if (voice === undefined) {
    const list = speechSynthesis.getVoices ? speechSynthesis.getVoices() : [];
    if (!list.length) return null; // still loading: try again next time
    voice = pickVoice(list, (typeof navigator !== 'undefined' && navigator.language) || 'en');
  }
  return voice;
}
if (speechAvailable() && speechSynthesis.addEventListener) speechSynthesis.addEventListener('voiceschanged', () => { voice = undefined; });

// Hands the synthesiser one utterance at a time, so the queue stays ours to edit.
function next() {
  if (current || !queue.length) return;
  const item = current = queue.shift();
  const utt = new SpeechSynthesisUtterance(item.text);
  const v = bestVoice();
  if (v) { utt.voice = v; utt.lang = v.lang; }
  utt.onend = utt.onerror = () => { if (current === item) { current = null; next(); } };
  speechSynthesis.speak(utt);
}

// The navigation buttons' symbols, in words: a voice reads ▶ as "black right-pointing triangle".
const SYMBOLS = [[/◀\s*▶/g, 'the back and forward buttons'], [/◀/g, 'the back button'], [/▶/g, 'the forward button'],
  [/⏮/g, 'the start button'], [/⏭/g, 'the latest button']];
export const sayable = text => SYMBOLS.reduce((t, [re, w]) => t.replace(re, w), text);

// Stops whatever is being said and drops what's waiting: the player moved, so it's old news.
export function hush() {
  if (!speaking) return;
  queue = []; current = null;
  speechSynthesis.cancel();
}

export function speak(text, cursor = false) {
  if (!speaking || !text) return;
  text = sayable(text);
  // Some browsers lose onend: an idle synthesiser means nothing is really being spoken.
  if (current && !speechSynthesis.speaking && !speechSynthesis.pending) current = null;
  if (cursor) {
    // A new cursor readout replaces older ones, waiting or being spoken; other announcements keep their place.
    queue = queue.filter(x => !x.cursor);
    if (current && current.cursor) { current = null; speechSynthesis.cancel(); }
  }
  // A sentence at a time: Chrome's network voices stop after ~15 s of one utterance.
  for (const s of text.split(/(?<=[.!?])\s+/)) if (s) queue.push({ text: s, cursor });
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
