// Little sound effects, synthesised with Web Audio: nothing to download, works offline.
let ctx = null;
let enabled = true;

export function setSoundsEnabled(on) {
  enabled = !!on;
}

function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  // Phones start audio suspended until a tap; every call here comes from one
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function noise(c, seconds) {
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * seconds), c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

/** One burst of filtered noise with a quick rise and fall. */
function rustle(c, out, t, { dur, from, to, q = 0.9, peak, type = 'bandpass' }) {
  const src = c.createBufferSource();
  src.buffer = noise(c, dur + 0.05);
  const filter = c.createBiquadFilter();
  filter.type = type;
  filter.Q.value = q;
  filter.frequency.setValueAtTime(from, t);
  filter.frequency.exponentialRampToValueAtTime(to, t + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + dur * 0.3);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(filter).connect(g).connect(out);
  src.start(t);
  src.stop(t + dur + 0.05);
}

/** A soft bell-like note: a sine plus a fainter octave that fades sooner. */
function bell(c, out, t, freq, { peak = 0.22, decay = 0.5 } = {}) {
  for (const [mult, level, d] of [[1, 1, decay], [2, 0.28, decay * 0.45], [3, 0.08, decay * 0.25]]) {
    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq * mult;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak * level, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + d + 0.02);
  }
}

/** Page turning: the page lifts (rising swish), flips, and settles (soft papery tap). */
export function pageTurn(c = audio(), out = c?.destination, t = c?.currentTime) {
  if (!c) return;
  const master = c.createGain();
  master.gain.value = 1.9; // noise reads quieter than tones at the same level
  master.connect(out);
  rustle(c, master, t, { dur: 0.17, from: 700, to: 3800, q: 0.7, peak: 0.32 });
  rustle(c, master, t + 0.13, { dur: 0.09, from: 4200, to: 2200, q: 1.1, peak: 0.2 });
  rustle(c, master, t + 0.19, { dur: 0.05, from: 380, to: 160, q: 0.7, peak: 0.28, type: 'lowpass' });
}

const NOTES = { G4: 392.0, D5: 587.33, G5: 783.99, C6: 1046.5, E6: 1318.51 };

/** 1 Again, 2 Hard, 3 Good, 4 Easy */
export function rated(rating, c = audio(), out = c?.destination, t = c?.currentTime) {
  if (!c) return;
  if (rating === 1) bell(c, out, t, NOTES.G4, { peak: 0.13, decay: 0.28 });
  else if (rating === 2) bell(c, out, t, NOTES.D5, { peak: 0.15, decay: 0.35 });
  else if (rating === 3) {
    bell(c, out, t, NOTES.G5, { peak: 0.17, decay: 0.4 });
    bell(c, out, t + 0.075, NOTES.C6, { peak: 0.17, decay: 0.55 });
  } else {
    bell(c, out, t, NOTES.G5, { peak: 0.15, decay: 0.35 });
    bell(c, out, t + 0.06, NOTES.C6, { peak: 0.15, decay: 0.4 });
    bell(c, out, t + 0.12, NOTES.E6, { peak: 0.15, decay: 0.6 });
  }
}

export function playPageTurn() {
  if (enabled) pageTurn();
}
export function playRated(rating) {
  if (enabled) rated(rating);
}
