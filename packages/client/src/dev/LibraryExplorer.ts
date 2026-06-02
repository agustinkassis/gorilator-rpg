import { CRATES } from "@rpg/shared";
import { NetworkClient } from "../net/NetworkClient";
import { PropManager } from "./PropManager";

/**
 * Dev Mode "Entity Library" — a tabbed catalog of everything in the game, grouped
 * into Characters / Players / Resources / Structures / Objects / Items. Each row is
 * a catalog entry (a type/def) with a live "in world" count; clicking it selects a
 * live instance of that type, opens its inspector, and pans the camera to it
 * (cycling through instances on repeated clicks). Browsing only — placement lives in
 * the model library / character importer.
 */
export interface LibraryExplorerDeps {
  net: NetworkClient;
  propManager: PropManager;
  /** Select + highlight an entity by (kind,id), open its inspector, focus the camera. */
  focusEntity: (kind: string, id: string) => boolean;
  /** Pan the camera to a bare world point (static structures with no mesh). */
  focusPos: (x: number, z: number) => void;
  /** Release the camera back to the local player. */
  clearFocus: () => void;
}

interface Entry {
  label: string;
  badge?: string; // right-aligned count / size / level
  dim?: boolean; // greyed out (nothing of this type in the world)
  onClick: () => void;
}

// minimal views over the synced schema (avoid importing every schema class)
interface SyncedItem {
  x: number;
  z: number;
  name?: string;
  level?: number;
  kind?: string;
  alive?: boolean;
}
type Coll = { forEach(cb: (v: SyncedItem, k: string) => void): void; size: number };

interface CharacterDefLite {
  id: string;
  name: string;
}
interface PlacementLite {
  id: string;
  defId: string;
}
interface ModelLite {
  name: string;
  model: string;
  size: number;
}

const TABS = ["characters", "players", "resources", "structures", "objects", "items"] as const;
type Tab = (typeof TABS)[number];

export class LibraryExplorer {
  private panel: HTMLElement;
  private listEl: HTMLElement;
  private statusEl: HTMLElement;
  private tabBtns = new Map<Tab, HTMLButtonElement>();
  private open = false;
  private tab: Tab = "characters";

  constructor(private deps: LibraryExplorerDeps) {
    const panel = document.createElement("div");
    panel.style.cssText =
      "position:fixed; left:16px; top:56px; width:300px; max-height:80vh; z-index:56; display:none;" +
      "background:#10131af5; border:2px solid #4a9a52; border-radius:10px; color:#e8e8e8;" +
      "font:12px/1.4 system-ui,sans-serif; box-shadow:0 8px 30px #000a; overflow:hidden; flex-direction:column;";

    const head = document.createElement("div");
    head.style.cssText =
      "display:flex; justify-content:space-between; align-items:center; padding:8px 12px; background:#1c2230; border-bottom:1px solid #4a9a52;";
    head.innerHTML = `<b style="color:#9fe0a0;">Entity Library</b>`;
    const right = document.createElement("div");
    right.style.cssText = "display:flex; gap:6px;";
    const refresh = document.createElement("button");
    refresh.textContent = "↻";
    refresh.title = "Refresh counts";
    refresh.style.cssText =
      "cursor:pointer; background:#243049; color:#cfe; border:1px solid #4a9a52; border-radius:4px; padding:2px 8px;";
    refresh.onclick = () => void this.render();
    const close = document.createElement("button");
    close.textContent = "✕";
    close.style.cssText =
      "cursor:pointer; background:#3a2230; color:#fff; border:1px solid #4a9a52; border-radius:4px; padding:2px 8px;";
    close.onclick = () => this.close();
    right.append(refresh, close);
    head.appendChild(right);

    const tabBar = document.createElement("div");
    tabBar.style.cssText =
      "display:flex; flex-wrap:wrap; gap:4px; padding:8px 10px; border-bottom:1px solid #2a3242;";
    for (const t of TABS) {
      const b = document.createElement("button");
      b.textContent = cap(t);
      b.style.cssText =
        "cursor:pointer; background:#222a38; color:#bcd; border:1px solid #3a4658; border-radius:5px; padding:3px 8px; font-size:11px;";
      b.onclick = () => this.setTab(t);
      tabBar.appendChild(b);
      this.tabBtns.set(t, b);
    }

    const list = document.createElement("div");
    list.style.cssText = "overflow-y:auto; padding:6px; display:flex; flex-direction:column; gap:4px;";
    const status = document.createElement("div");
    status.style.cssText =
      "padding:6px 12px; font-size:11px; color:#9fb0c0; min-height:14px; border-top:1px solid #2a3242;";

    panel.append(head, tabBar, list, status);
    document.body.appendChild(panel);
    this.panel = panel;
    this.listEl = list;
    this.statusEl = status;
  }

