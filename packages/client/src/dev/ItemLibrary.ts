import { NetworkClient } from "../net/NetworkClient";
import { ItemDef, loadItemDefs, renderItemIcon, safeItemId } from "../items/itemRegistry";

export interface ItemLibraryDeps {
  net: NetworkClient;
  spawnWorldItem: (itemId: string, label: string) => void;
}

export class ItemLibrary {
  private panel: HTMLElement;
  private nameEl: HTMLInputElement;
  private iconEl: HTMLInputElement;
  private modelEl: HTMLInputElement;
  private stackEl: HTMLInputElement;
  private scaleEl: HTMLInputElement;
  private listEl: HTMLElement;
  private statusEl: HTMLElement;
  private open = false;

  constructor(private deps: ItemLibraryDeps) {
    this.panel = document.createElement("div");
    this.panel.id = "devItemLibraryPanel";
    this.panel.style.cssText =
      "position:fixed; right:16px; top:72px; width:min(420px, calc(100vw - 32px)); max-height:calc(100vh - 96px); overflow:hidden; z-index:82;" +
      "display:none; flex-direction:column; background:#10131af6; color:#e8e8e8; border:1px solid #4a9a52; border-radius:8px;" +
      "box-shadow:0 18px 60px #000c; font:12px/1.4 system-ui,sans-serif;";
    const head = document.createElement("div");
    head.style.cssText = "display:flex; justify-content:space-between; align-items:center; gap:8px; padding:10px 12px; background:#1c2230; border-bottom:1px solid #31405a;";
    head.innerHTML = `<b style="color:#9fe0a0; font-size:14px;">Item Library</b>`;
    const close = document.createElement("button");
    close.textContent = "X";
    close.title = "Close";
    close.setAttribute("aria-label", "Close");
    close.style.cssText = iconButtonCss();
    close.onclick = () => this.close();
    head.appendChild(close);

    const form = document.createElement("div");
    form.style.cssText = "display:grid; gap:8px; padding:12px; border-bottom:1px solid #263245;";
    this.nameEl = input("Item name");
    this.iconEl = fileInput("image/png,image/jpeg,image/webp");
    this.modelEl = fileInput(".glb,model/gltf-binary");
    this.stackEl = input("Stack max");
    this.stackEl.type = "number";
    this.stackEl.value = "99";
    this.stackEl.min = "1";
    this.scaleEl = input("World scale");
    this.scaleEl.type = "number";
    this.scaleEl.value = "1.2";
    this.scaleEl.step = "0.1";
    this.scaleEl.min = "0.05";
    form.append(
      label("Name", this.nameEl),
      label("Inventory icon", this.iconEl),
      label("Dropped 3D model", this.modelEl),
      row(label("Stack", this.stackEl), label("World scale", this.scaleEl)),
    );
    const save = document.createElement("button");
    save.textContent = "Save item";
    save.style.cssText = smallButtonCss("#283", "#fff");
    save.onclick = () => void this.save();
    form.appendChild(save);

    this.listEl = document.createElement("div");
    this.listEl.style.cssText = "overflow:auto; padding:10px 12px; display:grid; gap:8px;";
    this.statusEl = document.createElement("div");
    this.statusEl.style.cssText = "padding:8px 12px; min-height:16px; border-top:1px solid #263245; color:#9fb0c0; background:#0d1118;";
    this.panel.append(head, form, this.listEl, this.statusEl);
    document.body.appendChild(this.panel);
  }

  toggle() {
    this.open ? this.close() : void this.show();
  }

  async show() {
    this.open = true;
    this.panel.style.display = "flex";
    await this.render();
  }

  close() {
    this.open = false;
    this.panel.style.display = "none";
  }

