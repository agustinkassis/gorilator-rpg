import { readFileSync, existsSync, watchFile } from "node:fs";
import { resolve } from "node:path";

/**
 * Per-structure-kind loot table, authored in Dev Mode → public/structures.json,
 * watched here live. When a structure is destroyed, each entry is rolled
 * INDEPENDENTLY against its probability (seeded "drops" stream) and, on success, drops `amount` of
 * `item`. resources.ts reads this via dropStructureLoot. Empty by default, so a
 * structure drops nothing until a loot table is configured.
 */
export interface LootEntry {
  item: string; // "log" | "stone" | "banana" | "potion" (+ future custom)
  amount: number; // how many drop when this entry's roll succeeds
  probability: number; // 0..1 independent chance to drop this entry
}
type LootMap = Record<string, { loot: LootEntry[] }>;

const PUBLIC_DIRS = [
  resolve(process.cwd(), "packages/client/public"),
  resolve(process.cwd(), "../client/public"),
  resolve(process.cwd(), "client/public"),
];
function file(): string | null {
  const d = PUBLIC_DIRS.find((p) => existsSync(p));
  return d ? resolve(d, "structures.json") : null;
}

const DEFAULTS: LootMap = { house: { loot: [] } };

let cfg: LootMap = {};
function applyFrom(path: string): void {
  try {
    cfg = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) || {} : {};
  } catch (e) {
    console.warn("[structureDrops] failed to read structures.json", e);
  }
}

/** Load structures.json and keep watching it (edited live by the Dev Mode editor). */
export function loadStructureLoot(): void {
  const path = file();
  if (!path) return;
  applyFrom(path);
  watchFile(path, { interval: 1500 }, () => applyFrom(path));
}

/** The loot table for a structure kind (authored value, else the built-in default). */
export function structureLoot(kind: string): LootEntry[] {
  return cfg[kind]?.loot ?? DEFAULTS[kind]?.loot ?? [];
}
