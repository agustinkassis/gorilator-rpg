import { readFileSync, existsSync, watchFile } from "fs";
import { resolve } from "path";
import { GameState, AnimState } from "@rpg/shared";
import { makeGoblin } from "./goblins";

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
}
interface Spawner {
  id: string;
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

let spawners: Spawner[] = [];
const timers = new Map<string, number>(); // ms until the next spawn, per spawner id

function applyFrom(path: string): void {
  try {
    if (!existsSync(path)) {
      spawners = [];
      return;
    }
    const arr = JSON.parse(readFileSync(path, "utf8"));
    spawners = Array.isArray(arr) ? arr : [];
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

/** Tick every spawner; spawn a goblin at its position when due + under its cap. */
export function spawnerSystem(state: GameState, dt: number): void {
  if (!spawners.length || dt <= 0) return; // paused (dt 0) freezes spawning
  const dtMs = dt * 1000;
  for (const s of spawners) {
    let t = (timers.get(s.id) ?? s.intervalMs) - dtMs;
    if (t <= 0) {
      let live = 0;
      state.enemies.forEach((e) => {
        if (e.spawnerId === s.id && e.kind === "goblin" && e.state !== AnimState.DEAD) live++;
      });
      if (live < s.cap) spawnFrom(state, s);
      t = s.intervalMs;
    }
    timers.set(s.id, t);
  }
}

function spawnFrom(state: GameState, s: Spawner): void {
  const g = makeGoblin(state, s.x, s.z);
  g.spawnerId = s.id;
  const b = s.behavior ?? {};
  if (b.hp && b.hp > 0) {
    g.maxHp = b.hp;
    g.hp = b.hp;
  }
  if (b.attack && b.attack > 0) g.attack = b.attack;
  g.aggroRadius = b.aggroRadius || 0;
  g.chaseSpeed = b.chaseSpeed || 0;
  g.atkCooldownMs = b.attackCooldownMs || 0;
  g.houseDamage = b.houseDamage || 0;
}
