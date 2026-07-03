import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type BrainId,
  type DevTuningKey,
  Enemy,
  type GameState,
  type InventorySlot,
  type Player,
  Rock,
  ROCK_ARMOR,
  ROCK_HP,
  type ScenarioManifest,
  type ScenarioPlayerStat,
  TIME_SCALE_MAX,
  Tree,
  TREE_ARMOR,
  TREE_HP,
} from "@rpg/shared";
import { configureEnemy } from "./enemyConfig";
import { setDevTuning } from "./devTuning";
import { addItem } from "./inventory";
import { placeAtFreeSpot } from "./movement";
import { nearestFreeWorld } from "./pathfinding";
import { setRealmEvents } from "./realm";
import { dropItem } from "./resources";

/**
 * Feature Lab scenario loader (#65, docs/feature-lab.md): scenarios/<name>.json
 * stages ONE feature in isolation — world entities, player loadout, system
 * toggles, tuning overrides, timeScale, bots — layered over realm.json/
 * DevTuning at boot. Merge order (binding): defaults → applyRealmConfig →
 * applyScenarioConfig → GORILATOR_TEST → live dev_tune. Last write wins.
 *
 * Selection channel: GORILATOR_SCENARIO env (set by `pnpm scenario <name>`) is
 * the source of truth; on open dev servers a `?scenario=` join option may set
 * it for a freshly created room (see GameRoom.onCreate).
 *
 * NOTE: devTuning/realmEvents are module-global (one room per process, like
 * realm.ts) — a scenario configures the whole process, not a single room.
 */

const STAT_WHITELIST: readonly ScenarioPlayerStat[] = [
  "level",
  "xp",
  "hp",
  "maxHp",
  "stamina",
  "maxStamina",
  "attack",
  "armor",
  "critChance",
  "moveSpeed",
  "throwPower",
  "mana",
  "maxMana",
  "hunger",
  "maxHunger",
];

let activeName: string | null | undefined; // undefined = not resolved yet
let activeManifest: ScenarioManifest | null = null;

/** The active scenario name (GORILATOR_SCENARIO, or a dev join option). */
export function activeScenarioName(): string | null {
  if (activeName === undefined) {
    const env = (process.env.GORILATOR_SCENARIO ?? "").trim();
    activeName = env ? env : null;
    activeManifest = activeName ? loadScenario(activeName) : null;
  }
  return activeName;
}

/** The active scenario manifest (loaded once), or null. */
export function getActiveScenario(): ScenarioManifest | null {
  activeScenarioName();
  return activeManifest;
}

/** Select a scenario at runtime (dev join option / tests). Null clears. */
export function setActiveScenario(name: string | null): ScenarioManifest | null {
  activeName = name;
  activeManifest = name ? loadScenario(name) : null;
  return activeManifest;
}

/** Load + sanitize scenarios/<name>.json from the repo root (cwd or ../../). */
export function loadScenario(name: string): ScenarioManifest | null {
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    console.warn(`[scenario] invalid name "${name}" — ignored`);
    return null;
  }
  const candidates = [
    resolve(process.cwd(), "scenarios", `${name}.json`),
    resolve(process.cwd(), "../../scenarios", `${name}.json`),
  ];
  const file = candidates.find((p) => existsSync(p));
  if (!file) {
    console.warn(`[scenario] scenarios/${name}.json not found (looked in ${candidates.join(", ")})`);
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as ScenarioManifest;
    if (!raw || typeof raw !== "object") return null;
    raw.name = String(raw.name || name);
    console.log(`[scenario] "${raw.name}" loaded (${file})`);
    return raw;
  } catch (err) {
    console.warn(`[scenario] failed to read ${file}`, err);
    return null;
  }
}

/** Config layer: tuning overrides, timeScale, system toggles. Runs right after
 *  applyRealmConfig (the scenario wins over realm.json; GORILATOR_TEST and live
 *  dev_tune still win over the scenario). */
export function applyScenarioConfig(state: GameState, m: ScenarioManifest): void {
  for (const [key, value] of Object.entries(m.tuning ?? {})) {
    const applied = setDevTuning(key as DevTuningKey, Number(value));
    if (applied === null) console.warn(`[scenario] unknown tuning key "${key}" — ignored`);
    else console.log(`[scenario] tuning ${key} = ${applied}`);
  }
  if (m.timeScale !== undefined) {
    const scale = Number(m.timeScale);
    state.timeScale = Number.isFinite(scale) ? Math.max(0, Math.min(TIME_SCALE_MAX, scale)) : 1;
    console.log(`[scenario] timeScale = ${state.timeScale}`);
  }
  for (const [system, on] of Object.entries(m.systems ?? {})) {
    if (system === "events") {
      // A scenario stages ONE feature — the realm event (waves/objective) stays
      // off unless the manifest explicitly turns it on.
      setRealmEvents({ enabled: Boolean(on) });
      console.log(`[scenario] events ${on ? "enabled" : "disabled"}`);
    } else {
      console.warn(`[scenario] unknown system toggle "${system}" — ignored`);
    }
  }
  if (m.systems?.events === undefined) setRealmEvents({ enabled: false });
}