  toggle() {
    this.open ? this.close() : this.openPanel();
  }

  private openPanel() {
    this.open = true;
    this.panel.style.display = "flex";
    this.setTab(this.tab);
  }

  close() {
    this.open = false;
    this.panel.style.display = "none";
    this.deps.clearFocus();
  }

  setStatus(msg: string) {
    this.statusEl.textContent = msg;
  }

  private setTab(tab: Tab) {
    this.tab = tab;
    for (const [k, btn] of this.tabBtns) {
      const on = k === tab;
      btn.style.background = on ? "#3a7a40" : "#222a38";
      btn.style.color = on ? "#fff" : "#bcd";
    }
    void this.render();
  }

  /** Rebuild the visible tab's rows (async tabs fetch from the dev endpoints). */
  private async render() {
    if (!this.open) return;
    const tab = this.tab;
    this.listEl.textContent = "loading…";
    const entries = await this.entriesFor(tab);
    if (tab !== this.tab || !this.open) return; // user switched/closed while fetching
    this.listEl.innerHTML = "";
    if (!entries.length) {
      this.listEl.textContent = "nothing here";
      return;
    }
    for (const e of entries) this.listEl.appendChild(this.row(e));
  }

  private row(e: Entry): HTMLElement {
    const b = document.createElement("button");
    b.style.cssText =
      "cursor:pointer; text-align:left; border:1px solid #2a3242; border-radius:5px; padding:6px 9px;" +
      "display:flex; justify-content:space-between; align-items:center; gap:8px; background:#1a2030; color:" +
      (e.dim ? "#7f8ba0" : "#e8e8e8") + ";";
    const nm = document.createElement("span");
    nm.textContent = e.label;
    nm.style.cssText = "overflow:hidden; text-overflow:ellipsis; white-space:nowrap;";
    b.appendChild(nm);
    if (e.badge) {
      const s = document.createElement("span");
      s.textContent = e.badge;
      s.style.cssText = "color:#7f93a8; font-size:10px; flex:none;";
      b.appendChild(s);
    }
    b.onmouseenter = () => (b.style.background = "#243049");
    b.onmouseleave = () => (b.style.background = "#1a2030");
    b.onclick = () => e.onClick();
    return b;
  }

  // ---- per-tab catalogs ----
  private entriesFor(tab: Tab): Promise<Entry[]> | Entry[] {
    switch (tab) {
      case "characters":
        return this.charactersTab();
      case "players":
        return this.playersTab();
      case "resources":
        return this.resourcesTab();
      case "structures":
        return this.structuresTab();
      case "objects":
        return this.objectsTab();
      case "items":
        return this.itemsTab();
    }
  }

  private state(): Record<string, Coll | undefined> | null {
    return (this.deps.net.room?.state as unknown as Record<string, Coll | undefined>) ?? null;
  }

  private playersTab(): Entry[] {
    const st = this.state();
    const out: Entry[] = [];
    st?.players?.forEach((p, id) => {
      out.push({ label: p.name || shortId(id), badge: `lv ${p.level ?? 1}`, onClick: this.cycleIds("player", [id]) });
    });
    return out.length ? out : [dim("no players connected")];
  }

  private resourcesTab(): Entry[] {
    const st = this.state();
    const trees = idsOf(st?.trees);
    const rocks = idsOf(st?.rocks);
    return [
      { label: "Tree", badge: count(trees), dim: !trees.length, onClick: this.cycleIds("tree", trees) },
      { label: "Rock", badge: count(rocks), dim: !rocks.length, onClick: this.cycleIds("rock", rocks) },
    ];
  }

