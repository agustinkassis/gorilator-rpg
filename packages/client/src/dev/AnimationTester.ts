import type { AnimState } from "@rpg/shared";
import type { AnimationDebugClip } from "../entities/Entity";

interface AnimationTesterDeps {
  getClips: () => AnimationDebugClip[];
  playClip: (state: AnimState) => boolean;
  clearClip: () => void;
}

export class AnimationTester {
  private visible = false;
  private active = false;
  private current: AnimState | null = null;
  private btn: HTMLButtonElement;
  private panel: HTMLElement;
  private list: HTMLElement;
  private status: HTMLElement;

  constructor(private deps: AnimationTesterDeps) {
    const btn = document.createElement("button");
    btn.id = "animTestBtn";
    btn.textContent = "Anim Test";
    btn.title = "Toggle local animation test keys";
    btn.style.cssText =
      "position:fixed; right:16px; bottom:348px; z-index:40; cursor:pointer; display:none;" +
      "background:#2a3242; color:#b8d8ff; border:1px solid #5a85ba; border-radius:6px;" +
      "padding:6px 10px; font:12px system-ui,sans-serif;";
    btn.onclick = () => this.toggle();
    document.body.appendChild(btn);
    this.btn = btn;

    const panel = document.createElement("div");
    panel.id = "animTesterPanel";
    panel.style.cssText =
      "position:fixed; right:16px; bottom:384px; width:300px; z-index:47; display:none;" +
      "background:#10131af2; border:2px solid #5a85ba; border-radius:10px; color:#e8e8e8;" +
      "font:12px/1.4 system-ui,sans-serif; box-shadow:0 8px 30px #000a; overflow:hidden;";
    panel.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:7px 12px; background:#1c2230; border-bottom:1px solid #5a85ba;">
        <b style="color:#b8d8ff;">Animation Test</b>
        <button id="animTestClose" style="cursor:pointer; background:#22334a; color:#fff; border:1px solid #5a85ba; border-radius:4px; padding:2px 8px;">x</button>
      </div>
      <div style="padding:10px 12px; display:flex; flex-direction:column; gap:8px;">
        <div id="animTestList" style="display:flex; flex-direction:column; gap:5px;"></div>
        <div id="animTestStatus" style="min-height:14px; color:#9fb0c0; font-size:11px;"></div>
      </div>`;
    document.body.appendChild(panel);
    this.panel = panel;
    this.list = panel.querySelector("#animTestList") as HTMLElement;
    this.status = panel.querySelector("#animTestStatus") as HTMLElement;
    (panel.querySelector("#animTestClose") as HTMLButtonElement).onclick = () => this.setActive(false);

    window.addEventListener("keydown", this.onKeyDown, true);
  }

  setVisible(on: boolean) {
    this.visible = on;
    // The standalone button is retired — Anim Test now launches from the Dev Mode
    // Tools window — but `visible` still gates whether the panel may open.
    this.btn.style.display = "none";
    if (!on) this.setActive(false);
  }

  /** Open/close the tester panel (called by the Dev Mode Tools window). */
  toggle() {
    this.setActive(!this.active);
  }

  private setActive(on: boolean) {
    if (on && !this.visible) return;
    if (on === this.active) return;
    this.active = on;
    this.btn.style.background = on ? "#305984" : "#2a3242";
    this.btn.style.color = on ? "#fff" : "#b8d8ff";
    this.btn.setAttribute("aria-pressed", String(on));
    this.panel.style.display = on ? "block" : "none";
    if (on) {
      this.renderClips();
    } else {
      this.current = null;
      this.deps.clearClip();
      this.status.textContent = "";
    }
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (!this.active || isTypingTarget(e.target)) return;
    const index = Number(e.key) - 1;
    if (!Number.isInteger(index) || index < 0 || index > 5) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.playIndex(index);
  };

  private playIndex(index: number) {
    const clip = this.deps.getClips()[index];
    if (!clip) {
      this.current = null;
      this.status.textContent = "No clip";
      this.renderClips();
      return;
    }
    if (!this.deps.playClip(clip.state)) {
      this.status.textContent = "No local target";
      return;
    }
    this.current = clip.state;
    this.status.textContent = `${index + 1} ${clip.label}`;
    this.renderClips();
  }

  private renderClips() {
    const clips = this.deps.getClips().slice(0, 6);
    this.list.innerHTML = "";
    for (let i = 0; i < 6; i++) {
      const clip = clips[i] ?? null;
      const row = document.createElement("button");
      row.type = "button";
      row.disabled = !clip;
      row.style.cssText =
        "display:grid; grid-template-columns:24px 1fr; align-items:center; gap:8px; width:100%;" +
        "cursor:pointer; text-align:left; background:#182131; color:#e8e8e8; border:1px solid #2f4663;" +
        "border-radius:5px; padding:5px 7px; font:12px system-ui,sans-serif;";
      if (!clip) {
        row.style.opacity = "0.45";
        row.style.cursor = "default";
      } else if (clip.state === this.current) {
        row.style.background = "#305984";
        row.style.borderColor = "#86b6ee";
      }
      const key = document.createElement("span");
      key.textContent = String(i + 1);
      key.style.cssText =
        "display:inline-flex; align-items:center; justify-content:center; width:22px; height:20px;" +
        "border-radius:4px; background:#0d121b; color:#b8d8ff; font:bold 11px monospace;";
      const label = document.createElement("span");
      label.textContent = clip?.label ?? "-";
      label.style.cssText = "min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;";
      row.append(key, label);
      row.onclick = () => this.playIndex(i);
      this.list.appendChild(row);
    }
    if (!clips.length) this.status.textContent = "No local clips";
  }
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}
