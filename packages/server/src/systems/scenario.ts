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
  WORLD_SIZE,
} from "@rpg/shared";
import { configureEnemy } from "./enemyConfig";
import { setDevTuning } from "./devTuning";
import { addItem } from "./inventory";
import { placeAtFreeSpot } from "./movement";
import { nearestFreeWorld } from "./pathfinding";
import { entityHp } from "./entityFeatures";
import { setRealmPolicy } from "./policy";
import { dropConfig } from "./resourceDrops";
import { setRealmEvents } from "./realm";
import { dropItem } from "./resources";
import { setSpawnersEnabled } from "./spawners";

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

function finite(raw: unknown, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function optionalFinite(raw: unknown): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function bool(raw: unknown): boolean | undefined {
  return typeof raw === "boolean" ? raw : undefined;
}

function clampWorld(raw: unknown, fallback = 0): number {
  return Math.max(-WORLD_SIZE, Math.min(WORLD_SIZE, finite(raw, fallback)));
}

function safeScenarioPart(raw: unknown, fallback: string): string {
  const safe = String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return safe || fallback;
}

function resourceKind(raw: unknown): "tree" | "bush" | "rock" | string {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const kind = String(obj.type ?? obj.kind ?? "tree").toLowerCase();
  if (kind === "bush" || kind === "tree" || kind === "rock") return kind;
  return kind;
}

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

/** Compatibility helper for older callers/tests that look directly at the env. */
export function loadScenarioFromEnv(env = process.env): ScenarioManifest | null {
  const name = String(env.GORILATOR_SCENARIO ?? "").trim();
  return name ? loadScenario(name) : null;
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
  if (m.policy) {
    const applied = setRealmPolicy(m.policy);
    console.log(
      `[scenario] policy: death=${applied.death.mode} (xpPenalty=${applied.death.xpPenalty}) ` +
        `persistAcrossWipes=${applied.progression.persistAcrossWipes} ` +
        `keepInventoryOnWipe=${applied.progression.keepInventoryOnWipe}`,
    );
  }
  if (m.events) {
    const applied = setRealmEvents(m.events);
    console.log(
      `[scenario] events: enabled=${applied.enabled} autoStart=${applied.autoStart}` +
        (applied.module ? ` module=${applied.module}` : ""),
    );
  }
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
  const world = (m.world ?? {}) as NonNullable<ScenarioManifest["world"]>;
  let handledEvents = false;
  let handledSpawners = false;
  for (const [system, on] of Object.entries(m.systems ?? {})) {
    if (system === "events") {
      // A scenario stages ONE feature — the realm event (waves/objective) stays
      // off unless the manifest explicitly turns it on.
      setRealmEvents({ enabled: Boolean(on) });
      console.log(`[scenario] events ${on ? "enabled" : "disabled"}`);
      handledEvents = true;
    } else if (system === "spawners") {
      setSpawnersEnabled(Boolean(on));
      console.log(`[scenario] ambient spawners ${on ? "enabled" : "disabled"}`);
      handledSpawners = true;
    } else if (system === "waves" || system === "resources" || system === "npcs") {
      // Reserved/legacy Feature Lab toggles. Kept accepted so older manifests
      // can declare intent without noisy warnings while their systems are live.
    } else {
      console.warn(`[scenario] unknown system toggle "${system}" — ignored`);
    }
  }
  const legacyEvents = bool(world.laCryptaDefense) ?? bool(world.wavesEnabled);
  if (!handledEvents) setRealmEvents({ enabled: legacyEvents ?? false });
  const legacySpawners = bool(world.spawnersEnabled);
  if (!handledSpawners && legacySpawners !== undefined) setSpawnersEnabled(legacySpawners);
  if (world.wavesEnabled !== undefined) state.wavesEnabled = Boolean(world.wavesEnabled);
}

let stageSeq = 0;

/** World layer: stage resources / ground items / npcs / enemies on top of the
 *  base world. Called at room create AND on every realm restart (re-stage). */
export function applyScenarioWorld(state: GameState, m: ScenarioManifest): void {
  const world = m.world ?? {};

  if (world.clearPickups) {
    state.logs.clear();
    state.stones.clear();
    state.potions.clear();
    state.bananas.clear();
    state.items.clear();
  }

  for (const r of world.resources ?? []) {
    const raw = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    const kind = resourceKind(raw);
    const count = Math.max(1, Math.min(50, Math.round(finite(raw.count, 1))));
    for (let i = 0; i < count; i++) {
      const x = clampWorld(raw.x) + (i % 4) * 1.1;
      const z = clampWorld(raw.z) + Math.floor(i / 4) * 1.1;
      const spot = nearestFreeWorld(x, z);
      const idBase = safeScenarioPart(raw.id, `scn-${kind}-${stageSeq++}`);
      const id = count === 1 ? idBase : `${idBase}-${i}`;
      if (kind === "tree" || kind === "bush") {
        const tree = new Tree();
        tree.id = id;
        tree.kind = kind;
        tree.x = spot.x;
        tree.z = spot.z;
        tree.rotY = finite(raw.rotY, 0);
        tree.scale = Math.max(0.1, Math.min(8, finite(raw.scale, kind === "bush" ? 0.8 : 1)));
        const hp = optionalFinite(raw.hp);
        tree.maxHp = hp === undefined ? entityHp(kind, id, undefined, dropConfig(kind).hp) : Math.max(1, Math.round(hp));
        tree.hp = tree.maxHp;
        tree.armor = TREE_ARMOR;
        tree.alive = true;
        state.trees.set(tree.id, tree);
      } else if (kind === "rock") {
        const rock = new Rock();
        rock.id = id;
        rock.x = spot.x;
        rock.z = spot.z;
        const hp = optionalFinite(raw.hp);
        rock.hp = hp === undefined ? ROCK_HP : Math.max(1, Math.round(hp));
        rock.maxHp = rock.hp;
        rock.armor = ROCK_ARMOR;
        rock.alive = true;
        state.rocks.set(rock.id, rock);
      } else {
        console.warn(`[scenario] unknown resource type "${kind}" — ignored (v1: tree | rock | bush)`);
      }
    }
  }

  for (const g of world.groundItems ?? []) {
    const count = Math.max(1, Math.min(200, Math.round(Number(g.count) || 1)));
    for (let i = 0; i < count; i++) {
      // Small deterministic ring so stacked counts stay reachable + visible.
      const ang = (i / count) * Math.PI * 2;
      const r = i === 0 ? 0 : 0.6;
      dropItem(state, String(g.item), clampWorld(g.x) + Math.cos(ang) * r, clampWorld(g.z) + Math.sin(ang) * r);
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
  if (stats.maxHunger !== undefined && stats.hunger === undefined) p.hunger = p.maxHunger;
  p.maxHunger = Math.max(1, p.maxHunger);
  p.hunger = Math.max(0, Math.min(p.maxHunger, p.hunger));
  p.maxStamina = Math.max(1, p.maxStamina);
  p.stamina = Math.max(0, Math.min(p.maxStamina, p.stamina));
  p.maxHp = Math.max(1, p.maxHp);
  p.hp = Math.max(0, Math.min(p.maxHp, p.hp));

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

export function scenarioSummary(scenario: ScenarioManifest | null): Record<string, unknown> {
  const world = scenario?.world;
  return scenario
    ? {
        active: true,
        name: scenario.name,
        description: scenario.description,
        timeScale: scenario.timeScale ?? 1,
        world: {
          wavesEnabled: world?.wavesEnabled,
          laCryptaDefense: world?.laCryptaDefense,
          spawnersEnabled: world?.spawnersEnabled,
          resources: world?.resources?.length ?? 0,
        },
        tweaks: scenario.tweaks ?? Object.keys(scenario.tuning ?? {}),
      }
    : { active: false };
}
