import {
  ArcRotateCamera,
  Color3,
  Color4,
  DirectionalLight,
  Engine,
  HemisphericLight,
  Scene,
  Vector3,
  type AbstractMesh,
  type TransformNode,
} from "@babylonjs/core";
import { CRATES } from "@rpg/shared";
import { NetworkClient } from "../net/NetworkClient";
import { buildBanana } from "../entities/models/banana";
import { buildBerserkerPotion } from "../entities/models/berserkerPotion";
import { buildDummy } from "../entities/models/dummy";
import { buildLog } from "../entities/models/log";
import { buildPotion } from "../entities/models/potion";
import { buildRock } from "../entities/models/rock";
import { buildStone } from "../entities/models/stone";
import { buildTree } from "../entities/models/tree";
import { bounds, importModel } from "../scene/props";
import { PropManager } from "./PropManager";
import { itemName, loadItemDefs } from "../items/itemRegistry";
import type { CharacterDef } from "../entities/characterDef";

/**
 * Dev Mode "Entity Library" — the main editor catalog. It has two top-level tabs:
 * Existing entities (browse/select what is already in the world) and New entity
 * (choose a model, place it, then drag/edit it through the normal inspector).
 */
export interface LibraryExplorerDeps {
  net: NetworkClient;
  propManager: PropManager;
  focusEntity: (kind: string, id: string) => boolean;
  focusPos: (x: number, z: number) => void;
  clearFocus: () => void;
  spawnEntity: (kind: string, label: string) => void;
  placeCharacter: (def: CharacterDef) => void;
  placeModel: (model: string, name: string) => void;
  uploadModel: (file: File, name: string) => void;
}

interface Entry {
  label: string;
  badge?: string;
  meta?: string;
  category: ExistingCategory;
  dim?: boolean;
  onClick: () => void;
}

interface ModelEntry {
  name: string;
  model: string;
  size: number;
}

type BuiltinThumb = "tree" | "rock" | "log" | "stone" | "potion" | "banana" | "berserker_potion" | "dummy";
type ThumbSource =
  | { type: "model"; model: string; token?: string | number }
  | { type: "builtin"; id: BuiltinThumb; token?: string | number };

interface TemplateEntry {
  label: string;
  kind: string;
  meta: string;
  category: ExistingCategory;
  thumb?: ThumbSource;
}

interface SyncedItem {
  x: number;
  z: number;
  name?: string;
  level?: number;
  kind?: string;
  alive?: boolean;
  itemId?: string;
}
type Coll = { forEach(cb: (v: SyncedItem, k: string) => void): void; size: number };

interface PlacementLite {
  id: string;
  defId: string;
}

const MODES = ["existing", "new"] as const;
type Mode = (typeof MODES)[number];
const CATEGORIES = ["all", "characters", "players", "resources", "structures", "objects", "items"] as const;
type ExistingCategory = (typeof CATEGORIES)[number];
const BUILTIN_NEW_ENTITIES: TemplateEntry[] = [
  { label: "Goblin", kind: "goblin", meta: "Enemy", category: "characters", thumb: { type: "model", model: "/models/goblin.glb", token: "runtime" } },
  { label: "Dummy", kind: "dummy", meta: "Training enemy", category: "characters", thumb: { type: "builtin", id: "dummy" } },
  { label: "Tree", kind: "tree", meta: "Resource", category: "resources", thumb: { type: "builtin", id: "tree" } },
  { label: "Rock", kind: "rock", meta: "Resource", category: "resources", thumb: { type: "builtin", id: "rock" } },
  { label: "House", kind: "house", meta: "Structure", category: "structures", thumb: { type: "model", model: "/models/house.glb", token: "runtime" } },
  { label: "Log", kind: "log", meta: "Pickup item", category: "items", thumb: { type: "builtin", id: "log" } },
  { label: "Stone", kind: "stone", meta: "Pickup item", category: "items", thumb: { type: "builtin", id: "stone" } },
  { label: "Banana", kind: "banana", meta: "Pickup item", category: "items", thumb: { type: "builtin", id: "banana" } },
  { label: "Potion", kind: "potion", meta: "Health pickup", category: "items", thumb: { type: "builtin", id: "potion" } },
  { label: "Berserker Potion", kind: "berserker_potion", meta: "Power pickup", category: "items", thumb: { type: "builtin", id: "berserker_potion" } },
];

