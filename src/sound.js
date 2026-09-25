// Sound effects, synthesised with ZzFX (src/zzfx.js). No audio files.
//
// Each effect is a ZZFXSound, built once here at startup and played directly.
// To tweak one, design it at https://killedbyapixel.github.io/ZzFX/ and paste
// the array in. From the console: dojo.sounds.stone = new dojo.ZZFXSound([...])
import { ZZFX, ZZFXSound } from './zzfx.js';

export const SOUNDS = {
  // A stone placed on the board: short woody click.
  stone:   new ZZFXSound([,.2,,,,.03,4,1.4,,,,,,,,,,,,,3e3]),
  // One captured stone rattling off the board; played once per stone, staggered.
  capture: new ZZFXSound([.7,.3,2800,,.01,.01,4,1.5,,,,,,,,,,.6,,,5e3]),
  // Someone passed: soft low tone.
  pass:    new ZZFXSound([,,440,,.05,,,,,,440,.05,,,,,.1]),
  // Illegal move (ko, suicide, occupied): short dull buzz.
  illegal: new ZZFXSound([.8,.3,340,.01,,.02,,.8,-10,,,,,1,,,,.5,.02]),
  // Take back: quick falling blip.
  undo:    new ZZFXSound([.5,,660,,,,1,,20]),
  // Game over, you won: rising three-note chime.
  win:     new ZZFXSound([,,,.01,,.9,,2,,-40,40,,.1]),
  // Game over, you lost (or a draw): gentle falling tone.
  lose:    new ZZFXSound([,,520,.01,,.9,,2,,40,-40,,.1]),
};

// Delay between rattles when several stones are captured at once.
const CAPTURE_STAGGER_MS = 45;
const CAPTURE_MAX = 6;
// The opponent's stones play slightly lower so you can hear whose move it was.
const OPPONENT_PITCH = 1.2;

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

// Play a named effect from SOUNDS, optionally pitch-shifted (1 = as designed).
export function playSound(name, pitch = 1) {
  const sound = SOUNDS[name];
  if (!sound || !ready()) return;
  try { sound.play(1, pitch); } catch { /* audio unavailable */ }
}

// A stone goes down; captured stones rattle off after it.
export function stoneSound(captures = 0, opponent = false) {
  const pitch = opponent ? OPPONENT_PITCH : 1;
  playSound('stone', pitch);
  for (let i = 0; i < Math.min(captures, CAPTURE_MAX); i++) {
    setTimeout(() => playSound('capture', pitch), 120 + i * CAPTURE_STAGGER_MS);
  }
}

export { ZZFXSound };
