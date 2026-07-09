import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type DevTuningKey,
  type GameState,
  type InventorySlot,
  type ItemType,
  type Player,
  Tree,
  TREE_ARMOR,
  TREE_HP,
  WORLD_SIZE,
} from "@rpg/shared";
import { addItem } from "./inventory";
import { setDevTuning } from "./devTuning";
import { dropItem } from "./resources";
import { safeItemId, spawnCustomItem } from "./items";
import { nearestFreeWorld } from "./pathfinding";
import { entityHp } from "./entityFeatures";
import { dropConfig } from "./resourceDrops";

export interface ScenarioGroundItem {
  item: string;
  x: number;
  z: number;
  count: number;
}

export interface ScenarioResource {
  kind: "tree" | "bush";
  id: string;
  x: number;
  z: number;
  count: number;
  scale: number;
  rotY: number;
  hp?: number;
}

export interface ScenarioManifest {
  name: string;
  description: string;
  world: {
    clearPickups: boolean;
    wavesEnabled: boolean;
    laCryptaDefense: boolean;
    spawnersEnabled: boolean;
    resources: ScenarioResource[];
    groundItems: ScenarioGroundItem[];
  };
  player: {
    position?: { x: number; z: number };
    stats: Record<string, number>;
    loadout: Array<{ item: string; count: number }>;
  };
  tuning: Partial<Record<DevTuningKey, number>>;
  timeScale: number;
  tweaks: DevTuningKey[];
}

const SCENARIO_DIRS = [
  resolve(process.cwd(), "scenarios"),
  resolve(process.cwd(), "../../scenarios"),
];

export function safeScenarioId(raw: string): string {
  return String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function finite(raw: unknown, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function optionalFinite(raw: unknown): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function bool(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

function finiteRecord(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const n = Number(value);
    if (Number.isFinite(n)) out[key] = n;
  }
  return out;
}

function parseLoadout(raw: unknown): Array<{ item: string; count: number }> {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => ({
      item: safeItemId(String(entry?.item || "")),
      count: Math.max(1, Math.min(999, Math.round(finite(entry?.count, 1)))),
    }))
    .filter((entry) => entry.item);
}

function parseGroundItems(raw: unknown): ScenarioGroundItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => ({
      item: safeItemId(String(entry?.item || "")),
      x: Math.max(-WORLD_SIZE, Math.min(WORLD_SIZE, finite(entry?.x, 0))),
      z: Math.max(-WORLD_SIZE, Math.min(WORLD_SIZE, finite(entry?.z, 0))),
      count: Math.max(1, Math.min(200, Math.round(finite(entry?.count, 1)))),
    }))
    .filter((entry) => entry.item);
}

function parseResources(raw: unknown): ScenarioResource[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry, index) => {
      const obj = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
      const kind: ScenarioResource["kind"] = String(obj.kind || "").toLowerCase() === "bush" ? "bush" : "tree";
      const id = safeScenarioId(String(obj.id || `${kind}_${index}`)) || `${kind}_${index}`;
      const hp = optionalFinite(obj.hp);
      return {
        kind,
        id,
        x: Math.max(-WORLD_SIZE, Math.min(WORLD_SIZE, finite(obj.x, 0))),
        z: Math.max(-WORLD_SIZE, Math.min(WORLD_SIZE, finite(obj.z, 0))),
        count: Math.max(1, Math.min(50, Math.round(finite(obj.count, 1)))),
        scale: Math.max(0.1, Math.min(8, finite(obj.scale, kind === "bush" ? 0.8 : 1))),
        rotY: finite(obj.rotY, 0),
        hp: hp === undefined ? undefined : Math.max(1, Math.round(hp)),
      };
    })
    .filter((entry) => entry.id);
}

function parseTuning(raw: unknown): Partial<Record<DevTuningKey, number>> {
  return finiteRecord(raw) as Partial<Record<DevTuningKey, number>>;
}

