import type { AudioManager } from "../audio/AudioManager";

type VolumeSettingKey = "master" | "music" | "sfx";

interface VolumeControlOptions {
  label: string;
  icon: () => string;
  active: () => boolean;
  volume: () => number;
  setVolume: (v: number) => void;
  toggle: () => void;
}

const SETTINGS_STORE = "gorilator-settings";

/** A tiny top-right widget for music and master volume. */
export class AudioControls {
  constructor(audio: AudioManager) {
    injectStyles();

    const bar = document.createElement("div");
    bar.id = "audioControls";

    const music = makeVolumeControl(bar, {
      label: "Music",
      icon: () => (audio.isMusicEnabled ? "♪" : "▶"),
      active: () => audio.isMusicEnabled,
      volume: () => audio.getMusicVolume(),
      setVolume: (v) => {
        audio.setMusicVolume(v);
        persistVolume("music", Math.round(v * 100));
      },
      toggle: () => {
        audio.toggleMusic();
      },
    });

    const master = makeVolumeControl(bar, {
      label: "Master sound",
      icon: () => (audio.isMuted ? "🔇" : "🔊"),
      active: () => !audio.isMuted,
      volume: () => audio.getMasterVolume(),
      setVolume: (v) => {
        audio.setMasterVolume(v);
        persistVolume("master", Math.round(v * 100));
      },
      toggle: () => {
        audio.toggleMute();
      },
    });

    const reflect = () => {
      music.reflect();
      master.reflect();
    };

    audio.onStateChange(reflect);
    reflect();

    document.body.appendChild(bar);
  }
}

function makeVolumeControl(parent: HTMLElement, opt: VolumeControlOptions) {
  const wrap = document.createElement("div");
  wrap.className = "audioCtl";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "audioCtlButton";
  wrap.appendChild(button);

  const popover = document.createElement("div");
  popover.className = "audioVolumePopover";
  const box = document.createElement("div");
  box.className = "audioVolumeBox";
  const slider = document.createElement("input");
  slider.className = "audioVolumeSlider";
  slider.type = "range";
  slider.min = "0";
  slider.max = "100";
  slider.step = "1";
  slider.setAttribute("aria-label", `${opt.label} volume`);
  box.appendChild(slider);
  popover.appendChild(box);
  wrap.appendChild(popover);
  parent.appendChild(wrap);

  button.onclick = () => opt.toggle();
  slider.oninput = () => opt.setVolume((Number(slider.value) || 0) / 100);

  const reflect = () => {
    const volume = clamp01(opt.volume());
    const percent = Math.round(volume * 100);
    const active = opt.active();
    button.textContent = opt.icon();
    button.title = `${opt.label} ${percent}% - click to ${active ? "turn off" : "turn on"}`;
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-pressed", String(active));
    button.style.opacity = volumeOpacity(volume).toFixed(2);
    button.style.borderColor = active ? "#a8d65a88" : "#ffffff22";
    slider.value = String(percent);
  };

  return { reflect };
}

function volumeOpacity(v: number): number {
  return 0.2 + clamp01(v) * 0.8;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
}

function persistVolume(key: VolumeSettingKey, value: number) {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_STORE) || "{}") as Record<string, unknown>;
    raw[key] = Math.max(0, Math.min(100, value));
    localStorage.setItem(SETTINGS_STORE, JSON.stringify(raw));
  } catch {
    /* storage unavailable */
  }
}

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    #audioControls {
      position: fixed; top: 10px; right: 12px; z-index: 30;
      display: flex; gap: 6px;
    }
    #audioControls .audioCtl { position: relative; width: 38px; height: 34px; }
    #audioControls .audioCtlButton {
      width: 38px; height: 34px; border-radius: 8px; border: 1px solid #ffffff22;
      background: #1b1f2aee; color: #e8edf6; font-size: 18px; line-height: 1;
      cursor: pointer; display: grid; place-items: center;
      transition: opacity .12s ease, border-color .12s ease, background .12s ease;
    }
    #audioControls .audioCtlButton:hover { background: #252c3bee; }
    #audioControls .audioVolumePopover {
      position: absolute; top: 100%; right: 0; width: 152px; padding-top: 6px;
      opacity: 0; pointer-events: none; transform: translateY(-3px);
      transition: opacity .12s ease, transform .12s ease;
    }
    #audioControls .audioCtl:hover .audioVolumePopover,
    #audioControls .audioCtl:focus-within .audioVolumePopover {
      opacity: 1; pointer-events: auto; transform: translateY(0);
    }
    #audioControls .audioVolumeBox {
      height: 36px; display: flex; align-items: center; padding: 0 10px;
      border-radius: 8px; border: 1px solid #ffffff22;
      background: #1b1f2af2; box-shadow: 0 8px 22px rgba(0,0,0,0.34);
    }
    #audioControls .audioVolumeSlider {
      width: 100%; accent-color: #c9a24a; cursor: pointer;
    }
  `;
  document.head.appendChild(style);
}
