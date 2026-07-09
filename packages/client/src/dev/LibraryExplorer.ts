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
import type { NetworkClient } from "../net/NetworkClient";
import { buildBanana } from "../entities/models/banana";
import { buildBerserkerPotion } from "../entities/models/berserkerPotion";
import { buildDummy } from "../entities/models/dummy";
import { buildLog } from "../entities/models/log";
import { buildPotion } from "../entities/models/potion";
import { buildRock } from "../entities/models/rock";
import { buildStone } from "../entities/models/stone";
import { buildTree } from "../entities/models/tree";
import { bounds, importModel } from "../scene/props";
import type { PropManager } from "./PropManager";
import { loadItemDefs } from "../items/itemRegistry";
import type { CharacterDef } from "../entities/characterDef";
import type { CommunityEntityType, CharacterStatsConfig, CommunityProvenance } from "@rpg/shared";
import { publishCharacter, publishStructure, publishItem } from "./communityPublish";
import {
  fetchCommunityEntities,
  fetchProfiles,
  importCommunityEntity,
  type CommunityCard,
  type OwnerProfile,
} from "./communityBrowse";
import { ensureNostrLogin } from "../ui/nostrLoginModal";
import { readCache, writeCache, CACHE_LOCAL, CACHE_COMMUNITY } from "./libraryCache";

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
  /** Hand off to the floating instance navigator (◀ prev / next ▶) on the map. */
  browseInstances: (focusKind: string, ids: string[], label: string) => void;
  spawnEntity: (kind: string, label: string) => void;
  placeCharacter: (def: CharacterDef) => void;
  placeModel: (model: string, name: string) => void;
  uploadModel: (file: File, name: string) => void;
  openItemLibrary: () => void;
  /** Open the stepped creator wizard for a given entity type. */
  createEntity: (type: CommunityEntityType) => void;
  /** Grant a custom item to the player's inventory (Library "＋ Add" on items). */
  giveItem: (id: string, label: string) => void;
}

/** A creator-authored structure def (mirrors vite StructureDef / structures-lib.json). */
interface StructureDef {
  id: string;
  name: string;
  description?: string;
  model: string;
  scale: number;
  collisionRadius?: number;
  hp?: number;
  stats?: CharacterStatsConfig;
  community?: CommunityProvenance;
}

/** A custom item def (mirrors vite ItemDef / items.json). */
interface ItemDefLite {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  model?: string;
  stack?: number;
  worldScale?: number;
  community?: CommunityProvenance;
}

/** The full set of Local-library lists fetched from the dev server (cached for SWR). */
interface LocalLists {
  allModels: ModelEntry[];
  defs: CharacterDef[];
  placements: PlacementLite[];
  structDefs: StructureDef[];
  itemDefs: ItemDefLite[];
  pending: { characters: string[]; structures: string[]; items: string[] };
}

interface ModelEntry {
  name: string;
  model: string;
  size: number;
}

type BuiltinThumb = "tree" | "bush" | "rock" | "log" | "stone" | "potion" | "banana" | "berserker_potion" | "dummy";
type ThumbSource =
  | { type: "model"; model: string; token?: string | number }
  | { type: "builtin"; id: BuiltinThumb; token?: string | number }
  | { type: "image"; url: string };

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