export class LibraryExplorer {
  private panel: HTMLElement;
  private titleEl: HTMLElement;
  private summaryEl: HTMLElement;
  private searchEl: HTMLInputElement;
  private filterEl: HTMLSelectElement;
  private gridEl: HTMLElement;
  private statusEl: HTMLElement;
  private modeBtns = new Map<Mode, HTMLButtonElement>();
  private compactBtn: HTMLButtonElement;
  private uploadEl: HTMLInputElement;
  private open = false;
  private compact = false;
  private mode: Mode = "new";
  private category: ExistingCategory = "all";
  private newCategory: ExistingCategory = "all";
  private previewDisposers: Array<() => void> = [];

  constructor(private deps: LibraryExplorerDeps) {
    this.panel = document.createElement("div");
    this.panel.id = "devEntityLibraryPanel";
    this.panel.style.cssText =
      "position:fixed; inset:18px; z-index:80; display:none; flex-direction:column; overflow:hidden;" +
      "background:#10131af7; border:1px solid #4a9a52; border-radius:8px; color:#e8e8e8;" +
      "font:12px/1.4 system-ui,sans-serif; box-shadow:0 18px 60px #000c;";

    const head = document.createElement("div");
    head.style.cssText =
      "display:grid; grid-template-columns:auto 1fr auto; gap:10px; align-items:center; padding:12px 14px;" +
      "background:#1c2230; border-bottom:1px solid #31405a;";

    this.compactBtn = document.createElement("button");
    this.compactBtn.textContent = "−";
    this.compactBtn.title = "Minify library";
    this.compactBtn.setAttribute("aria-label", "Minify library");
    this.compactBtn.style.cssText = iconButtonCss();
    this.compactBtn.onclick = () => this.setCompact(!this.compact);

    const titleBox = document.createElement("div");
    this.titleEl = document.createElement("b");
    this.titleEl.style.cssText = "display:block; color:#9fe0a0; font-size:15px;";
    this.titleEl.textContent = "Entity Library";
    this.summaryEl = document.createElement("div");
    this.summaryEl.style.cssText = "color:#9fb0c0; font-size:11px; margin-top:2px;";
    titleBox.append(this.titleEl, this.summaryEl);

    const controls = document.createElement("div");
    controls.style.cssText = "display:flex; align-items:center; gap:7px;";
    for (const mode of MODES) {
      const b = document.createElement("button");
      b.textContent = mode === "existing" ? "Existing entities" : "New entity";
      b.style.cssText = tabButtonCss(false);
      b.onclick = () => this.setMode(mode);
      this.modeBtns.set(mode, b);
      controls.appendChild(b);
    }
    const refresh = document.createElement("button");
    refresh.innerHTML = refreshIconSvg();
    refresh.title = "Refresh library";
    refresh.setAttribute("aria-label", "Refresh library");
    refresh.style.cssText = iconButtonCss();
    refresh.onclick = () => void this.render();
    const close = document.createElement("button");
    close.textContent = "X";
    close.title = "Close";
    close.setAttribute("aria-label", "Close");
    close.style.cssText = iconButtonCss();
    close.onclick = () => this.close();
    controls.append(refresh, close);
    head.append(this.compactBtn, titleBox, controls);

    const toolbar = document.createElement("div");
    toolbar.style.cssText =
      "display:grid; grid-template-columns:minmax(180px, 1fr) 180px auto; gap:8px; align-items:center;" +
      "padding:10px 14px; background:#111720; border-bottom:1px solid #263245;";
    this.searchEl = document.createElement("input");
    this.searchEl.type = "search";
    this.searchEl.placeholder = "Search entities";
    this.searchEl.style.cssText =
      "min-width:0; height:32px; border:1px solid #35445e; border-radius:6px; background:#0b0f16;" +
      "color:#eef4fb; padding:0 10px; outline:none;";
    this.searchEl.oninput = () => void this.render();
    this.filterEl = document.createElement("select");
    this.filterEl.style.cssText =
      "height:32px; border:1px solid #35445e; border-radius:6px; background:#0b0f16; color:#eef4fb; padding:0 8px;";
    this.filterEl.onchange = () => {
      if (this.mode === "existing") this.category = this.filterEl.value as ExistingCategory;
      else this.newCategory = this.filterEl.value as ExistingCategory;
      void this.render();
    };
    const uploadWrap = document.createElement("label");
    uploadWrap.textContent = "Import GLB";
    uploadWrap.style.cssText = smallButtonCss("#26362c", "#dff5df") + "display:inline-flex; align-items:center;";
    this.uploadEl = document.createElement("input");
    this.uploadEl.type = "file";
    this.uploadEl.accept = ".glb,model/gltf-binary";
    this.uploadEl.style.display = "none";
    this.uploadEl.onchange = (e) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (!f) return;
      const name = f.name.replace(/\.glb$/i, "").slice(0, 24) || "prop";
      this.setStatus(`uploading ${name}...`);
      this.deps.uploadModel(f, name);
      (e.target as HTMLInputElement).value = "";
    };
    uploadWrap.appendChild(this.uploadEl);
    toolbar.append(this.searchEl, this.filterEl, uploadWrap);

