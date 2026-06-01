// Canonical static-obstacle layout — the SINGLE source of truth shared by the
// client (which renders these props) and the server (which uses them for
// collision + A* pathfinding). Trees are NOT here: they're choppable resource
// entities (see schema/Tree). Only boulders/crates block movement.

import { WORLD_SIZE, ROCK_COUNT } from "./constants";

export interface Vec2 {
  x: number;
  z: number;
}

export interface Circle {
  x: number;
  z: number;
  radius: number;
}

/** Collision radius of a character for nav/pathfinding (gorillas are bulky). */
export const AGENT_RADIUS = 0.6;

/** Crate stacks (clustered to read as solid blobs). */
export const CRATES: Array<Vec2 & { rotY: number }> = [
  { x: -10, z: -8, rotY: 0.4 },
  { x: -10.9, z: -7.2, rotY: 1.1 },
  { x: -10.2, z: -8.7, rotY: 0.2 },
  { x: 22, z: 14, rotY: 0.6 },
  { x: 22.9, z: 14.7, rotY: 1.3 },
  { x: 21.4, z: 14.4, rotY: 0.1 },
];

/** Deterministic PRNG so the server and every client generate the SAME boulders. */
function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Scatter `count` boulders across the map, clear of the spawn area + each other. */
function generateBoulders(count: number, range: number, seed: number): Circle[] {
  const rng = mulberry32(seed);
  const out: Circle[] = [];
  let guard = 0;
  while (out.length < count && guard < count * 60) {
    guard++;
    const x = (rng() * 2 - 1) * range;
    const z = (rng() * 2 - 1) * range;
    if (Math.hypot(x, z) < 12) continue; // keep the central spawn area clear
    const radius = 1.0 + rng() * 1.2;
    const tooClose = out.some(
      (b) => (b.x - x) ** 2 + (b.z - z) ** 2 < (b.radius + radius + 5) ** 2,
    );
    if (tooClose) continue;
    out.push({ x, z, radius });
  }
  return out;
}

/** Big rocks the pathfinder has to route around, scattered across the whole map. */
export const BOULDERS: Circle[] = generateBoulders(ROCK_COUNT, WORLD_SIZE - 12, 0x9e3779b9);

/** The Viking house at the map centre — a solid collision footprint (it's a
 *  concrete object: players, enemies and thrown bananas can't pass through it). */
export const HOUSE_CENTER = { x: 0, z: 0 };
export const HOUSE_RADIUS = 5;

/** Everything that physically blocks movement, as collision circles. */
export const OBSTACLES: Circle[] = [
  ...CRATES.map((c) => ({ x: c.x, z: c.z, radius: 0.8 })),
  ...BOULDERS,
  { x: HOUSE_CENTER.x, z: HOUSE_CENTER.z, radius: HOUSE_RADIUS },
];
