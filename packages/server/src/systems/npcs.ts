import { existsSync, readFileSync, watchFile } from "node:fs";
import { resolve } from "node:path";
import { type BrainId, type CharacterStatsConfig, Enemy, type GameState } from "@rpg/shared";
import { configureEnemy } from "./enemyConfig";

interface CharacterDef {
  id: string;
  name: string;
  stats?: CharacterStatsConfig;
}

interface NpcPlacement {
  id: string;
  defId: string;
  x: number;
  z: number;
  rotationY?: number;
  brain?: BrainId;
  stats?: CharacterStatsConfig;
}

const PUBLIC_DIRS = [
  resolve(process.cwd(), "packages/client/public"),
  resolve(process.cwd(), "../client/public"),
  resolve(process.cwd(), "client/public"),
];

function publicDir(): string | null {
  return PUBLIC_DIRS.find((p) => existsSync(p)) ?? null;
}

function readJsonArray<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  try {
    const arr = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

const authored = new WeakMap<GameState, Set<string>>();

export function loadAuthoredNpcs(state: GameState): void {
  const dir = publicDir();
  if (!dir) return;
  const npcsPath = resolve(dir, "npcs.json");
  const charsPath = resolve(dir, "characters.json");
  const apply = () => applyAuthoredNpcs(state, npcsPath, charsPath);
  apply();
  watchFile(npcsPath, { interval: 1500 }, apply);
  watchFile(charsPath, { interval: 1500 }, apply);
}

export function syncAuthoredNpcs(state: GameState): void {
  const dir = publicDir();
  if (!dir) return;
  applyAuthoredNpcs(state, resolve(dir, "npcs.json"), resolve(dir, "characters.json"));
}

function applyAuthoredNpcs(state: GameState, npcsPath: string, charsPath: string): void {
  const defs = new Map(readJsonArray<CharacterDef>(charsPath).map((d) => [d.id, d]));
  const placements = readJsonArray<NpcPlacement>(npcsPath);
  const nextIds = new Set(placements.map((p) => p.id));
  const prevIds = authored.get(state) ?? new Set<string>();

  for (const id of prevIds) {
    if (!nextIds.has(id)) state.enemies.delete(id);
  }

  for (const p of placements) {
    const def = defs.get(p.defId);
    const existing = state.enemies.get(p.id);
    const e = existing ?? new Enemy();
    configureEnemy(e, {
      kind: "npc",
      id: p.id,
      x: Number(p.x) || 0,
      z: Number(p.z) || 0,
      modelId: p.defId,
      displayName: def?.name || p.defId,
      brain: p.brain,
      stats: { ...(def?.stats ?? {}), ...(p.stats ?? {}) },
    });
    e.rotY = Number(p.rotationY) || 0;
    state.enemies.set(e.id, e);
  }

  authored.set(state, nextIds);
  if (placements.length) console.log(`[npcs] ${placements.length} authored npc(s) applied`);
}