function parseTweaks(raw: unknown): DevTuningKey[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: DevTuningKey[] = [];
  for (const value of raw) {
    const key = String(value || "") as DevTuningKey;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

export function parseScenario(raw: unknown, fallbackName: string): ScenarioManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const world = (obj.world && typeof obj.world === "object" ? obj.world : {}) as Record<string, unknown>;
  const player = (obj.player && typeof obj.player === "object" ? obj.player : {}) as Record<string, unknown>;
  const position =
    player.position && typeof player.position === "object"
      ? {
          x: Math.max(-WORLD_SIZE, Math.min(WORLD_SIZE, finite((player.position as Record<string, unknown>).x, 0))),
          z: Math.max(-WORLD_SIZE, Math.min(WORLD_SIZE, finite((player.position as Record<string, unknown>).z, 0))),
        }
      : undefined;
  const timeScale = Math.max(0, Math.min(8, finite(obj.timeScale, 1)));
  return {
    name: safeScenarioId(String(obj.name || fallbackName)) || fallbackName,
    description: String(obj.description || ""),
    world: {
      clearPickups: Boolean(world.clearPickups),
      wavesEnabled: bool(world.wavesEnabled, false),
      laCryptaDefense: bool(world.laCryptaDefense, false),
      spawnersEnabled: bool(world.spawnersEnabled, false),
      resources: parseResources(world.resources),
      groundItems: parseGroundItems(world.groundItems),
    },
    player: {
      position,
      stats: finiteRecord(player.stats),
      loadout: parseLoadout(player.loadout),
    },
    tuning: parseTuning(obj.tuning),
    timeScale,
    tweaks: parseTweaks(obj.tweaks),
  };
}

export function loadScenarioFromEnv(env = process.env): ScenarioManifest | null {
  const id = safeScenarioId(env.GORILATOR_SCENARIO || "");
  if (!id) return null;
  const dir = SCENARIO_DIRS.find((candidate) => existsSync(candidate));
  if (!dir) {
    console.warn(`[scenario] no scenarios directory found for "${id}"`);
    return null;
  }
  const path = resolve(dir, `${id}.json`);
  if (!path.startsWith(dir) || !existsSync(path)) {
    console.warn(`[scenario] scenario "${id}" not found at ${path}`);
    return null;
  }
  try {
    return parseScenario(JSON.parse(readFileSync(path, "utf8")), id);
  } catch (err) {
    console.warn(`[scenario] failed to load "${id}"`, err);
    return null;
  }
}

export function applyScenarioTuning(scenario: ScenarioManifest | null): void {
  if (!scenario) return;
  for (const [key, value] of Object.entries(scenario.tuning)) {
    const applied = setDevTuning(key as DevTuningKey, Number(value));
    if (applied === null) console.warn(`[scenario:${scenario.name}] unknown tuning key "${key}" ignored`);
    else console.log(`[scenario:${scenario.name}] tuning ${key} = ${applied}`);
  }
}

function applyScenarioResources(state: GameState, scenario: ScenarioManifest): void {
  for (const entry of scenario.world.resources) {
    for (let i = 0; i < entry.count; i++) {
      const id = entry.count === 1 ? entry.id : `${entry.id}_${i}`;
      const spot = nearestFreeWorld(entry.x + (i % 4) * 1.1, entry.z + Math.floor(i / 4) * 1.1);
      const tree = new Tree();
      tree.id = id;
      tree.kind = entry.kind;
      tree.x = spot.x;
      tree.z = spot.z;
      tree.rotY = entry.rotY;
      tree.scale = entry.scale;
      tree.maxHp = entry.hp ?? entityHp(entry.kind, id, undefined, dropConfig(entry.kind).hp);
      tree.hp = tree.maxHp;
      tree.armor = TREE_ARMOR;
      tree.alive = true;
      state.trees.set(tree.id, tree);
    }
  }
}

export function applyScenarioWorld(state: GameState, scenario: ScenarioManifest | null): void {
  if (!scenario) return;
  state.wavesEnabled = scenario.world.wavesEnabled;
  if (!scenario.world.laCryptaDefense) state.houses.clear();
  if (scenario.world.clearPickups) {
    state.logs.clear();
    state.stones.clear();
    state.potions.clear();
    state.bananas.clear();
    state.items.clear();
  }
  state.timeScale = scenario.timeScale;
  applyScenarioResources(state, scenario);
  let seq = 0;
  for (const entry of scenario.world.groundItems) {
    for (let i = 0; i < entry.count; i++) {
      const x = entry.x + (i % 5) * 0.7;
      const z = entry.z + Math.floor(i / 5) * 0.7;
      if (spawnCustomItem(state, entry.item, x, z, `scenario-${scenario.name}-${entry.item}-${seq++}`)) continue;
      dropItem(state, entry.item, x, z);
    }
  }
  console.log(
    `[scenario:${scenario.name}] staged ${scenario.world.resources.length} resource group(s), ` +
      `${scenario.world.groundItems.length} ground item group(s)`,
  );
}

export function scenarioWavesEnabled(scenario: ScenarioManifest | null): boolean {
  return scenario ? scenario.world.wavesEnabled : true;
}

export function scenarioLaCryptaDefenseEnabled(scenario: ScenarioManifest | null): boolean {
  return scenario ? scenario.world.laCryptaDefense : true;
}

export function scenarioSpawnersEnabled(scenario: ScenarioManifest | null): boolean {
  return scenario ? scenario.world.spawnersEnabled : true;
}

export function applyScenarioPlayer(
  player: Player,
  inventory: InventorySlot[],
  scenario: ScenarioManifest | null,
): boolean {
  if (!scenario) return false;
  const stats = scenario.player.stats;
  for (const [key, value] of Object.entries(stats)) {
    if (key in player && typeof (player as unknown as Record<string, unknown>)[key] === "number") {
      (player as unknown as Record<string, number>)[key] = value;
    }
  }
  player.maxHunger = Math.max(1, player.maxHunger);
  player.hunger = Math.max(0, Math.min(player.maxHunger, player.hunger));
  player.maxStamina = Math.max(1, player.maxStamina);
  player.stamina = Math.max(0, Math.min(player.maxStamina, player.stamina));
  player.maxHp = Math.max(1, player.maxHp);
  player.hp = Math.max(0, Math.min(player.maxHp, player.hp));
  if (scenario.player.position) {
    const spot = nearestFreeWorld(scenario.player.position.x, scenario.player.position.z);
    player.x = spot.x;
    player.z = spot.z;
    player.targetX = spot.x;
    player.targetZ = spot.z;
    player.path = [];
    player.pathIndex = 0;
  }
  if (!scenario.player.loadout.length) return false;
  for (const slot of inventory) {
    slot.type = "";
    slot.count = 0;
  }
  for (const entry of scenario.player.loadout) addItem(inventory, entry.item as ItemType, entry.count);
  return true;
}

export function scenarioSummary(scenario: ScenarioManifest | null): Record<string, unknown> {
  return scenario
    ? {
        active: true,
        name: scenario.name,
        description: scenario.description,
        timeScale: scenario.timeScale,
        world: {
          wavesEnabled: scenario.world.wavesEnabled,
          laCryptaDefense: scenario.world.laCryptaDefense,
          spawnersEnabled: scenario.world.spawnersEnabled,
          resources: scenario.world.resources.length,
        },
        tweaks: scenario.tweaks,
      }
    : { active: false };
}