    this.gridEl = document.createElement("div");
    this.gridEl.style.cssText =
      "overflow:auto; padding:14px; display:grid; grid-template-columns:repeat(auto-fill, minmax(178px, 1fr)); gap:12px;";
    this.statusEl = document.createElement("div");
    this.statusEl.style.cssText =
      "padding:8px 14px; min-height:16px; border-top:1px solid #263245; color:#9fb0c0; background:#0d1118; font-size:11px;";

    this.panel.append(head, toolbar, this.gridEl, this.statusEl);
    document.body.appendChild(this.panel);
    this.refreshChrome();
  }

  toggle() {
    this.open ? this.close() : this.openPanel();
  }

  openNew() {
    this.openPanel("new");
  }

  private openPanel(mode: Mode = "new") {
    this.mode = mode;
    this.open = true;
    this.panel.style.display = "flex";
    this.refreshChrome();
    void this.render();
  }

  close() {
    this.open = false;
    this.panel.style.display = "none";
    this.disposePreviews();
    this.deps.clearFocus();
  }

  setStatus(msg: string) {
    this.statusEl.textContent = msg;
  }

  private setMode(mode: Mode) {
    this.mode = mode;
    this.searchEl.placeholder = mode === "existing" ? "Search existing entities" : "Search new entities";
    this.refreshChrome();
    void this.render();
  }

  private setCompact(on: boolean) {
    this.compact = on;
    this.refreshChrome();
    if (this.open) void this.render();
  }

  private refreshChrome() {
    this.panel.style.inset = this.compact ? "auto 16px 82px auto" : "18px";
    this.panel.style.width = this.compact ? "360px" : "auto";
    this.panel.style.height = this.compact ? "520px" : "auto";
    this.panel.style.maxHeight = this.compact ? "72vh" : "none";
    this.compactBtn.textContent = this.compact ? "□" : "−";
    this.compactBtn.title = this.compact ? "Expand library" : "Minify library";
    this.compactBtn.setAttribute("aria-label", this.compact ? "Expand library" : "Minify library");
    this.gridEl.style.gridTemplateColumns = this.compact ? "1fr" : "repeat(auto-fill, minmax(178px, 1fr))";
    this.gridEl.style.gap = this.compact ? "7px" : "12px";
    for (const [mode, btn] of this.modeBtns) btn.style.cssText = tabButtonCss(mode === this.mode);
    this.renderFilterOptions();
  }

  private renderFilterOptions() {
    const opts = CATEGORIES.map((c) => [c, c === "all" ? "All types" : cap(c)] as const);
    this.filterEl.innerHTML = "";
    for (const [value, label] of opts) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      this.filterEl.appendChild(option);
    }
    this.filterEl.value = this.mode === "existing" ? this.category : this.newCategory;
    this.uploadEl.parentElement!.style.display = this.mode === "new" ? "inline-flex" : "none";
  }

  private async render() {
    if (!this.open) return;
    this.disposePreviews();
    this.gridEl.textContent = "loading...";
    if (this.mode === "existing") await this.renderExisting();
    else await this.renderNew();
  }

  private async renderExisting() {
    const entries = await this.existingEntries();
    if (!this.open || this.mode !== "existing") return;
    const total = entries.reduce((sum, e) => sum + countNumber(e.badge), 0);
    this.summaryEl.textContent = `${total} total entities in world`;
    this.titleEl.textContent = "Entity Library";
    const q = normalized(this.searchEl.value);
    const filtered = entries.filter((e) => {
      const matchesSearch = !q || normalized(`${e.label} ${e.meta ?? ""} ${e.category}`).includes(q);
      const matchesCategory = this.category === "all" || e.category === this.category;
      return matchesSearch && matchesCategory;
    });
    this.gridEl.innerHTML = "";
    if (!filtered.length) {
      this.gridEl.textContent = "nothing matches";
      return;
    }
    for (const e of filtered) this.gridEl.appendChild(this.existingCard(e));
    this.setStatus("Click a card to cycle through matching world instances and open the inspector.");
  }

  private async renderNew() {
    const [allModels, defs, placements] = await Promise.all([
      this.fetchJson<ModelEntry[]>("/__props/models"),
      this.fetchJson<CharacterDef[]>("/__char/defs"),
      this.fetchJson<PlacementLite[]>("/__char/placements"),
    ]);
    const models = allModels.filter((m) => !runtimeAssetInfo(m.model));
    if (!this.open || this.mode !== "new") return;
    const placed = this.deps.propManager.all();
    this.titleEl.textContent = "Entity Library";
    const total = BUILTIN_NEW_ENTITIES.length + defs.length + models.length;
    this.summaryEl.textContent = `${total} new entity templates`;
    const q = normalized(this.searchEl.value);
    const matches = (label: string, meta: string, category: ExistingCategory) => {
      const matchesSearch = !q || normalized(`${label} ${meta} ${category}`).includes(q);
      const matchesCategory = this.newCategory === "all" || this.newCategory === category;
      return matchesSearch && matchesCategory;
    };
    const builtin = BUILTIN_NEW_ENTITIES.filter((e) => matches(e.label, e.meta, e.category));
    const filteredDefs = defs.filter((d) => matches(d.name || d.id, `Custom character ${d.baseModel}`, "characters"));
    const filteredModels = models.filter((m) => matches(m.name, `Placed object ${m.model}`, "objects"));
    this.gridEl.innerHTML = "";
    if (!builtin.length && !filteredDefs.length && !filteredModels.length) {
      this.gridEl.textContent = "no entities match";
      return;
    }
    for (const e of builtin) {
      const current = this.currentCountFor(e.kind);
      this.gridEl.appendChild(this.templateCard(e, current));
    }
    for (const d of filteredDefs) {
      const count = placements.filter((p) => p.defId === d.id).length;
      this.gridEl.appendChild(this.characterCard(d, count));
    }
    for (const m of filteredModels) {
      const count = placed.filter((p) => p.def.model === m.model).length;
      this.gridEl.appendChild(this.modelCard(m, count));
    }
    this.setStatus("Click an entity to add it, then move the cursor over the ground and click to place.");
  }

  private existingCard(e: Entry): HTMLElement {
    const b = document.createElement("button");
    b.style.cssText = cardCss(this.compact, e.dim);
    b.innerHTML = `
      <div style="display:flex; justify-content:space-between; gap:10px; align-items:start;">
        <div style="min-width:0;">
          <div style="font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(e.label)}</div>
          <div style="color:#8fa0b5; font-size:11px; margin-top:3px;">${esc(e.meta ?? cap(e.category))}</div>
        </div>
        <div style="flex:none; min-width:34px; text-align:center; background:#0d131d; border:1px solid #263245; border-radius:6px; padding:3px 6px; color:#b8c7dc;">${esc(e.badge ?? "")}</div>
      </div>`;
    b.onmouseenter = () => (b.style.borderColor = "#65bc72");
    b.onmouseleave = () => (b.style.borderColor = "#2a3548");
    b.onclick = () => e.onClick();
    return b;
  }

  private modelCard(m: ModelEntry, placedCount: number): HTMLElement {
    return this.modelLikeCard(m, mb(m.size), `${placedCount} placed`, () => {
      this.setStatus(`placing ${m.name}...`);
      this.deps.placeModel(m.model, m.name);
    });
  }

  private modelLikeCard(m: ModelEntry, leftMeta: string, rightMeta: string, onAdd: () => void): HTMLElement {
    const b = document.createElement("button");
    b.style.cssText =
      cardCss(this.compact, false) +
      "padding:0; overflow:hidden;" +
      (this.compact ? "display:grid; grid-template-columns:92px minmax(0,1fr); align-items:stretch;" : "display:block;");
    const previewWrap = document.createElement("div");
    previewWrap.style.cssText =
      "position:relative; width:100%; height:" + (this.compact ? "100%" : "128px") + "; min-height:" + (this.compact ? "74px" : "128px") + "; background:#0a0e14; overflow:hidden;";
    const preview = document.createElement("img");
    preview.alt = "";
    preview.decoding = "async";
    preview.loading = "lazy";
    preview.width = this.compact ? 112 : 220;
    preview.height = this.compact ? 62 : 128;
    preview.style.cssText = "width:100%; height:100%; display:block; object-fit:contain; background:#0a0e14;";
    const fallback = this.thumbPlaceholder(m.name);
    previewWrap.append(preview, fallback);
    const body = document.createElement("div");
    body.style.cssText = "padding:9px; display:grid; gap:5px; min-width:0;";
    body.innerHTML = `
      <div style="font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(m.name)}</div>
      <div style="display:flex; justify-content:space-between; color:#8fa0b5; font-size:11px; gap:8px;">
        <span>${esc(leftMeta)}</span>
        <span>${esc(rightMeta)}</span>
      </div>
      <div style="height:26px; display:grid; place-items:center; border:1px solid #3f8c49; border-radius:6px; color:#e8ffe8; background:#23472b;">Add</div>`;
    b.append(previewWrap, body);
    b.onmouseenter = () => (b.style.borderColor = "#65bc72");
    b.onmouseleave = () => (b.style.borderColor = "#2a3548");
    b.onclick = onAdd;
    void this.loadThumb(preview, { type: "model", model: m.model, token: m.size }, fallback);
    return b;
  }

  private templateCard(e: TemplateEntry, currentCount: number): HTMLElement {
    const b = document.createElement("button");
    b.style.cssText = cardCss(this.compact, false);
    b.innerHTML = `
      <div style="display:flex; justify-content:space-between; gap:10px; align-items:start;">
        <div style="min-width:0;">
          <div style="font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(e.label)}</div>
          <div style="color:#8fa0b5; font-size:11px; margin-top:3px;">${esc(e.meta)}</div>
        </div>
        <div style="flex:none; min-width:34px; text-align:center; background:#0d131d; border:1px solid #263245; border-radius:6px; padding:3px 6px; color:#b8c7dc;">${currentCount}</div>
      </div>`;
    const previewWrap = document.createElement("div");
    previewWrap.style.cssText =
      "position:relative; margin-top:12px; height:74px; display:grid; place-items:center; background:#0a0e14; border:1px solid #263245; border-radius:6px; overflow:hidden;";
    const preview = document.createElement("img");
    preview.alt = "";
    preview.decoding = "async";
    preview.loading = "lazy";
    preview.width = 150;
    preview.height = 74;
    preview.style.cssText = "width:100%; height:100%; display:block; object-fit:contain; background:#0a0e14;";
    const fallback = this.thumbPlaceholder(e.label);
    previewWrap.append(preview, fallback);
    if (e.thumb) void this.loadThumb(preview, e.thumb, fallback);
    const add = document.createElement("div");
    add.textContent = "Add";
    add.style.cssText =
      "margin-top:8px; height:26px; display:grid; place-items:center; border:1px solid #3f8c49; border-radius:6px; color:#e8ffe8; background:#23472b;";
    b.append(previewWrap, add);
    b.onmouseenter = () => (b.style.borderColor = "#65bc72");
    b.onmouseleave = () => (b.style.borderColor = "#2a3548");
    b.onclick = () => {
      this.setStatus(`placing ${e.label}...`);
      this.deps.spawnEntity(e.kind, e.label);
    };
    return b;
  }

  private characterCard(def: CharacterDef, placedCount: number): HTMLElement {
    const m: ModelEntry = {
      name: def.name || def.id,
      model: def.baseModel,
      size: 0,
    };
    const b = this.modelLikeCard(m, "Custom character", `${placedCount} placed`, () => {
      this.setStatus(`placing ${def.name || def.id}...`);
      this.deps.placeCharacter(def);
    });
    return b;
  }

  private async existingEntries(): Promise<Entry[]> {
    const st = this.state();
    const out: Entry[] = [];

    st?.players?.forEach((p, id) => {
      out.push({
        label: p.name || shortId(id),
        badge: "1",
        meta: `Player · level ${p.level ?? 1}`,
        category: "players",
        onClick: this.cycleIds("player", [id]),
      });
    });

    const trees = idsOf(st?.trees);
    const rocks = idsOf(st?.rocks);
    out.push({ label: "Tree", badge: count(trees), meta: "Resource", category: "resources", dim: !trees.length, onClick: this.cycleIds("tree", trees) });
    out.push({ label: "Rock", badge: count(rocks), meta: "Resource", category: "resources", dim: !rocks.length, onClick: this.cycleIds("rock", rocks) });

    const houses = idsOf(st?.houses);
    const crates = CRATES.map((c) => ({ x: c.x, z: c.z }));
    out.push({ label: "House", badge: count(houses), meta: "Structure", category: "structures", dim: !houses.length, onClick: this.cycleIds("house", houses) });
    out.push({ label: "Crate", badge: count(crates), meta: "Static structure", category: "structures", dim: !crates.length, onClick: this.cyclePos("crate", crates) });

    const itemKinds: Array<[string, string]> = [
      ["log", "logs"],
      ["stone", "stones"],
      ["banana", "bananas"],
      ["potion", "potions"],
    ];
    for (const [kind, map] of itemKinds) {
      const ids = idsOf(st?.[map]);
      out.push({ label: cap(kind), badge: count(ids), meta: "Item", category: "items", dim: !ids.length, onClick: this.cycleIds(kind, ids) });
    }
    await loadItemDefs().catch(() => undefined);
    const customItems = new Map<string, string[]>();
    st?.items?.forEach((item, id) => {
      const itemId = item.itemId || "item";
      const ids = customItems.get(itemId) ?? [];
      ids.push(id);
      customItems.set(itemId, ids);
    });
    for (const [itemId, ids] of customItems) {
      out.push({
        label: itemName(itemId),
        badge: count(ids),
        meta: "Custom item",
        category: "items",
        dim: !ids.length,
        onClick: this.cycleIds("item", ids),
      });
    }

    const [defs, placements] = await Promise.all([
      this.fetchJson<CharacterDef[]>("/__char/defs"),
      this.fetchJson<PlacementLite[]>("/__char/placements"),
    ]);
    for (const d of defs) {
      const ids = placements.filter((p) => p.defId === d.id).map((p) => p.id);
      out.push({
        label: d.name || d.id,
        badge: count(ids),
        meta: "Custom character",
        category: "characters",
        dim: !ids.length,
        onClick: this.cycleIds("enemy", ids),
      });
    }
    const goblins = idsOf(st?.enemies, (v) => v.kind === "goblin");
    const dummies = idsOf(st?.enemies, (v) => v.kind === "dummy");
    out.push({ label: "Goblin", badge: count(goblins), meta: "Enemy", category: "characters", dim: !goblins.length, onClick: this.cycleIds("enemy", goblins) });
    out.push({ label: "Dummy", badge: count(dummies), meta: "Enemy", category: "characters", dim: !dummies.length, onClick: this.cycleIds("enemy", dummies) });

    const placed = this.deps.propManager.all();
    const byModel = new Map<string, { label: string; ids: string[] }>();
    for (const p of placed) {
      const model = p.def.model;
      const group = byModel.get(model) ?? { label: p.def.name || nameFromModel(model), ids: [] };
      group.ids.push(p.id);
      if (!group.label && p.def.name) group.label = p.def.name;
      byModel.set(model, group);
    }
    for (const [model, group] of byModel) {
      const runtime = runtimeAssetInfo(model);
      if (runtime) continue;
      out.push({
        label: group.label || nameFromModel(model),
        badge: count(group.ids),
        meta: "Placed object",
        category: "objects",
        dim: !group.ids.length,
        onClick: this.cycleIds("prop", group.ids),
      });
    }

    return out;
  }

  private state(): Record<string, Coll | undefined> | null {
    return (this.deps.net.room?.state as unknown as Record<string, Coll | undefined>) ?? null;
  }

  private currentCountFor(kind: string): number {
    const st = this.state();
    if (!st) return 0;
    if (kind === "goblin") return idsOf(st.enemies, (v) => v.kind === "goblin").length;
    if (kind === "dummy") return idsOf(st.enemies, (v) => v.kind === "dummy").length;
    if (kind === "berserker_potion") return idsOf(st.potions, (v) => v.kind === "berserker_potion").length;
    if (kind === "potion") return idsOf(st.potions, (v) => !v.kind || v.kind === "potion").length;
    const mapName = `${kind}s`;
    return st[mapName]?.size ?? 0;
  }

  private cycleIds(kind: string, ids: string[]): () => void {
    let i = 0;
    return () => {
      if (!ids.length) return this.setStatus("none in world");
      const id = ids[i % ids.length];
      const ok = this.deps.focusEntity(kind, id);
      this.setStatus(ok ? `${kind} · ${shortId(id)}  (${(i % ids.length) + 1}/${ids.length})` : `${kind} no longer in world`);
      i++;
    };
  }

  private cyclePos(label: string, ps: Array<{ x: number; z: number }>): () => void {
    let i = 0;
    return () => {
      if (!ps.length) return this.setStatus("none in world");
      const p = ps[i % ps.length];
      this.deps.focusPos(p.x, p.z);
      this.setStatus(`${label}  (${(i % ps.length) + 1}/${ps.length})`);
      i++;
    };
  }

  private thumbPlaceholder(label: string): HTMLElement {
    const el = document.createElement("div");
    el.style.cssText =
      "position:absolute; inset:0; display:grid; place-items:center;" +
      "background:linear-gradient(135deg,#172233,#0a0e14); color:#d9ffe0; pointer-events:none;";
    el.innerHTML = `
      <div style="width:52px; height:52px; display:grid; place-items:center; border:2px solid #3f8c49; color:#d9ffe0; background:#223149; clip-path:polygon(50% 0, 94% 25%, 94% 75%, 50% 100%, 6% 75%, 6% 25%); font:700 12px system-ui;">
        ${esc(initials(label))}
      </div>`;
    return el;
  }

  private async loadThumb(img: HTMLImageElement, source: ThumbSource, fallback: HTMLElement) {
    const url = await getThumbUrl(source);
    if (!url || !img.isConnected) return;
    img.onload = () => {
      fallback.style.display = "none";
    };
    img.onerror = () => {
      fallback.style.display = "";
    };
    img.src = url;
    if (img.complete && img.naturalWidth > 0) fallback.style.display = "none";
  }

  private disposePreviews() {
    for (const dispose of this.previewDisposers.splice(0)) dispose();
  }

  private async fetchJson<T>(url: string): Promise<T> {
    try {
      const r = await fetch(url, { cache: "no-store" });
      return r.ok ? ((await r.json()) as T) : ([] as unknown as T);
    } catch {
      return [] as unknown as T;
    }
  }
}

