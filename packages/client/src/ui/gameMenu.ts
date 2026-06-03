import type { Engine, ShadowGenerator } from "@babylonjs/core";
import type { AudioManager } from "../audio/AudioManager";
import type { NetworkClient } from "../net/NetworkClient";

type View = "main" | "hotkeys" | "sound" | "graphics";
type Quality = "low" | "medium" | "high";

interface Settings {
  master: number; // 0..100
  music: number; // 0..100
  sfx: number; // 0..100
  shadows: boolean;
  quality: Quality;
}

const STORE = "gorilator-settings";
const DEFAULTS: Settings = { master: 80, music: 50, sfx: 90, shadows: true, quality: "medium" };
// hardware scaling: >1 lower-res/faster, <1 super-sampled/sharper-slower.
const QUALITY_SCALE: Record<Quality, number> = { low: 2.0, medium: 1.0, high: 0.66 };

export interface GameMenuDeps {
  net: NetworkClient;
  audio: AudioManager;
  engine: Engine;
  shadow: ShadowGenerator;
  isNostrVerified: () => boolean;
}

/**
 * The Esc game menu: resume, hotkeys guide, sound + graphics settings (persisted),
 * "login with Nostr" (if anonymous), "kill yourself" (server suicide → respawn), and
 * "exit game". An overlay — the multiplayer world keeps running behind it.
 */
export class GameMenu {
  private overlay: HTMLDivElement;
  private panel: HTMLDivElement;
  private view: View = "main";
  private isOpen = false;
  private settings: Settings;

