// Sound effects, synthesised with ZzFX (src/zzfx.js). No audio files.
//
// Every effect is one entry in SOUNDS below. To tweak one, design it at
// https://killedbyapixel.github.io/ZzFX/ and paste the array here. You can also
// live-edit from the console:  dojo.sounds.stone = [...]; dojo.play('stone')
import { zzfx, ZZFX } from './zzfx.js';

export const SOUNDS = {
  // A stone placed on the board: short woody click.
  stone:   [1.2, .1, 1900, , .01, .04, 4, 1.4, , , , , , , , , , .7, .01, , 3000],
  // One captured stone rattling off the board; played once per stone, staggered.
  capture: [.6, .3, 2800, , .005, .03, 4, 1.5, , , , , , , , , , .6, .01, , 4000],
  // Someone passed: soft low tone.
  pass:    [.5, , 330, .01, .06, .12, 0, 1.2, , , , , , , , , , .7, .04],
  // Illegal move (ko, suicide, occupied): short dull buzz.
  illegal: [.4, , 140, , .04, .08, 2, 1.5, , , , , , , , , , .6, .02],
  // Take back: quick falling blip.
  undo:    [.4, , 520, , .03, .08, 1, 1.2, -6],
  // Game over, you won: rising three-note chime.
  win:     [.6, , 440, .02, .12, .3, 0, 1.6, , , 200, .1, .12],
  // Game over, you lost (or a draw): gentle falling tone.
  lose:    [.5, , 330, .02, .15, .35, 0, 1.5, -2, , , , , , , , , .8, .1],
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

// Play a named effect from SOUNDS.
export function playSound(name) {
  const params = SOUNDS[name];
  if (!params || !ready()) return;
  try { zzfx(...params); } catch { /* audio unavailable */ }
}

// A stone goes down; captured stones rattle off after it.
export function stoneSound(captures = 0) {
  playSound('stone');
  for (let i = 0; i < Math.min(captures, CAPTURE_MAX); i++) {
    setTimeout(() => playSound('capture'), 120 + i * CAPTURE_STAGGER_MS);
  }
}
