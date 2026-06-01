/**
 * Diablo-style health orb (DOM/CSS overlay). The red "liquid" drains from the
 * top as HP drops; a low-HP class adds a pulse. Driven from the local player's
 * synced HP each frame.
 */
export class HealthGlobe {
  private el: HTMLElement;
  private liquid: HTMLElement;
  private text: HTMLElement;
  private lastRatio = -1;
  private lastLabel = "";

  constructor() {
    this.el = document.getElementById("healthGlobe") as HTMLElement;
    this.liquid = document.getElementById("hgLiquid") as HTMLElement;
    this.text = document.getElementById("hgText") as HTMLElement;
  }

  set(hp: number, maxHp: number) {
    const ratio = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 0;
    if (Math.abs(ratio - this.lastRatio) > 0.001) {
      this.liquid.style.height = (ratio * 100).toFixed(1) + "%";
      this.el.classList.toggle("low", ratio > 0 && ratio <= 0.3);
      this.lastRatio = ratio;
    }
    const label = `${Math.max(0, Math.round(hp))}/${Math.round(maxHp)}`;
    if (label !== this.lastLabel) {
      this.text.textContent = label;
      this.lastLabel = label;
    }
  }
}
