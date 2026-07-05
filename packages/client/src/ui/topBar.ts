/**
 * TopBar: a persistent top-centre HUD showing the home ("La
 * Crypta") HP and the wave state, visible to every player at all times. Fed each
 * frame from the synced House + wave fields (see main.ts).
 */
export class TopBar {
  private root: HTMLDivElement;
  private title: HTMLDivElement;
  private wave: HTMLDivElement;
  private fill: HTMLDivElement;
  private hpText: HTMLDivElement;
  private sub: HTMLDivElement;
  private fallen = false;
  private lastCountdownSecond: number | null = null;

  constructor() {
    injectStyles();
    this.root = document.createElement("div");
    this.root.id = "topBar";

    const top = document.createElement("div");
    top.className = "tbRow tbHead";
    this.title = document.createElement("div");
    this.title.className = "tbTitle";
    this.title.textContent = "La Crypta";
    const divider = document.createElement("div");
    divider.className = "tbDivider";
    divider.textContent = "-";
    this.wave = document.createElement("div");
    this.wave.className = "tbWave";
    this.wave.textContent = "";
    top.append(this.title, divider, this.wave);

    const track = document.createElement("div");
    track.className = "tbTrack";
    this.fill = document.createElement("div");
    this.fill.className = "tbFill";
    this.hpText = document.createElement("div");
    this.hpText.className = "tbHp";
    track.append(this.fill, this.hpText);

    this.sub = document.createElement("div");
    this.sub.className = "tbRow tbCountdownSlot";

    this.root.append(top, track, this.sub);
    document.body.appendChild(this.root);
  }

  /** Hide the whole banner when no event module runs (open sandbox / scenario
   *  lab): there is no objective or wave clock to report. */
  setVisible(on: boolean) {
    this.root.style.display = on ? "" : "none";
  }

  /** Update the home's HP bar (alive=false → collapsed). */
  setHouse(hp: number, maxHp: number, alive: boolean) {
    if (maxHp <= 0) {
      // Dev-set indestructible structure (HP 0): always standing, no destructible bar.
      if (this.fallen) {
        this.fallen = false;
        this.root.classList.remove("tbDead");
      }
      this.title.textContent = "La Crypta";
      this.wave.textContent = "shielded";
      this.fill.style.width = "100%";
      this.fill.style.background = "#54d98c";
      this.root.classList.remove("tbLow");
      this.hpText.textContent = "∞";
      return;
    }
    if (!alive || hp <= 0) {
      if (!this.fallen) {
        this.fallen = true;
        this.title.textContent = "La Crypta";
        this.wave.textContent = "fallen";
        this.root.classList.add("tbDead");
      }
      this.fill.style.width = "0%";
      this.hpText.textContent = "0 / " + Math.round(maxHp);
      return;
    }
    if (this.fallen) {
      this.fallen = false;
      this.title.textContent = "La Crypta";
      this.root.classList.remove("tbDead");
    }
    const frac = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 0;
    this.fill.style.width = (frac * 100).toFixed(1) + "%";
    // green → amber → red as the home is worn down; pulse when critical
    const color = frac > 0.5 ? "#54d98c" : frac > 0.25 ? "#e0b341" : "#e0563f";
    this.fill.style.background = color;
    this.root.classList.toggle("tbLow", frac <= 0.25);
    this.hpText.textContent = `${Math.ceil(hp)} / ${Math.round(maxHp)}`;
  }

