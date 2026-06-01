import type { AudioManager } from "../audio/AudioManager";

/** A tiny top-right widget: toggle the music bed and mute all sound. (UI-button
 *  click ticks are wired globally in the AudioManager, so they aren't handled here.) */
export class AudioControls {
  constructor(audio: AudioManager) {
    const bar = document.createElement("div");
    bar.id = "audioControls";
    bar.style.cssText =
      "position:fixed;top:10px;right:12px;z-index:30;display:flex;gap:6px;";

    const mk = (label: string, title: string) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.title = title;
      b.style.cssText =
        "width:38px;height:34px;border-radius:8px;border:1px solid #ffffff22;" +
        "background:#1b1f2aee;color:#e8edf6;font-size:18px;line-height:1;cursor:pointer;";
      bar.appendChild(b);
      return b;
    };

    const music = mk("🎵", "Music on/off");
    const mute = mk("🔊", "Mute all sound");

    const reflectMusic = () => {
      music.style.opacity = audio.musicPlaying ? "1" : "0.4";
    };
    music.onclick = () => {
      audio.toggleMusic();
      reflectMusic();
    };
    mute.onclick = () => {
      const m = audio.toggleMute();
      mute.textContent = m ? "🔇" : "🔊";
    };
    reflectMusic();

    document.body.appendChild(bar);
  }
}
