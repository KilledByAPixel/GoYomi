// Synthesised stone sounds (no audio files): a wooden click, plus a rattle of
// pebbles when stones are captured.
let ctx = null;

function audio() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function click(a, t, gain, freq) {
  const len = Math.floor(a.sampleRate * 0.05);
  const buf = a.createBuffer(1, len, a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 6);
  const src = a.createBufferSource();
  src.buffer = buf;
  const bp = a.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = 1.4;
  const g = a.createGain();
  g.gain.value = gain;
  src.connect(bp).connect(g).connect(a.destination);
  src.start(t);

  const osc = a.createOscillator();
  osc.frequency.setValueAtTime(260, t);
  osc.frequency.exponentialRampToValueAtTime(110, t + 0.05);
  const og = a.createGain();
  og.gain.setValueAtTime(gain * 0.35, t);
  og.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
  osc.connect(og).connect(a.destination);
  osc.start(t); osc.stop(t + 0.1);
}

export function stoneSound(captures = 0) {
  try {
    const a = audio(), t = a.currentTime + 0.005;
    click(a, t, 0.9, 1900);
    for (let i = 0; i < Math.min(captures, 6); i++) click(a, t + 0.12 + i * 0.05 + Math.random() * 0.02, 0.35, 2600 + Math.random() * 900);
  } catch { /* audio unavailable */ }
}
