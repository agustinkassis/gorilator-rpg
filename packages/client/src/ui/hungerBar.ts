/**
 * Ring hunger meter around the health orb. Hovering the hunger ring reveals
 * the detailed horizontal bar; low/empty states warn before starvation hurts HP.
 */
export class HungerBar {
  private wrap: HTMLElement;
  private detail: HTMLElement;
  private fill: HTMLElement;
  private text: HTMLElement;
  private lastRatio = -1;
  private lastLabel = "";
  private initialized = false;
  private displayedHunger = 0;
  private syncedHunger = 0;
  private syncedMaxHunger = 100;
  private foodAnim: { from: number; to: number; startMs: number; durationMs: number } | null = null;

  constructor() {
    this.wrap = document.getElementById("hungerBar") as HTMLElement;
    this.detail = document.getElementById("hungerDetail") as HTMLElement;
    this.fill = document.getElementById("hungerFill") as HTMLElement;
    this.text = document.getElementById("hungerText") as HTMLElement;
    this.wrap.addEventListener("pointerenter", () => this.setDetailVisible(true));
    this.wrap.addEventListener("pointerleave", () => this.setDetailVisible(false));
    this.wrap.addEventListener("focus", () => this.setDetailVisible(true));
    this.wrap.addEventListener("blur", () => this.setDetailVisible(false));
  }

  animateFood(fromHunger: number, toHunger: number, durationMs = 4000) {
    const max = Math.max(1, this.syncedMaxHunger);
    const to = Math.max(0, Math.min(max, Number(toHunger) || 0));
    const from = Math.max(0, Math.min(max, Number(fromHunger) || 0));
    if (to <= from) return;
    const start = this.initialized && this.displayedHunger < to ? this.displayedHunger : from;
    this.foodAnim = {
      from: Math.max(0, Math.min(to, start)),
      to,
      startMs: performance.now(),
      durationMs: Math.max(250, Number(durationMs) || 4000),
    };
    this.render(this.foodAnim.from, max);
  }

  set(hunger: number, maxHunger: number) {
    const safeMax = Math.max(1, Number(maxHunger) || 1);
    const safeHunger = Math.max(0, Math.min(safeMax, Number(hunger) || 0));
    this.syncedHunger = safeHunger;
    this.syncedMaxHunger = safeMax;
    if (!this.initialized) {
      this.initialized = true;
      this.displayedHunger = safeHunger;
    }

    const displayHunger = this.foodAnim
      ? this.foodDisplayHunger(performance.now(), safeHunger)
      : safeHunger;
    this.render(displayHunger, safeMax);
  }

  private foodDisplayHunger(now: number, syncedHunger: number): number {
    const anim = this.foodAnim;
    if (!anim) return syncedHunger;
    const t = Math.max(0, Math.min(1, (now - anim.startMs) / anim.durationMs));
    if (t >= 1) {
      this.foodAnim = null;
      this.displayedHunger = syncedHunger;
      return syncedHunger;
    }
    const target = syncedHunger > anim.from + 0.01 ? syncedHunger : anim.to;
    if (target <= anim.from) {
      this.foodAnim = null;
      this.displayedHunger = syncedHunger;
      return syncedHunger;
    }
    return anim.from + (target - anim.from) * t;
  }

  private render(hunger: number, maxHunger: number) {
    this.displayedHunger = Math.max(0, Math.min(Math.max(1, maxHunger), hunger));
    const ratio = maxHunger > 0 ? Math.max(0, Math.min(1, this.displayedHunger / maxHunger)) : 0;
    this.wrap.setAttribute("aria-valuenow", String(Math.round(this.displayedHunger)));
    this.wrap.setAttribute("aria-valuemax", String(Math.max(1, Math.round(maxHunger))));
    if (Math.abs(ratio - this.lastRatio) > 0.002) {
      this.wrap.style.setProperty("--hunger-angle", `${(ratio * 360).toFixed(1)}deg`);
      this.fill.style.width = (ratio * 100).toFixed(1) + "%";
      this.wrap.classList.toggle("low", ratio > 0 && ratio <= 0.2);
      this.wrap.classList.toggle("empty", ratio <= 0);
      this.lastRatio = ratio;
    }
    const label = `${Math.max(0, Math.round(this.displayedHunger))}/${Math.round(maxHunger)}`;
    if (label !== this.lastLabel) {
      this.text.textContent = label;
      this.lastLabel = label;
    }
  }

  private setDetailVisible(visible: boolean) {
    this.detail.style.visibility = visible ? "visible" : "";
  }
}
