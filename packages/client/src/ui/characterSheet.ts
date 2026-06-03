import {
  Engine,
  Scene,
  ArcRotateCamera,
  HemisphericLight,
  DirectionalLight,
  Vector3,
  Color4,
  SceneLoader,
  PBRMaterial,
  TransformNode,
  AnimationGroup,
} from "@babylonjs/core";
import "@babylonjs/loaders/glTF";
import {
  xpForLevel,
  HP_PER_LEVEL,
  ATTACK_PER_LEVEL,
  ARMOR_PER_LEVEL,
  CRIT_PER_LEVEL,
  SPEED_PER_LEVEL,
  THROW_POWER_PER_LEVEL,
} from "@rpg/shared";

const MODEL_URL = "/models/knight.glb";

/** Emoji icon per item type (mirrors the inventory). */
const ICONS: Record<string, string> = { log: "🪵", potion: "🧪", stone: "🪨", banana: "🍌" };

/** The paper-doll equipment slots (purely client-side / cosmetic for now). */
const SLOTS: { id: string; name: string }[] = [
  { id: "head", name: "Head" },
  { id: "body", name: "Body" },
  { id: "mainHand", name: "Main" },
  { id: "offHand", name: "Off" },
  { id: "belt", name: "Belt" },
  { id: "feet", name: "Feet" },
];

const EQUIP_STORE = "gorilator-equip";

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

/**
 * The "Character (C)" window: a rotating 3D view of the player gorilla, drag-drop
 * equipment slots for inventory items, and the player's full stats. The 3D preview
 * uses its own tiny Babylon engine, started lazily on first open and paused while
 * closed. Equipment slots are a client-side paper-doll (cosmetic) persisted locally.
 */
export class CharacterSheet {
  private panel: HTMLElement;
  private stats: HTMLElement;
  private canvas: HTMLCanvasElement;
  private open = false;
  private lastSig = "";

  // 3D preview (lazy)
  private engine?: Engine;
  private scene?: Scene;
  private holder?: TransformNode;
  private groups: AnimationGroup[] = [];
  private started = false;

  // equipment (client-side)
  private equip: Record<string, string> = {};

