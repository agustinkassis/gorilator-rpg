// The low-level audio plumbing: one Web Audio context, a master bus through a
// limiter, three category sub-buses (music / sfx / ui), a spatial panner per
// positioned voice, and a small file loader+cache. Higher-level game semantics
// live in AudioManager; this file knows nothing about the game.

import type { SynthFn, SynthOpts } from "./synth";

export type Category = "music" | "sfx" | "ui";

export interface PlayOpts {
  volume?: number;
  rate?: number; // playback-rate / pitch multiplier
  position?: { x: number; z: number } | null; // world XZ → spatialized; null → centered
}

/** Older browsers expose the listener pose via setPosition/setOrientation. */
type LegacyListener = AudioListener & {
  setPosition?(x: number, y: number, z: number): void;
  setOrientation?(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void;
};
type LegacyPanner = PannerNode & {
  setPosition?(x: number, y: number, z: number): void;
};

const REF_DISTANCE = 6; // full volume within this many world units of the listener
const MAX_DISTANCE = 48; // inaudible beyond this (keeps the big map quiet)

export class AudioEngine {
  readonly ctx: AudioContext;
  private readonly master: GainNode;
  private readonly busNodes: Record<Category, GainNode>;
  private readonly buffers = new Map<string, AudioBuffer | null>();

  constructor() {
    const Ctor: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor();

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    // A gentle limiter on the master so a flurry of overlapping sounds can't clip.
    const limiter = this.ctx.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.knee.value = 8;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    this.master.connect(limiter);
    limiter.connect(this.ctx.destination);

    const mk = (v: number) => {
      const g = this.ctx.createGain();
      g.gain.value = v;
      g.connect(this.master);
      return g;
    };
    this.busNodes = { music: mk(0.45), sfx: mk(0.9), ui: mk(0.6) };
  }

  bus(c: Category): GainNode {
    return this.busNodes[c];
  }

  get running(): boolean {
    return this.ctx.state === "running";
  }

  /** Resume the context (call from a user-gesture handler — autoplay is blocked). */
  resume() {
    if (this.ctx.state !== "running") void this.ctx.resume();
  }

  setMasterVolume(v: number) {
    this.master.gain.value = Math.max(0, Math.min(1, v));
  }

  setBusVolume(c: Category, v: number) {
    this.busNodes[c].gain.value = Math.max(0, Math.min(1, v));
  }

  /** Place the WebAudio listener so positioned voices pan + attenuate correctly. */
  setListener(
    px: number,
    pz: number,
    fwd: { x: number; y: number; z: number },
    up: { x: number; y: number; z: number },
  ) {
    const l = this.ctx.listener as LegacyListener;
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setValueAtTime(px, t);
      l.positionY.setValueAtTime(0, t);
      l.positionZ.setValueAtTime(pz, t);
      l.forwardX.setValueAtTime(fwd.x, t);
      l.forwardY.setValueAtTime(fwd.y, t);
      l.forwardZ.setValueAtTime(fwd.z, t);
      l.upX.setValueAtTime(up.x, t);
      l.upY.setValueAtTime(up.y, t);
      l.upZ.setValueAtTime(up.z, t);
    } else {
      l.setPosition?.(px, 0, pz);
      l.setOrientation?.(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }
  }

  private panner(pos: { x: number; z: number }): PannerNode {
    const p = this.ctx.createPanner() as LegacyPanner;
    p.panningModel = "equalpower";
    p.distanceModel = "linear";
    p.refDistance = REF_DISTANCE;
    p.maxDistance = MAX_DISTANCE;
    p.rolloffFactor = 1;
    if (p.positionX) {
      p.positionX.value = pos.x;
      p.positionY.value = 0;
      p.positionZ.value = pos.z;
    } else {
      p.setPosition?.(pos.x, 0, pos.z);
    }
    return p;
  }

  /** Build the voice tail: [per-voice gain] → [panner?] → category bus, with cleanup. */
  private route(cat: Category, opt: PlayOpts): { out: GainNode; done: (afterSec: number) => void } {
    const out = this.ctx.createGain();
    out.gain.value = opt.volume ?? 1;
    let pan: PannerNode | null = null;
    if (opt.position) {
      pan = this.panner(opt.position);
      out.connect(pan);
      pan.connect(this.bus(cat));
    } else {
      out.connect(this.bus(cat));
    }
    const done = (afterSec: number) => {
      window.setTimeout(
        () => {
          out.disconnect();
          pan?.disconnect();
        },
        afterSec * 1000 + 80,
      );
    };
    return { out, done };
  }

  /** Play a procedural synth voice. */
  playSynth(fn: SynthFn, cat: Category, opt: PlayOpts) {
    const { out, done } = this.route(cat, opt);
    const synthOpt: SynthOpts = { rate: opt.rate };
    const dur = fn(this.ctx, out, this.ctx.currentTime + 0.001, synthOpt);
    done(dur);
  }

  /** Play a decoded sample. */
  playBuffer(buf: AudioBuffer, cat: Category, opt: PlayOpts) {
    const { out, done } = this.route(cat, opt);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = opt.rate ?? 1;
    src.connect(out);
    src.start();
    done(buf.duration / (opt.rate ?? 1));
  }

  /** A previously-loaded buffer for `url`, or null if absent/failed/not-yet-loaded. */
  getBuffer(url?: string): AudioBuffer | null {
    if (!url) return null;
    return this.buffers.get(url) ?? null;
  }

  /** Fetch + decode a sample (cached). Returns null on any failure (→ caller synths). */
  async load(url: string): Promise<AudioBuffer | null> {
    const cached = this.buffers.get(url);
    if (cached !== undefined) return cached;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.arrayBuffer();
      const buf = await this.ctx.decodeAudioData(data);
      this.buffers.set(url, buf);
      return buf;
    } catch {
      this.buffers.set(url, null); // remember the miss so we don't refetch
      return null;
    }
  }
}
