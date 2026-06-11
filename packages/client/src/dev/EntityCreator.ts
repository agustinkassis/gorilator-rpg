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
  type TransformNode,
  type AbstractMesh,
} from "@babylonjs/core";
import { AnimState, type CharacterStatsConfig, type CommunityEntityType } from "@rpg/shared";
import { assembleCharacter, CharacterDef, CharAction, AssembledCharacter } from "../entities/characterDef";
import { importModel, bounds } from "../scene/props";

/**
 * Dev Mode "Create Entity" — a stepped wizard that authors a Library entry of any
 * type (character / structure / item) WITHOUT placing it on the map:
 *
 *   1. Details  — name + description
 *   2. Model    — upload the asset(s): a Meshy character .zip, a structure .glb,
 *                 or an item icon (+ optional .glb), with a live 3D preview
 *   3. Stats    — combat tuning (chars/structures) or stack/scale (items)
 *
 * "Add to Library" persists the def to the matching dev endpoint; the new entry
 * shows up in the Local library as *pending* (uncommitted). Placement onto the map
 * is a separate "＋ Add" on the Library card, like every other entity.
 */

interface ImportedFile {
  name: string;
  path: string; // url under /models
  kind: "base" | "anim";
  clip: string;
}

const ACTIONS: CharAction[] = ["IDLE", "WALK", "ATTACK", "THROW", "HIT", "DEAD"];

/** Auto-map a clip label to an action by keyword (mirrors CharacterImporter). */
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

/** Stat fields surfaced in step 3 for living entities (characters + structures). */
const STAT_FIELDS: Array<{ key: keyof CharacterStatsConfig; label: string; step?: number; min?: number; max?: number }> = [
  { key: "maxHp", label: "Max HP", min: 1, max: 100000 },
  { key: "attack", label: "Attack", min: 0, max: 100000 },
  { key: "armor", label: "Armor", min: 0, max: 100000 },
  { key: "critChance", label: "Crit %", step: 0.01, min: 0, max: 1 },
  { key: "moveSpeed", label: "Move speed", step: 0.1, min: 0, max: 100 },
  { key: "throwPower", label: "Throw power", step: 0.1, min: 0, max: 100 },
  { key: "level", label: "Level", min: 1, max: 999 },
];

export interface EntityCreatorDeps {
  /** Called after a def is saved so the Library can refresh + jump to its tab. */
  onAdded: (type: CommunityEntityType, id: string) => void;
}

type ItemModel = { icon?: string; model?: string };

export class EntityCreator {
  private panel: HTMLElement;
  private body: HTMLElement;
  private status: HTMLElement;
  private stepsBar: HTMLElement;
  private backBtn: HTMLButtonElement;
  private nextBtn: HTMLButtonElement;
  private open = false;

  private type: CommunityEntityType = "character";
  private step = 0; // 0=details 1=model 2=stats
  private name = "";
  private description = "";
  private stats: CharacterStatsConfig = {};

  // character working state
  private imported: { id: string; files: ImportedFile[] } | null = null;
  private charDef: CharacterDef | null = null;
  // structure working state
  private structModel: { model: string } | null = null;
  private structScale = 1;
  private structCollision = 1;
  // item working state
  private item: ItemModel = {};
  private itemStack = 99;
  private itemScale = 1.2;