  /** Update the wave label + countdown to the next wave. */
  setWave(waveNumber: number, msToNext: number) {
    if (this.fallen) {
      this.clearCountdownMode();
      this.wave.textContent = "";
      this.sub.textContent = "the horde overran the gate";
      return;
    }
    const secs = Math.max(0, Math.ceil(msToNext / 1000));
    const t =
      secs >= 60 ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}` : `${secs}s`;
    if (waveNumber <= 0) {
      this.wave.textContent = "WAVE 1";
    } else {
      this.wave.textContent = `WAVE ${waveNumber}`;
    }
    if (secs <= 30) {
      this.showCountdownSecond(secs);
      return;
    }
    this.clearCountdownMode();
    this.sub.textContent = waveNumber <= 0 ? `first wave in ${t}` : `next wave in ${t}`;
  }

  private showCountdownSecond(secs: number) {
    const final = secs <= 10;
    const size = final ? 48 + (10 - secs) * 4 : 28 + (30 - secs) * 0.8;
    this.sub.textContent = String(secs);
    this.sub.style.setProperty("--tbCountdownSize", `${Math.round(size)}px`);
    this.sub.style.setProperty("--tbCountdownSlot", `${Math.round(size + 8)}px`);
    this.sub.classList.add("tbCountdown");
    this.sub.classList.toggle("tbFinalCountdown", final);
    if (this.lastCountdownSecond === secs) return;
    this.lastCountdownSecond = secs;
    this.sub.classList.remove("tbTick");
    void this.sub.offsetWidth;
    this.sub.classList.add("tbTick");
  }

  private clearCountdownMode() {
    this.lastCountdownSecond = null;
    this.sub.classList.remove("tbCountdown", "tbFinalCountdown", "tbTick");
    this.sub.style.removeProperty("--tbCountdownSize");
    this.sub.style.removeProperty("--tbCountdownSlot");
  }

  /** Brief full-screen defeat flash when La Crypta falls and the realm resets.
   *  Under the default policy progression persists, so the copy reassures
   *  instead of threatening a wipe. */
  flashDefeat(wave: number, persist = false) {
    let b = document.getElementById("hbBanner");
    if (!b) {
      b = document.createElement("div");
      b.id = "hbBanner";
      document.body.appendChild(b);
    }
    const outcome = persist ? "the world resets — your character endures" : "the realm resets to level 1";
    b.innerHTML =
      `<div class="hbbTitle">🏛 La Crypta has fallen</div>` +
      `<div class="hbbSub">survived ${wave} wave${wave === 1 ? "" : "s"} · ${outcome}</div>`;
    b.classList.remove("hbbShow");
    void b.offsetWidth; // reflow so the animation restarts on a repeat wipe
    b.classList.add("hbbShow");
  }

  /** Big center-screen wave callout when a new horde starts. */
  flashWave(wave: number) {
    let b = document.getElementById("waveBanner");
    if (!b) {
      b = document.createElement("div");
      b.id = "waveBanner";
      document.body.appendChild(b);
    }
    b.innerHTML = `<div class="wbTitle">WAVE ${Math.max(1, Math.round(wave))}</div><div class="wbSub">INCOMING</div>`;
    b.classList.remove("wbShow");
    void b.offsetWidth;
    b.classList.add("wbShow");
  }
}

let injected = false;
function injectStyles() {
  if (injected) return;
  injected = true;
  const css = `
    #topBar {
      position: fixed; top: 8px; left: 50%; transform: translateX(-50%);
      z-index: 32; width: 390px; max-width: 86vw; padding: 8px 12px;
      display: grid; grid-template-rows: 22px 16px auto; row-gap: 6px; align-items: center;
      background: linear-gradient(180deg, rgba(24,17,10,0.92), rgba(13,9,6,0.92));
      border: 2px solid #6b4f2e; border-radius: 10px;
      box-shadow: 0 4px 18px rgba(0,0,0,0.55), inset 0 0 16px rgba(0,0,0,0.5);
      font-family: system-ui, sans-serif; pointer-events: none; user-select: none;
    }
    #topBar .tbRow { min-width: 0; display: flex; align-items: center; justify-content: center; }
    #topBar .tbHead {
      display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
      column-gap: 10px; align-items: center;
    }
    #topBar .tbTitle {
      justify-self: end; font-size: 15px; font-weight: 800; color: #ffe0a8;
      text-shadow: 0 1px 2px #000; white-space: nowrap;
    }
    #topBar .tbDivider { justify-self: center; font-size: 14px; font-weight: 900; color: #a88958; text-shadow: 0 1px 2px #000; }
    #topBar .tbWave {
      justify-self: start; font-size: 13px; font-weight: 900; letter-spacing: 0.04em;
      color: #ffb454; text-shadow: 0 1px 2px #000; text-transform: uppercase; white-space: nowrap;
    }
    #topBar .tbTrack {
      position: relative; height: 16px; width: 100%; border-radius: 8px; overflow: hidden;
      background: #1c1f27; border: 1px solid #00000088;
    }
    #topBar .tbFill { height: 100%; width: 100%; background: #54d98c; border-radius: 8px 0 0 8px; transition: width 0.25s ease, background 0.4s ease; }
    #topBar .tbHp {
      position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
      font-size: 11px; font-weight: 700; color: #fff; text-shadow: 0 1px 2px #000, 0 0 3px #000;
    }
    #topBar .tbCountdownSlot {
      height: 18px; text-align: center; font-size: 11px; line-height: 1;
      color: #cdd3e0; opacity: 0.85; text-shadow: 0 1px 2px #000;
      transform-origin: center; transition: color 0.16s ease, font-size 0.16s ease, height 0.16s ease;
    }
    #topBar .tbCountdownSlot.tbCountdown {
      height: var(--tbCountdownSlot, 36px); font-size: var(--tbCountdownSize, 28px);
      font-weight: 1000; color: #ffd479; opacity: 1; letter-spacing: 0;
      line-height: 0.9;
      text-shadow: 0 2px 4px #000, 0 0 12px rgba(255, 180, 60, 0.55);
    }
    #topBar .tbCountdownSlot.tbFinalCountdown {
      color: #ff6a4d;
      text-shadow: 0 2px 5px #000, 0 0 18px rgba(255, 80, 40, 0.72), 0 0 34px rgba(255, 160, 30, 0.34);
    }
    #topBar .tbCountdownSlot.tbTick { animation: tbCountdownBounce 0.38s cubic-bezier(0.17, 0.92, 0.24, 1.28); }
    #topBar.tbLow { animation: tbPulse 0.9s ease-in-out infinite; }
    #topBar.tbDead { border-color: #7a2b22; }
    #topBar.tbDead .tbTitle, #topBar.tbDead .tbWave { color: #ff8b7a; }
    body.preGame #topBar { display: none !important; } /* hidden on the splash, shown in-game */
    @keyframes tbPulse { 0%,100% { box-shadow: 0 4px 18px rgba(0,0,0,0.55), inset 0 0 16px rgba(0,0,0,0.5); } 50% { box-shadow: 0 0 16px 3px rgba(224,86,63,0.55), inset 0 0 16px rgba(0,0,0,0.5); } }
    @keyframes tbCountdownBounce {
      0% { transform: scale(0.74); filter: brightness(1.35); }
      54% { transform: scale(1.28); filter: brightness(1.15); }
      100% { transform: scale(1); filter: brightness(1); }
    }
    /* (the identity badge now lives lower-left, above the health orb — see index.html) */
    /* full-screen defeat flash when La Crypta falls (a wipe) */
    #hbBanner { position: fixed; top: 30%; left: 50%; transform: translate(-50%,-50%); z-index: 60; text-align: center; pointer-events: none; opacity: 0; }
    body.preGame #hbBanner { display: none !important; }
    #hbBanner.hbbShow { animation: hbbFlash 4.5s ease-out forwards; }
    #hbBanner .hbbTitle { font: 800 38px system-ui, sans-serif; color: #ff6a4d; text-shadow: 0 2px 8px #000, 0 0 18px rgba(224,60,40,0.7); letter-spacing: 0.02em; }
    #hbBanner .hbbSub { margin-top: 8px; font: 600 16px system-ui, sans-serif; color: #ffe0a8; text-shadow: 0 2px 6px #000; }
    @keyframes hbbFlash { 0% { opacity: 0; transform: translate(-50%,-58%) scale(0.9); } 12% { opacity: 1; transform: translate(-50%,-50%) scale(1); } 80% { opacity: 1; } 100% { opacity: 0; } }
    #waveBanner {
      position: fixed; inset: 0; z-index: 58; display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      pointer-events: none; user-select: none; opacity: 0; font-family: system-ui, sans-serif;
    }
    body.preGame #waveBanner { display: none !important; }
    #waveBanner.wbShow { animation: wbWrap 3.2s ease-out forwards; }
    #waveBanner .wbTitle {
      font-size: clamp(56px, 11vw, 132px); line-height: 0.9; font-weight: 900;
      color: #ffd166; text-shadow: 0 4px 0 #5b2116, 0 8px 22px #000, 0 0 28px rgba(255,95,46,0.9);
      transform: skewX(-6deg);
    }
    #waveBanner .wbSub {
      margin-top: 12px; text-align: center; font-size: clamp(18px, 3vw, 34px); line-height: 1;
      font-weight: 900; color: #ff6b35; text-shadow: 0 2px 8px #000, 0 0 18px rgba(255,90,40,0.85);
    }
    @keyframes wbWrap {
      0% { opacity: 0; transform: scale(1.35) translateY(-34px); filter: blur(6px); }
      14% { opacity: 1; transform: scale(1) translateY(0); filter: blur(0); }
      24% { transform: scale(1.06) translateY(0); }
      34% { transform: scale(1) translateY(0); }
      78% { opacity: 1; }
      100% { opacity: 0; transform: scale(0.92) translateY(28px); filter: blur(2px); }
    }

    /* Dev Mode: the top bar animates into a compact, minified version (narrower,
       smaller header + thinner HP bar, and the wave countdown row collapses away)
       so it stays out of the way while editing. Toggled by body.devMode. */
    #topBar { transition: width .3s ease, padding .3s ease, row-gap .3s ease, grid-template-rows .3s ease; }
    #topBar .tbTitle, #topBar .tbWave, #topBar .tbHp { transition: font-size .24s ease; }
    #topBar .tbTrack { transition: height .26s ease; }
    #topBar .tbCountdownSlot {
      max-height: 110px;
      transition: color .16s ease, font-size .16s ease, height .16s ease, max-height .3s ease, opacity .24s ease;
    }
    body.devMode #topBar {
      width: 300px; padding: 5px 11px; row-gap: 3px; grid-template-rows: 17px 10px auto;
    }
    body.devMode #topBar .tbTitle { font-size: 12px; }
    body.devMode #topBar .tbWave { font-size: 10px; }
    body.devMode #topBar .tbTrack { height: 10px; }
    body.devMode #topBar .tbHp { font-size: 9px; }
    body.devMode #topBar .tbCountdownSlot { max-height: 0; opacity: 0; overflow: hidden; }
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}
