import { readFileSync, existsSync, watchFile } from "fs";
import { resolve } from "path";
import { GameState, AnimState, Enemy, SpawnRuleConfig } from "@rpg/shared";
import { makeGoblin } from "./goblins";
import { configureEnemy } from "./enemyConfig";
import { devSpawn } from "./devEdit";
import { propPosition, concreteProps } from "./props";

/**
 * Dev-placed spawners: objects (a house, a prop, …) that spawn goblins on a timer.
 * Authored in Dev Mode → written to public/spawners.json (via the Vite endpoint),
 * which this watches live. Each spawner's `behavior` overrides the global goblin
 * constants for the goblins it produces. Coexists with the tower-defense waveSystem.
 */
interface SpawnerBehavior {
  hp?: number;
  attack?: number;
  aggroRadius?: number;
  chaseSpeed?: number;
  attackCooldownMs?: number;
  houseDamage?: number;
  brain?: SpawnRuleConfig["brain"];
  modelId?: string;
  label?: string;
  stats?: SpawnRuleConfig["stats"];
}
type SpawnerRule = SpawnRuleConfig & {
  aggroRadius?: number;
  attackCooldownMs?: number;
  houseDamage?: number;
};

interface LegacySpawner {
  id: string;
  ownerId?: string;
  type?: string;
  spawnType?: string;
  modelId?: string;
  label?: string;
  x?: number;
  z?: number;
  intervalMs: number;
  cap: number;
  behavior?: SpawnerBehavior;
}

// The browser-served public dir (server cwd is packages/server, so "../client/public").
const PUBLIC_DIRS = [
  resolve(process.cwd(), "packages/client/public"),
  resolve(process.cwd(), "../client/public"),
  resolve(process.cwd(), "client/public"),
];
function spawnersFile(): string | null {
  const dir = PUBLIC_DIRS.find((d) => existsSync(d));
  return dir ? resolve(dir, "spawners.json") : null;
}

let spawners: SpawnerRule[] = [];
const timers = new Map<string, number>(); // ms until the next spawn, per spawner id
let seq = 0;

function normalizeSpawner(raw: LegacySpawner): SpawnerRule | null {
  const ownerId = String(raw.ownerId || raw.id || "");
  if (!ownerId) return null;
  const modelId = raw.modelId || raw.behavior?.modelId;
  const type = String(raw.type || raw.spawnType || (modelId ? "npc" : "goblin"));
  const stats = {
    ...(raw.behavior?.stats ?? {}),
    ...(raw.behavior?.hp ? { maxHp: raw.behavior.hp } : {}),
    ...(raw.behavior?.attack ? { attack: raw.behavior.attack } : {}),
    ...(raw.behavior?.chaseSpeed ? { moveSpeed: raw.behavior.chaseSpeed } : {}),
  };
  return {
    id: String(raw.id || `spawner-${Date.now()}`),
    ownerId,
    type,
    modelId,
    label: raw.label || raw.behavior?.label,
    intervalMs: Math.max(200, Number(raw.intervalMs) || 4000),
    cap: Math.max(0, Number(raw.cap) || 3),
    brain: raw.behavior?.brain,
    stats: Object.keys(stats).length ? stats : undefined,
    aggroRadius: raw.behavior?.aggroRadius,
    attackCooldownMs: raw.behavior?.attackCooldownMs,
    houseDamage: raw.behavior?.houseDamage,
  };
}

function applyFrom(path: string, resetTimers = false): void {
  try {
    if (!existsSync(path)) {
      spawners = [];
      return;
    }
    const arr = JSON.parse(readFileSync(path, "utf8"));
    spawners = Array.isArray(arr)
      ? arr.map((s) => normalizeSpawner(s)).filter((s): s is SpawnerRule => Boolean(s))
      : [];
    if (resetTimers) {
      timers.clear();
      seq = 0;
    }
    const ids = new Set(spawners.map((s) => s.id));
    for (const id of [...timers.keys()]) if (!ids.has(id)) timers.delete(id); // drop removed
    for (const s of spawners) {
      const current = timers.get(s.id);
      timers.set(s.id, current === undefined ? s.intervalMs : Math.min(current, s.intervalMs));
    }
    console.log(`[spawners] ${spawners.length} spawner(s) loaded`);
  } catch (e) {
    console.warn("[spawners] failed to read spawners.json", e);
  }
}