let stageSeq = 0;

/** World layer: stage resources / ground items / npcs / enemies on top of the
 *  base world. Called at room create AND on every realm restart (re-stage). */
export function applyScenarioWorld(state: GameState, m: ScenarioManifest): void {
  const world = m.world ?? {};

  for (const r of world.resources ?? []) {
    const spot = nearestFreeWorld(Number(r.x) || 0, Number(r.z) || 0);
    if (r.type === "tree") {
      const tree = new Tree();
      tree.id = `scn-tree-${stageSeq++}`;
      tree.x = spot.x;
      tree.z = spot.z;
      tree.hp = TREE_HP;
      tree.maxHp = TREE_HP;
      tree.armor = TREE_ARMOR;
      tree.alive = true;
      state.trees.set(tree.id, tree);
    } else if (r.type === "rock") {
      const rock = new Rock();
      rock.id = `scn-rock-${stageSeq++}`;
      rock.x = spot.x;
      rock.z = spot.z;
      rock.hp = ROCK_HP;
      rock.maxHp = ROCK_HP;
      rock.armor = ROCK_ARMOR;
      rock.alive = true;
      state.rocks.set(rock.id, rock);
    } else {
      console.warn(`[scenario] unknown resource type "${r.type}" — ignored (v1: tree | rock)`);
    }
  }

  for (const g of world.groundItems ?? []) {
    const count = Math.max(1, Math.min(50, Math.round(Number(g.count) || 1)));
    for (let i = 0; i < count; i++) {
      // Small deterministic ring so stacked counts stay reachable + visible.
      const ang = (i / count) * Math.PI * 2;
      const r = i === 0 ? 0 : 0.6;
      dropItem(state, String(g.item), (Number(g.x) || 0) + Math.cos(ang) * r, (Number(g.z) || 0) + Math.sin(ang) * r);
    }
  }

  for (const n of world.npcs ?? []) {
    const spot = nearestFreeWorld(Number(n.x) || 0, Number(n.z) || 0);
    const enemy = configureEnemy(new Enemy(), {
      kind: "npc",
      id: `scn-npc-${stageSeq++}`,
      x: spot.x,
      z: spot.z,
      modelId: String(n.defId),
      brain: n.brain ? (n.brain as BrainId) : undefined,
      stats: n.level != null ? { level: Number(n.level) } : undefined,
    });
    state.enemies.set(enemy.id, enemy);
  }

  for (const en of world.enemies ?? []) {
    const spot = nearestFreeWorld(Number(en.x) || 0, Number(en.z) || 0);
    const kind = String(en.kind || "goblin");
    const cfgKind = kind === "goblin" || kind === "dummy" ? kind : "npc";
    const enemy = configureEnemy(new Enemy(), {
      kind: cfgKind,
      id: `scn-enemy-${stageSeq++}`,
      x: spot.x,
      z: spot.z,
      modelId: cfgKind === "npc" ? kind : undefined,
      brain: en.brain ? (en.brain as BrainId) : undefined,
      stats: en.level != null ? { level: Number(en.level) } : undefined,
    });
    state.enemies.set(enemy.id, enemy);
  }

  const staged =
    (world.resources?.length ?? 0) +
    (world.groundItems?.length ?? 0) +
    (world.npcs?.length ?? 0) +
    (world.enemies?.length ?? 0);
  if (staged > 0) console.log(`[scenario] staged ${staged} world entr${staged === 1 ? "y" : "ies"}`);
}

/** Player layer: loadout / stats / position for a FRESH (non-restored) joiner. */
export function applyScenarioPlayer(p: Player, inv: InventorySlot[], m: ScenarioManifest): void {
  const spec = m.player;
  if (!spec) return;

  const stats = spec.stats ?? {};
  for (const key of STAT_WHITELIST) {
    const value = stats[key];
    if (value === undefined) continue;
    const n = Number(value);
    if (Number.isFinite(n)) (p as unknown as Record<string, number>)[key] = n;
  }
  if (stats.maxHp !== undefined && stats.hp === undefined) p.hp = p.maxHp;
  if (stats.maxStamina !== undefined && stats.stamina === undefined) p.stamina = p.maxStamina;

  if (spec.loadout) {
    for (const slot of inv) {
      slot.type = "";
      slot.count = 0;
    }
    for (const entry of spec.loadout) {
      addItem(inv, String(entry.item), Math.max(1, Math.round(Number(entry.count) || 1)));
    }
  }

  if (spec.position) {
    placeAtFreeSpot(p, Number(spec.position.x) || 0, Number(spec.position.z) || 0);
  }
}
