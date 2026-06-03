// Procedural Web Audio "synths". Each builds a tiny node graph that plays a short
// sound, so the whole game is audible with ZERO asset files (the same philosophy as
// the capsule/knight placeholder). Drop real samples into public/audio/ and list
// them in public/audio/manifest.json to override any of these per-key.

export type SfxKey =
  | "hit" // you land a blow on a character
  | "body_hit" // a character body receives damage
  | "hurt" // the local player takes damage
  | "footstep" // a footfall while running
  | "throw" // a banana/stone leaves the hand (whoosh)
  | "land" // a thrown banana hits the ground
  | "stone" // stone-on-stone: mining a rock / a stone landing
  | "chop" // axe into a tree
  | "tree_chop" // a tree receives chop damage
  | "death" // a character drops dead
  | "click" // a UI button press
  | "levelup" // a player levels up
  | "pickup" // an item is collected
  | "heal" // HP restored
  | "berserker" // the local player drinks a berserker potion
  | "splash_roar" // splash-screen gorilla launch roar
  | "gorilla_attack"; // a player gorilla starts an attack animation

export interface SynthOpts {
  rate?: number; // frequency multiplier (pitch variation), default 1
}

/** Builds a sound into `out` starting at `t0`; returns its rough duration (seconds). */
export type SynthFn = (
  ctx: AudioContext,
  out: AudioNode,
  t0: number,
  opt: SynthOpts,
) => number;

const EPS = 0.0001; // exponential ramps can't hit 0

let noiseBuf: AudioBuffer | null = null;
/** 1s of white noise, generated once and reused by every noise-based sound. */
function noise(ctx: AudioContext): AudioBuffer {
  if (noiseBuf && noiseBuf.sampleRate === ctx.sampleRate) return noiseBuf;
  const len = Math.floor(ctx.sampleRate);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
  noiseBuf = buf;
  return buf;
}

/** A pitched oscillator with an attack/decay envelope (and an optional pitch glide). */
function tone(
  ctx: AudioContext,
  out: AudioNode,
  t0: number,
  type: OscillatorType,
  f0: number,
  f1: number,
  dur: number,
  peak: number,
  attack = 0.005,
) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(Math.max(1, f0), t0);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(EPS, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
  g.gain.exponentialRampToValueAtTime(EPS, t0 + dur);
  o.connect(g).connect(out);
  o.start(t0);
  o.stop(t0 + dur + 0.03);
}