const THUMB_W = 220;
const THUMB_H = 128;
const THUMB_CACHE_VERSION = "entity-thumbs-v2";
const thumbUrls = new Map<string, string>();
const thumbJobs = new Map<string, Promise<string | null>>();
const thumbRenderQueue: Array<() => void> = [];
let activeThumbRenders = 0;

interface ThumbTarget {
  root: TransformNode;
  meshes: AbstractMesh[];
  dispose: () => void;
}

async function getThumbUrl(source: ThumbSource): Promise<string | null> {
  const key = thumbKey(source);
  const cached = thumbUrls.get(key);
  if (cached) return cached;
  const existingJob = thumbJobs.get(key);
  if (existingJob) return existingJob;

  const job = (async () => {
    const cachedUrl = await readThumbUrl(key);
    if (cachedUrl) {
      thumbUrls.set(key, cachedUrl);
      return cachedUrl;
    }
    const blob = await enqueueThumbRender(source);
    if (!blob) return null;
    await writeThumbBlob(key, blob);
    const url = URL.createObjectURL(blob);
    thumbUrls.set(key, url);
    return url;
  })().finally(() => {
    thumbJobs.delete(key);
  });
  thumbJobs.set(key, job);
  return job;
}

async function readThumbUrl(key: string): Promise<string | null> {
  try {
    if (!("caches" in window)) return null;
    const cache = await window.caches.open(THUMB_CACHE_VERSION);
    const res = await cache.match(thumbRequest(key));
    if (!res) return null;
    return URL.createObjectURL(await res.blob());
  } catch {
    return null;
  }
}

