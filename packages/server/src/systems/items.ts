import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { type GameState, Item, WORLD_SIZE } from "@rpg/shared";
import { nearestFreeWorld } from "./pathfinding";

export interface ItemDef {
  id: string;
  name: string;
  icon?: string;
  model?: string;
  stack?: number;
  worldScale?: number;
}

const ITEM_PATHS = [
  resolve(process.cwd(), "packages/client/public/items.json"),
  resolve(process.cwd(), "../client/public/items.json"),
  resolve(process.cwd(), "client/public/items.json"),
];

let cachedPath = "";
let cachedMtime = 0;
let cachedDefs: ItemDef[] = [];
let seq = 0;

export const safeItemId = (raw: string) =>
  String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);

export function itemDefs(): ItemDef[] {
  const path = ITEM_PATHS.find((p) => existsSync(p));
  if (!path) return [];
  try {
    const mtime = statSync(path).mtimeMs;
    if (path === cachedPath && mtime === cachedMtime) return cachedDefs;
    const arr = JSON.parse(readFileSync(path, "utf8"));
    cachedDefs = Array.isArray(arr) ? arr.filter((d) => safeItemId(d?.id) === d?.id) : [];
    cachedPath = path;
    cachedMtime = mtime;
    return cachedDefs;
  } catch {
    return cachedDefs;
  }
}

export function hasCustomItem(id: string): boolean {
  const safe = safeItemId(id);
  return !!safe && itemDefs().some((d) => d.id === safe);
}

export function spawnCustomItem(state: GameState, itemId: string, x: number, z: number, id?: string): Item | null {
  const safe = safeItemId(itemId);
  if (!safe || !hasCustomItem(safe)) return null;
  const spot = nearestFreeWorld(
    Math.max(-WORLD_SIZE, Math.min(WORLD_SIZE, Number(x) || 0)),
    Math.max(-WORLD_SIZE, Math.min(WORLD_SIZE, Number(z) || 0)),
  );
  const e = new Item();
  e.id = id && id.length <= 80 ? id : `item-${safe}-${Date.now().toString(36)}-${seq++}`;
  e.itemId = safe;
  e.x = spot.x;
  e.z = spot.z;
  state.items.set(e.id, e);
  return e;
}
