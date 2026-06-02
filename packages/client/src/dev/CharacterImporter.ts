import {
  Engine,
  Scene,
  ArcRotateCamera,
  HemisphericLight,
  DirectionalLight,
  Vector3,
  Color3,
  Color4,
  MeshBuilder,
  StandardMaterial,
} from "@babylonjs/core";
import { AnimState } from "@rpg/shared";
import {
  assembleCharacter,
  CharacterDef,
  CharAction,
  AssembledCharacter,
} from "../entities/characterDef";

interface ImportedFile {
  name: string;
  path: string; // url under /models
  kind: "base" | "anim";
  clip: string;
}

const ACTIONS: CharAction[] = ["IDLE", "WALK", "ATTACK", "THROW", "HIT", "DEAD"];

/** Auto-map a clip label to an action by keyword (mirrors CharacterFactory.matchState
 *  + a throw/pitch rule). Returns null if nothing matches. */
function guessAction(clip: string): CharAction | null {
  const n = clip.toLowerCase();
  if (n.includes("idle")) return "IDLE";
  if (n.includes("walk") || n.includes("run") || n.includes("jog")) return "WALK";
  if (n.includes("throw") || n.includes("pitch") || n.includes("baseball")) return "THROW";
  if (n.includes("attack") || n.includes("slash") || n.includes("swing") || n.includes("hook") || n.includes("punch_attack"))
    return "ATTACK";
  if (n.includes("hit") || n.includes("damage") || n.includes("react") || n.includes("recieve") || n.includes("reaction"))
    return "HIT";
  if (n.includes("death") || n.includes("die") || n.includes("dead")) return "DEAD";
  return null;
}

export interface CharacterImporterDeps {
  /** Where to drop the placed character (the player's position), or null. */
  getPlayerPos: () => { x: number; z: number } | null;
  /** Called after a character is placed so the world can spawn it live. */
  onPlaced: (def: CharacterDef, placement: { id: string; x: number; z: number; rotationY: number }) => void;
}

/**
 * Dev tool: drop a Meshy character .zip → it's unzipped server-side, each animation
 * glb is detected, and this panel lets you map clips → actions, fix orientation +
 * scale, preview every action on the assembled rig, then save the character and add
 * it to the world. Open via the Dev Mode "Import Character" button.
 */
export class CharacterImporter {
  private panel: HTMLElement;
  private status: HTMLElement;
  private mapBody: HTMLElement;
  private canvas: HTMLCanvasElement;
  private open = false;

  // preview engine/scene (lazy)
  private engine?: Engine;
  private scene?: Scene;
  private assembled?: AssembledCharacter;
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;

  // import state
  private imported: { id: string; files: ImportedFile[] } | null = null;
  private def: CharacterDef | null = null; // the working def being edited

