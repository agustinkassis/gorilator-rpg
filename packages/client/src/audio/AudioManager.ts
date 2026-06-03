// The game-facing sound API. Call sites stay tidy — `audio.hit(pos)`,
// `audio.chop(pos)`, `audio.footstep(...)`, `audio.toggleMusic()` — and this class
// owns the registry (per-key volume/category/cooldown + optional sample override),
// the footstep cadence, death-on-state-change detection, and music play/pause.

import { AnimState } from "@rpg/shared";
import type { ArcRotateCamera } from "@babylonjs/core";
import { AudioEngine, Category } from "./engine";
import { SYNTHS, SfxKey } from "./synth";

interface Vec2 {
  x: number;
  z: number;
}

interface SfxDef {
  category: Category;
  volume: number; // base level for this key
  spatial: boolean; // true → positioned in the world; false → centered (UI / "it's you")
  file?: string; // sample override (set from the manifest); falls back to the synth
  cooldownMs?: number; // global min gap between plays of this key (anti-machine-gun)
}

const MANIFEST_URL = "/audio/manifest.json";
const THEME_GAIN = 0.7;
const WAVE_GAIN = 0.82;
const WAVE_CLEAR_FADE_SECONDS = 0.22;

const DEFS: Record<SfxKey, SfxDef> = {
  hit: { category: "sfx", volume: 0.9, spatial: true, cooldownMs: 40 },
  hurt: { category: "sfx", volume: 0.95, spatial: false, cooldownMs: 60 },
  footstep: { category: "sfx", volume: 0.5, spatial: true }, // cadence handled per-entity
  throw: { category: "sfx", volume: 0.8, spatial: true, cooldownMs: 40 },
  land: { category: "sfx", volume: 0.7, spatial: true, cooldownMs: 20 },
  stone: { category: "sfx", volume: 0.85, spatial: true, cooldownMs: 20 },
  chop: { category: "sfx", volume: 0.8, spatial: true, cooldownMs: 20 },
  death: { category: "sfx", volume: 0.9, spatial: true, cooldownMs: 60 },
  click: { category: "ui", volume: 0.6, spatial: false, cooldownMs: 30 },
  levelup: { category: "sfx", volume: 0.8, spatial: true, cooldownMs: 120 },
  pickup: { category: "sfx", volume: 0.6, spatial: true, cooldownMs: 30 },
  heal: { category: "sfx", volume: 0.7, spatial: true, cooldownMs: 60 },
};

const FOOT_INTERVAL = 0.34; // seconds between footfalls (walking)
const FOOT_INTERVAL_SPRINT = 0.26; // ...quicker when sprinting

export class AudioManager {
  readonly engine: AudioEngine;
  readonly ready: Promise<void>;
  private readonly listeners = new Set<() => void>();

  private muted = false;
  private readonly lastPlay = new Map<SfxKey, number>(); // key → ctx time of last play
  private readonly stepAcc = new Map<string, number>(); // entity id → footstep timer
  private readonly lastState = new Map<string, AnimState>(); // entity id → last anim state

  // File-based music. No built-in theme fallback: if manifest "music" is absent,
  // the game stays quiet between waves.
  private themeBuffer: AudioBuffer | null = null;
  private themeSource: AudioBufferSourceNode | null = null;
  private waveBuffer: AudioBuffer | null = null;
  private waveSource: AudioBufferSourceNode | null = null;
  private readonly themeGain: GainNode;
  private readonly waveGain: GainNode;
  private requestedMusicMode: "theme" | "wave" = "theme";
  private musicMode: "theme" | "wave" | "stopped" = "stopped";
  private musicEnabled = true;
  private musicOn = false;

  constructor() {
    this.engine = new AudioEngine();
    this.themeGain = this.engine.ctx.createGain();
    this.themeGain.gain.value = 0;
    this.themeGain.connect(this.engine.bus("music"));
    this.waveGain = this.engine.ctx.createGain();
    this.waveGain.gain.value = 0;
    this.waveGain.connect(this.engine.bus("music"));

    // Browsers block audio until a user gesture — unlock on the first one (the
    // splash "ENTER" click / a keypress), then stop listening.
    const unlock = () => {
      this.engine.resume();
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);

    // Every <button> (or [data-sfx]) press ticks — covers all UI buttons for free.
    window.addEventListener("pointerdown", (e) => {
      const el = (e.target as HTMLElement | null)?.closest?.("button,[data-sfx]");
      if (el) this.click();
    });

    this.ready = this.loadManifest();
  }

  onStateChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emitStateChange() {
    this.listeners.forEach((listener) => listener());
  }

  /** Load optional sample overrides. Missing manifest/files → everything is synthesized. */
  private async loadManifest() {
    try {
      const res = await fetch(MANIFEST_URL);
      if (!res.ok) return;
      const map = (await res.json()) as Record<string, string>;
      for (const [key, file] of Object.entries(map)) {
        if (typeof file !== "string" || !file) continue;
        if (key === "music") {
          this.themeBuffer = await this.engine.load(file);
        } else if (key === "waveMusic") {
          this.waveBuffer = await this.engine.load(file);
        } else if (key in DEFS) {
          DEFS[key as SfxKey].file = file;
          await this.engine.load(file);
        }
      }
    } catch {
      /* no manifest → built-in SFX only, no file music */
    }
  }

  // ---- core play ----
  private play(
    key: SfxKey,
    opt: { position?: Vec2 | null; volume?: number; rate?: number } = {},
  ) {
    if (this.muted) return;
    const def = DEFS[key];
    if (def.cooldownMs) {
      const now = this.engine.ctx.currentTime;
      const last = this.lastPlay.get(key);
      if (last !== undefined && (now - last) * 1000 < def.cooldownMs) return;
      this.lastPlay.set(key, now);
    }
    const playOpt = {
      volume: (opt.volume ?? 1) * def.volume,
      rate: opt.rate,
      position: def.spatial ? (opt.position ?? null) : null,
    };
    const buf = this.engine.getBuffer(def.file);
    if (buf) this.engine.playBuffer(buf, def.category, playOpt);
    else this.engine.playSynth(SYNTHS[key], def.category, playOpt);
  }

  // ---- semantic helpers (the game calls these) ----
  hit(pos: Vec2) {
    this.play("hit", { position: pos });
  }
  hurt() {
    this.play("hurt"); // it's you → centered, full presence
  }
  chop(pos: Vec2) {
    this.play("chop", { position: pos });
  }
  mine(pos: Vec2) {
    this.play("stone", { position: pos });
  }
  throwItem(pos: Vec2, item: "banana" | "stone") {
    this.play("throw", { position: pos, rate: item === "stone" ? 0.82 : 1.05 });
  }
  land(pos: Vec2, item: "banana" | "stone", strength = 1) {
    if (item === "stone")
      this.play("stone", { position: pos, volume: Math.min(1.2, 0.6 + strength * 0.4) });
    else this.play("land", { position: pos, volume: Math.min(1.1, 0.5 + strength * 0.4) });
  }
  pickup(pos: Vec2) {
    this.play("pickup", { position: pos });
  }
  heal(pos: Vec2) {
    this.play("heal", { position: pos });
  }
  levelUp(pos: Vec2) {
    this.play("levelup", { position: pos });
  }
  click() {
    this.play("click");
  }

  /** Per-frame footstep cadence for one entity (call every frame; `moving` gates it). */
  footstep(id: string, pos: Vec2, moving: boolean, sprinting: boolean, dt: number) {
    if (!moving) {
      this.stepAcc.delete(id);
      return;
    }
    const interval = sprinting ? FOOT_INTERVAL_SPRINT : FOOT_INTERVAL;
    const acc = (this.stepAcc.get(id) ?? interval) + dt; // primed → first step is immediate
    if (acc >= interval) {
      this.stepAcc.set(id, 0);
      this.play("footstep", {
        position: pos,
        rate: 0.92 + Math.random() * 0.16,
        volume: sprinting ? 1 : 0.8,
      });
    } else {
      this.stepAcc.set(id, acc);
    }
  }

  /** Watch an entity's anim state; fire the death sting on the transition into DEAD. */
  entityState(id: string, state: AnimState, pos: Vec2) {
    const prev = this.lastState.get(id);
    this.lastState.set(id, state);
    if (state === AnimState.DEAD && prev !== undefined && prev !== AnimState.DEAD) {
      this.play("death", { position: pos });
    }
  }

  /** Drop per-entity bookkeeping when an entity despawns. */
  forget(id: string) {
    this.stepAcc.delete(id);
    this.lastState.delete(id);
  }