  private structuresTab(): Entry[] {
    const st = this.state();
    const houses = idsOf(st?.houses);
    const crates = CRATES.map((c) => ({ x: c.x, z: c.z }));
    return [
      { label: "House", badge: count(houses), dim: !houses.length, onClick: this.cycleIds("house", houses) },
      { label: "Crate", badge: count(crates), dim: !crates.length, onClick: this.cyclePos("crate", crates) },
    ];
  }

  private itemsTab(): Entry[] {
    const st = this.state();
    const kinds: Array<[string, string]> = [
      ["log", "logs"],
      ["stone", "stones"],
      ["banana", "bananas"],
      ["potion", "potions"],
    ];
    return kinds.map(([kind, map]) => {
      const ids = idsOf(st?.[map]);
      return { label: cap(kind), badge: count(ids), dim: !ids.length, onClick: this.cycleIds(kind, ids) };
    });
  }

  private async charactersTab(): Promise<Entry[]> {
    const [defs, placements] = await Promise.all([
      this.fetchJson<CharacterDefLite[]>("/__char/defs"),
      this.fetchJson<PlacementLite[]>("/__char/placements"),
    ]);
    const out: Entry[] = [];
    for (const d of defs) {
      const ids = placements.filter((p) => p.defId === d.id).map((p) => p.id);
      out.push({ label: d.name || d.id, badge: `${ids.length} placed`, dim: !ids.length, onClick: this.cycleIds("character", ids) });
    }
    // built-in NPC types live in the synced enemies map (kind-tagged)
    const st = this.state();
    const goblins = idsOf(st?.enemies, (v) => v.kind === "goblin");
    const dummies = idsOf(st?.enemies, (v) => v.kind === "dummy");
    out.push({ label: "Goblin", badge: count(goblins), dim: !goblins.length, onClick: this.cycleIds("enemy", goblins) });
    out.push({ label: "Dummy", badge: count(dummies), dim: !dummies.length, onClick: this.cycleIds("enemy", dummies) });
    return out;
  }

  private async objectsTab(): Promise<Entry[]> {
    const models = await this.fetchJson<ModelLite[]>("/__props/models");
    const placed = this.deps.propManager.all();
    if (!models.length && !placed.length) return [dim("no models")];
    return models.map((m) => {
      const ids = placed.filter((p) => p.def.model === m.model).map((p) => p.id);
      return {
        label: m.name,
        badge: ids.length ? `${ids.length} placed` : mb(m.size),
        dim: !ids.length,
        onClick: this.cycleIds("prop", ids),
      };
    });
  }

  // ---- focus cycling ----
  /** A click handler that walks the camera through each live instance of a type. */
  private cycleIds(kind: string, ids: string[]): () => void {
    let i = 0;
    return () => {
      if (!ids.length) return this.setStatus("none in world");
      const id = ids[i % ids.length];
      const ok = this.deps.focusEntity(kind, id);
      this.setStatus(ok ? `▸ ${kind} · ${shortId(id)}  (${(i % ids.length) + 1}/${ids.length})` : `${kind} no longer in world`);
      i++;
    };
  }
  /** Same, for static positions (crates have no selectable mesh). */
  private cyclePos(label: string, ps: Array<{ x: number; z: number }>): () => void {
    let i = 0;
    return () => {
      if (!ps.length) return this.setStatus("none in world");
      const p = ps[i % ps.length];
      this.deps.focusPos(p.x, p.z);
      this.setStatus(`▸ ${label}  (${(i % ps.length) + 1}/${ps.length})`);
      i++;
    };
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

function idsOf(map: Coll | undefined, filter?: (v: SyncedItem) => boolean): string[] {
  const ids: string[] = [];
  map?.forEach((v, k) => {
    if (!filter || filter(v)) ids.push(k);
  });
  return ids;
}

const count = (a: unknown[]) => `${a.length}`;
const dim = (label: string): Entry => ({ label, dim: true, onClick: () => {} });
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const shortId = (id: string) => (id.length > 18 ? "…" + id.slice(-16) : id);
const mb = (bytes: number) => (bytes > 1e6 ? (bytes / 1e6).toFixed(1) + "MB" : Math.round(bytes / 1e3) + "KB");