/** Load spawners.json and keep watching it (created/edited live by the dev editor). */
export function loadSpawners(): void {
  const path = spawnersFile();
  if (!path) return;
  applyFrom(path, true);
  watchFile(path, { interval: 1500 }, () => applyFrom(path)); // fires even when the file first appears
}

/** Reset per-spawner countdowns and runtime ids to the same state as room start. */
export function resetSpawners(): void {
  timers.clear();
  seq = 0;
  for (const s of spawners) timers.set(s.id, s.intervalMs);
}

/** Tick every spawner; spawn at each owner when due + under its cap. A spawner
 *  whose ownerId is a MODEL path acts as a per-model template: it spawns from
 *  EVERY concrete prop of that model, so a newly-placed structure inherits it. */
export function spawnerSystem(state: GameState, dt: number): void {
  if (!spawners.length || dt <= 0) return; // paused (dt 0) freezes spawning
  const dtMs = dt * 1000;
  for (const s of spawners) {
    for (const tgt of spawnerTargets(state, s)) {
      const key = `${s.id}:${tgt.id}`; // per-owner timer/cap (one template → many props)
      let t = (timers.get(key) ?? s.intervalMs) - dtMs;
      if (t <= 0) {
        if (liveCountFor(state, key) < s.cap) spawnFrom(state, s, tgt, key);
        t = s.intervalMs;
      }
      timers.set(key, t);
    }
  }
}

interface SpawnTarget {
  id: string;
  x: number;
  z: number;
}

/** Where a spawner spawns from: every concrete prop of the owner MODEL (template),
 *  else the single owner entity by id. */
function spawnerTargets(state: GameState, s: SpawnerRule): SpawnTarget[] {
  const byModel = concreteProps().filter((c) => c.model === s.ownerId);
  if (byModel.length) return byModel.map((c) => ({ id: c.id, x: c.x, z: c.z }));
  const pos = ownerPosition(state, s.ownerId);
  return pos ? [{ id: s.ownerId, x: pos.x, z: pos.z }] : [];
}

function ownerPosition(state: GameState, ownerId: string): { x: number; z: number } | null {
  const prop = propPosition(ownerId);
  if (prop) return prop;

  const house = state.houses.get(ownerId);
  if (house) return { x: house.x, z: house.z };
  const tree = state.trees.get(ownerId);
  if (tree) return { x: tree.x, z: tree.z };
  const rock = state.rocks.get(ownerId);
  if (rock) return { x: rock.x, z: rock.z };
  return null;
}

function liveCountFor(state: GameState, key: string): number {
  let live = 0;
  state.enemies.forEach((e) => {
    if (e.spawnerId === key && e.state !== AnimState.DEAD) live++;
  });
  return live;
}

function spawnFrom(state: GameState, s: SpawnerRule, pos: SpawnTarget, key: string): void {
  const type = String(s.type || "goblin");
  if (type === "goblin" && !s.modelId && !s.brain && !s.stats) {
    const g = makeGoblin(state, pos.x, pos.z);
    g.spawnerId = key;
    return;
  }
  if (type === "goblin" || type === "dummy" || type === "npc" || type === "character" || s.modelId) {
    const e = new Enemy();
    const kind = type === "goblin" || type === "dummy" ? type : "npc";
    configureEnemy(e, {
      kind,
      id: `${s.id}-${seq++}`,
      x: pos.x,
      z: pos.z,
      modelId: s.modelId,
      displayName: s.label,
      brain: s.brain,
      stats: s.stats,
    });
    e.spawnerId = key;
    e.aggroRadius = s.aggroRadius || 0;
    e.atkCooldownMs = s.attackCooldownMs || 0;
    e.houseDamage = s.houseDamage || 0;
    state.enemies.set(e.id, e);
    return;
  }
  devSpawn(state, type, `${s.id}-${seq++}`, pos.x, pos.z);
}