async function writeThumbBlob(key: string, blob: Blob): Promise<void> {
  try {
    if (!("caches" in window)) return;
    const cache = await window.caches.open(THUMB_CACHE_VERSION);
    await cache.put(
      thumbRequest(key),
      new Response(blob, {
        headers: {
          "content-type": blob.type || "image/png",
          "cache-control": "max-age=31536000, immutable",
        },
      }),
    );
  } catch {
    /* Cache API may be unavailable in some embedded contexts; memory cache still works. */
  }
}

function thumbRequest(key: string): Request {
  return new Request(`${location.origin}/__entity-thumb-cache/${key}.webp`);
}

async function renderThumbBlob(source: ThumbSource): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = THUMB_W;
  canvas.height = THUMB_H;
  let engine: Engine | null = null;
  let scene: Scene | null = null;
  let target: ThumbTarget | null = null;
  try {
    engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: false, antialias: true }, true);
    scene = new Scene(engine);
    scene.clearColor = new Color4(0.055, 0.07, 0.095, 1);
    scene.ambientColor = new Color3(0.58, 0.58, 0.62);
    const hemi = new HemisphericLight("thumbHemi", new Vector3(0.2, 1, 0.3), scene);
    hemi.intensity = 1.45;
    const key = new DirectionalLight("thumbKey", new Vector3(-0.5, -1, -0.35), scene);
    key.intensity = 2.35;

    target = await buildThumbTarget(scene, source);
    fitThumbTarget(target);
    const b = bounds(target.meshes);
    const center = new Vector3((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
    const span = Math.max(1, b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);
    const camera = new ArcRotateCamera("thumbCamera", -Math.PI / 4, Math.PI / 2.75, span * 2.15, center, scene);
    camera.minZ = 0.01;
    camera.maxZ = span * 24;
    camera.setPosition(new Vector3(center.x + span * 1.3, center.y + span * 0.8, center.z + span * 1.3));
    camera.setTarget(center);
    scene.activeCamera = camera;
    engine.resize();
    await scene.whenReadyAsync();
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      scene.render();
    }
    return await canvasBlob(canvas);
  } catch {
    return null;
  } finally {
    target?.dispose();
    scene?.dispose();
    engine?.dispose();
  }
}

