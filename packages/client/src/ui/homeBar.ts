/**
 * The siege objective HUD: a persistent top-centre bar showing the home ("La
 * Crypta") HP and the wave state, visible to every player at all times. Fed each
 * frame from the synced House + wave fields (see main.ts).
 */
export class HomeBar {
  private root: HTMLDivElement;
  private title: HTMLDivElement;
  private wave: HTMLDivElement;
  private fill: HTMLDivElement;
  private hpText: HTMLDivElement;
  private sub: HTMLDivElement;
  private fallen = false;

  constructor() {
    injectStyles();
    this.root = document.createElement("div");
    this.root.id = "homeBar";

    const top = document.createElement("div");
    top.className = "hbTop";
    this.title = document.createElement("div");
    this.title.className = "hbTitle";
    this.title.textContent = "🏛 La Crypta";
    this.wave = document.createElement("div");
    this.wave.className = "hbWave";
    this.wave.textContent = "";
    top.append(this.title, this.wave);

    const track = document.createElement("div");
    track.className = "hbTrack";
    this.fill = document.createElement("div");
    this.fill.className = "hbFill";
    this.hpText = document.createElement("div");
    this.hpText.className = "hbHp";
    track.append(this.fill, this.hpText);

    this.sub = document.createElement("div");
    this.sub.className = "hbSub";

    this.root.append(top, track, this.sub);
    document.body.appendChild(this.root);
  }

  /** Update the home's HP bar (alive=false → collapsed). */
  setHouse(hp: number, maxHp: number, alive: boolean) {
    if (!alive || hp <= 0) {
      if (!this.fallen) {
        this.fallen = true;
        this.title.textContent = "💀 La Crypta has fallen";
        this.root.classList.add("hbDead");
      }
      this.fill.style.width = "0%";
      this.hpText.textContent = "0 / " + Math.round(maxHp);
      return;
    }
    if (this.fallen) {
      this.fallen = false;
      this.title.textContent = "🏛 La Crypta";
      this.root.classList.remove("hbDead");
    }
    const frac = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 0;
    this.fill.style.width = (frac * 100).toFixed(1) + "%";
    // green → amber → red as the home is worn down; pulse when critical
    const color = frac > 0.5 ? "#54d98c" : frac > 0.25 ? "#e0b341" : "#e0563f";
    this.fill.style.background = color;
    this.root.classList.toggle("hbLow", frac <= 0.25);
    this.hpText.textContent = `${Math.ceil(hp)} / ${Math.round(maxHp)}`;
  }

  /** Update the wave label + countdown to the next wave. */
  setWave(waveNumber: number, msToNext: number) {
    if (this.fallen) {
      this.wave.textContent = "";
      this.sub.textContent = "the horde overran the gate";
      return;
    }
    const secs = Math.max(0, Math.ceil(msToNext / 1000));
    const t =
      secs >= 60 ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}` : `${secs}s`;
    if (waveNumber <= 0) {
      this.wave.textContent = "GET READY";
      this.sub.textContent = `first wave in ${t}`;
    } else {
      this.wave.textContent = `WAVE ${waveNumber}`;
      this.sub.textContent = secs <= 1 ? "INCOMING!" : `next wave in ${t}`;
    }
  }

  /** Brief full-screen defeat flash when La Crypta falls and the round wipes. */
  flashDefeat(wave: number) {
    let b = document.getElementById("hbBanner");
    if (!b) {
      b = document.createElement("div");
      b.id = "hbBanner";
      document.body.appendChild(b);
    }
    b.innerHTML =
      `<div class="hbbTitle">🏛 La Crypta has fallen</div>` +
      `<div class="hbbSub">survived ${wave} wave${wave === 1 ? "" : "s"} · the realm resets to level 1</div>`;
    b.classList.remove("hbbShow");
    void b.offsetWidth; // reflow so the animation restarts on a repeat wipe
    b.classList.add("hbbShow");
  }
}

let injected = false;
function injectStyles() {
  if (injected) return;
  injected = true;
  const css = `
    #homeBar {
      position: fixed; top: 8px; left: 50%; transform: translateX(-50%);
      z-index: 32; width: 360px; max-width: 86vw; padding: 7px 12px 6px;
      background: linear-gradient(180deg, rgba(24,17,10,0.92), rgba(13,9,6,0.92));
      border: 2px solid #6b4f2e; border-radius: 12px;
      box-shadow: 0 4px 18px rgba(0,0,0,0.55), inset 0 0 16px rgba(0,0,0,0.5);
      font-family: system-ui, sans-serif; pointer-events: none; user-select: none;
    }
    #homeBar .hbTop { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 4px; }
    #homeBar .hbTitle { font-size: 14px; font-weight: 700; color: #ffe0a8; text-shadow: 0 1px 2px #000; }
    #homeBar .hbWave { font-size: 12px; font-weight: 800; letter-spacing: 0.06em; color: #ffb454; text-shadow: 0 1px 2px #000; }
    #homeBar .hbTrack {
      position: relative; height: 16px; border-radius: 8px; overflow: hidden;
      background: #1c1f27; border: 1px solid #00000088;
    }
    #homeBar .hbFill { height: 100%; width: 100%; background: #54d98c; border-radius: 8px 0 0 8px; transition: width 0.25s ease, background 0.4s ease; }
    #homeBar .hbHp {
      position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
      font-size: 11px; font-weight: 700; color: #fff; text-shadow: 0 1px 2px #000, 0 0 3px #000;
    }
    #homeBar .hbSub { margin-top: 3px; text-align: center; font-size: 11px; color: #cdd3e0; opacity: 0.85; text-shadow: 0 1px 2px #000; }
    #homeBar.hbLow { animation: hbPulse 0.9s ease-in-out infinite; }
    #homeBar.hbDead { border-color: #7a2b22; }
    #homeBar.hbDead .hbTitle { color: #ff8b7a; }
    body.preGame #homeBar { display: none !important; } /* hidden on the splash, shown in-game */
    @keyframes hbPulse { 0%,100% { box-shadow: 0 4px 18px rgba(0,0,0,0.55), inset 0 0 16px rgba(0,0,0,0.5); } 50% { box-shadow: 0 0 16px 3px rgba(224,86,63,0.55), inset 0 0 16px rgba(0,0,0,0.5); } }
    /* (the identity badge now lives lower-left, above the health orb — see index.html) */
    /* full-screen defeat flash when La Crypta falls (a wipe) */
    #hbBanner { position: fixed; top: 30%; left: 50%; transform: translate(-50%,-50%); z-index: 60; text-align: center; pointer-events: none; opacity: 0; }
    body.preGame #hbBanner { display: none !important; }
    #hbBanner.hbbShow { animation: hbbFlash 4.5s ease-out forwards; }
    #hbBanner .hbbTitle { font: 800 38px system-ui, sans-serif; color: #ff6a4d; text-shadow: 0 2px 8px #000, 0 0 18px rgba(224,60,40,0.7); letter-spacing: 0.02em; }
    #hbBanner .hbbSub { margin-top: 8px; font: 600 16px system-ui, sans-serif; color: #ffe0a8; text-shadow: 0 2px 6px #000; }
    @keyframes hbbFlash { 0% { opacity: 0; transform: translate(-50%,-58%) scale(0.9); } 12% { opacity: 1; transform: translate(-50%,-50%) scale(1); } 80% { opacity: 1; } 100% { opacity: 0; } }
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}
