interface ModelEntry {
  name: string;
  model: string; // url under /models
  size: number;
}

export interface PropLibraryCallbacks {
  /** Place an existing model into the world (then select it for editing). */
  onPlace: (model: string, name: string) => void;
  /** Upload a new .glb, then place + select it. */
  onUpload: (file: File, name: string) => void;
}

/**
 * Dev Mode model library: lists every `.glb` under public/models (via the dev
 * endpoint) so you can drop any of them into the world with a click, and uploads
 * a brand-new model. Placed props land at the player and are immediately selected,
 * so you position/scale/rotate them with the inspector + ground drag.
 */
export class PropLibrary {
  private panel: HTMLElement;
  private list: HTMLElement;
  private status: HTMLElement;
  private open = false;
  private loaded = false;

  constructor(private cb: PropLibraryCallbacks) {
    const panel = document.createElement("div");
    panel.id = "devPropLibraryPanel";
    panel.style.cssText =
      "position:fixed; right:16px; top:118px; width:280px; max-height:60vh; z-index:48; display:none;" +
      "background:#10131af2; border:2px solid #4a9a52; border-radius:10px; color:#e8e8e8;" +
      "font:13px/1.4 system-ui,sans-serif; box-shadow:0 8px 30px #000a; overflow:hidden; flex-direction:column;";
    panel.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 12px; background:#1c2230; border-bottom:1px solid #4a9a52;">
        <b style="color:#9fe0a0;">Model Library</b>
        <button id="plClose" style="cursor:pointer; background:#3a2230; color:#fff; border:1px solid #4a9a52; border-radius:4px; padding:2px 8px;">✕</button>
      </div>
      <div style="padding:10px 12px; border-bottom:1px solid #2a3242; display:flex; flex-direction:column; gap:6px;">
        <label style="font-size:11px; color:#9fb0c0;">Import a new .glb</label>
        <input id="plFile" type="file" accept=".glb,model/gltf-binary" style="font-size:11px;">
      </div>
      <div id="plList" style="overflow-y:auto; padding:6px; display:flex; flex-direction:column; gap:4px;"></div>
      <div id="plStatus" style="padding:6px 12px; font-size:11px; color:#9fb0c0; min-height:14px; border-top:1px solid #2a3242;"></div>`;
    document.body.appendChild(panel);
    this.panel = panel;
    this.list = panel.querySelector("#plList") as HTMLElement;
    this.status = panel.querySelector("#plStatus") as HTMLElement;
    (panel.querySelector("#plClose") as HTMLElement).onclick = () => this.close();
    (panel.querySelector("#plFile") as HTMLInputElement).onchange = (e) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (!f) return;
      const name = f.name.replace(/\.glb$/i, "").slice(0, 24) || "prop";
      this.status.textContent = `uploading ${name}…`;
      this.cb.onUpload(f, name);
      (e.target as HTMLInputElement).value = "";
    };
  }

  toggle() {
    this.open ? this.close() : this.openPanel();
  }

  private openPanel() {
    this.open = true;
    this.panel.style.display = "flex";
    if (!this.loaded) void this.refresh();
  }

  close() {
    this.open = false;
    this.panel.style.display = "none";
  }

  setStatus(msg: string) {
    this.status.textContent = msg;
  }

  /** (Re)fetch the model list from the dev endpoint and render it. */
  async refresh() {
    this.list.textContent = "loading…";
    try {
      const res = await fetch("/__props/models", { cache: "no-store" });
      const models: ModelEntry[] = res.ok ? await res.json() : [];
      this.loaded = true;
      this.list.innerHTML = "";
      if (!models.length) {
        this.list.textContent = "no models found";
        return;
      }
      for (const m of models) this.list.appendChild(this.row(m));
    } catch (e) {
      this.list.textContent = "failed to load models: " + (e as Error).message;
    }
  }

  private row(m: ModelEntry): HTMLElement {
    const row = document.createElement("button");
    row.style.cssText =
      "cursor:pointer; text-align:left; background:#1a2030; color:#e8e8e8; border:1px solid #2a3242;" +
      "border-radius:5px; padding:6px 9px; display:flex; justify-content:space-between; align-items:center; gap:8px;";
    const nm = document.createElement("span");
    nm.textContent = m.name;
    nm.style.cssText = "overflow:hidden; text-overflow:ellipsis; white-space:nowrap;";
    const sz = document.createElement("span");
    sz.textContent = mb(m.size);
    sz.style.cssText = "color:#7f93a8; font-size:10px; flex:none;";
    row.append(nm, sz);
    row.onmouseenter = () => (row.style.background = "#243049");
    row.onmouseleave = () => (row.style.background = "#1a2030");
    row.onclick = () => {
      this.status.textContent = `placing ${m.name}…`;
      this.cb.onPlace(m.model, m.name);
    };
    return row;
  }
}

const mb = (bytes: number) => (bytes > 1e6 ? (bytes / 1e6).toFixed(1) + "MB" : Math.round(bytes / 1e3) + "KB");