function enqueueThumbRender(source: ThumbSource): Promise<Blob | null> {
  return new Promise((resolve) => {
    const run = () => {
      activeThumbRenders++;
      void renderThumbBlob(source)
        .then(resolve)
        .finally(() => {
          activeThumbRenders--;
          const next = thumbRenderQueue.shift();
          if (next) next();
        });
    };
    if (activeThumbRenders < 1) run();
    else thumbRenderQueue.push(run);
  });
}

async function buildThumbTarget(scene: Scene, source: ThumbSource): Promise<ThumbTarget> {
  if (source.type === "model") {
    const loaded = await importModel(scene, source.model);
    for (const mesh of loaded.meshes) {
      if (mesh.getTotalVertices && mesh.getTotalVertices() > 0) mesh.isVisible = true;
    }
    return loaded;
  }
  if (source.id === "tree") return buildTree(scene);
  if (source.id === "rock") return buildRock(scene, 1.25);
  if (source.id === "log") return buildLog(scene);
  if (source.id === "stone") return buildStone(scene);
  if (source.id === "potion") return buildPotion(scene);
  if (source.id === "banana") return buildBanana(scene);
  if (source.id === "berserker_potion") return buildBerserkerPotion(scene);
  return buildDummy(scene);
}

function fitThumbTarget(target: ThumbTarget) {
  let b = bounds(target.meshes);
  const footprint = Math.max(0.001, b.max.x - b.min.x, b.max.z - b.min.z);
  const k = 3.5 / footprint;
  target.root.scaling.scaleInPlace(k);
  target.root.rotation.y += -Math.PI / 7;
  target.root.computeWorldMatrix(true);
  b = bounds(target.meshes);
  target.root.position.x += -(b.min.x + b.max.x) / 2;
  target.root.position.z += -(b.min.z + b.max.z) / 2;
  target.root.position.y += -b.min.y;
  target.root.computeWorldMatrix(true);
}

