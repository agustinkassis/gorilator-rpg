import { xpForLevel } from "@rpg/shared";

/**
 * Bottom XP / level bar. Shows the current level and progress toward the next,
 * with a one-shot "LEVEL UP!" flourish whenever the level increases.
 */
export class XpBar {
  private bar: HTMLElement;
  private fill: HTMLElement;
  private text: HTMLElement;
  private levelUp: HTMLElement;
  private lossAlert: HTMLElement;
  private lastLevel = -1;
  private lastRatio = -1;
  private lastLabel = "";
  private lastTotalXp = -1;
  private lossTimer: number | undefined;

  constructor() {
    this.bar = document.getElementById("xpBar") as HTMLElement;
    this.fill = document.getElementById("xpFill") as HTMLElement;
    this.text = document.getElementById("xpText") as HTMLElement;
    this.levelUp = document.getElementById("xpLevelUp") as HTMLElement;
    this.lossAlert = document.getElementById("xpLossAlert") as HTMLElement;
  }

  set(level: number, xp: number) {
    const need = xpForLevel(level);
    const ratio = need > 0 ? Math.max(0, Math.min(1, xp / need)) : 0;
    const total = this.totalXp(level, xp);
    if (this.lastTotalXp >= 0 && total < this.lastTotalXp - 0.5) {
      this.flashXpLoss(Math.round(this.lastTotalXp - total));
    }
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
    this.lastTotalXp = total;
  }

  private flashLevelUp(level: number) {
    this.levelUp.textContent = `LEVEL UP!  Lv. ${level}`;
    this.levelUp.classList.remove("show");
    void this.levelUp.offsetWidth; // force reflow so the CSS animation restarts
    this.levelUp.classList.add("show");
  }

  private totalXp(level: number, xp: number): number {
    let total = Math.max(0, xp);
    for (let l = 1; l < Math.max(1, level); l++) total += xpForLevel(l);
    return total;
  }

  private flashXpLoss(amount: number) {
    if (amount <= 0) return;
    this.bar.classList.add("loss");
    this.fill.classList.add("loss");
    this.lossAlert.textContent = `-${amount.toLocaleString()} EXP lost`;
    this.lossAlert.classList.remove("show");
    void this.lossAlert.offsetWidth; // force reflow so the CSS animation restarts
    this.lossAlert.classList.add("show");
    if (this.lossTimer !== undefined) window.clearTimeout(this.lossTimer);
    this.lossTimer = window.setTimeout(() => {
      this.bar.classList.remove("loss");
      this.fill.classList.remove("loss");
      this.lossAlert.classList.remove("show");
      this.lossTimer = undefined;
    }, 1400);
  }
}
