// Sound effects, synthesised with ZzFX (src/zzfx.js). No audio files.
//
// Every effect is one entry in SOUNDS below. To tweak one, design it at
// https://killedbyapixel.github.io/ZzFX/ and paste the array here. You can also
// live-edit from the console:  dojo.sounds.stone = [...]; dojo.play('stone')
import { ZZFX, ZZFXSound } from './zzfx.js';

export const SOUNDS = {
  // A stone placed on the board: short woody click.
  stone:   [,.2,,,,.03,4,1.4,,,,,,,,,,,,,3e3],
  // One captured stone rattling off the board; played once per stone, staggered.
  capture: [.7,.3,2800,,.01,.01,4,1.5,,,,,,,,,,.6,,,5e3],
  // Someone passed: soft low tone.
  pass:    [,,440,,.05,,,,,,440,.05,,,,,.1],
  // Illegal move (ko, suicide, occupied): short dull buzz.
  illegal: [.8,.3,340,.01,,.02,,.8,-10,,,,,1,,,,.5,.02],
  // Take back: quick falling blip.
  undo:    [.5,,660,,,,1,,20],
  // Game over, you won: rising three-note chime.
  win:     [,,,.01,,.9,,2,,-40,40,,.1],
  // Game over, you lost (or a draw): gentle falling tone.
  lose:    [,,520,.01,,.9,,2,,40,-40,,.1],
};

// Delay between rattles when several stones are captured at once.
const CAPTURE_STAGGER_MS = 45;
const CAPTURE_MAX = 6;

let enabled = true;
export function setSoundEnabled(on) { enabled = !!on; }

// Browsers only let audio start after a user gesture. If the AI moves first,
// the context is still suspended: skip that sound rather than queue it.
function ready() {
  if (!enabled) return false;
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return false;
  const ctx = ZZFX.audioContext;
  if (ctx.state === 'suspended') ctx.resume();
  return true;
}

// Samples are synthesised once per effect and cached; ZZFXSound applies the
// randomness parameter as a small playback-rate wobble at play time. Replacing
// an array in SOUNDS (e.g. from the console) rebuilds that effect on next play.
const cache = new Map(); // name -> { params, sound }
function cached(name) {
  const params = SOUNDS[name];
  if (!params) return null;
  let entry = cache.get(name);
  if (!entry || entry.params !== params) {
    entry = { params, sound: new ZZFXSound([...params]) }; // copy: the constructor zeroes randomness in the array it gets
    cache.set(name, entry);
  }
  return entry.sound;
}

// Play a named effect from SOUNDS.
export function playSound(name) {
  const sound = cached(name);
  if (!sound || !ready()) return;
  try { sound.play(); } catch { /* audio unavailable */ }
}

// A stone goes down; captured stones rattle off after it.
export function stoneSound(captures = 0) {
  playSound('stone');
  for (let i = 0; i < Math.min(captures, CAPTURE_MAX); i++) {
    setTimeout(() => playSound('capture'), 120 + i * CAPTURE_STAGGER_MS);
  }
}
