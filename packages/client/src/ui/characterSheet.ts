import {
  xpForLevel,
  HP_PER_LEVEL,
  ATTACK_PER_LEVEL,
  ARMOR_PER_LEVEL,
  CRIT_PER_LEVEL,
  SPEED_PER_LEVEL,
  THROW_POWER_PER_LEVEL,
} from "@rpg/shared";

export interface CharStats {
  name: string;
  level: number;
  xp: number;
  hp: number;
  maxHp: number;
  attack: number;
  armor: number;
  critChance: number;
  moveSpeed: number;
  throwPower: number;
}

/** The "Character (C)" sheet: the local player's complete stats for their level. */
export class CharacterSheet {
  private panel: HTMLElement;
  private body: HTMLElement;
  private open = false;
  private lastSig = "";

  constructor() {
    const btn = document.createElement("button");
    btn.textContent = "📊 Character (C)";
    btn.style.cssText =
      "position:fixed; right:16px; bottom:96px; z-index:40; cursor:pointer;" +
      "background:#2a3242; color:#f0d27a; border:1px solid #c9a24a; border-radius:6px;" +
      "padding:6px 10px; font:12px system-ui,sans-serif;";
    btn.onclick = () => this.toggle();
    document.body.appendChild(btn);

    const panel = document.createElement("div");
    panel.style.cssText =
      "position:fixed; right:16px; top:56px; width:280px; z-index:50;" +
      "background:#10131af2; border:2px solid #c9a24a; border-radius:10px; display:none;" +
      "box-shadow:0 8px 30px #000a; color:#e8e8e8; font:13px/1.5 system-ui,sans-serif; overflow:hidden;";
    panel.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 12px; background:#1c2230; border-bottom:1px solid #c9a24a;">
        <b style="color:#f0d27a;">Character</b>
        <button id="charSheetClose" style="cursor:pointer; background:#3a2230; color:#fff; border:1px solid #c9a24a; border-radius:4px; padding:2px 8px;">✕</button>
      </div>
      <div id="charSheetBody" style="padding:12px 14px;"></div>`;
    document.body.appendChild(panel);
    this.panel = panel;
    this.body = panel.querySelector("#charSheetBody") as HTMLElement;
    (panel.querySelector("#charSheetClose") as HTMLElement).onclick = () => this.toggle();

    window.addEventListener("keydown", (e) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "c" || e.key === "C") this.toggle();
    });
  }

  toggle() {
    this.open = !this.open;
    this.panel.style.display = this.open ? "block" : "none";
    this.lastSig = ""; // force a redraw next set()
  }

  set(s: CharStats) {
    if (!this.open) return;
    const need = xpForLevel(s.level);
    const sig = `${s.name}|${s.level}|${Math.floor(s.xp)}|${Math.round(s.hp)}|${Math.round(s.maxHp)}|${s.attack}|${s.armor}|${s.critChance}|${s.moveSpeed.toFixed(2)}|${s.throwPower.toFixed(2)}`;
    if (sig === this.lastSig) return;
    this.lastSig = sig;

    const xpPct = need > 0 ? Math.min(100, Math.round((s.xp / need) * 100)) : 0;
    const row = (label: string, value: string, color = "#e8e8e8") =>
      `<div style="display:flex; justify-content:space-between; padding:3px 0;"><span style="color:#9fb0c0;">${label}</span><span style="color:${color}; font-weight:600;">${value}</span></div>`;

    this.body.innerHTML =
      `<div style="font-size:15px; font-weight:700; color:#fff;">${s.name}</div>` +
      `<div style="color:#f0d27a; font-weight:700; margin:2px 0 8px;">Level ${s.level}</div>` +
      `<div style="height:12px; background:rgba(0,0,0,0.5); border:1px solid rgba(0,0,0,0.6); border-radius:6px; overflow:hidden;"><div style="height:100%; width:${xpPct}%; background:linear-gradient(180deg,#8fe0ff,#2b8fd6);"></div></div>` +
      `<div style="text-align:center; font-size:11px; color:#9fb0c0; margin:3px 0 10px;">${Math.floor(s.xp)} / ${need} XP &nbsp;→&nbsp; Lv. ${s.level + 1}</div>` +
      row("❤️ Health", `${Math.round(s.hp)} / ${Math.round(s.maxHp)}`, "#ff8a8a") +
      row("⚔️ Attack", `${Math.round(s.attack)}`, "#ffd27a") +
      row("🛡️ Armor", `${Math.round(s.armor)}`, "#9fd0ff") +
      row("✦ Crit chance", `${Math.round(s.critChance * 100)}%`, "#c9a2ff") +
      row("🏃 Run speed", `${s.moveSpeed.toFixed(1)}`, "#8fe6c0") +
      row("🍌 Throw power", `${Math.round(s.throwPower * 100)}%`, "#ffe08a") +
      `<hr style="border:none; border-top:1px solid #2a3242; margin:10px 0;">` +
      `<div style="font-size:11px; color:#7f8a98;">Next level: +${HP_PER_LEVEL} HP · +${ATTACK_PER_LEVEL} atk · +${ARMOR_PER_LEVEL} armor · +${Math.round(CRIT_PER_LEVEL * 100)}% crit · +${SPEED_PER_LEVEL.toFixed(2)} speed · +${Math.round(THROW_POWER_PER_LEVEL * 100)}% throw</div>`;
  }
}
