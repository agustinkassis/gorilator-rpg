import { readFileSync, existsSync, watchFile } from "fs";
import { resolve } from "path";
import { GameState, AnimState, Enemy, SpawnRuleConfig } from "@rpg/shared";
import { makeGoblin } from "./goblins";
import { configureEnemy } from "./enemyConfig";
import { devSpawn } from "./devEdit";

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
  x: number;
  z: number;
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

function normalizeSpawner(raw: LegacySpawner): SpawnerRule {
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
    ownerId: String(raw.ownerId || raw.id || ""),
    type,
    modelId,
    label: raw.label || raw.behavior?.label,
    x: Number(raw.x) || 0,
    z: Number(raw.z) || 0,
    intervalMs: Math.max(200, Number(raw.intervalMs) || 4000),
    cap: Math.max(0, Number(raw.cap) || 3),
    brain: raw.behavior?.brain,
    stats,
    aggroRadius: raw.behavior?.aggroRadius,
    attackCooldownMs: raw.behavior?.attackCooldownMs,
    houseDamage: raw.behavior?.houseDamage,
  };
}

function applyFrom(path: string): void {
  try {
    if (!existsSync(path)) {
      spawners = [];
      return;
    }
    const arr = JSON.parse(readFileSync(path, "utf8"));
    spawners = Array.isArray(arr) ? arr.map((s) => normalizeSpawner(s)) : [];
    const ids = new Set(spawners.map((s) => s.id));
    for (const id of [...timers.keys()]) if (!ids.has(id)) timers.delete(id); // drop removed
    for (const s of spawners) if (!timers.has(s.id)) timers.set(s.id, 800); // new → spawn soon
    console.log(`[spawners] ${spawners.length} spawner(s) loaded`);
  } catch (e) {
    console.warn("[spawners] failed to read spawners.json", e);
  }
}

/** Load spawners.json and keep watching it (created/edited live by the dev editor). */
export function loadSpawners(): void {
  const path = spawnersFile();
  if (!path) return;
  applyFrom(path);
  watchFile(path, { interval: 1500 }, () => applyFrom(path)); // fires even when the file first appears
}

/** Reset per-spawner countdowns and runtime ids to the same state as room start. */
export function resetSpawners(): void {
  timers.clear();
  seq = 0;
  for (const s of spawners) timers.set(s.id, 800);
}

/** Tick every spawner; spawn a goblin at its position when due + under its cap. */
export function spawnerSystem(state: GameState, dt: number): void {
  if (!spawners.length || dt <= 0) return; // paused (dt 0) freezes spawning
  const dtMs = dt * 1000;
  for (const s of spawners) {
    let t = (timers.get(s.id) ?? s.intervalMs) - dtMs;
    if (t <= 0) {
      let live = 0;
      live = liveCount(state, s);
      if (live < s.cap) spawnFrom(state, s);
      t = s.intervalMs;
    }
    timers.set(s.id, t);
  }
}

function liveCount(state: GameState, s: SpawnerRule): number {
  let live = 0;
  state.enemies.forEach((e) => {
    if (e.spawnerId === s.id && e.state !== AnimState.DEAD) live++;
  });
  return live;
}

function spawnFrom(state: GameState, s: SpawnerRule): void {
  const type = String(s.type || "goblin");
  if (type === "goblin" && !s.modelId && !s.brain && !s.stats) {
    const g = makeGoblin(state, s.x, s.z);
    g.spawnerId = s.id;
    return;
  }
  if (type === "goblin" || type === "dummy" || type === "npc" || type === "character" || s.modelId) {
    const e = new Enemy();
    const kind = type === "goblin" || type === "dummy" ? type : "npc";
    configureEnemy(e, {
      kind,
      id: `${s.id}-${seq++}`,
      x: s.x,
      z: s.z,
      modelId: s.modelId,
      displayName: s.label,
      brain: s.brain,
      stats: s.stats,
    });
    e.spawnerId = s.id;
    e.aggroRadius = s.aggroRadius || 0;
    e.atkCooldownMs = s.attackCooldownMs || 0;
    e.houseDamage = s.houseDamage || 0;
    state.enemies.set(e.id, e);
    return;
  }
  devSpawn(state, type, `${s.id}-${seq++}`, s.x, s.z);
}