async function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  const webp = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.86));
  if (webp) return webp;
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
}

function thumbKey(source: ThumbSource): string {
  const raw =
    source.type === "model"
      ? `model:${source.model}:${source.token ?? ""}:${THUMB_W}x${THUMB_H}`
      : `builtin:${source.id}:${source.token ?? ""}:${THUMB_W}x${THUMB_H}`;
  return `${THUMB_CACHE_VERSION}-${hashString(raw)}`;
}

function hashString(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function idsOf(map: Coll | undefined, filter?: (v: SyncedItem) => boolean): string[] {
  const ids: string[] = [];
  map?.forEach((v, k) => {
    if (!filter || filter(v)) ids.push(k);
  });
  return ids;
}

const count = (a: unknown[]) => `${a.length}`;
const countNumber = (s?: string) => {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const shortId = (id: string) => (id.length > 18 ? "..." + id.slice(-16) : id);
const mb = (bytes: number) => (bytes > 1e6 ? (bytes / 1e6).toFixed(1) + "MB" : Math.round(bytes / 1e3) + "KB");
const normalized = (s: string) => s.trim().toLowerCase();
const nameFromModel = (model: string) => model.split("/").pop()?.replace(/\.glb$/i, "") || model;
const runtimeAssetInfo = (model: string): string | null => {
  const name = nameFromModel(model).toLowerCase();
  if (name === "attack") return "Attack animation clip for the player rig";
  if (name === "throw") return "Throw animation clip for the player rig";
  if (name === "knight") return "Base player character rig";
  if (name === "goblin") return "Enemy character runtime model";
  if (name === "house") return "La Crypta structure runtime model";
  return null;
};
const initials = (s: string) =>
  s
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("") || "3D";
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);

const tabButtonCss = (on: boolean) =>
  `cursor:pointer; background:${on ? "#3a7a40" : "#222a38"}; color:${on ? "#fff" : "#bcd"}; border:1px solid ${
    on ? "#7dd986" : "#3a4658"
  }; border-radius:6px; padding:6px 9px; font:12px system-ui,sans-serif;`;

const smallButtonCss = (bg: string, color: string) =>
  `cursor:pointer; background:${bg}; color:${color}; border:1px solid #4a5b72; border-radius:6px; padding:6px 9px; font:12px system-ui,sans-serif;`;

const iconButtonCss = () =>
  "cursor:pointer; width:24px; height:24px; display:grid; place-items:center; padding:0;" +
  "background:#222a38; color:#d8e2ef; border:1px solid #4a5b72; border-radius:5px;" +
  "font:16px/1 system-ui,sans-serif;";

const refreshIconSvg = () =>
  '<svg aria-hidden="true" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M21 12a9 9 0 1 1-2.64-6.36" />' +
  '<path d="M21 3v6h-6" />' +
  "</svg>";

const cardCss = (compact: boolean, dim: boolean) =>
  "cursor:pointer; text-align:left; border:1px solid #2a3548; border-radius:8px;" +
  `background:${dim ? "#151a23" : "#171f2b"}; color:${dim ? "#7f8ba0" : "#e8e8e8"};` +
  `padding:${compact ? "8px" : "10px"}; min-width:0; box-shadow:0 8px 22px #0005;`;
