import { xpForLevel } from "@rpg/shared";

/**
 * Bottom XP / level bar. Shows the current level and progress toward the next,
 * with a one-shot "LEVEL UP!" flourish whenever the level increases.
 */
export class XpBar {
  private fill: HTMLElement;
  private text: HTMLElement;
  private levelUp: HTMLElement;
  private lastLevel = -1;
  private lastRatio = -1;
  private lastLabel = "";

  constructor() {
    this.fill = document.getElementById("xpFill") as HTMLElement;
    this.text = document.getElementById("xpText") as HTMLElement;
    this.levelUp = document.getElementById("xpLevelUp") as HTMLElement;
  }

  set(level: number, xp: number) {
    const need = xpForLevel(level);
    const ratio = need > 0 ? Math.max(0, Math.min(1, xp / need)) : 0;
    if (Math.abs(ratio - this.lastRatio) > 0.002) {
      this.fill.style.width = (ratio * 100).toFixed(1) + "%";
      this.lastRatio = ratio;
    }
    const label = `Lv. ${level} · ${Math.floor(xp)} / ${need} XP`;
    if (label !== this.lastLabel) {
      this.text.textContent = label;
      this.lastLabel = label;
    }
    // celebrate a level-up (skip the very first set, which just sets the baseline)
    if (this.lastLevel !== -1 && level > this.lastLevel) this.flashLevelUp(level);
    this.lastLevel = level;
  }

  private flashLevelUp(level: number) {
    this.levelUp.textContent = `LEVEL UP!  Lv. ${level}`;
    this.levelUp.classList.remove("show");
    void this.levelUp.offsetWidth; // force reflow so the CSS animation restarts
    this.levelUp.classList.add("show");
  }
}