  private async save() {
    const name = this.nameEl.value.trim();
    const id = safeItemId(name);
    if (!id) return this.setStatus("name required");
    this.setStatus("saving item...");
    try {
      const iconFile = this.iconEl.files?.[0];
      const modelFile = this.modelEl.files?.[0];
      const icon = iconFile ? await this.upload(iconFile, "icon", id) : undefined;
      const model = modelFile ? await this.upload(modelFile, "model", id) : undefined;
      const res = await fetch("/__items/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id,
          name,
          icon,
          model,
          stack: Number(this.stackEl.value) || 99,
          worldScale: Number(this.scaleEl.value) || 1.2,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      this.nameEl.value = "";
      this.iconEl.value = "";
      this.modelEl.value = "";
      await loadItemDefs();
      await this.render();
      this.setStatus(`saved ${name}`);
    } catch (e) {
      this.setStatus("save failed: " + (e as Error).message);
    }
  }

  private async upload(file: File, kind: "icon" | "model", name: string): Promise<string> {
    const url = `/__items/upload?kind=${kind}&name=${encodeURIComponent(name)}&filename=${encodeURIComponent(file.name)}`;
    const res = await fetch(url, { method: "POST", body: file });
    if (!res.ok) throw new Error(await res.text());
    return (await res.json()).url as string;
  }

  private async render() {
    const items = await this.fetchItems();
    this.listEl.innerHTML = "";
    if (!items.length) {
      this.listEl.textContent = "no custom items yet";
      this.setStatus("Create an item, then give it to inventory or drop it into the world.");
      return;
    }
    for (const item of items) this.listEl.appendChild(this.row(item));
    this.setStatus(`${items.length} custom item${items.length === 1 ? "" : "s"}`);
  }

  private row(item: ItemDef): HTMLElement {
    const el = document.createElement("div");
    el.style.cssText =
      "display:grid; grid-template-columns:36px minmax(0,1fr) auto; gap:8px; align-items:center; padding:8px; border:1px solid #2a3548; border-radius:7px; background:#171f2b;";
    const icon = document.createElement("div");
    icon.style.cssText = "width:34px; height:34px; display:grid; place-items:center; background:#0d131d; border:1px solid #263245; border-radius:6px;";
    renderItemIcon(icon, item.id, 28);
    const text = document.createElement("div");
    text.style.cssText = "min-width:0;";
    text.innerHTML = `<div style="font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(item.name)}</div><div style="color:#8fa0b5; font-size:11px;">${esc(item.id)} · stack ${item.stack ?? 99}${item.model ? " · 3D" : ""}</div>`;
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex; gap:6px;";
    const give = action("Give", () => {
      this.deps.net.sendDevGiveItem(item.id, 1);
      this.setStatus(`added ${item.name} to inventory`);
    });
    const drop = action("Drop", () => {
      this.deps.spawnWorldItem(item.id, item.name);
      this.setStatus(`dropping ${item.name} into world`);
    });
    const del = action("Del", () => void this.delete(item.id));
    actions.append(give, drop, del);
    el.append(icon, text, actions);
    return el;
  }

  private async delete(id: string) {
    const res = await fetch("/__items/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) return this.setStatus("delete failed");
    await loadItemDefs();
    await this.render();
  }

  private async fetchItems(): Promise<ItemDef[]> {
    try {
      const res = await fetch("/__items/defs", { cache: "no-store" });
      return res.ok ? await res.json() : [];
    } catch {
      return [];
    }
  }

  private setStatus(msg: string) {
    this.statusEl.textContent = msg;
  }
}

const input = (placeholder: string) => {
  const el = document.createElement("input");
  el.placeholder = placeholder;
  el.style.cssText = fieldCss();
  return el;
};
const fileInput = (accept: string) => {
  const el = input("");
  el.type = "file";
  el.accept = accept;
  return el;
};
const label = (text: string, control: HTMLElement) => {
  const el = document.createElement("label");
  el.style.cssText = "display:grid; gap:4px; color:#9fb0c0;";
  const span = document.createElement("span");
  span.textContent = text;
  span.style.cssText = "font-size:11px;";
  el.append(span, control);
  return el;
};
const row = (...children: HTMLElement[]) => {
  const el = document.createElement("div");
  el.style.cssText = "display:grid; grid-template-columns:1fr 1fr; gap:8px;";
  el.append(...children);
  return el;
};
const action = (text: string, onClick: () => void) => {
  const btn = document.createElement("button");
  btn.textContent = text;
  btn.style.cssText = smallButtonCss("#243049", "#cfe");
  btn.onclick = onClick;
  return btn;
};
const fieldCss = () =>
  "min-width:0; height:30px; border:1px solid #35445e; border-radius:6px; background:#0b0f16; color:#eef4fb; padding:0 8px;";
const smallButtonCss = (bg: string, color: string) =>
  `cursor:pointer; background:${bg}; color:${color}; border:1px solid #4a5b72; border-radius:6px; padding:6px 9px; font:12px system-ui,sans-serif;`;
const iconButtonCss = () =>
  "cursor:pointer; width:24px; height:24px; display:grid; place-items:center; padding:0;" +
  "background:#222a38; color:#d8e2ef; border:1px solid #4a5b72; border-radius:5px; font:16px/1 system-ui,sans-serif;";
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