  constructor(private deps: CharacterImporterDeps) {
    const btn = document.createElement("button");
    btn.textContent = "🦍 Import Character";
    btn.style.cssText =
      "position:fixed; right:16px; bottom:276px; z-index:40; cursor:pointer; display:none;" +
      "background:#2a3242; color:#f0c0a0; border:1px solid #c98a5a; border-radius:6px;" +
      "padding:6px 10px; font:12px system-ui,sans-serif;";
    btn.onclick = () => this.toggle();
    document.body.appendChild(btn);
    this.toggleBtn = btn;

    const panel = document.createElement("div");
    panel.style.cssText =
      "position:fixed; left:16px; top:56px; width:430px; max-height:88vh; z-index:75; display:none;" +
      "background:#10131af5; border:2px solid #c98a5a; border-radius:10px; color:#e8e8e8;" +
      "font:12px/1.4 system-ui,sans-serif; box-shadow:0 8px 30px #000a; overflow:hidden; flex-direction:column;";
    panel.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 12px; background:#1c2230; border-bottom:1px solid #c98a5a;">
        <b style="color:#f0c0a0;">Character Importer</b>
        <button id="ciClose" style="cursor:pointer; background:#3a2230; color:#fff; border:1px solid #c98a5a; border-radius:4px; padding:2px 8px;">✕</button>
      </div>
      <div style="padding:10px 12px; display:flex; flex-direction:column; gap:8px; overflow-y:auto;">
        <label style="font-size:11px; color:#9fb0c0;">Drop a Meshy character .zip</label>
        <input id="ciFile" type="file" accept=".zip,application/zip" style="font-size:11px;">
        <canvas id="ciCanvas" style="width:100%; height:200px; background:#0b0e14; border-radius:6px; display:block; outline:none;"></canvas>
        <div style="display:flex; gap:6px; flex-wrap:wrap;" id="ciPlay"></div>
        <label style="display:flex; justify-content:space-between; align-items:center; gap:8px;">Name
          <input id="ciName" type="text" value="" style="width:200px;"></label>
        <label style="display:flex; justify-content:space-between; align-items:center; gap:8px;">Category
          <input id="ciCat" type="text" value="Characters" style="width:200px;"></label>
        <label style="display:flex; justify-content:space-between; align-items:center; gap:8px;">Yaw
          <input id="ciYaw" type="range" min="0" max="360" step="1" value="0" style="flex:1;"><span id="ciYawV" style="width:34px; text-align:right;">0°</span></label>
        <label style="display:flex; justify-content:space-between; align-items:center; gap:8px;">Scale
          <input id="ciScale" type="range" min="0.2" max="6" step="0.1" value="1" style="flex:1;"><span id="ciScaleV" style="width:34px; text-align:right;">1</span></label>
        <div style="border-top:1px solid #2a3242; padding-top:6px; color:#9fb0c0; font-size:11px;">Map clips → actions</div>
        <div id="ciMap" style="display:flex; flex-direction:column; gap:5px;"></div>
        <div style="display:flex; gap:6px; margin-top:4px;">
          <button id="ciSave" style="cursor:pointer; flex:1; background:#3a7a40; color:#fff; border:none; border-radius:5px; padding:7px; font-weight:600;">Save</button>
          <button id="ciAdd" style="cursor:pointer; flex:1; background:#283; color:#fff; border:none; border-radius:5px; padding:7px; font-weight:600;">Add to game</button>
        </div>
        <div id="ciStatus" style="font-size:11px; color:#9fb0c0; min-height:14px;"></div>
      </div>`;
    document.body.appendChild(panel);
    this.panel = panel;
    this.status = panel.querySelector("#ciStatus") as HTMLElement;
    this.mapBody = panel.querySelector("#ciMap") as HTMLElement;
    this.canvas = panel.querySelector("#ciCanvas") as HTMLCanvasElement;

    (panel.querySelector("#ciClose") as HTMLElement).onclick = () => this.toggle();
    (panel.querySelector("#ciFile") as HTMLInputElement).onchange = (e) =>
      void this.onZip((e.target as HTMLInputElement).files?.[0] ?? null);
    (panel.querySelector("#ciName") as HTMLInputElement).oninput = (e) => {
      if (this.def) this.def.name = (e.target as HTMLInputElement).value || this.def.id;
    };
    (panel.querySelector("#ciCat") as HTMLInputElement).oninput = (e) => {
      if (this.def) this.def.category = (e.target as HTMLInputElement).value || "Characters";
    };
    const yaw = panel.querySelector("#ciYaw") as HTMLInputElement;
    yaw.oninput = () => {
      const deg = +yaw.value;
      (panel.querySelector("#ciYawV") as HTMLElement).textContent = deg + "°";
      if (this.def) this.def.yaw = (deg * Math.PI) / 180;
      if (this.assembled) this.assembled.root.rotation.y = this.def?.yaw ?? 0;
    };
    const scale = panel.querySelector("#ciScale") as HTMLInputElement;
    scale.oninput = () => {
      const s = +scale.value;
      (panel.querySelector("#ciScaleV") as HTMLElement).textContent = String(s);
      if (this.def) this.def.scale = s;
      if (this.assembled) this.assembled.root.scaling.setAll(s);
    };
    (panel.querySelector("#ciSave") as HTMLElement).onclick = () => void this.save();
    (panel.querySelector("#ciAdd") as HTMLElement).onclick = () => void this.addToGame();

    // action preview buttons
    const play = panel.querySelector("#ciPlay") as HTMLElement;
    for (const a of ACTIONS) {
      const b = document.createElement("button");
      b.textContent = a.toLowerCase();
      b.style.cssText =
        "cursor:pointer; background:#2a3242; color:#cfe; border:1px solid #3a4658; border-radius:4px; padding:3px 7px; font:11px system-ui;";
      b.onclick = () => this.assembled?.controller.play(a as unknown as AnimState);
      play.appendChild(b);
    }
  }

  private toggleBtn: HTMLButtonElement;

  /** Show/hide the "Import Character" toolbar button (Dev Mode on/off). */
  setVisible(on: boolean) {
    this.toggleBtn.style.display = on ? "block" : "none";
    if (!on) this.close();
  }

  private toggle() {
    this.open ? this.close() : this.openPanel();
  }
  private openPanel() {
    this.open = true;
    this.panel.style.display = "flex";
    if (this.engine) this.engine.runRenderLoop(this.tick);
  }
  private close() {
    this.open = false;
    this.panel.style.display = "none";
    this.engine?.stopRenderLoop(this.tick);
  }

  private tick = () => this.scene?.render();

  private ensurePreview() {
    if (this.engine) return;
    const engine = new Engine(this.canvas, true, { preserveDrawingBuffer: true });
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.04, 0.06, 0.09, 1);
    const cam = new ArcRotateCamera("ciCam", -Math.PI / 2, Math.PI / 2.6, 6, new Vector3(0, 1, 0), scene);
    cam.attachControl(this.canvas, true);
    cam.wheelPrecision = 25;
    cam.lowerRadiusLimit = 2;
    cam.upperRadiusLimit = 30;
    new HemisphericLight("ciHemi", new Vector3(0, 1, 0), scene).intensity = 0.95;
    new DirectionalLight("ciDir", new Vector3(-1, -2, -0.5), scene).intensity = 1.0;
    const ground = MeshBuilder.CreateGround("ciGround", { width: 8, height: 8, subdivisions: 8 }, scene);
    const gm = new StandardMaterial("ciGm", scene);
    gm.wireframe = true;
    gm.emissiveColor = new Color3(0.18, 0.3, 0.24);
    gm.disableLighting = true;
    ground.material = gm;
    this.engine = engine;
    this.scene = scene;
    engine.runRenderLoop(this.tick);
    window.addEventListener("resize", () => this.engine?.resize());
  }

  private async onZip(file: File | null) {
    if (!file) return;
    this.status.textContent = "uploading + unzipping…";
    try {
      const name = file.name.replace(/\.zip$/i, "");
      const res = await fetch(`/__char/import?name=${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "content-type": "application/zip" },
        body: file,
      });
      if (!res.ok) throw new Error(await res.text());
      const out = (await res.json()) as { id: string; files: ImportedFile[] };
      this.imported = { id: out.id, files: out.files };

      const base = out.files.find((f) => f.kind === "base") ?? out.files[0];
      const anims = out.files.filter((f) => f.kind === "anim");

      // build an auto-mapped working def (first clip that matches each action)
      const def: CharacterDef = {
        id: out.id,
        name: name.slice(0, 40) || out.id,
        category: "Characters",
        baseModel: base.path,
        anims: {},
        yaw: 0,
        scale: 1,
        stats: {},
      };
      for (const a of anims) {
        const action = guessAction(a.clip);
        if (action && !def.anims[action]) def.anims[action] = { file: a.path, speed: 1 };
      }
      this.def = def;
      (this.panel.querySelector("#ciName") as HTMLInputElement).value = def.name;
      this.renderMap();
      this.status.textContent = `imported ${anims.length} clips — assembling preview…`;
      await this.rebuildPreview();
      this.status.textContent = "map clips → actions, fix orientation, then Save / Add to game";
    } catch (e) {
      this.status.textContent = "import failed: " + (e as Error).message;
    }
  }

  /** One row per action: a dropdown of all imported clips (+ none) and a speed box. */
  private renderMap() {
    this.mapBody.innerHTML = "";
    if (!this.def || !this.imported) return;
    const anims = this.imported.files.filter((f) => f.kind === "anim");
    for (const action of ACTIONS) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex; align-items:center; gap:6px;";
      const label = document.createElement("span");
      label.textContent = action.toLowerCase();
      label.style.cssText = "width:54px; color:#9fb0c0;";
      const sel = document.createElement("select");
      sel.style.cssText = "flex:1; min-width:0;";
      const none = document.createElement("option");
      none.value = "";
      none.textContent = "— none —";
      sel.appendChild(none);
      const cur = this.def.anims[action]?.file ?? "";
      for (const a of anims) {
        const o = document.createElement("option");
        o.value = a.path;
        o.textContent = a.clip;
        if (a.path === cur) o.selected = true;
        sel.appendChild(o);
      }
      sel.onchange = () => {
        if (!this.def) return;
        if (sel.value) this.def.anims[action] = { file: sel.value, speed: this.def.anims[action]?.speed ?? 1 };
        else delete this.def.anims[action];
        this.scheduleRebuild();
      };
      const speed = document.createElement("input");
      speed.type = "number";
      speed.min = "0.1";
      speed.step = "0.1";
      speed.value = String(this.def.anims[action]?.speed ?? 1);
      speed.title = "speed";
      speed.style.cssText = "width:48px;";
      speed.oninput = () => {
        if (this.def?.anims[action]) this.def.anims[action]!.speed = +speed.value || 1;
        this.scheduleRebuild();
      };
      row.append(label, sel, speed);
      this.mapBody.appendChild(row);
    }
  }

  private scheduleRebuild() {
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => void this.rebuildPreview(), 250);
  }

  /** (Re)assemble the working def in the preview scene and loop IDLE. */
  private async rebuildPreview() {
    if (!this.def) return;
    this.ensurePreview();
    const scene = this.scene!;
    this.assembled?.dispose();
    this.assembled = undefined;
    try {
      this.assembled = await assembleCharacter(scene, this.def);
      // play the first available action (prefer idle)
      const first = ACTIONS.find((a) => this.assembled!.groups[a as unknown as AnimState]);
      if (first) this.assembled.controller.play(first as unknown as AnimState);
    } catch (e) {
      this.status.textContent = "assemble failed: " + (e as Error).message;
    }
  }

  private async save(): Promise<boolean> {
    if (!this.def) {
      this.status.textContent = "import a .zip first";
      return false;
    }
    this.status.textContent = "saving…";
    try {
      const res = await fetch("/__char/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(this.def),
      });
      if (!res.ok) throw new Error(await res.text());
      this.status.textContent = `✓ saved "${this.def.name}"`;
      return true;
    } catch (e) {
      this.status.textContent = "save failed: " + (e as Error).message;
      return false;
    }
  }

  private async addToGame() {
    if (!this.def) {
      this.status.textContent = "import a .zip first";
      return;
    }
    if (!(await this.save())) return;
    const pos = this.deps.getPlayerPos() ?? { x: 0, z: 0 };
    try {
      const res = await fetch("/__char/place", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ defId: this.def.id, x: +pos.x.toFixed(1), z: +pos.z.toFixed(1), rotationY: 0 }),
      });
      if (!res.ok) throw new Error(await res.text());
      const out = await res.json();
      this.deps.onPlaced(this.def, { id: out.id, x: +pos.x.toFixed(1), z: +pos.z.toFixed(1), rotationY: 0 });
      this.status.textContent = `✓ added "${this.def.name}" to the world`;
    } catch (e) {
      this.status.textContent = "place failed: " + (e as Error).message;
    }
  }
}