  constructor(private deps: GameMenuDeps) {
    this.settings = this.load();
    injectStyles();

    this.overlay = document.createElement("div");
    this.overlay.id = "gameMenu";
    this.overlay.addEventListener("pointerdown", (e) => {
      if (e.target === this.overlay) this.close(); // click the dim backdrop to dismiss
    });
    this.panel = document.createElement("div");
    this.panel.className = "gmPanel";
    this.overlay.appendChild(this.panel);
    document.body.appendChild(this.overlay);

    this.applySettings(); // apply persisted audio + graphics at boot

    window.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") {
        (e.target as HTMLElement).blur(); // Esc in chat just unfocuses it
        return;
      }
      if (document.body.classList.contains("preGame")) return; // not on the splash
      e.preventDefault();
      if (!this.isOpen) this.openTo("main");
      else if (this.view !== "main") this.openTo("main"); // a sub-view → back to the menu
      else this.close();
    });
  }

  private openTo(v: View) {
    this.view = v;
    this.isOpen = true;
    this.overlay.style.display = "flex";
    this.render();
  }
  private close() {
    this.isOpen = false;
    this.overlay.style.display = "none";
  }

  // ---- settings persistence + apply ----

  private load(): Settings {
    try {
      return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE) || "{}") };
    } catch {
      return { ...DEFAULTS };
    }
  }
  private save() {
    this.syncAudioSettings();
    try {
      localStorage.setItem(STORE, JSON.stringify(this.settings));
    } catch {
      /* storage unavailable */
    }
  }
  private syncAudioSettings() {
    this.settings.master = Math.round(this.deps.audio.getMasterVolume() * 100);
    this.settings.music = Math.round(this.deps.audio.getMusicVolume() * 100);
    this.settings.sfx = Math.round(this.deps.audio.getSfxVolume() * 100);
  }
  private applySettings() {
    const s = this.settings;
    this.deps.audio.setMasterVolume(s.master / 100);
    this.deps.audio.setMusicVolume(s.music / 100);
    this.deps.audio.setSfxVolume(s.sfx / 100);
    this.setShadows(s.shadows);
    this.deps.engine.setHardwareScalingLevel(QUALITY_SCALE[s.quality]);
  }
  private setShadows(on: boolean) {
    const light = this.deps.shadow.getLight() as unknown as { shadowEnabled: boolean };
    if (light) light.shadowEnabled = on;
  }

  // ---- views ----

  private render() {
    if (this.view === "hotkeys") this.renderHotkeys();
    else if (this.view === "sound") this.renderSound();
    else if (this.view === "graphics") this.renderGraphics();
    else this.renderMain();
  }

  private head(title: string, back: boolean) {
    return (
      `<div class="gmHead">` +
      (back ? `<button class="gmIconBtn" id="gmBack">←</button>` : `<span style="width:28px"></span>`) +
      `<b>${title}</b><button class="gmIconBtn" id="gmClose">✕</button></div>`
    );
  }
  private wireHead() {
    const close = this.panel.querySelector<HTMLElement>("#gmClose");
    if (close) close.onclick = () => this.close();
    const back = this.panel.querySelector<HTMLElement>("#gmBack");
    if (back) back.onclick = () => this.openTo("main");
  }
  private on(id: string, fn: () => void) {
    const el = this.panel.querySelector<HTMLElement>("#" + id);
    if (el) el.onclick = fn;
  }

  private renderMain() {
    const showNostr = !this.deps.isNostrVerified();
    const item = (id: string, icon: string, label: string, cls = "") =>
      `<button class="gmItem ${cls}" id="${id}"><span class="gmIco">${icon}</span>${label}</button>`;
    this.panel.innerHTML =
      this.head("Menu", false) +
      `<div class="gmBody">` +
      item("gmResume", "▶", "Resume") +
      item("gmHotkeys", "⌨️", "Hotkeys") +
      item("gmSound", "🔊", "Sound settings") +
      item("gmGraphics", "🖥️", "Graphics settings") +
      (showNostr ? item("gmNostr", "⚡", "Login with Nostr") : "") +
      item("gmSuicide", "💀", "Kill yourself", "gmWarn") +
      item("gmExit", "🚪", "Exit game", "gmDanger") +
      `</div>`;
    this.wireHead();
    this.on("gmResume", () => this.close());
    this.on("gmHotkeys", () => this.openTo("hotkeys"));
    this.on("gmSound", () => this.openTo("sound"));
    this.on("gmGraphics", () => this.openTo("graphics"));
    // Nostr login + exit both return to the splash (the canonical entry); logging in
    // with Nostr there restores any saved character for that npub.
    this.on("gmNostr", () => window.location.reload());
    this.on("gmSuicide", () => {
      this.deps.net.sendSuicide();
      this.close();
    });
    this.on("gmExit", () => window.location.reload());
  }

  private renderHotkeys() {
    const rows: [string, string][] = [
      ["Move", "Left-click the ground"],
      ["Attack", "Left-click an enemy / resource"],
      ["Throw", "Hold Q · W · E · R, release to fling"],
      ["Sprint", "Hold SPACE"],
      ["Inventory", "I"],
      ["Character", "C"],
      ["Map", "Hold TAB (or the Map button)"],
      ["Chat", "Enter"],
      ["Menu", "Esc"],
    ];
    this.panel.innerHTML =
      this.head("Hotkeys", true) +
      `<div class="gmBody">` +
      rows.map(([a, k]) => `<div class="gmKeyRow"><span>${a}</span><kbd>${k}</kbd></div>`).join("") +
      `<div class="gmNote">Dev builds: <kbd>\`</kbd> Dev Mode · <kbd>B</kbd> model inspector.</div>` +
      `</div>`;
    this.wireHead();
  }

  private renderSound() {
    this.syncAudioSettings();
    const s = this.settings;
    const audioBtn = (id: string, icon: string, label: string, val: number, active: boolean) =>
      `<button id="${id}Toggle" class="gmAudioBtn${active ? " gmAudioOn" : ""}" style="opacity:${volumeOpacity(val / 100).toFixed(2)}" aria-label="${label}" title="${label}">${icon}</button>`;
    const slider = (id: string, label: string, val: number, button = "") =>
      `<div class="gmRow gmAudioRow">${button}<label>${label}</label><input id="${id}" class="gmSlider" type="range" min="0" max="100" value="${val}"><span id="${id}v" class="gmVal">${val}%</span></div>`;
    this.panel.innerHTML =
      this.head("Sound", true) +
      `<div class="gmBody">` +
      slider("gmMaster", "Master", s.master, audioBtn("gmMaster", this.deps.audio.isMuted ? "🔇" : "🔊", "Toggle master sound", s.master, !this.deps.audio.isMuted)) +
      slider("gmMusic", "Music", s.music, audioBtn("gmMusic", this.deps.audio.isMusicEnabled ? "♪" : "▶", "Toggle music", s.music, this.deps.audio.isMusicEnabled)) +
      slider("gmSfx", "💥 Effects", s.sfx) +
      `</div>`;
    this.wireHead();
    const wire = (id: string, key: "master" | "music" | "sfx", apply: (v: number) => void) => {
      const el = this.panel.querySelector<HTMLInputElement>("#" + id);
      const out = this.panel.querySelector<HTMLElement>("#" + id + "v");
      const btn = this.panel.querySelector<HTMLElement>("#" + id + "Toggle");
      if (!el) return;
      el.oninput = () => {
        const n = +el.value;
        this.settings[key] = n;
        if (out) out.textContent = n + "%";
        if (btn) btn.style.opacity = volumeOpacity(n / 100).toFixed(2);
        apply(n / 100);
        this.save();
      };
    };
    wire("gmMaster", "master", (n) => this.deps.audio.setMasterVolume(n));
    wire("gmMusic", "music", (n) => this.deps.audio.setMusicVolume(n));
    wire("gmSfx", "sfx", (n) => this.deps.audio.setSfxVolume(n));
    this.on("gmMasterToggle", () => {
      this.deps.audio.toggleMute();
      this.renderSound();
    });
    this.on("gmMusicToggle", () => {
      this.deps.audio.toggleMusic();
      this.renderSound();
    });
  }

  private renderGraphics() {
    const s = this.settings;
    const qBtn = (q: Quality, label: string) =>
      `<button class="gmQual${s.quality === q ? " gmQualOn" : ""}" data-q="${q}">${label}</button>`;
    this.panel.innerHTML =
      this.head("Graphics", true) +
      `<div class="gmBody">` +
      `<div class="gmRow"><label>🌑 Shadows</label><button id="gmShadows" class="gmToggle">${s.shadows ? "On" : "Off"}</button></div>` +
      `<div class="gmRow"><label>✨ Quality</label><div class="gmQuals">${qBtn("low", "Low")}${qBtn("medium", "Medium")}${qBtn("high", "High")}</div></div>` +
      `<div class="gmNote">Quality sets the render resolution — lower it if the game runs slow.</div>` +
      `</div>`;
    this.wireHead();
    const sh = this.panel.querySelector<HTMLElement>("#gmShadows");
    if (sh)
      sh.onclick = () => {
        this.settings.shadows = !this.settings.shadows;
        this.setShadows(this.settings.shadows);
        sh.textContent = this.settings.shadows ? "On" : "Off";
        this.save();
      };
    this.panel.querySelectorAll<HTMLElement>(".gmQual").forEach((b) => {
      b.onclick = () => {
        const q = b.dataset.q as Quality;
        this.settings.quality = q;
        this.deps.engine.setHardwareScalingLevel(QUALITY_SCALE[q]);
        this.save();
        this.renderGraphics(); // refresh the active highlight
      };
    });
  }
}

