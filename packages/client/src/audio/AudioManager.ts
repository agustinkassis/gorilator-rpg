// The game-facing sound API. Call sites stay tidy — `audio.hit(pos)`,
// `audio.chop(pos)`, `audio.footstep(...)`, `audio.toggleMusic()` — and this class
// owns the registry (per-key volume/category/cooldown + optional sample override),
// the footstep cadence, death-on-state-change detection, and music play/pause.

import { AnimState } from "@rpg/shared";
import type { ArcRotateCamera } from "@babylonjs/core";
import { AudioEngine, type Category } from "./engine";
import { SYNTHS, type SfxKey } from "./synth";

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
const SPLASH_GAIN = 0.68;
const WAVE_GAIN = 0.82;
const WAVE_CLEAR_FADE_SECONDS = 0.22;

const DEFS: Record<SfxKey, SfxDef> = {
  hit: { category: "sfx", volume: 0.9, spatial: true, cooldownMs: 40 },
  body_hit: { category: "sfx", volume: 0.95, spatial: true, cooldownMs: 30 },
  hurt: { category: "sfx", volume: 0.95, spatial: false, cooldownMs: 60 },
  footstep: { category: "sfx", volume: 0.5, spatial: true }, // cadence handled per-entity
  throw: { category: "sfx", volume: 0.8, spatial: true, cooldownMs: 40 },
  land: { category: "sfx", volume: 0.7, spatial: true, cooldownMs: 20 },
  stone: { category: "sfx", volume: 0.85, spatial: true, cooldownMs: 20 },
  chop: { category: "sfx", volume: 0.8, spatial: true, cooldownMs: 20 },
  tree_chop: { category: "sfx", volume: 0.88, spatial: true, cooldownMs: 20 },
  death: { category: "sfx", volume: 0.9, spatial: true, cooldownMs: 60 },
  click: { category: "ui", volume: 0.6, spatial: false, cooldownMs: 30 },
  levelup: { category: "sfx", volume: 0.8, spatial: true, cooldownMs: 120 },
  pickup: { category: "sfx", volume: 0.6, spatial: true, cooldownMs: 30 },
  heal: { category: "sfx", volume: 0.7, spatial: true, cooldownMs: 60 },
  berserker: { category: "sfx", volume: 0.95, spatial: false, cooldownMs: 500 },
  splash_roar: { category: "sfx", volume: 0.92, spatial: false, cooldownMs: 1000 },
  gorilla_attack: { category: "sfx", volume: 0.1, spatial: true, cooldownMs: 80 },
};

const FOOT_INTERVAL = 0.34; // seconds between footfalls (walking)
const FOOT_INTERVAL_SPRINT = 0.26; // ...quicker when sprinting

export class AudioManager {
  readonly engine: AudioEngine;
  readonly ready: Promise<void>;
  private readonly listeners = new Set<() => void>();

  private muted = false;
  private masterVolume = 0.9;
  private musicVolume = 0.45;
  private sfxVolume = 0.9;
  private readonly lastPlay = new Map<SfxKey, number>(); // key → ctx time of last play
  private readonly stepAcc = new Map<string, number>(); // entity id → footstep timer
  private readonly lastState = new Map<string, AnimState>(); // entity id → last anim state

  // File-based music. No built-in theme fallback: if manifest "music" is absent,
  // the game stays quiet between waves.
  private splashBuffer: AudioBuffer | null = null;
  private splashSource: AudioBufferSourceNode | null = null;
  private themeBuffer: AudioBuffer | null = null;
  private themeSource: AudioBufferSourceNode | null = null;
  private waveBuffer: AudioBuffer | null = null;
  private waveSource: AudioBufferSourceNode | null = null;
  private readonly splashGain: GainNode;
  private readonly themeGain: GainNode;
  private readonly waveGain: GainNode;
  private requestedMusicMode: "theme" | "wave" = "theme";
  private musicMode: "theme" | "wave" | "stopped" = "stopped";
  private musicEnabled = true;
  private musicOn = false;

