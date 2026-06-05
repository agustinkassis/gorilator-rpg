import { readFileSync, existsSync, watchFile } from "fs";
import { resolve, dirname, join } from "path";
import { setPropObstacles } from "./pathfinding";

/** The importer writes the manifest into the client's public dir (so the browser
 *  can fetch it too). Resolve it from the repo root or one level up. */
const CANDIDATES = [
  resolve(process.cwd(), "packages/client/public/props.json"),
  resolve(process.cwd(), "../client/public/props.json"),
  resolve(process.cwd(), "client/public/props.json"),
];

interface PropDef {
  id?: string;
  name: string;
  x: number;
  z: number;
  model?: string; // path under public/, e.g. "/models/house.glb"
  scale?: number; // uniform model scale
  collisionRadius?: number; // present + > 0 ⇒ concrete (blocks movement / bananas)
}

const propPositions = new Map<string, { x: number; z: number }>();

/** Concrete props (collisionRadius>0) — the source for destructible Structures. */
export interface ConcreteProp {
  id: string;
  model?: string;
  x: number;
  z: number;
  radius: number;
  spawn: number;
}
let concreteCache: ConcreteProp[] = [];
const destroyedProps = new Set<string>(); // structures destroyed at runtime → drop their collision
const propsChangeCbs: Array<() => void> = [];

function propKeys(p: PropDef): string[] {
  return [p.id, p.model].filter((key): key is string => Boolean(key));
}

export function propPosition(id: string): { x: number; z: number } | null {
  return propPositions.get(id) ?? null;
}

/** The current concrete props minus any destroyed at runtime. */
export function concreteProps(): ConcreteProp[] {
  return concreteCache.filter((c) => !destroyedProps.has(c.id));
}

/** Run `cb` whenever props.json reloads (so per-room systems can re-sync). */
export function onPropsChange(cb: () => void): void {
  propsChangeCbs.push(cb);
}

/** A destructible structure was destroyed: drop its collision so the rubble is walkable. */
export function destroyPropObstacle(id: string): void {
  destroyedProps.add(id);
  rebuildObstacles();
}

function rebuildObstacles(): void {
  setPropObstacles(concreteProps().map((c) => ({ x: c.x, z: c.z, radius: c.radius, spawn: c.spawn })));
}

function manifestPath(): string | null {
  return CANDIDATES.find((p) => existsSync(p)) ?? null;
}

/**
 * The horizontal half-extent of a prop's VISIBLE model after scaling — read from
 * the GLB's POSITION bounds. A concrete prop's collisionRadius (what players bump
 * into) is often far smaller than its model (e.g. a scale-5 house with radius 2.5),
 * so spawns must clear this larger value or a restored position drops the player
 * INSIDE the building. Falls back to 2× the collision radius when the GLB isn't
 * readable (e.g. a models-less deploy) — which matches the common house ratio.
 */
function visualRadius(publicDir: string, model: string | undefined, scale: number, fallback: number): number {
  if (model) {
    try {
      const f = join(publicDir, model.replace(/^\//, ""));
      if (existsSync(f)) {
        const buf = readFileSync(f);
        const json = JSON.parse(buf.toString("utf8", 20, 20 + buf.readUInt32LE(12)));
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (const m of json.meshes || [])
          for (const p of m.primitives || []) {
            const a = json.accessors?.[p.attributes?.POSITION];
            if (a?.min && a?.max) {
              minX = Math.min(minX, a.min[0]); maxX = Math.max(maxX, a.max[0]);
              minZ = Math.min(minZ, a.min[2]); maxZ = Math.max(maxZ, a.max[2]);
            }
          }
        if (maxX > minX) return (Math.max(maxX - minX, maxZ - minZ) * scale) / 2;
      }
    } catch {
      /* unreadable GLB → fall through to the heuristic */
    }
  }
  return fallback;
}

function applyFrom(path: string): void {
  try {
    const props: PropDef[] = JSON.parse(readFileSync(path, "utf8"));
    const dir = dirname(path); // .../client/public — models live under here
    propPositions.clear();
    for (const p of props) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
      for (const key of propKeys(p)) propPositions.set(key, { x: p.x, z: p.z });
    }
    destroyedProps.clear(); // a fresh manifest re-instates every concrete prop's collision
    concreteCache = props
      .filter((p) => typeof p.collisionRadius === "number" && p.collisionRadius > 0)
      .map((p) => {
        const coll = p.collisionRadius as number;
        const vis = visualRadius(dir, p.model, p.scale ?? 1, coll * 2);
        // `radius` blocks movement (walk up to it); `spawn` keeps SPAWNS out of the
        // whole visible model so a restored position never lands inside a building.
        return { id: p.id || p.model || "", model: p.model, x: p.x, z: p.z, radius: coll, spawn: Math.max(coll, vis) };
      });
    rebuildObstacles();
    console.log(`[props] ${props.length} prop(s), ${concreteCache.length} concrete (collision) from props.json`);
    for (const cb of propsChangeCbs) cb();
  } catch (e) {
    console.warn("[props] failed to read props.json", e);
  }
}

/** Load concrete-prop collisions from props.json and keep watching it, so props
 *  added by the in-game importer start blocking movement without a server restart. */
export function loadPropObstacles(): void {
  const path = manifestPath();
  if (!path) return; // no manifest yet — nothing imported
  applyFrom(path);
  // Poll the file (works across editors/dev-servers) and re-apply on change.
  watchFile(path, { interval: 1500 }, () => applyFrom(path));
}
