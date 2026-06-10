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
  type AnimationGroup,
} from "@babylonjs/core";
import "@babylonjs/loaders/glTF";
import {
  xpForLevel,
  PLAYER_HP_PER_LEVEL,
  PLAYER_ATTACK_PER_LEVEL,
  PLAYER_ARMOR_PER_LEVEL,
  PLAYER_CRIT_PER_LEVEL,
  PLAYER_SPEED_PER_LEVEL,
  PLAYER_THROW_POWER_PER_LEVEL,
  type ItemType,
} from "@rpg/shared";
import { loadItemDefs, renderItemIcon } from "../items/itemRegistry";

const MODEL_URL = "/models/knight.glb";

type HeldItem =
  | { source: "inventory"; type: ItemType; inventorySlot: number }
  | { source: "character"; type: ItemType; characterSlot: string };

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
  private heldItem: HeldItem | null = null;

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
    panel.id = "charSheetPanel";
    panel.style.cssText =
      "position:fixed; left:16px; top:56px; width:min(384px, calc(100vw - 32px)); max-height:calc(100vh - 72px); overflow-y:auto; z-index:50;" +
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
      <div style="text-align:center; font-size:10px; color:#7f8a98; padding:4px 12px 0;">drag items from inventory onto slots · drag equipped items back to inventory</div>
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
    window.addEventListener("itemHold:changed", (e) => {
      this.heldItem = (e as CustomEvent<{ held: HeldItem | null }>).detail?.held ?? null;
    });
    window.addEventListener("characterSheet:unequip", (e) => {
      const slotId = (e as CustomEvent<{ slotId?: string }>).detail?.slotId;
      if (slotId && this.equip[slotId]) {
        delete this.equip[slotId];
        this.saveEquip();
        this.renderSlot(slotId);
      }
    });
    window.addEventListener("items:changed", () => {
      for (const s of SLOTS) this.renderSlot(s.id);
    });
    void loadItemDefs().then(() => {
      for (const s of SLOTS) this.renderSlot(s.id);
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
      slot.draggable = true;
      const icon = document.createElement("div");
      icon.className = "charItemIcon";
      icon.style.cssText = "display:grid; place-items:center; width:34px; height:34px;";
      const label = document.createElement("div");
      label.textContent = s.name;
      label.style.cssText =
        "position:absolute; bottom:2px; right:5px; font-size:9px; color:#6b7686; pointer-events:none;";
      slot.append(icon, label);

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
        const type = e.dataTransfer?.getData("text/itemtype") as ItemType | "";
        const sourceSlot = e.dataTransfer?.getData("text/charslot");
        if (type) {
          if (sourceSlot && sourceSlot !== s.id) {
            delete this.equip[sourceSlot];
            this.renderSlot(sourceSlot);
          }
          this.equip[s.id] = type;
          this.saveEquip();
          this.renderSlot(s.id);
        }
      });
      let placedFromPointer = false;
      const placeHeldItem = () => {
        const held = this.currentHeldItem();
        if (!held) return false;
        if (held.source === "character" && held.characterSlot !== s.id) {
          delete this.equip[held.characterSlot];
          this.renderSlot(held.characterSlot);
        }
        this.equip[s.id] = held.type;
        this.saveEquip();
        this.renderSlot(s.id);
        window.dispatchEvent(new Event("itemHold:consume"));
        return true;
      };
      slot.addEventListener("pointerdown", (e) => {
        if (this.currentHeldItem() && placeHeldItem()) {
          placedFromPointer = true;
          e.preventDefault();
        }
      });
      slot.addEventListener("click", (e) => {
        if (placedFromPointer) {
          placedFromPointer = false;
          return;
        }
        if (placeHeldItem()) return;
        const type = this.equip[s.id] as ItemType | "";
        if (!type) return;
        const held = { source: "character", type, characterSlot: s.id } satisfies HeldItem;
        window.dispatchEvent(new CustomEvent("itemHold:start", { detail: { ...held, x: e.clientX, y: e.clientY } }));
      });
      slot.addEventListener("dragstart", (e) => {
        const type = this.equip[s.id];
        if (!type) {
          e.preventDefault();
          return;
        }
        e.dataTransfer?.setData("text/charslot", s.id);
        e.dataTransfer?.setData("text/itemtype", type);
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
    const icon = el.querySelector<HTMLElement>(".charItemIcon");
    const type = this.equip[id] || "";
    if (icon) {
      if (type) renderItemIcon(icon, type, 30);
      else icon.textContent = "";
    }
    el.style.opacity = type ? "1" : "0.85";
    el.draggable = Boolean(type);
  }

  private currentHeldItem(): HeldItem | null {
    if (this.heldItem) return this.heldItem;
    const source = document.body.dataset.itemHoldSource;
    const type = document.body.dataset.itemHoldType as ItemType | undefined;
    if (!source || !type) return null;
    if (source === "inventory") {
      const inventorySlot = Number(document.body.dataset.itemHoldInventorySlot);
      return Number.isFinite(inventorySlot) ? { source, type, inventorySlot } : null;
    }
    if (source === "character") {
      const characterSlot = document.body.dataset.itemHoldCharacterSlot;
      return characterSlot ? { source, type, characterSlot } : null;
    }
    return null;
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
    if (document.body.classList.contains("preGame")) return;
    this.setOpen(!this.open);
  }

  private setOpen(open: boolean) {
    if (this.open === open) return;
    this.open = open;
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
    const pct = (value: number) => {
      const n = value * 100;
      return `${Number.isInteger(n) ? n : n.toFixed(1)}%`;
    };

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
      `<div style="font-size:11px; color:#7f8a98;">Next level: +${PLAYER_HP_PER_LEVEL} HP · +${PLAYER_ATTACK_PER_LEVEL} atk · +${PLAYER_ARMOR_PER_LEVEL} armor · +${pct(PLAYER_CRIT_PER_LEVEL)} crit · +${PLAYER_SPEED_PER_LEVEL.toFixed(2)} speed · +${pct(PLAYER_THROW_POWER_PER_LEVEL)} throw</div>`;
  }
}