function volumeOpacity(v: number): number {
  const n = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
  return 0.2 + n * 0.8;
}

let injected = false;
function injectStyles() {
  if (injected) return;
  injected = true;
  const css = `
    #gameMenu {
      position: fixed; inset: 0; z-index: 70; display: none;
      align-items: center; justify-content: center;
      background: rgba(6,8,12,0.62); backdrop-filter: blur(2px);
      font-family: system-ui, sans-serif; color: #e8edf6;
    }
    #gameMenu .gmPanel {
      width: 320px; max-width: 90vw; max-height: 86vh; overflow-y: auto;
      background: linear-gradient(180deg, rgba(24,28,38,0.98), rgba(14,17,24,0.98));
      border: 2px solid #c9a24a; border-radius: 14px;
      box-shadow: 0 12px 48px rgba(0,0,0,0.6);
    }
    #gameMenu .gmHead { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:10px 12px; border-bottom:1px solid #3a4456; }
    #gameMenu .gmHead b { font-size:15px; color:#f0d27a; }
    #gameMenu .gmIconBtn { width:28px; height:28px; cursor:pointer; background:#2a3242; color:#e8edf6; border:1px solid #4a5568; border-radius:6px; font-size:14px; line-height:1; }
    #gameMenu .gmBody { padding: 12px; display:flex; flex-direction:column; gap:8px; }
    #gameMenu .gmItem {
      display:flex; align-items:center; gap:12px; width:100%; padding:11px 14px; cursor:pointer;
      background:#222a38; color:#e8edf6; border:1px solid #3a4456; border-radius:9px;
      font-size:14px; font-weight:600; text-align:left; transition: background 0.12s, border-color 0.12s;
    }
    #gameMenu .gmItem:hover { background:#2c3648; border-color:#c9a24a; }
    #gameMenu .gmItem .gmIco { font-size:18px; width:22px; text-align:center; }
    #gameMenu .gmWarn:hover { border-color:#e0b341; }
    #gameMenu .gmDanger { color:#ff9a8a; }
    #gameMenu .gmDanger:hover { background:#3a2230; border-color:#e0563f; }
    #gameMenu .gmKeyRow { display:flex; align-items:center; justify-content:space-between; padding:6px 4px; border-bottom:1px solid #232b39; }
    #gameMenu kbd { background:#11151d; border:1px solid #3a4456; border-radius:5px; padding:2px 7px; font:600 12px monospace; color:#ffe0a8; }
    #gameMenu .gmNote { margin-top:8px; font-size:11px; color:#8a94a6; line-height:1.5; }
    #gameMenu .gmRow { display:flex; align-items:center; gap:10px; padding:8px 4px; }
    #gameMenu .gmAudioRow { gap:8px; }
    #gameMenu .gmAudioBtn {
      flex: 0 0 30px; width: 30px; height: 30px; cursor: pointer;
      display: grid; place-items: center; border: 1px solid #ffffff22; border-radius: 7px;
      background: #202838; color: #e8edf6; font-size: 16px; line-height: 1;
      transition: opacity .12s ease, border-color .12s ease, background .12s ease;
    }
    #gameMenu .gmAudioBtn:hover { background:#2c3648; border-color:#c9a24a; }
    #gameMenu .gmAudioOn { border-color:#a8d65a88; }
    #gameMenu .gmRow label { flex:0 0 96px; font-size:13px; color:#cdd3e0; }
    #gameMenu .gmSlider { flex:1; }
    #gameMenu .gmVal { width:40px; text-align:right; font-size:12px; color:#9fb0c0; }
    #gameMenu .gmToggle { cursor:pointer; padding:5px 16px; background:#2a3242; color:#e8edf6; border:1px solid #4a5568; border-radius:6px; font-weight:600; }
    #gameMenu .gmQuals { display:flex; gap:6px; flex:1; }
    #gameMenu .gmQual { flex:1; cursor:pointer; padding:6px 0; background:#222a38; color:#cdd3e0; border:1px solid #3a4456; border-radius:6px; font-size:12px; font-weight:600; }
    #gameMenu .gmQualOn { background:#c9a24a; color:#1a1207; border-color:#c9a24a; }
    body.preGame #gameMenu { display: none !important; }
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}