  constructor() {
    this.engine = new AudioEngine();
    this.splashGain = this.engine.ctx.createGain();
    this.splashGain.gain.value = 0;
    this.splashGain.connect(this.engine.bus("music"));
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
        if (key === "splashMusic") {
          this.splashBuffer = await this.engine.load(file);
        } else if (key === "music") {
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
  bodyHit(pos: Vec2) {
    this.play("body_hit", { position: pos });
  }
  hurt() {
    this.play("hurt"); // it's you → centered, full presence
  }
  chop(pos: Vec2) {
    this.play("chop", { position: pos });
  }
  treeChop(pos: Vec2) {
    this.play("tree_chop", { position: pos });
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
  berserker() {
    this.play("berserker");
  }
  splashRoar() {
    this.play("splash_roar");
  }
  gorillaAttack(pos: Vec2) {
    this.play("gorilla_attack", { position: pos });
    this.play("pickup", { position: pos, volume: 1.2, rate: 1.25 });
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

  /** Watch an entity's anim state; fire one-shot sounds on state transitions. */
  entityState(id: string, state: AnimState, pos: Vec2, opt: { gorillaAttack?: boolean } = {}) {
    const prev = this.lastState.get(id);
    this.lastState.set(id, state);
    if (state === AnimState.ATTACK && prev !== undefined && prev !== AnimState.ATTACK && opt.gorillaAttack) {
      this.gorillaAttack(pos);
    }
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
  startSplashMusic() {
    if (!this.musicEnabled || !this.splashBuffer || this.splashSource) return;
    this.startSplashSource();
    this.rampGain(this.splashGain, SPLASH_GAIN, 1.2);
  }

  stopSplashMusic(fadeSeconds = 0.35) {
    this.fadeOutSplash(fadeSeconds);
  }

  startMusic(restart = true) {
    this.requestedMusicMode = "theme";
    this.fadeOutSplash(0.25);
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
    this.fadeOutSplash(0.25);
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
    this.fadeOutSplash(0.6);
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

  get isMusicEnabled(): boolean {
    return this.musicEnabled;
  }

  get isWaveMusicPlaying(): boolean {
    return this.musicMode === "wave";
  }

  private startSplashSource() {
    if (!this.splashBuffer) return;
    this.stopSplashSource(0);
    const src = this.engine.ctx.createBufferSource();
    src.buffer = this.splashBuffer;
    src.loop = true;
    src.connect(this.splashGain);
    src.start();
    src.onended = () => {
      if (this.splashSource === src) this.splashSource = null;
      src.disconnect();
    };
    this.splashGain.gain.value = 0;
    this.splashSource = src;
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

  private fadeOutSplash(secs: number) {
    this.rampGain(this.splashGain, 0, secs);
    this.stopSplashSource(secs);
  }

  private fadeOutTheme(secs: number) {
    this.rampGain(this.themeGain, 0, secs);
    this.stopThemeSource(secs);
  }

  private fadeOutWave(secs: number) {
    this.rampGain(this.waveGain, 0, secs);
    this.stopWaveSource(secs);
  }

  private stopSplashSource(afterSec: number) {
    const src = this.splashSource;
    if (!src) return;
    this.splashSource = null;
    this.stopSource(src, afterSec);
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

  // ---- volume state ----
  setMasterVolume(v: number) {
    this.masterVolume = clamp01(v);
    this.engine.setMasterVolume(this.muted ? 0 : this.masterVolume);
    this.emitStateChange();
  }

  setMusicVolume(v: number) {
    this.musicVolume = clamp01(v);
    this.engine.setBusVolume("music", this.musicVolume);
    this.emitStateChange();
  }

  setSfxVolume(v: number) {
    this.sfxVolume = clamp01(v);
    this.engine.setBusVolume("sfx", this.sfxVolume);
    this.emitStateChange();
  }

  getMasterVolume(): number {
    return this.masterVolume;
  }

  getMusicVolume(): number {
    return this.musicVolume;
  }

  getSfxVolume(): number {
    return this.sfxVolume;
  }

  // ---- master mute ----
  toggleMute(): boolean {
    this.muted = !this.muted;
    this.engine.setMasterVolume(this.muted ? 0 : this.masterVolume);
    this.emitStateChange();
    return this.muted;
  }

  get isMuted(): boolean {
    return this.muted;
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
}