/** A filtered noise burst with an attack/decay envelope (and an optional filter sweep). */
function noiseBurst(
  ctx: AudioContext,
  out: AudioNode,
  t0: number,
  filter: BiquadFilterType,
  c0: number,
  c1: number,
  dur: number,
  peak: number,
  q = 1,
) {
  const src = ctx.createBufferSource();
  src.buffer = noise(ctx);
  const f = ctx.createBiquadFilter();
  f.type = filter;
  f.Q.value = q;
  f.frequency.setValueAtTime(Math.max(20, c0), t0);
  if (c1 !== c0) f.frequency.exponentialRampToValueAtTime(Math.max(20, c1), t0 + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(EPS, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.004);
  g.gain.exponentialRampToValueAtTime(EPS, t0 + dur);
  src.connect(f).connect(g).connect(out);
  src.start(t0);
  src.stop(t0 + dur + 0.03);
}

export const SYNTHS: Record<SfxKey, SynthFn> = {
  // A meaty melee impact: a low thump under a short noise smack.
  hit(ctx, out, t0, { rate = 1 }) {
    tone(ctx, out, t0, "sine", 170 * rate, 90 * rate, 0.13, 0.7);
    noiseBurst(ctx, out, t0, "lowpass", 1400, 350, 0.09, 0.7);
    return 0.16;
  },
  // Generic flesh/body impact for any character receiving damage.
  body_hit(ctx, out, t0, { rate = 1 }) {
    tone(ctx, out, t0, "sine", 150 * rate, 70 * rate, 0.16, 0.75);
    noiseBurst(ctx, out, t0, "lowpass", 1000, 240, 0.12, 0.72);
    return 0.18;
  },
  // You took damage: a lower, grittier thud with a downward grunt.
  hurt(ctx, out, t0, { rate = 1 }) {
    tone(ctx, out, t0, "sawtooth", 240 * rate, 110 * rate, 0.2, 0.4, 0.004);
    noiseBurst(ctx, out, t0, "lowpass", 900, 300, 0.16, 0.35);
    return 0.22;
  },
  // A soft, dull footfall.
  footstep(ctx, out, t0, { rate = 1 }) {
    noiseBurst(ctx, out, t0, "lowpass", 320 * rate, 160 * rate, 0.07, 0.5, 0.7);
    tone(ctx, out, t0, "sine", 90 * rate, 60 * rate, 0.06, 0.25);
    return 0.09;
  },
  // A whoosh: band-passed noise sweeping up then back down.
  throw(ctx, out, t0, { rate = 1 }) {
    const src = ctx.createBufferSource();
    src.buffer = noise(ctx);
    const f = ctx.createBiquadFilter();
    f.type = "bandpass";
    f.Q.value = 1.2;
    f.frequency.setValueAtTime(500 * rate, t0);
    f.frequency.exponentialRampToValueAtTime(1700 * rate, t0 + 0.09);
    f.frequency.exponentialRampToValueAtTime(600 * rate, t0 + 0.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(EPS, t0);
    g.gain.exponentialRampToValueAtTime(0.45, t0 + 0.05);
    g.gain.exponentialRampToValueAtTime(EPS, t0 + 0.2);
    src.connect(f).connect(g).connect(out);
    src.start(t0);
    src.stop(t0 + 0.24);
    return 0.22;
  },
  // A light item slapping the dirt.
  land(ctx, out, t0, { rate = 1 }) {
    tone(ctx, out, t0, "sine", 150 * rate, 70 * rate, 0.1, 0.5);
    noiseBurst(ctx, out, t0, "lowpass", 800, 200, 0.07, 0.25);
    return 0.12;
  },
  // Stone on stone: a brighter, clacky knock.
  stone(ctx, out, t0, { rate = 1 }) {
    tone(ctx, out, t0, "triangle", 340 * rate, 180 * rate, 0.12, 0.5);
    noiseBurst(ctx, out, t0, "highpass", 2200, 1400, 0.1, 0.5, 0.8);
    return 0.14;
  },
  // Axe into wood: a woody knock with a click transient.
  chop(ctx, out, t0, { rate = 1 }) {
    tone(ctx, out, t0, "triangle", 190 * rate, 120 * rate, 0.12, 0.7);
    noiseBurst(ctx, out, t0, "lowpass", 1600, 600, 0.03, 0.5);
    return 0.14;
  },
  // A heavier woody strike for tree damage.
  tree_chop(ctx, out, t0, { rate = 1 }) {
    tone(ctx, out, t0, "triangle", 170 * rate, 90 * rate, 0.16, 0.72);
    noiseBurst(ctx, out, t0, "lowpass", 1400, 420, 0.12, 0.58);
    return 0.18;
  },
  // A defeated death sting: a long downward sweep with a noise tail.
  death(ctx, out, t0, { rate = 1 }) {
    tone(ctx, out, t0, "sawtooth", 320 * rate, 60 * rate, 0.6, 0.5, 0.006);
    noiseBurst(ctx, out, t0, "lowpass", 1200, 300, 0.5, 0.2);
    return 0.62;
  },
  // A crisp UI tick.
  click(ctx, out, t0, { rate = 1 }) {
    tone(ctx, out, t0, "square", 1500 * rate, 1200 * rate, 0.04, 0.12);
    return 0.05;
  },
  // A bright rising bell triad (C–E–G).
  levelup(ctx, out, t0, { rate = 1 }) {
    const notes = [523.25, 659.25, 783.99];
    notes.forEach((n, i) =>
      tone(ctx, out, t0 + i * 0.09, "triangle", n * rate, n * rate, 0.3, 0.32, 0.01),
    );
    return 0.55;
  },
  // A two-note "blip" for grabbing an item.
  pickup(ctx, out, t0, { rate = 1 }) {
    tone(ctx, out, t0, "triangle", 700 * rate, 700 * rate, 0.06, 0.3, 0.008);
    tone(ctx, out, t0 + 0.06, "triangle", 1050 * rate, 1050 * rate, 0.07, 0.3, 0.008);
    return 0.14;
  },
  // A soft shimmer for healing.
  heal(ctx, out, t0, { rate = 1 }) {
    tone(ctx, out, t0, "sine", 620 * rate, 940 * rate, 0.28, 0.28, 0.02);
    tone(ctx, out, t0 + 0.08, "sine", 940 * rate, 1240 * rate, 0.24, 0.2, 0.02);
    return 0.34;
  },
  // A short primal surge for drinking a berserker potion.
  berserker(ctx, out, t0, { rate = 1 }) {
    tone(ctx, out, t0, "sawtooth", 160 * rate, 80 * rate, 0.55, 0.45, 0.02);
    noiseBurst(ctx, out, t0, "lowpass", 1200, 260, 0.58, 0.5, 0.8);
    tone(ctx, out, t0 + 0.08, "sine", 90 * rate, 55 * rate, 0.45, 0.38, 0.02);
    return 0.65;
  },
  // Cinematic splash launch roar.
  splash_roar(ctx, out, t0, { rate = 1 }) {
    tone(ctx, out, t0, "sawtooth", 150 * rate, 70 * rate, 0.72, 0.46, 0.025);
    noiseBurst(ctx, out, t0, "lowpass", 1100, 240, 0.72, 0.54, 0.9);
    tone(ctx, out, t0 + 0.12, "sine", 80 * rate, 48 * rate, 0.55, 0.36, 0.02);
    return 0.86;
  },
  // A quick aggressive vocal bark for a gorilla attack animation.
  gorilla_attack(ctx, out, t0, { rate = 1 }) {
    tone(ctx, out, t0, "sawtooth", 210 * rate, 115 * rate, 0.2, 0.34, 0.01);
    noiseBurst(ctx, out, t0, "bandpass", 700, 360, 0.2, 0.42, 1.2);
    return 0.25;
  },
};
