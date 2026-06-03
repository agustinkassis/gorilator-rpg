import { Scene, ShadowGenerator } from "@babylonjs/core";
import { importModel, applyTransform, LoadedProp } from "../scene/props";

/**
 * Dev tool: upload a .glb, position/resize/rotate it live in the world, name it,
 * mark it concrete (collision) or not, then "Add to game" — which POSTs it to the
 * Vite dev endpoint that writes the model + appends to props.json. From then on the
 * client renders it on load and the server gives concrete ones collision.
 */
export class PropImporter {
  private panel: HTMLElement;
  private toggleBtn: HTMLButtonElement;
  private open = false;
  private file: File | null = null;
  private prop: LoadedProp | null = null;
  private state = { size: 5, rotDeg: 0, x: 0, z: 0, name: "prop", concrete: true };
  private status: HTMLElement;

  constructor(
    private scene: Scene,
    private shadow: ShadowGenerator,
    private getPlayerPos: () => { x: number; z: number } | null,
  ) {
    const btn = document.createElement("button");
    btn.id = "propImportBtn";
    btn.textContent = "📦 Import Model";
    btn.style.cssText =
      "position:fixed; right:16px; bottom:132px; z-index:40; cursor:pointer; display:none;" +
      "background:#2a3242; color:#9fe0a0; border:1px solid #4a9a52; border-radius:6px;" +
      "padding:6px 10px; font:12px system-ui,sans-serif;";
    btn.onclick = () => this.toggle();
    document.body.appendChild(btn);
    this.toggleBtn = btn;

    const panel = document.createElement("div");
    panel.id = "propImporterPanel";
    panel.style.cssText =
      "position:fixed; right:16px; top:56px; width:300px; z-index:50; display:none;" +
      "background:#10131af2; border:2px solid #4a9a52; border-radius:10px; color:#e8e8e8;" +
      "font:13px/1.5 system-ui,sans-serif; box-shadow:0 8px 30px #000a; overflow:hidden;";
    panel.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 12px; background:#1c2230; border-bottom:1px solid #4a9a52;">
        <b style="color:#9fe0a0;">Model Importer</b>
        <button id="piClose" style="cursor:pointer; background:#3a2230; color:#fff; border:1px solid #4a9a52; border-radius:4px; padding:2px 8px;">✕</button>
      </div>
      <div style="padding:12px 14px; display:flex; flex-direction:column; gap:9px;">
        <input id="piFile" type="file" accept=".glb,model/gltf-binary" style="font-size:12px;">
        <label style="display:flex; justify-content:space-between; align-items:center; gap:8px;">Name
          <input id="piName" type="text" value="prop" style="width:160px;"></label>
        <label style="display:flex; justify-content:space-between; align-items:center; gap:8px;">Size (units)
          <input id="piSize" type="range" min="0.5" max="40" step="0.5" value="5" style="flex:1;">
          <span id="piSizeV" style="width:34px; text-align:right;">5</span></label>
        <label style="display:flex; justify-content:space-between; align-items:center; gap:8px;">Rotate Y
          <input id="piRot" type="range" min="0" max="360" step="1" value="0" style="flex:1;">
          <span id="piRotV" style="width:34px; text-align:right;">0°</span></label>
        <div style="display:flex; gap:6px; align-items:center;">
          <button id="piAtPlayer" style="cursor:pointer; flex:1; background:#283; color:#fff; border:none; border-radius:4px; padding:4px;">Place at me</button>
          <span style="font-size:11px; color:#9fb0c0;">pos <span id="piPos">0, 0</span></span>
        </div>
        <label style="display:flex; align-items:center; gap:8px;"><input id="piConcrete" type="checkbox" checked> Concrete (collision)</label>
        <div style="display:flex; gap:6px;">
          <button id="piAdd" style="cursor:pointer; flex:1; background:#3a7a40; color:#fff; border:none; border-radius:5px; padding:7px; font-weight:600;">Add to game</button>
          <button id="piDiscard" style="cursor:pointer; background:#5a3030; color:#fff; border:none; border-radius:5px; padding:7px;">Discard</button>
        </div>
        <div id="piStatus" style="font-size:11px; color:#9fb0c0; min-height:14px;"></div>
      </div>`;
    document.body.appendChild(panel);
    this.panel = panel;
    this.status = panel.querySelector("#piStatus") as HTMLElement;
    (panel.querySelector("#piClose") as HTMLElement).onclick = () => this.toggle();

    const $ = (id: string) => panel.querySelector(id) as HTMLInputElement;
    $("#piFile").onchange = (e) => this.onFile((e.target as HTMLInputElement).files?.[0] ?? null);
    $("#piName").oninput = (e) => (this.state.name = (e.target as HTMLInputElement).value || "prop");
    $("#piSize").oninput = (e) => {
      this.state.size = +(e.target as HTMLInputElement).value;
      (panel.querySelector("#piSizeV") as HTMLElement).textContent = String(this.state.size);
      this.refresh();
    };
    $("#piRot").oninput = (e) => {
      this.state.rotDeg = +(e.target as HTMLInputElement).value;
      (panel.querySelector("#piRotV") as HTMLElement).textContent = this.state.rotDeg + "°";
      this.refresh();
    };
    $("#piConcrete").onchange = (e) => (this.state.concrete = (e.target as HTMLInputElement).checked);
    (panel.querySelector("#piAtPlayer") as HTMLElement).onclick = () => {
      const p = this.getPlayerPos();
      if (p) {
        this.state.x = +p.x.toFixed(1);
        this.state.z = +p.z.toFixed(1);
        (panel.querySelector("#piPos") as HTMLElement).textContent = `${this.state.x}, ${this.state.z}`;
        this.refresh();
      }
    };
    (panel.querySelector("#piAdd") as HTMLElement).onclick = () => void this.add();
    (panel.querySelector("#piDiscard") as HTMLElement).onclick = () => this.discard();
    // (M is the world-map hotkey now; open this dev tool with its button.)
  }

  setVisible(on: boolean) {
    this.toggleBtn.style.display = on ? "block" : "none";
    if (!on && this.open) this.toggle();
  }

  private toggle() {
    this.open = !this.open;
    this.panel.style.display = this.open ? "block" : "none";
  }

  private async onFile(f: File | null) {
    if (!f) return;
    this.discard();
    this.file = f;
    this.status.textContent = "loading…";
    try {
      const url = URL.createObjectURL(f);
      this.prop = await importModel(this.scene, url);
      URL.revokeObjectURL(url);
      const p = this.getPlayerPos();
      if (p) {
        this.state.x = +p.x.toFixed(1);
        this.state.z = +p.z.toFixed(1);
        (this.panel.querySelector("#piPos") as HTMLElement).textContent = `${this.state.x}, ${this.state.z}`;
      }
      if (!this.state.name || this.state.name === "prop") {
        this.state.name = f.name.replace(/\.glb$/i, "").slice(0, 24) || "prop";
        (this.panel.querySelector("#piName") as HTMLInputElement).value = this.state.name;
      }
      this.refresh();
      this.status.textContent = "drag the sliders, then Add to game";
    } catch (e) {
      this.status.textContent = "load failed: " + (e as Error).message;
    }
  }

  private refresh() {
    if (!this.prop) return;
    applyTransform(this.prop, this.state.size, this.state.x, this.state.z, (this.state.rotDeg * Math.PI) / 180);
  }

  private discard() {
    this.prop?.dispose();
    this.prop = null;
    this.file = null;
  }

  private async add() {
    if (!this.file || !this.prop) {
      this.status.textContent = "upload a .glb first";
      return;
    }
    const s = this.state;
    const meta = {
      name: s.name,
      x: s.x,
      z: s.z,
      scale: s.size,
      rotationY: (s.rotDeg * Math.PI) / 180,
      collisionRadius: s.concrete ? +(s.size / 2).toFixed(2) : 0,
    };
    this.status.textContent = "saving…";
    try {
      const res = await fetch(`/__props/add?meta=${encodeURIComponent(JSON.stringify(meta))}`, {
        method: "POST",
        body: this.file,
        headers: { "content-type": "application/octet-stream" },
      });
      if (!res.ok) throw new Error(await res.text());
      const out = await res.json();
      this.status.textContent = `✓ saved "${out.name}" → it persists on reload${s.concrete ? " (collision active)" : ""}`;
      // keep the current preview in the world; it'll re-load from props.json next reload
      this.prop = null; // detach so Discard doesn't remove the now-permanent prop
      this.file = null;
    } catch (e) {
      this.status.textContent = "save failed: " + (e as Error).message;
    }
  }
}