const ENTRY_CATEGORIES = ["characters", "players", "resources", "structures", "objects", "items"] as const;
type ExistingCategory = (typeof ENTRY_CATEGORIES)[number];
// Create-entity top-level kinds the user picks between.
const LIBRARY_TABS = ["character", "structure", "item"] as const;
type LibraryTab = (typeof LIBRARY_TABS)[number];
const BUILTIN_NEW_ENTITIES: TemplateEntry[] = [
  { label: "Goblin", kind: "goblin", meta: "Enemy", category: "characters", thumb: { type: "model", model: "/models/goblin.glb", token: "runtime" } },
  { label: "Dummy", kind: "dummy", meta: "Training enemy", category: "characters", thumb: { type: "builtin", id: "dummy" } },
  { label: "Tree", kind: "tree", meta: "Resource", category: "resources", thumb: { type: "builtin", id: "tree" } },
  { label: "Bush", kind: "bush", meta: "Cranberry resource", category: "resources", thumb: { type: "builtin", id: "bush" } },
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
  private gridEl: HTMLElement;
  private statusEl: HTMLElement;
  private categoryBtns = new Map<LibraryTab, HTMLButtonElement>();
  private compactBtn: HTMLButtonElement;
  private uploadEl: HTMLInputElement;
  private addBtn: HTMLButtonElement;
  private open = false;
  private compact = false;
  private activeTab: LibraryTab = "character";
  private source: "local" | "community" = "local";
  private localBtn!: HTMLButtonElement;
  private communityBtn!: HTMLButtonElement;
  private renderToken = 0; // guards against overlapping async renders

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
    this.titleEl.textContent = "Library";
    this.summaryEl = document.createElement("div");
    this.summaryEl.style.cssText = "color:#9fb0c0; font-size:11px; margin-top:2px;";
    titleBox.append(this.titleEl, this.summaryEl);

    const controls = document.createElement("div");
    controls.style.cssText = "display:flex; align-items:center; gap:7px;";
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

    // Local ⇆ Community source toggle (segmented control).
    const sourceToggle = document.createElement("div");
    sourceToggle.style.cssText = "display:flex; gap:0; border:1px solid #35445e; border-radius:7px; overflow:hidden;";
    this.localBtn = document.createElement("button");
    this.localBtn.textContent = "Local";
    this.localBtn.onclick = () => this.setSource("local");
    this.communityBtn = document.createElement("button");
    this.communityBtn.textContent = "Community";
    this.communityBtn.onclick = () => this.setSource("community");
    sourceToggle.append(this.localBtn, this.communityBtn);

    const toolbar = document.createElement("div");
    toolbar.style.cssText =
      "display:grid; grid-template-columns:auto minmax(140px, 1fr) auto; gap:8px; align-items:center;" +
      "padding:10px 14px; background:#111720; border-bottom:1px solid #263245;";
    this.searchEl = document.createElement("input");
    this.searchEl.type = "search";
    this.searchEl.placeholder = "Search entities";
    this.searchEl.style.cssText =
      "min-width:0; height:32px; border:1px solid #35445e; border-radius:6px; background:#0b0f16;" +
      "color:#eef4fb; padding:0 10px; outline:none;";
    this.searchEl.oninput = () => void this.render();
    // Hidden .glb picker, triggered by "Add Structure".
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
    // Per-tab primary "Add <Type>" button (label + action set in refreshChrome).
    this.addBtn = document.createElement("button");
    this.addBtn.style.cssText = smallButtonCss("#26362c", "#dff5df");
    this.addBtn.onclick = () => this.onAddClick();
    toolbar.append(sourceToggle, this.searchEl, this.addBtn, this.uploadEl);

    const categoryTabs = document.createElement("div");
    categoryTabs.style.cssText =
      "display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:6px; padding:0 14px 10px;" +
      "background:#111720; border-bottom:1px solid #263245;";
    categoryTabs.setAttribute("role", "tablist");
    for (const tab of LIBRARY_TABS) {
      const b = document.createElement("button");
      b.textContent = tabLabel(tab);
      b.setAttribute("role", "tab");
      b.style.cssText = categoryTabCss(false);
      b.onclick = () => this.setActiveTab(tab);
      this.categoryBtns.set(tab, b);
      categoryTabs.appendChild(b);
    }

    this.gridEl = document.createElement("div");
    this.gridEl.style.cssText =
      "overflow:auto; padding:14px; display:grid; grid-template-columns:repeat(auto-fill, minmax(178px, 1fr)); gap:12px;";
    this.statusEl = document.createElement("div");
    this.statusEl.style.cssText =
      "padding:8px 14px; min-height:16px; border-top:1px solid #263245; color:#9fb0c0; background:#0d1118; font-size:11px;";

    this.panel.append(head, toolbar, categoryTabs, this.gridEl, this.statusEl);
    document.body.appendChild(this.panel);
    this.refreshChrome();
  }

  toggle() {
    this.open ? this.close() : this.openPanel();
  }

  private openPanel() {
    this.open = true;
    this.panel.style.display = "flex";
    this.refreshChrome();
    void this.render();
  }

  close() {
    this.open = false;
    this.panel.style.display = "none";
    this.deps.clearFocus();
  }

  setStatus(msg: string) {
    this.statusEl.textContent = msg;
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
    for (const [tab, btn] of this.categoryBtns) {
      const on = tab === this.activeTab;
      btn.style.cssText = categoryTabCss(on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    }
    const addLabel: Record<LibraryTab, string> = {
      character: "➕ Add Character",
      structure: "➕ Add Structure",
      item: "➕ Add Item",
    };
    this.addBtn.textContent = addLabel[this.activeTab];
    // Source toggle styling + "Add" only makes sense for the Local library.
    this.localBtn.style.cssText = sourceBtnCss(this.source === "local");
    this.communityBtn.style.cssText = sourceBtnCss(this.source === "community");
    this.addBtn.style.display = this.source === "local" ? "" : "none";
  }

  /** The per-tab "Add <Type>" action opens the stepped creator wizard.
   *  (LibraryTab values match CommunityEntityType one-to-one.) */
  private onAddClick() {
    this.deps.createEntity(this.activeTab);
  }

  private setSource(source: "local" | "community") {
    if (this.source === source) return;
    this.source = source;
    this.refreshChrome();
    void this.render();
  }

  private setActiveTab(tab: LibraryTab) {
    this.activeTab = tab;
    this.refreshChrome();
    void this.render();
  }

  /** Open the Library focused on a tab + refresh (e.g. after the creator adds one). */
  showTab(tab: LibraryTab) {
    this.activeTab = tab;
    if (!this.open) this.openPanel();
    else {
      this.refreshChrome();
      void this.render();
    }
  }

  /** Single unified view: every entity type for the active tab as an identical
   *  card showing its thumbnail, name, live "N in map" count, and an Add action. */
  private async render() {
    if (!this.open) return;
    // A single render epoch across BOTH local + community renders: switching tabs
    // (or source) bumps it, so a slow in-flight render — e.g. the community relay
    // fetch — bails instead of clobbering the grid the new render just drew.
    const token = ++this.renderToken;
    if (this.source === "community") return this.renderCommunity(token);
    // SWR: paint the cached lists instantly, then always revalidate + repaint.
    const cached = readCache<LocalLists>(CACHE_LOCAL);
    if (cached) this.paintLocal(cached, token);
    else this.gridEl.textContent = "loading...";
    const lists = await this.fetchLocalLists();
    if (token !== this.renderToken || !this.open) return;
    writeCache(CACHE_LOCAL, lists);
    this.paintLocal(lists, token);
  }

  /** Fetch every Local-library list (defs + placements + git-pending) from the dev server. */
  private async fetchLocalLists(): Promise<LocalLists> {
    const [allModels, defs, placements, structDefs, itemDefs, pending] = await Promise.all([
      this.fetchJson<ModelEntry[]>("/__props/models"),
      this.fetchJson<CharacterDef[]>("/__char/defs"),
      this.fetchJson<PlacementLite[]>("/__char/placements"),
      this.fetchJson<StructureDef[]>("/__structures/defs"),
      this.fetchJson<ItemDefLite[]>("/__items/defs"),
      this.fetchPending(),
    ]);
    await loadItemDefs().catch(() => undefined);
    return { allModels, defs, placements, structDefs, itemDefs, pending };
  }

  /** Render the Local grid from already-fetched lists (live "in map" counts + search filter). */
  private paintLocal(lists: LocalLists, token: number) {
    if (token !== this.renderToken || !this.open) return;
    const { allModels, defs, placements, structDefs, itemDefs, pending } = lists;
    const pendingChars = new Set(pending.characters);
    const pendingStructs = new Set(pending.structures);
    const pendingItems = new Set(pending.items);
    // Models referenced by a structure def are shown as that def's card instead of
    // a bare "Object" — avoid listing the same .glb twice.
    const structModels = new Set(structDefs.map((s) => s.model));
    const models = allModels.filter((m) => !runtimeAssetInfo(m.model) && !structModels.has(m.model));
    const placed = this.deps.propManager.all();
    this.titleEl.textContent = "Library";
    const q = normalized(this.searchEl.value);
    const matches = (label: string, meta: string, category: ExistingCategory) =>
      (!q || normalized(`${label} ${meta} ${category}`).includes(q)) && this.matchesActiveTab(category);

    const cards: HTMLElement[] = [];
    let inMap = 0;

    // Built-in entity types: Tree/Rock/House, Goblin/Dummy, the pickup items.
    for (const e of BUILTIN_NEW_ENTITIES) {
      if (!matches(e.label, e.meta, e.category)) continue;
      const { ids, focusKind } = this.liveIdsForKind(e.kind);
      inMap += ids.length;
      cards.push(
        this.entityCard({
          name: e.label,
          meta: e.meta,
          thumb: e.thumb,
          count: ids.length,
          onAdd: () => {
            this.setStatus(`adding ${e.label}...`);
            this.deps.spawnEntity(e.kind, e.label);
          },
          onFocus: () => this.browse(focusKind, ids, e.label),
        }),
      );
    }

    // Custom characters (creator/imported Meshy defs).
    for (const d of defs) {
      const meta = d.description || "Custom character";
      if (!matches(d.name || d.id, meta, "characters")) continue;
      const ids = placements.filter((p) => p.defId === d.id).map((p) => p.id);
      inMap += ids.length;
      cards.push(
        this.entityCard({
          name: d.name || d.id,
          meta,
          thumb: { type: "model", model: d.baseModel },
          count: ids.length,
          onAdd: () => {
            this.setStatus(`adding ${d.name || d.id}...`);
            this.deps.placeCharacter(d);
          },
          onFocus: () => this.browse("enemy", ids, d.name || d.id),
          pending: pendingChars.has(d.id),
          onRemove: () => void this.removeEntity("character", d.id, d.name || d.id),
          onPublish: d.community?.imported ? undefined : () => void this.publishEntity("character", d),
          published: !!d.community && !d.community.imported,
        }),
      );
    }

    // Creator-authored structures (structures-lib.json).
    for (const s of structDefs) {
      const meta = s.description || "Custom structure";
      if (!matches(s.name || s.id, meta, "structures")) continue;
      const ids = placed.filter((p) => p.def.model === s.model).map((p) => p.id);
      inMap += ids.length;
      cards.push(
        this.entityCard({
          name: s.name || s.id,
          meta,
          thumb: { type: "model", model: s.model },
          count: ids.length,
          onAdd: () => {
            this.setStatus(`placing ${s.name || s.id}...`);
            this.deps.placeModel(s.model, s.name || s.id);
          },
          onFocus: () => this.browse("prop", ids, s.name || s.id),
          pending: pendingStructs.has(s.id),
          onRemove: () => void this.removeEntity("structure", s.id, s.name || s.id),
          onPublish: s.community?.imported ? undefined : () => void this.publishEntity("structure", s),
          published: !!s.community && !s.community.imported,
        }),
      );
    }

    // Creator-authored items (items.json).
    for (const it of itemDefs) {
      const meta = it.description || "Custom item";
      if (!matches(it.name || it.id, meta, "items")) continue;
      cards.push(
        this.entityCard({
          name: it.name || it.id,
          meta,
          thumb: it.icon ? { type: "image", url: it.icon } : it.model ? { type: "model", model: it.model } : undefined,
          count: 0,
          onAdd: () => {
            this.setStatus(`giving ${it.name || it.id}...`);
            this.deps.giveItem(it.id, it.name || it.id);
          },
          pending: pendingItems.has(it.id),
          onRemove: () => void this.removeEntity("item", it.id, it.name || it.id),
          onPublish: it.community?.imported ? undefined : () => void this.publishEntity("item", it),
          published: !!it.community && !it.community.imported,
        }),
      );
    }

    // Imported .glb object models (e.g. meshy_ai_timberstone) not tied to a def.
    for (const m of models) {
      if (!matches(m.name, "Object", "objects")) continue;
      const ids = placed.filter((p) => p.def.model === m.model).map((p) => p.id);
      inMap += ids.length;
      cards.push(
        this.entityCard({
          name: m.name,
          meta: `Object · ${mb(m.size)}`,
          thumb: { type: "model", model: m.model, token: m.size },
          count: ids.length,
          onAdd: () => {
            this.setStatus(`placing ${m.name}...`);
            this.deps.placeModel(m.model, m.name);
          },
          onFocus: () => this.browse("prop", ids, m.name),
        }),
      );
    }

    if (token !== this.renderToken || !this.open) return;
    this.summaryEl.textContent = `${tabLabel(this.activeTab)} · ${cards.length} types · ${inMap} in map`;
    this.gridEl.innerHTML = "";
    if (!cards.length) {
      this.gridEl.textContent = "no entities match";
      return;
    }
    for (const c of cards) this.gridEl.appendChild(c);
    this.setStatus("＋ Add places a new one. Click a count badge to focus existing instances.");
  }

  /** Community view: published kind-30333 entities of the active type, each card
   *  carrying its owner's avatar; "＋ Add" imports it into the Local library. The
   *  render epoch `token` is owned by render() so a tab/source switch cancels this. */
  private async renderCommunity(token: number) {
    // SWR: paint the cached community cards instantly, then always revalidate
    // (server cache → relays) + repaint. Cache holds ALL types; paint filters.
    const cached = readCache<{ cards: CommunityCard[]; profiles: Record<string, OwnerProfile> }>(CACHE_COMMUNITY);
    if (cached) {
      this.paintCommunity(cached.cards, cached.profiles, token);
    } else {
      this.titleEl.textContent = "Community Library";
      this.summaryEl.textContent = "browsing community entities…";
      this.gridEl.innerHTML = "";
      this.gridEl.textContent = "searching…";
    }

    let cards: CommunityCard[] = [];
    try {
      cards = await fetchCommunityEntities();
    } catch {
      cards = [];
    }
    if (token !== this.renderToken || !this.open) return;
    const profiles = await fetchProfiles(cards.map((c) => c.author));
    if (token !== this.renderToken || !this.open) return;
    writeCache(CACHE_COMMUNITY, { cards, profiles });
    this.paintCommunity(cards, profiles, token);
  }

  /** Render the Community grid from already-fetched cards (filtered by active tab + search). */
  private paintCommunity(cards: CommunityCard[], profiles: Record<string, OwnerProfile>, token: number) {
    if (token !== this.renderToken || !this.open) return;
    this.titleEl.textContent = "Community Library";
    const q = normalized(this.searchEl.value);
    const matched = cards.filter(
      (c) =>
        c.entity.type === this.activeTab &&
        (!q || normalized(`${c.entity.name} ${c.entity.description ?? ""}`).includes(q)),
    );
    this.summaryEl.textContent = `Community · ${tabLabel(this.activeTab)} · ${matched.length} published`;
    this.gridEl.innerHTML = "";
    if (!matched.length) {
      this.gridEl.textContent = "no community entities found";
      this.setStatus("Publish one from your Local library, or check back later.");
      return;
    }
    for (const c of matched) {
      const owner = profiles[c.author];
      // Community cards render the published preview image (no in-browser .glb render).
      const thumb: ThumbSource | undefined = c.entity.preview?.url
        ? { type: "image", url: c.entity.preview.url }
        : undefined;
      this.gridEl.appendChild(
        this.entityCard({
          name: c.entity.name,
          meta: c.entity.description || `Community ${c.entity.type}`,
          thumb,
          count: 0,
          owner: { name: owner?.name, picture: owner?.picture, pubkey: c.author },
          onAdd: () => void this.importCommunity(c),
        }),
      );
    }
    this.setStatus("＋ Add copies a community entity into your Local library (pending).");
  }

  /** Import a community entity → Local library (pending), then jump to Local. */
  private async importCommunity(card: CommunityCard) {
    this.setStatus(`importing "${card.entity.name}"…`);
    try {
      await importCommunityEntity(card);
      this.source = "local";
      this.refreshChrome();
      await this.render();
      this.setStatus(`✓ imported "${card.entity.name}" — pending in your Local library`);
    } catch (e) {
      this.setStatus("import failed: " + (e as Error).message);
    }
  }

  private matchesActiveTab(category: ExistingCategory): boolean {
    if (this.activeTab === "item") return category === "items";
    if (this.activeTab === "character") return category === "characters" || category === "players";
    // "structure" = everything non-alive, non-pickup: houses, crates, props, trees, rocks.
    return category === "structures" || category === "objects" || category === "resources";
  }

  /** Live instance ids (and the focus kind) for a built-in entity kind. */
  private liveIdsForKind(kind: string): { ids: string[]; focusKind: string } {
    const st = this.state();
    if (!st) return { ids: [], focusKind: kind };
    if (kind === "goblin") return { ids: idsOf(st.enemies, (v) => v.kind === "goblin"), focusKind: "enemy" };
    if (kind === "dummy") return { ids: idsOf(st.enemies, (v) => v.kind === "dummy"), focusKind: "enemy" };
    if (kind === "berserker_potion")
      return { ids: idsOf(st.potions, (v) => v.kind === "berserker_potion"), focusKind: "potion" };
    if (kind === "potion") return { ids: idsOf(st.potions, (v) => !v.kind || v.kind === "potion"), focusKind: "potion" };
    if (kind === "house") return { ids: idsOf(st.houses), focusKind: "house" };
    if (kind === "tree") return { ids: idsOf(st.trees, (v) => (v.kind || "tree") !== "bush"), focusKind: "tree" };
    if (kind === "bush") return { ids: idsOf(st.trees, (v) => v.kind === "bush"), focusKind: "bush" };
    if (kind === "rock") return { ids: idsOf(st.rocks), focusKind: "rock" };
    return { ids: idsOf(st[`${kind}s`]), focusKind: kind }; // log / stone / banana
  }

  /** One uniform card for every library entity (built-in, custom char, or model):
   *  thumbnail + name + meta + a live "N in map" badge + an Add action. */
  private entityCard(opts: {
    name: string;
    meta: string;
    thumb?: ThumbSource;
    count: number;
    onAdd: () => void;
    onFocus?: () => void;
    pending?: boolean; // not yet committed to git → amber badge + Remove
    onRemove?: () => void;
    onPublish?: () => void; // publish this entity to the community
    published?: boolean; // already has a community event → "Update" instead of "Publish"
    owner?: { name?: string; picture?: string; pubkey: string }; // community card → owner avatar
  }): HTMLElement {
    const card = document.createElement("div");
    card.style.cssText =
      cardCss(this.compact, false) + "padding:0; overflow:hidden; display:flex; flex-direction:column;";

    const previewWrap = document.createElement("div");
    previewWrap.style.cssText =
      "position:relative; width:100%; height:" +
      (this.compact ? "84px" : "120px") +
      "; background:#0a0e14; overflow:hidden;";
    const preview = document.createElement("img");
    preview.alt = "";
    preview.decoding = "async";
    preview.loading = "lazy";
    preview.style.cssText = "width:100%; height:100%; display:block; object-fit:contain; background:#0a0e14;";
    const fallback = this.thumbPlaceholder(opts.name);
    previewWrap.append(preview, fallback);
    if (opts.thumb) void this.loadThumb(preview, opts.thumb, fallback);

    const badge = document.createElement("button");
    badge.textContent = `${opts.count} in map`;
    const canFocus = opts.count > 0 && !!opts.onFocus;
    badge.title = canFocus ? "Focus instances in the world" : "None in the world yet";
    badge.style.cssText =
      "position:absolute; top:6px; right:6px; border:1px solid #263245; border-radius:6px; padding:2px 7px;" +
      `background:#0d131de8; color:${opts.count ? "#b8c7dc" : "#6f8192"}; font:700 11px system-ui,sans-serif;` +
      `cursor:${canFocus ? "pointer" : "default"};`;
    badge.onclick = (e) => {
      e.stopPropagation();
      if (canFocus) opts.onFocus!();
    };
    previewWrap.appendChild(badge);

    // Owner avatar (top-left) for community cards.
    if (opts.owner) {
      const av = document.createElement("div");
      const short = `${opts.owner.pubkey.slice(0, 8)}…`;
      av.title = opts.owner.name ? `${opts.owner.name} (${short})` : short;
      av.style.cssText =
        "position:absolute; top:6px; left:6px; width:26px; height:26px; border-radius:50%; overflow:hidden;" +
        "border:1px solid #4a9a52; background:#223149; display:grid; place-items:center; color:#d9ffe0; font:700 10px system-ui;";
      if (opts.owner.picture) {
        const img = document.createElement("img");
        img.src = opts.owner.picture;
        img.referrerPolicy = "no-referrer";
        img.style.cssText = "width:100%; height:100%; object-fit:cover;";
        img.onerror = () => {
          img.remove();
          av.textContent = initials(opts.owner!.name || short);
        };
        av.appendChild(img);
      } else {
        av.textContent = initials(opts.owner.name || short);
      }
      previewWrap.appendChild(av);
    }

    // "pending" badge (top-left) for entities not yet committed to git.
    if (opts.pending) {
      const pend = document.createElement("div");
      pend.textContent = "pending";
      pend.title = "Not committed to git yet — commit it to keep it, or Remove it.";
      pend.style.cssText =
        "position:absolute; top:6px; left:6px; border:1px solid #b9821f; border-radius:6px; padding:2px 7px;" +
        "background:#3a2c0de8; color:#f3c969; font:700 11px system-ui,sans-serif;";
      previewWrap.appendChild(pend);
    }

    const body = document.createElement("div");
    body.style.cssText = "padding:9px; display:grid; gap:6px; min-width:0;";
    const name = document.createElement("div");
    name.textContent = opts.name;
    name.title = opts.name;
    name.style.cssText = "font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;";
    const meta = document.createElement("div");
    meta.textContent = opts.meta;
    meta.style.cssText = "color:#8fa0b5; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;";
    const add = document.createElement("button");
    add.textContent = "＋ Add";
    add.style.cssText =
      "cursor:pointer; height:28px; border:1px solid #3f8c49; border-radius:6px; color:#e8ffe8;" +
      "background:#23472b; font:600 12px system-ui,sans-serif;";
    add.onmouseenter = () => (add.style.background = "#2c5836");
    add.onmouseleave = () => (add.style.background = "#23472b");
    add.onclick = (e) => {
      e.stopPropagation();
      opts.onAdd();
    };
    body.append(name, meta, add);

    // Publish (or update) this entity to the community.
    if (opts.onPublish) {
      const pub = document.createElement("button");
      pub.textContent = opts.published ? "📡 Update community" : "📡 Publish to community";
      pub.title = "Upload assets to Blossom and publish a community entity event";
      pub.style.cssText =
        "cursor:pointer; height:26px; border:1px solid #6a3fa0; border-radius:6px; color:#ecdcff;" +
        "background:#2d2148; font:600 11px system-ui,sans-serif;";
      pub.onmouseenter = () => (pub.style.background = "#3a2a5e");
      pub.onmouseleave = () => (pub.style.background = "#2d2148");
      pub.onclick = (e) => {
        e.stopPropagation();
        opts.onPublish!();
      };
      body.appendChild(pub);
    }

    // Pending entities can be removed (deletes the def + its uncommitted files).
    if (opts.pending && opts.onRemove) {
      const remove = document.createElement("button");
      remove.textContent = "🗑 Remove";
      remove.title = "Delete this pending entity and its files";
      remove.style.cssText =
        "cursor:pointer; height:26px; border:1px solid #6a2f33; border-radius:6px; color:#ffd9d9;" +
        "background:#3a1f22; font:600 11px system-ui,sans-serif;";
      remove.onmouseenter = () => (remove.style.background = "#56282c");
      remove.onmouseleave = () => (remove.style.background = "#3a1f22");
      remove.onclick = (e) => {
        e.stopPropagation();
        opts.onRemove!();
      };
      body.appendChild(remove);
    }

    card.append(previewWrap, body);
    return card;
  }

  /** Publish a Local entity to the community (Blossom upload + kind-30333 event),
   *  then stamp the def with its provenance so the card shows "Update". */
  private async publishEntity(
    type: CommunityEntityType,
    def: CharacterDef | StructureDef | ItemDefLite,
  ): Promise<void> {
    // Publishing signs with the user's key — require a Nostr login first. This
    // logs in IN-GAME (extension / remote signer) and upgrades the server session.
    try {
      this.setStatus("checking Nostr login…");
      const identity = await ensureNostrLogin(this.deps.net);
      if (!identity) return this.setStatus("publish cancelled — sign in to publish.");
    } catch (e) {
      return this.setStatus("login failed: " + (e as Error).message);
    }
    this.setStatus(`publishing ${def.name || def.id}…`);
    try {
      const onProgress = (m: string) => this.setStatus(m);
      const prov =
        type === "character"
          ? await publishCharacter(def as CharacterDef, onProgress)
          : type === "structure"
            ? await publishStructure(def as StructureDef, onProgress)
            : await publishItem(def as ItemDefLite, onProgress);
      const saveUrl =
        type === "character" ? "/__char/save" : type === "structure" ? "/__structures/save" : "/__items/save";
      await fetch(saveUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...def, community: prov }),
      });
      await this.render();
      this.setStatus(`✓ published "${def.name || def.id}" to the community`);
    } catch (e) {
      this.setStatus("publish failed: " + (e as Error).message);
    }
  }

  /** Delete a creator-authored entity (Library "Remove" on a pending card). */
  private async removeEntity(type: CommunityEntityType, id: string, label: string) {
    const url =
      type === "character" ? "/__char/def-delete" : type === "structure" ? "/__structures/delete" : "/__items/delete";
    this.setStatus(`removing ${label}…`);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, deleteFiles: true }),
      });
      if (!res.ok) throw new Error(await res.text());
      await loadItemDefs().catch(() => undefined);
      await this.render();
      this.setStatus(`removed ${label}`);
    } catch (e) {
      this.setStatus("remove failed: " + (e as Error).message);
    }
  }

  private state(): Record<string, Coll | undefined> | null {
    return (this.deps.net.room?.state as unknown as Record<string, Coll | undefined>) ?? null;
  }

  /** Count-badge click: close the Library and jump to the map, selecting the first
   *  instance with a floating ◀ prev / next ▶ navigator to step through them all. */
  private browse(focusKind: string, ids: string[], label: string) {
    if (!ids.length) return;
    this.close();
    this.deps.browseInstances(focusKind, ids, label);
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

  private async fetchJson<T>(url: string): Promise<T> {
    try {
      const r = await fetch(url, { cache: "no-store" });
      return r.ok ? ((await r.json()) as T) : ([] as unknown as T);
    } catch {
      return [] as unknown as T;
    }
  }

  /** Git-tracked "pending" ids per type (uncommitted creator/imported content). */
  private async fetchPending(): Promise<{ characters: string[]; structures: string[]; items: string[] }> {
    try {
      const r = await fetch("/__content/pending", { cache: "no-store" });
      if (r.ok) return (await r.json()) as { characters: string[]; structures: string[]; items: string[] };
    } catch {
      /* dev endpoint unavailable → nothing pending */
    }
    return { characters: [], structures: [], items: [] };
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
  if (source.type === "image") {
    if (!source.url) return null;
    // Same-origin / relative / data: URLs load and cache fine as-is.
    if (!/^https?:\/\//i.test(source.url)) return source.url;
    // Remote previews (e.g. Blossom): route through the dev proxy so the browser HTTP-caches them
    // under our own origin with immutable headers. Blossom sends no cache-control AND its CDN blocks
    // cross-origin fetch via CORS — so a raw <img src> re-fetches on every Library reopen (the flash)
    // and a client-side blob cache is impossible. The proxy fetches server-side (no CORS) once; every
    // reopen is then a same-origin disk-cache hit. In prod builds (no dev proxy) fall back to the raw URL.
    return import.meta.env.DEV ? `/__asset-cache?u=${encodeURIComponent(source.url)}` : source.url;
  }
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

/** Render a 220×128 WebP thumbnail of a .glb model (reused by community publish to
 *  attach a preview image to the entity event). Returns null if rendering fails. */
export function renderModelThumb(model: string): Promise<Blob | null> {
  return enqueueThumbRender({ type: "model", model });
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
  // Image thumbs render directly via <img> and never reach the 3D thumb pipeline.
  if (source.type === "image") throw new Error("image thumbnails have no 3D target");
  if (source.type === "model") {
    const loaded = await importModel(scene, source.model);
    for (const mesh of loaded.meshes) {
      if (mesh.getTotalVertices && mesh.getTotalVertices() > 0) mesh.isVisible = true;
    }
    return loaded;
  }
  if (source.id === "tree") return buildTree(scene);
  if (source.id === "bush") return buildTree(scene, "bush");
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
      : source.type === "image"
        ? `image:${source.url}`
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

const tabLabel = (tab: LibraryTab) => {
  if (tab === "character") return "Character (Alive)";
  if (tab === "structure") return "Structure";
  return "Item";
};

const tabButtonCss = (on: boolean) =>
  `cursor:pointer; background:${on ? "#3a7a40" : "#222a38"}; color:${on ? "#fff" : "#bcd"}; border:1px solid ${
    on ? "#7dd986" : "#3a4658"
  }; border-radius:6px; padding:6px 9px; font:12px system-ui,sans-serif;`;

const sourceBtnCss = (on: boolean) =>
  `cursor:pointer; height:32px; padding:0 12px; border:none; font:700 11px system-ui,sans-serif;` +
  `background:${on ? "#2f6d37" : "#0b0f16"}; color:${on ? "#f3fff3" : "#9fb0c0"};`;

const categoryTabCss = (on: boolean) =>
  "cursor:pointer; min-width:0; height:30px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" +
  `background:${on ? "#2f6d37" : "#182130"}; color:${on ? "#f3fff3" : "#b9c7d8"};` +
  `border:1px solid ${on ? "#75d381" : "#334257"}; border-radius:6px; padding:0 8px; font:700 11px system-ui,sans-serif;`;

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