  /** Re-point the listener each frame: at the player, oriented like the camera. */
  updateListener(camera: ArcRotateCamera, pos: Vec2 | null) {
    const dir = camera.getForwardRay().direction;
    const up = camera.upVector;
    const at = pos ?? { x: camera.target.x, z: camera.target.z };
    this.engine.setListener(
      at.x,
      at.z,
      { x: dir.x, y: dir.y, z: dir.z },
      { x: up.x, y: up.y, z: up.z },
    );
  }

  // ---- music ----
  startMusic(restart = true) {
    this.requestedMusicMode = "theme";
    this.fadeOutWave(WAVE_CLEAR_FADE_SECONDS);
    if (!this.musicEnabled || !this.themeBuffer) {
      this.musicOn = false;
      this.musicMode = "stopped";
      this.emitStateChange();
      return;
    }
    if (restart || !this.themeSource) this.startThemeSource();
    this.rampGain(this.themeGain, THEME_GAIN, 1.5);
    this.musicOn = true;
    this.musicMode = "theme";
    this.emitStateChange();
  }

  startWaveMusic() {
    this.requestedMusicMode = "wave";
    this.fadeOutTheme(0.9);
    if (!this.musicEnabled || !this.waveBuffer) {
      this.musicOn = false;
      this.musicMode = "stopped";
      this.emitStateChange();
      return;
    }
    this.startWaveSource();
    this.rampGain(this.waveGain, WAVE_GAIN, 0.85);
    this.musicOn = true;
    this.musicMode = "wave";
    this.emitStateChange();
  }

  pauseMusic() {
    this.musicEnabled = false;
    this.fadeOutTheme(0.6);
    this.fadeOutWave(0.6);
    this.musicOn = false;
    this.musicMode = "stopped";
    this.emitStateChange();
  }

  toggleMusic(): boolean {
    if (this.musicEnabled) this.pauseMusic();
    else {
      this.musicEnabled = true;
      if (this.requestedMusicMode === "wave") this.startWaveMusic();
      else this.startMusic();
    }
    return this.musicOn;
  }

  get musicPlaying(): boolean {
    return this.musicOn;
  }

  get isWaveMusicPlaying(): boolean {
    return this.musicMode === "wave";
  }

  private startThemeSource() {
    if (!this.themeBuffer) return;
    this.stopThemeSource(0);
    const src = this.engine.ctx.createBufferSource();
    src.buffer = this.themeBuffer;
    src.loop = true;
    src.connect(this.themeGain);
    src.start();
    src.onended = () => {
      if (this.themeSource === src) this.themeSource = null;
      src.disconnect();
    };
    this.themeGain.gain.value = 0;
    this.themeSource = src;
  }

  private startWaveSource() {
    if (!this.waveBuffer) return;
    this.stopWaveSource(0);
    const src = this.engine.ctx.createBufferSource();
    src.buffer = this.waveBuffer;
    src.loop = true;
    src.connect(this.waveGain);
    src.start();
    src.onended = () => {
      if (this.waveSource === src) this.waveSource = null;
      src.disconnect();
    };
    this.waveGain.gain.value = 0;
    this.waveSource = src;
  }

  private fadeOutTheme(secs: number) {
    this.rampGain(this.themeGain, 0, secs);
    this.stopThemeSource(secs);
  }

  private fadeOutWave(secs: number) {
    this.rampGain(this.waveGain, 0, secs);
    this.stopWaveSource(secs);
  }

  private stopThemeSource(afterSec: number) {
    const src = this.themeSource;
    if (!src) return;
    this.themeSource = null;
    this.stopSource(src, afterSec);
  }

  private stopWaveSource(afterSec: number) {
    const src = this.waveSource;
    if (!src) return;
    this.waveSource = null;
    this.stopSource(src, afterSec);
  }

  private stopSource(src: AudioBufferSourceNode, afterSec: number) {
    try {
      src.stop(this.engine.ctx.currentTime + Math.max(0.01, afterSec));
    } catch {
      /* already stopped */
    }
  }

  private rampGain(gain: GainNode, to: number, secs: number) {
    const t = this.engine.ctx.currentTime;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(gain.gain.value, t);
    gain.gain.linearRampToValueAtTime(to, t + secs);
  }

  // ---- master mute ----
  toggleMute(): boolean {
    this.muted = !this.muted;
    this.engine.setMasterVolume(this.muted ? 0 : 0.9);
    this.emitStateChange();
    return this.muted;
  }

  get isMuted(): boolean {
    return this.muted;
  }
}
