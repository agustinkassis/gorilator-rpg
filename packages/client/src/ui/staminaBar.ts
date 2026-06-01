/**
 * Green stamina bar (sits just above the hotkey bar). Refills over time and
 * drains while sprinting (hold SPACE). Driven from the local player's synced
 * stamina each frame; turns amber when nearly empty as a "winded" warning.
 */
export class StaminaBar {
  private wrap: HTMLElement;
  private fill: HTMLElement;
  private lastRatio = -1;

  constructor() {
    this.wrap = document.getElementById("staminaBar") as HTMLElement;
    this.fill = document.getElementById("staminaFill") as HTMLElement;
  }

  set(stamina: number, maxStamina: number) {
    const ratio = maxStamina > 0 ? Math.max(0, Math.min(1, stamina / maxStamina)) : 0;
    if (Math.abs(ratio - this.lastRatio) <= 0.002) return;
    this.fill.style.width = (ratio * 100).toFixed(1) + "%";
    this.wrap.classList.toggle("low", ratio <= 0.15); // amber warning when nearly spent
    this.lastRatio = ratio;
  }
}
