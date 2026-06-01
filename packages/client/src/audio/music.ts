// A procedural ambient music bed: a soft four-voice chord pad drifting through a
// slow vi–IV–I–V progression under a wandering low-pass filter. Runs with zero
// assets and supports play/pause (gain ramps). Drop a real loop at the path given
// in manifest.json under "music" to replace it (AudioManager handles that case).

const CHORDS: number[][] = [
  [110.0, 164.81, 220.0, 329.63], // Am: A2 E3 A3 E4
  [87.31, 130.81, 174.61, 261.63], // F:  F2 C3 F3 C4
  [130.81, 196.0, 261.63, 392.0], // C:  C3 G3 C4 G4
  [98.0, 146.83, 196.0, 293.66], // G:  G2 D3 G3 D4
];
const CHORD_MS = 7000; // hold each chord this long
const TARGET_GAIN = 0.5; // pad level when playing (under the music bus volume)

export class AmbientMusic {
  private readonly gain: GainNode;
  private readonly filter: BiquadFilterNode;
  private voices: OscillatorNode[] = [];
  private lfo: OscillatorNode | null = null;
  private timer: number | null = null;
  private idx = 0;
  private built = false;
  private on = false;

  constructor(
    private readonly ctx: AudioContext,
    dest: AudioNode,
  ) {
    this.filter = ctx.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = 800;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.filter.connect(this.gain).connect(dest);
  }

  get playing(): boolean {
    return this.on;
  }

  start() {
    if (!this.built) this.build();
    this.on = true;
    this.ramp(TARGET_GAIN, 1.5);
  }

  pause() {
    this.on = false;
    this.ramp(0, 0.8);
  }

  toggle(): boolean {
    if (this.on) this.pause();
    else this.start();
    return this.on;
  }

  private ramp(to: number, secs: number) {
    const t = this.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(t);
    this.gain.gain.setValueAtTime(this.gain.gain.value, t);
    this.gain.gain.linearRampToValueAtTime(to, t + secs);
  }

  private build() {
    const chord = CHORDS[this.idx];
    chord.forEach((f, i) => {
      const o = this.ctx.createOscillator();
      o.type = i === 0 ? "sine" : "sawtooth"; // sine bass, soft saw upper voices
      o.frequency.value = f;
      o.detune.value = (i - 1.5) * 4; // gentle chorus spread
      const vg = this.ctx.createGain();
      vg.gain.value = i === 0 ? 0.5 : 0.16;
      o.connect(vg).connect(this.filter);
      o.start();
      this.voices.push(o);
    });
    // A slow filter wobble gives the pad some life.
    this.lfo = this.ctx.createOscillator();
    this.lfo.frequency.value = 0.06;
    const lg = this.ctx.createGain();
    lg.gain.value = 220;
    this.lfo.connect(lg).connect(this.filter.frequency);
    this.lfo.start();

    this.timer = window.setInterval(() => this.nextChord(), CHORD_MS);
    this.built = true;
  }

  private nextChord() {
    this.idx = (this.idx + 1) % CHORDS.length;
    const chord = CHORDS[this.idx];
    const t = this.ctx.currentTime;
    this.voices.forEach((o, i) => {
      o.frequency.cancelScheduledValues(t);
      o.frequency.setValueAtTime(o.frequency.value, t);
      o.frequency.linearRampToValueAtTime(chord[i], t + 2.5); // glide between chords
    });
  }

  dispose() {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.voices.forEach((o) => o.stop());
    this.lfo?.stop();
    this.voices = [];
    this.lfo = null;
  }
}
