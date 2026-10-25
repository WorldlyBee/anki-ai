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

/**
 * One breath of filtered noise. The extra lowpass takes off the fizzy top end (what makes noise
 * sound like a maraca), and the smooth curves keep it free of hard edges.
 */
function rustle(c, out, t, { dur, from, to, q = 0.5, peak, attack = 0.35, lowpass = 2600 }) {
  const src = c.createBufferSource();
  src.buffer = noise(c, dur + 0.1);
  const band = c.createBiquadFilter();
  band.type = 'bandpass';
  band.Q.value = q;
  band.frequency.setValueAtTime(from, t);
  band.frequency.exponentialRampToValueAtTime(to, t + dur);
  const soft = c.createBiquadFilter();
  soft.type = 'lowpass';
  soft.frequency.value = lowpass;
  const g = c.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.setTargetAtTime(peak, t, dur * attack * 0.45); // gentle swell
  g.gain.setTargetAtTime(0, t + dur * attack, dur * 0.22); // long, soft fade
  src.connect(band).connect(soft).connect(g).connect(out);
  src.start(t);
  src.stop(t + dur + 0.1);
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

/** A slow, soft page turn: the page lifts with a gentle swell, then settles with a longer, darker sigh. */
export function pageTurn(c = audio(), out = c?.destination, t = c?.currentTime) {
  if (!c) return;
  const master = c.createGain();
  master.gain.value = 0.6;
  master.connect(out);
  rustle(c, master, t, { dur: 0.38, from: 450, to: 1900, peak: 0.6, attack: 0.5 });
  rustle(c, master, t + 0.3, { dur: 0.4, from: 1400, to: 550, peak: 0.24, attack: 0.2, lowpass: 1800 });
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

/** Finished a deck: a gentle rising fanfare. */
export function complete(c = audio(), out = c?.destination, t = c?.currentTime) {
  if (!c) return;
  [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => bell(c, out, t + i * 0.1, f, { peak: 0.13, decay: i === 3 ? 1.1 : 0.45 }));
}

export function playComplete() {
  if (enabled) complete();
}
export function playPageTurn() {
  if (enabled) pageTurn();
}
export function playRated(rating) {
  if (enabled) rated(rating);
}