  // preview engine/scene (lazy, shared across steps)
  private canvas: HTMLCanvasElement;
  private engine?: Engine;
  private scene?: Scene;
  private assembled?: AssembledCharacter;
  private previewProp: { root: TransformNode; meshes: AbstractMesh[]; dispose: () => void } | null = null;
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private deps: EntityCreatorDeps) {
    const panel = document.createElement("div");
    panel.id = "entityCreatorPanel";
    panel.style.cssText =
      "position:fixed; left:16px; top:56px; width:440px; max-height:88vh; z-index:95; display:none;" +
      "background:#10131af7; border:2px solid #4a9a52; border-radius:10px; color:#e8e8e8;" +
      "font:12px/1.4 system-ui,sans-serif; box-shadow:0 12px 40px #000b; overflow:hidden; flex-direction:column;";

    const head = document.createElement("div");
    head.style.cssText =
      "display:flex; justify-content:space-between; align-items:center; padding:9px 12px;" +
      "background:#1c2230; border-bottom:1px solid #4a9a52;";
    const title = document.createElement("b");
    title.id = "ecTitle";
    title.style.cssText = "color:#9fe0a0; font-size:14px;";
    title.textContent = "Create Entity";
    const close = document.createElement("button");
    close.textContent = "✕";
    close.title = "Close";
    close.style.cssText =
      "cursor:pointer; background:#26303f; color:#fff; border:1px solid #4a5b72; border-radius:5px; padding:2px 8px;";
    close.onclick = () => this.close();
    head.append(title, close);
    this.titleEl = title;

    this.stepsBar = document.createElement("div");
    this.stepsBar.style.cssText =
      "display:grid; grid-template-columns:repeat(3,1fr); gap:6px; padding:10px 12px; background:#121826;";

    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText =
      "width:100%; height:200px; background:#0b0e14; border-radius:6px; display:none; outline:none; margin:0 12px;";
    this.canvas.width = 416;
    this.canvas.height = 200;

    this.body = document.createElement("div");
    this.body.style.cssText = "padding:10px 12px; display:flex; flex-direction:column; gap:8px; overflow-y:auto;";

    const foot = document.createElement("div");
    foot.style.cssText = "display:flex; gap:8px; padding:10px 12px; border-top:1px solid #263245; background:#0e131c;";
    this.backBtn = document.createElement("button");
    this.backBtn.textContent = "‹ Back";
    this.backBtn.style.cssText = footBtn("#26303f", "#cfe");
    this.backBtn.onclick = () => this.goto(this.step - 1);
    this.nextBtn = document.createElement("button");
    this.nextBtn.style.cssText = footBtn("#23472b", "#e8ffe8") + "flex:1;";
    this.nextBtn.onclick = () => this.onNext();
    foot.append(this.backBtn, this.nextBtn);

    this.status = document.createElement("div");
    this.status.style.cssText = "padding:0 12px 10px; font-size:11px; color:#9fb0c0; min-height:14px;";

    const canvasWrap = document.createElement("div");
    canvasWrap.style.cssText = "display:flex;";
    canvasWrap.appendChild(this.canvas);

    panel.append(head, this.stepsBar, canvasWrap, this.body, this.status, foot);
    document.body.appendChild(panel);
    this.panel = panel;
  }

  private titleEl: HTMLElement;

  /** Open the wizard to author a fresh entity of `type`. */
  openFor(type: CommunityEntityType) {
    this.reset(type);
    this.open = true;
    this.panel.style.display = "flex";
    this.goto(0);
  }

  /** Closed automatically when leaving Dev Mode. */
  setVisible(on: boolean) {
    if (!on) this.close();
  }

  close() {
    this.open = false;
    this.panel.style.display = "none";
    this.engine?.stopRenderLoop(this.tick);
  }

  private reset(type: CommunityEntityType) {
    this.type = type;
    this.step = 0;
    this.name = "";
    this.description = "";
    this.stats = {};
    this.imported = null;
    this.charDef = null;
    this.structModel = null;
    this.structScale = 1;
    this.structCollision = 1;
    this.item = {};
    this.itemStack = 99;
    this.itemScale = 1.2;
    this.disposePreview();
  }

  private typeLabel(): string {
    return this.type === "character" ? "Character" : this.type === "structure" ? "Structure" : "Item";
  }

  private goto(step: number) {
    this.step = Math.max(0, Math.min(2, step));
    this.titleEl.textContent = `Create ${this.typeLabel()}`;
    this.renderSteps();
    this.renderBody();
    this.renderFoot();
  }

  private renderSteps() {
    const labels = ["1 · Details", "2 · Model", "3 · Stats"];
    this.stepsBar.innerHTML = "";
    labels.forEach((l, i) => {
      const b = document.createElement("div");
      const on = i === this.step;
      const done = i < this.step;
      b.textContent = l;
      b.style.cssText =
        "text-align:center; padding:6px 4px; border-radius:6px; font:700 11px system-ui,sans-serif;" +
        `background:${on ? "#2f6d37" : done ? "#1f3326" : "#182130"}; color:${on ? "#f3fff3" : done ? "#9fe0a0" : "#7e8da0"};` +
        `border:1px solid ${on ? "#75d381" : "#2a3a4c"};`;
      this.stepsBar.appendChild(b);
    });
  }

  private renderFoot() {
    this.backBtn.style.visibility = this.step === 0 ? "hidden" : "visible";
    this.nextBtn.textContent = this.step === 2 ? `＋ Add to Library` : "Next ›";
  }

  private setStatus(msg: string) {
    this.status.textContent = msg;
  }

  // ---- step bodies --------------------------------------------------------

  private renderBody() {
    this.body.innerHTML = "";
    this.canvas.style.display = this.step === 1 && this.type !== "item" ? "block" : "none";
    if (this.step === 0) this.renderDetails();
    else if (this.step === 1) this.renderModel();
    else this.renderStats();
  }

  private renderDetails() {
    const name = labeledInput("Name", this.name, (v) => (this.name = v.slice(0, 48)));
    name.input.placeholder = `My ${this.typeLabel().toLowerCase()}`;
    const desc = document.createElement("textarea");
    desc.value = this.description;
    desc.rows = 4;
    desc.placeholder = "Describe this entity — shown in the Library and on community profiles.";
    desc.style.cssText = inputCss() + "resize:vertical; min-height:64px;";
    desc.oninput = () => (this.description = desc.value.slice(0, 500));
    const descLabel = document.createElement("label");
    descLabel.textContent = "Description";
    descLabel.style.cssText = "color:#9fb0c0; font-size:11px;";
    this.body.append(name.wrap, descLabel, desc);
    this.setStatus("Give your entity a name and a short description.");
  }

  private renderModel() {
    if (this.type === "character") this.renderCharacterModel();
    else if (this.type === "structure") this.renderStructureModel();
    else this.renderItemModel();
  }

  private renderCharacterModel() {
    const file = fileInput(".zip,application/zip", (f) => void this.onCharZip(f));
    const hint = small("Drop a Meshy character .zip — clips are auto-mapped to actions below.");
    this.body.append(hint, file);

    if (this.charDef) {
      // action preview buttons
      const play = document.createElement("div");
      play.style.cssText = "display:flex; gap:6px; flex-wrap:wrap;";
      for (const a of ACTIONS) {
        const b = document.createElement("button");
        b.textContent = a.toLowerCase();
        b.style.cssText =
          "cursor:pointer; background:#2a3242; color:#cfe; border:1px solid #3a4658; border-radius:4px; padding:3px 7px; font:11px system-ui;";
        b.onclick = () => this.assembled?.controller.play(a as unknown as AnimState);
        play.appendChild(b);
      }
      const yaw = slider("Yaw", 0, 360, 1, (this.charDef.yaw * 180) / Math.PI, (v) => {
        if (this.charDef) this.charDef.yaw = (v * Math.PI) / 180;
        if (this.assembled) this.assembled.root.rotation.y = this.charDef?.yaw ?? 0;
      }, (v) => `${Math.round(v)}°`);
      const scale = slider("Scale", 0.2, 6, 0.1, this.charDef.scale, (v) => {
        if (this.charDef) this.charDef.scale = v;
        if (this.assembled) this.assembled.root.scaling.setAll(v);
      }, (v) => v.toFixed(1));
      const mapHdr = small("Map clips → actions");
      const mapBody = document.createElement("div");
      mapBody.style.cssText = "display:flex; flex-direction:column; gap:5px;";
      this.renderClipMap(mapBody);
      this.body.append(play, yaw, scale, mapHdr, mapBody);
    }
  }

  private renderClipMap(host: HTMLElement) {
    host.innerHTML = "";
    if (!this.charDef || !this.imported) return;
    const anims = this.imported.files.filter((f) => f.kind === "anim");
    for (const action of ACTIONS) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex; align-items:center; gap:6px;";
      const label = document.createElement("span");
      label.textContent = action.toLowerCase();
      label.style.cssText = "width:54px; color:#9fb0c0;";
      const sel = document.createElement("select");
      sel.style.cssText = "flex:1; min-width:0;" + inputCss();
      const none = document.createElement("option");
      none.value = "";
      none.textContent = "— none —";
      sel.appendChild(none);
      const cur = this.charDef.anims[action]?.file ?? "";
      for (const a of anims) {
        const o = document.createElement("option");
        o.value = a.path;
        o.textContent = a.clip;
        if (a.path === cur) o.selected = true;
        sel.appendChild(o);
      }
      sel.onchange = () => {
        if (!this.charDef) return;
        if (sel.value) this.charDef.anims[action] = { file: sel.value, speed: this.charDef.anims[action]?.speed ?? 1 };
        else delete this.charDef.anims[action];
        this.scheduleCharRebuild();
      };
      const speed = document.createElement("input");
      speed.type = "number";
      speed.min = "0.1";
      speed.step = "0.1";
      speed.value = String(this.charDef.anims[action]?.speed ?? 1);
      speed.title = "speed";
      speed.style.cssText = "width:52px;" + inputCss();
      speed.oninput = () => {
        if (this.charDef?.anims[action]) this.charDef.anims[action]!.speed = +speed.value || 1;
        this.scheduleCharRebuild();
      };
      row.append(label, sel, speed);
      host.appendChild(row);
    }
  }

  private renderStructureModel() {
    const file = fileInput(".glb,model/gltf-binary", (f) => void this.onStructGlb(f));
    this.body.append(small("Upload a single .glb model for this structure."), file);
    if (this.structModel) {
      const scale = slider("Scale", 0.1, 20, 0.1, this.structScale, (v) => {
        this.structScale = v;
        if (this.previewProp) this.previewProp.root.scaling.setAll(v);
      }, (v) => v.toFixed(1));
      const coll = slider("Collision radius", 0, 20, 0.1, this.structCollision, (v) => (this.structCollision = v), (v) => v.toFixed(1));
      this.body.append(scale, coll);
    }
  }

  private renderItemModel() {
    const icon = fileInput("image/png,image/jpeg,image/webp", (f) => void this.onItemFile(f, "icon"), "Upload icon (PNG/JPG/WebP)");
    const model = fileInput(".glb,model/gltf-binary", (f) => void this.onItemFile(f, "model"), "Optional world model (.glb)");
    this.body.append(small("Items need an icon; a world .glb is optional."), icon, model);
    if (this.item.icon) {
      const img = document.createElement("img");
      img.src = this.item.icon;
      img.style.cssText = "width:96px; height:96px; object-fit:contain; background:#0b0e14; border-radius:6px; align-self:flex-start;";
      this.body.appendChild(img);
    }
  }

  private renderStats() {
    if (this.type === "item") {
      const stack = numberRow("Stack max", this.itemStack, 1, 999, 1, (v) => (this.itemStack = v));
      const scale = numberRow("World scale", this.itemScale, 0.05, 20, 0.05, (v) => (this.itemScale = v));
      this.body.append(small("How this item stacks and how big it appears dropped in the world."), stack, scale);
      this.setStatus("Set item stack + world scale, then add to the Library.");
      return;
    }
    this.body.append(small("Combat tuning. Leave blank to use the engine defaults."));
    for (const f of STAT_FIELDS) {
      const cur = this.stats[f.key];
      const row = numberRow(f.label, cur ?? NaN, f.min ?? 0, f.max ?? 100000, f.step ?? 1, (v) => {
        if (Number.isFinite(v)) this.stats[f.key] = v;
        else delete this.stats[f.key];
      }, true);
      this.body.appendChild(row);
    }
    this.setStatus("Set stats (optional), then add to the Library.");
  }

  // ---- uploads ------------------------------------------------------------

  private async onCharZip(file: File | null) {
    if (!file) return;
    this.setStatus("uploading + unzipping…");
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
      const def: CharacterDef = {
        id: out.id,
        name: this.name || name.slice(0, 48) || out.id,
        category: "Characters",
        baseModel: base.path,
        anims: {},
        yaw: 0,
        scale: 1,
      };
      for (const a of out.files.filter((f) => f.kind === "anim")) {
        const action = guessAction(a.clip);
        if (action && !def.anims[action]) def.anims[action] = { file: a.path, speed: 1 };
      }
      this.charDef = def;
      this.renderBody();
      await this.rebuildCharPreview();
      this.setStatus("Map clips, fix orientation, then continue to stats.");
    } catch (e) {
      this.setStatus("import failed: " + (e as Error).message);
    }
  }

  private async onStructGlb(file: File | null) {
    if (!file) return;
    this.setStatus("uploading model…");
    try {
      const name = (this.name || file.name.replace(/\.glb$/i, "")).slice(0, 48);
      const res = await fetch(`/__structures/upload?name=${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "content-type": "model/gltf-binary" },
        body: file,
      });
      if (!res.ok) throw new Error(await res.text());
      const out = (await res.json()) as { model: string };
      this.structModel = { model: out.model };
      this.renderBody();
      await this.rebuildPropPreview(out.model);
      this.setStatus("Adjust scale + collision, then continue.");
    } catch (e) {
      this.setStatus("upload failed: " + (e as Error).message);
    }
  }

  private async onItemFile(file: File | null, kind: "icon" | "model") {
    if (!file) return;
    this.setStatus(`uploading ${kind}…`);
    try {
      const name = this.name || file.name.replace(/\.[a-z0-9]+$/i, "");
      const res = await fetch(
        `/__items/upload?kind=${kind}&name=${encodeURIComponent(name)}&filename=${encodeURIComponent(file.name)}`,
        { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file },
      );
      if (!res.ok) throw new Error(await res.text());
      const out = (await res.json()) as { url: string };
      this.item[kind] = out.url;
      this.renderBody();
      this.setStatus(`${kind} uploaded.`);
    } catch (e) {
      this.setStatus("upload failed: " + (e as Error).message);
    }
  }

  // ---- preview ------------------------------------------------------------

  private tick = () => this.scene?.render();

  private ensurePreview() {
    if (this.engine) return;
    const engine = new Engine(this.canvas, true, { preserveDrawingBuffer: true });
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.04, 0.06, 0.09, 1);
    const cam = new ArcRotateCamera("ecCam", -Math.PI / 2, Math.PI / 2.6, 6, new Vector3(0, 1, 0), scene);
    cam.attachControl(this.canvas, true);
    cam.wheelPrecision = 25;
    cam.lowerRadiusLimit = 2;
    cam.upperRadiusLimit = 40;
    new HemisphericLight("ecHemi", new Vector3(0, 1, 0), scene).intensity = 0.95;
    new DirectionalLight("ecDir", new Vector3(-1, -2, -0.5), scene).intensity = 1.0;
    const ground = MeshBuilder.CreateGround("ecGround", { width: 8, height: 8, subdivisions: 8 }, scene);
    const gm = new StandardMaterial("ecGm", scene);
    gm.wireframe = true;
    gm.emissiveColor = new Color3(0.18, 0.3, 0.24);
    gm.disableLighting = true;
    ground.material = gm;
    this.engine = engine;
    this.scene = scene;
    engine.runRenderLoop(this.tick);
    window.addEventListener("resize", () => this.engine?.resize());
  }

  private scheduleCharRebuild() {
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => void this.rebuildCharPreview(), 250);
  }

  private async rebuildCharPreview() {
    if (!this.charDef) return;
    this.ensurePreview();
    const scene = this.scene!;
    this.assembled?.dispose();
    this.assembled = undefined;
    try {
      this.assembled = await assembleCharacter(scene, this.charDef);
      const first = ACTIONS.find((a) => this.assembled!.groups[a as unknown as AnimState]);
      if (first) this.assembled.controller.play(first as unknown as AnimState);
    } catch (e) {
      this.setStatus("assemble failed: " + (e as Error).message);
    }
  }

  private async rebuildPropPreview(model: string) {
    this.ensurePreview();
    const scene = this.scene!;
    this.previewProp?.dispose();
    this.previewProp = null;
    try {
      const loaded = await importModel(scene, model);
      for (const m of loaded.meshes) if (m.getTotalVertices && m.getTotalVertices() > 0) m.isVisible = true;
      // sit on the ground + apply current scale
      loaded.root.scaling.setAll(this.structScale);
      loaded.root.computeWorldMatrix(true);
      const b = bounds(loaded.meshes);
      if (Number.isFinite(b.min.y)) loaded.root.position.y -= b.min.y;
      this.previewProp = loaded;
    } catch (e) {
      this.setStatus("preview failed: " + (e as Error).message);
    }
  }

  private disposePreview() {
    this.assembled?.dispose();
    this.assembled = undefined;
    this.previewProp?.dispose();
    this.previewProp = null;
  }

  // ---- navigation + save --------------------------------------------------

  private onNext() {
    if (this.step === 0) {
      if (!this.name.trim()) return this.setStatus("Please enter a name first.");
      // keep char def name in sync
      if (this.charDef) this.charDef.name = this.name;
      return this.goto(1);
    }
    if (this.step === 1) {
      if (this.type === "character" && !this.charDef) return this.setStatus("Upload a character .zip first.");
      if (this.type === "structure" && !this.structModel) return this.setStatus("Upload a .glb first.");
      if (this.type === "item" && !this.item.icon) return this.setStatus("Upload an icon first.");
      return this.goto(2);
    }
    void this.save();
  }

  private async save() {
    this.setStatus("saving…");
    try {
      if (this.type === "character") await this.saveCharacter();
      else if (this.type === "structure") await this.saveStructure();
      else await this.saveItem();
    } catch (e) {
      this.setStatus("save failed: " + (e as Error).message);
    }
  }

  private async saveCharacter() {
    if (!this.charDef) return this.setStatus("Upload a character first.");
    const def: CharacterDef = {
      ...this.charDef,
      name: this.name || this.charDef.name,
      description: this.description || undefined,
      stats: Object.keys(this.stats).length ? this.stats : undefined,
    };
    const res = await fetch("/__char/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(def),
    });
    if (!res.ok) throw new Error(await res.text());
    this.finish(def.id);
  }

  private async saveStructure() {
    if (!this.structModel) return this.setStatus("Upload a model first.");
    const id = `struct_${Date.now()}`;
    const def = {
      id,
      name: this.name,
      description: this.description || undefined,
      model: this.structModel.model,
      scale: this.structScale,
      collisionRadius: this.structCollision || undefined,
      hp: this.stats.maxHp,
      stats: Object.keys(this.stats).length ? this.stats : undefined,
    };
    const res = await fetch("/__structures/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(def),
    });
    if (!res.ok) throw new Error(await res.text());
    this.finish(id);
  }

  private async saveItem() {
    const id = slugify(this.name) || `item_${Date.now()}`;
    const def = {
      id,
      name: this.name,
      description: this.description || undefined,
      icon: this.item.icon,
      model: this.item.model,
      stack: this.itemStack,
      worldScale: this.itemScale,
    };
    const res = await fetch("/__items/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(def),
    });
    if (!res.ok) throw new Error(await res.text());
    this.finish(id);
  }

  private finish(id: string) {
    this.setStatus(`✓ added "${this.name}" to the Library`);
    const type = this.type;
    this.deps.onAdded(type, id);
    this.close();
  }
}

// ---- small DOM helpers ------------------------------------------------------

const inputCss = () =>
  "height:30px; border:1px solid #35445e; border-radius:6px; background:#0b0f16; color:#eef4fb; padding:0 9px; outline:none;";
const footBtn = (bg: string, color: string) =>
  `cursor:pointer; background:${bg}; color:${color}; border:1px solid #4a5b72; border-radius:6px; padding:8px 12px; font:600 12px system-ui,sans-serif;`;

function small(text: string): HTMLElement {
  const el = document.createElement("div");
  el.textContent = text;
  el.style.cssText = "color:#9fb0c0; font-size:11px;";
  return el;
}

function labeledInput(label: string, value: string, onInput: (v: string) => void) {
  const wrap = document.createElement("label");
  wrap.style.cssText = "display:flex; flex-direction:column; gap:4px; color:#9fb0c0; font-size:11px;";
  wrap.textContent = label;
  const input = document.createElement("input");
  input.type = "text";
  input.value = value;
  input.style.cssText = inputCss();
  input.oninput = () => onInput(input.value);
  wrap.appendChild(input);
  return { wrap, input };
}

function fileInput(accept: string, onFile: (f: File | null) => void, label?: string): HTMLElement {
  const wrap = document.createElement("label");
  wrap.style.cssText = "display:flex; flex-direction:column; gap:4px; color:#9fb0c0; font-size:11px;";
  if (label) wrap.textContent = label;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.style.cssText = "font-size:11px;";
  input.onchange = (e) => {
    onFile((e.target as HTMLInputElement).files?.[0] ?? null);
    (e.target as HTMLInputElement).value = "";
  };
  wrap.appendChild(input);
  return wrap;
}

function slider(
  label: string,
  min: number,
  max: number,
  stepv: number,
  value: number,
  onInput: (v: number) => void,
  fmt: (v: number) => string,
): HTMLElement {
  const wrap = document.createElement("label");
  wrap.style.cssText = "display:flex; justify-content:space-between; align-items:center; gap:8px; color:#cfe;";
  wrap.append(document.createTextNode(label));
  const range = document.createElement("input");
  range.type = "range";
  range.min = String(min);
  range.max = String(max);
  range.step = String(stepv);
  range.value = String(value);
  range.style.cssText = "flex:1;";
  const out = document.createElement("span");
  out.style.cssText = "width:42px; text-align:right;";
  out.textContent = fmt(value);
  range.oninput = () => {
    const v = +range.value;
    out.textContent = fmt(v);
    onInput(v);
  };
  wrap.append(range, out);
  return wrap;
}

function numberRow(
  label: string,
  value: number,
  min: number,
  max: number,
  stepv: number,
  onInput: (v: number) => void,
  blankable = false,
): HTMLElement {
  const wrap = document.createElement("label");
  wrap.style.cssText = "display:flex; justify-content:space-between; align-items:center; gap:8px; color:#cfe;";
  wrap.append(document.createTextNode(label));
  const input = document.createElement("input");
  input.type = "number";
  input.min = String(min);
  input.max = String(max);
  input.step = String(stepv);
  input.value = blankable && !Number.isFinite(value) ? "" : String(value);
  input.placeholder = blankable ? "default" : "";
  input.style.cssText = "width:120px;" + inputCss();
  input.oninput = () => onInput(input.value === "" ? NaN : +input.value);
  wrap.appendChild(input);
  return wrap;
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
