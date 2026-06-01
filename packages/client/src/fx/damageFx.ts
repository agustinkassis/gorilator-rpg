/**
 * Full-screen "you're getting hurt" feedback for the LOCAL player:
 *  - a transient red flash + camera shake on each hit (∝ damage taken), and
 *  - a persistent low-HP vignette that desaturates the world to black-and-white,
 *    dims it and bleeds red — getting more aggressive the lower your HP, until at
 *    death everything is red.
 *
 * Done with a single fullscreen DOM layer over the canvas: `backdrop-filter`
 * grayscales + dims the WebGL canvas behind it, and a red background paints the
 * overlay/flash on top. The HUD (separate DOM, higher z-index) stays readable.
 * Camera shake is a cheap CSS transform on the canvas, decoupled from Babylon.
 */
const MAX_SHAKE_PX = 16; // peak camera-shake displacement at full strength
const FLASH_DECAY = 1 / 0.4; // red flash fades over ~0.4s
const SHAKE_DECAY = 1 / 0.35; // shake settles over ~0.35s

export class DamageFx {
  private overlay: HTMLDivElement;
  private canvas: HTMLElement;
  private low = 0; // smoothed 0..1 severity (1 = near death)
  private targetLow = 0;
  private flash = 0; // transient red flash 0..1
  private shake = 0; // transient shake 0..1

  constructor(canvas: HTMLElement) {
    this.canvas = canvas;
    const d = document.createElement("div");
    // below the HUD layers (damage numbers z25, chat z24) so the UI stays crisp,
    // above the canvas so it tints the world.
    d.style.cssText =
      "position:fixed; inset:0; pointer-events:none; z-index:15; display:none;" +
      "will-change:backdrop-filter,background;";
    document.body.appendChild(d);
    this.overlay = d;
  }

  /** A hit landed on the local player; `dmgFrac` = damage / maxHp. */
  onHit(dmgFrac: number) {
    const k = Math.max(0.12, Math.min(0.85, dmgFrac * 2.2));
    this.flash = Math.min(1, this.flash + k);
    this.shake = Math.min(1, this.shake + k);
  }

  /** Local-player HP → drives the persistent low-HP effect (smoothed in update). */
  setHp(hp: number, maxHp: number) {
    this.targetLow = maxHp > 0 ? Math.max(0, Math.min(1, 1 - hp / maxHp)) : 1;
  }

  update(dt: number) {
    // ease the persistent severity toward the current HP (a slow brightness/desat shift)
    this.low += (this.targetLow - this.low) * Math.min(1, dt * 4);
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * FLASH_DECAY);
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * SHAKE_DECAY);

    const low = this.low;
    const active = low > 0.01 || this.flash > 0.01;
    if (active) {
      const gray = low; // black & white as HP drops
      const bright = 1 - low * 0.55; // dim toward ~45% near death
      const redA = Math.min(0.21, low * 0.125 + this.flash * 0.15); // persistent red + hit flash (halved again)
      const filter = `grayscale(${gray.toFixed(3)}) brightness(${bright.toFixed(3)})`;
      this.overlay.style.display = "block";
      this.overlay.style.backdropFilter = filter;
      this.overlay.style.setProperty("-webkit-backdrop-filter", filter);
      this.overlay.style.background = `rgba(175, 14, 14, ${redA.toFixed(3)})`;
    } else if (this.overlay.style.display !== "none") {
      this.overlay.style.display = "none";
    }

    // camera shake — jitter the canvas (a touch of scale hides the exposed edges)
    if (this.shake > 0.001) {
      const a = this.shake * MAX_SHAKE_PX;
      const jx = (Math.random() * 2 - 1) * a;
      const jy = (Math.random() * 2 - 1) * a;
      this.canvas.style.transform = `translate(${jx.toFixed(1)}px, ${jy.toFixed(1)}px) scale(1.04)`;
    } else if (this.canvas.style.transform) {
      this.canvas.style.transform = "";
    }
  }
}
