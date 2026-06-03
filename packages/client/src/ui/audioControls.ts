import type { AudioManager } from "../audio/AudioManager";

/** A tiny top-right widget: toggle the music bed and mute all sound. (UI-button
 *  click ticks are wired globally in the AudioManager, so they aren't handled here.) */
export class AudioControls {
  constructor(audio: AudioManager) {
    const bar = document.createElement("div");
    bar.id = "audioControls";
    bar.style.cssText =
      "position:fixed;top:10px;right:12px;z-index:30;display:flex;gap:6px;";

    const mk = (title: string) => {
      const b = document.createElement("button");
      b.title = title;
      b.setAttribute("aria-label", title);
      b.style.cssText =
        "width:38px;height:34px;border-radius:8px;border:1px solid #ffffff22;" +
        "background:#1b1f2aee;color:#e8edf6;font-size:18px;line-height:1;cursor:pointer;" +
        "display:grid;place-items:center;transition:opacity .12s ease,border-color .12s ease;";
      bar.appendChild(b);
      return b;
    };

    const music = mk("Toggle music");
    const mute = mk("Mute all sound");

    const reflect = () => {
      music.textContent = audio.musicPlaying ? "♪" : "▶";
      music.title = audio.musicPlaying ? "Pause music" : "Play music";
      music.setAttribute("aria-label", music.title);
      music.setAttribute("aria-pressed", String(audio.musicPlaying));
      music.style.opacity = audio.musicPlaying ? "1" : "0.52";
      music.style.borderColor = audio.musicPlaying ? "#a8d65a88" : "#ffffff22";

      mute.textContent = audio.isMuted ? "🔇" : "🔊";
      mute.title = audio.isMuted ? "Unmute all sound" : "Mute all sound";
      mute.setAttribute("aria-label", mute.title);
      mute.setAttribute("aria-pressed", String(audio.isMuted));
      mute.style.opacity = audio.isMuted ? "0.58" : "1";
    };
    music.onclick = () => {
      audio.toggleMusic();
    };
    mute.onclick = () => {
      audio.toggleMute();
    };
    audio.onStateChange(reflect);
    reflect();

    document.body.appendChild(bar);
  }
}