  constructor() {
    this.loadEquip();

    const btn = document.createElement("button");
    btn.id = "charBtn";
    btn.className = "hudIconBtn";
    btn.innerHTML = `<span class="hudIcon" aria-hidden="true">📊</span><span class="hudKey">(C)</span>`;
    btn.title = "Character (C)";
    btn.onclick = () => this.toggle();
    document.body.appendChild(btn);

    const panel = document.createElement("div");
    panel.style.cssText =
      "position:fixed; right:16px; top:56px; width:384px; max-height:90vh; overflow-y:auto; z-index:50;" +
      "background:#10131af2; border:2px solid #c9a24a; border-radius:10px; display:none;" +
      "box-shadow:0 8px 30px #000a; color:#e8e8e8; font:13px/1.5 system-ui,sans-serif;";
    panel.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 12px; background:#1c2230; border-bottom:1px solid #c9a24a; position:sticky; top:0;">
        <b style="color:#f0d27a;">Character</b>
        <button id="charSheetClose" style="cursor:pointer; background:#3a2230; color:#fff; border:1px solid #c9a24a; border-radius:4px; padding:2px 8px;">✕</button>
      </div>
      <div style="display:flex; gap:10px; padding:12px 12px 0;">
        <canvas id="charSheetCanvas" style="width:168px; height:224px; border-radius:8px; background:#0b0e14; outline:none; flex:0 0 auto;"></canvas>
        <div id="charSheetEquip" style="display:grid; grid-template-columns:1fr 1fr; gap:8px; align-content:start; flex:1;"></div>
      </div>
      <div style="text-align:center; font-size:10px; color:#7f8a98; padding:4px 12px 0;">drag items from the inventory onto a slot · right-click to clear</div>
      <div id="charSheetBody" style="padding:10px 14px 14px;"></div>`;
    document.body.appendChild(panel);
    this.panel = panel;
    this.stats = panel.querySelector("#charSheetBody") as HTMLElement;
    this.canvas = panel.querySelector("#charSheetCanvas") as HTMLCanvasElement;
    (panel.querySelector("#charSheetClose") as HTMLElement).onclick = () => this.toggle();

    this.buildSlots(panel.querySelector("#charSheetEquip") as HTMLElement);

    window.addEventListener("keydown", (e) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "c" || e.key === "C") this.toggle();
    });
  }

  // ---- equipment slots ----

  private buildSlots(host: HTMLElement) {
    for (const s of SLOTS) {
      const slot = document.createElement("div");
      slot.dataset.slot = s.id;
      slot.title = s.name;
      slot.style.cssText =
        "position:relative; height:56px; border:1px solid #3a4456; border-radius:8px;" +
        "background:#171b25; display:flex; align-items:center; justify-content:center;" +
        "font-size:30px; line-height:1; cursor:pointer;";
      const label = document.createElement("div");
      label.textContent = s.name;
      label.style.cssText =
        "position:absolute; bottom:2px; right:5px; font-size:9px; color:#6b7686; pointer-events:none;";
      slot.appendChild(label);

      slot.addEventListener("dragover", (e) => {
        e.preventDefault();
        slot.style.borderColor = "#f0d27a";
      });
      slot.addEventListener("dragleave", () => {
        slot.style.borderColor = "#3a4456";
      });
      slot.addEventListener("drop", (e) => {
        e.preventDefault();
        slot.style.borderColor = "#3a4456";
        const type = e.dataTransfer?.getData("text/itemtype");
        if (type && ICONS[type]) {
          this.equip[s.id] = type;
          this.saveEquip();
          this.renderSlot(s.id);
        }
      });
      slot.addEventListener("contextmenu", (e) => {
        e.preventDefault(); // right-click clears the slot
        delete this.equip[s.id];
        this.saveEquip();
        this.renderSlot(s.id);
      });

      host.appendChild(slot);
      this.renderSlot(s.id);
    }
  }

  private renderSlot(id: string) {
    const el = this.panel.querySelector<HTMLElement>(`[data-slot="${id}"]`);
    if (!el) return;
    const icon = el.childNodes[0];
    const emoji = this.equip[id] ? ICONS[this.equip[id]] : "";
    // first child is the emoji text node; the label div stays as the last child
    if (icon && icon.nodeType === Node.TEXT_NODE) icon.textContent = emoji;
    else el.insertBefore(document.createTextNode(emoji), el.firstChild);
    el.style.opacity = emoji ? "1" : "0.85";
  }

  private loadEquip() {
    try {
      const raw = localStorage.getItem(EQUIP_STORE);
      if (raw) this.equip = JSON.parse(raw) || {};
    } catch {
      this.equip = {};
    }
  }

  private saveEquip() {
    try {
      localStorage.setItem(EQUIP_STORE, JSON.stringify(this.equip));
    } catch {
      /* storage unavailable — keep it in-memory */
    }
  }

  // ---- 3D preview ----

  private async startPreview() {
    this.started = true;
    const engine = new Engine(this.canvas, true, { preserveDrawingBuffer: true });
    this.engine = engine;
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.05, 0.07, 0.1, 1);
    this.scene = scene;

    const cam = new ArcRotateCamera("csCam", -Math.PI / 2, Math.PI / 2.5, 5.4, new Vector3(0, 1.0, 0), scene);
    cam.attachControl(this.canvas, true);
    cam.wheelPrecision = 30;
    cam.lowerRadiusLimit = 3;
    cam.upperRadiusLimit = 12;
    cam.minZ = 0.05;

    new HemisphericLight("csHemi", new Vector3(0, 1, 0), scene).intensity = 0.95;
    new DirectionalLight("csDir", new Vector3(-1, -2, -0.5), scene).intensity = 1.0;

    const holder = new TransformNode("csHolder", scene);
    this.holder = holder;

    try {
      const res = await SceneLoader.ImportMeshAsync("", MODEL_URL, "", scene);
      res.meshes[0].parent = holder;
      scene.materials.forEach((m) => {
        if (m instanceof PBRMaterial) {
          m.metallic = 0;
          m.roughness = 0.85;
          m.backFaceCulling = true;
          m.twoSidedLighting = false;
        }
      });
      this.groups = res.animationGroups;
      res.animationGroups.forEach((g) => g.stop());
      const idle = res.animationGroups.find((g) => /idle/i.test(g.name)) ?? res.animationGroups[0];
      idle?.start(true, 1, idle.from, idle.to, false);
    } catch (err) {
      console.warn("[charSheet] model preview failed", err);
    }
  }

  private renderTick = () => {
    if (this.holder) this.holder.rotation.y += 0.006; // slow turntable
    this.scene?.render();
  };

  // ---- open/close ----

  toggle() {
    this.open = !this.open;
    this.panel.style.display = this.open ? "block" : "none";
    this.lastSig = "";
    if (this.open) {
      if (!this.started) void this.startPreview().then(() => this.runLoop());
      else this.runLoop();
    } else {
      this.engine?.stopRenderLoop(this.renderTick);
    }
  }

  private runLoop() {
    if (!this.engine) return;
    this.engine.resize();
    this.engine.runRenderLoop(this.renderTick);
  }

  // ---- stats ----

  set(s: CharStats) {
    if (!this.open) return;
    const need = xpForLevel(s.level);
    const sig = `${s.name}|${s.level}|${Math.floor(s.xp)}|${Math.round(s.hp)}|${Math.round(s.maxHp)}|${s.attack}|${s.armor}|${s.critChance}|${s.moveSpeed.toFixed(2)}|${s.throwPower.toFixed(2)}`;
    if (sig === this.lastSig) return;
    this.lastSig = sig;

    const xpPct = need > 0 ? Math.min(100, Math.round((s.xp / need) * 100)) : 0;
    const row = (label: string, value: string, color = "#e8e8e8") =>
      `<div style="display:flex; justify-content:space-between; padding:3px 0;"><span style="color:#9fb0c0;">${label}</span><span style="color:${color}; font-weight:600;">${value}</span></div>`;

    this.stats.innerHTML =
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
