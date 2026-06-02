import { OBSTACLES, BOULDERS, AGENT_RADIUS, NAV_CELL, WORLD_SIZE, HOUSE_CENTER } from "@rpg/shared";

// La Crypta's VISIBLE footprint (~10.5 × 11, corners ~7.6 from centre) is wider
// than its movement-collision circle (radius 5). Players may walk right up to the
// collision edge during play, but they must never be SPAWNED under the visible
// model — a restored Nostr save / takeover position can sit there. Spawns are
// therefore pushed out to this ring (visual corner 7.6 + agent + margin), which
// only affects placement, not movement collision.
const HOUSE_SPAWN_CLEARANCE = 8.5;

/**
 * Grid-based A* navigation over the static obstacle set. Obstacles are inflated
 * by the agent radius so any free cell fits a centred agent. Paths are then
 * "string-pulled" with line-of-sight checks so movement looks natural rather
 * than grid-stair. Includes a depenetration helper used every tick as a safety
 * net so characters can never end up inside a solid object.
 */

interface Pt {
  x: number;
  z: number;
}

const GRID = Math.ceil((WORLD_SIZE * 2) / NAV_CELL); // cells per axis
const blocked = new Uint8Array(GRID * GRID);

const cellIndex = (cx: number, cz: number) => cz * GRID + cx;
const worldToCell = (w: number) =>
  Math.min(GRID - 1, Math.max(0, Math.floor((w + WORLD_SIZE) / NAV_CELL)));
const cellCenter = (c: number) => -WORLD_SIZE + (c + 0.5) * NAV_CELL;

// Collision circles in three groups:
//  • STATIC      — crates + house (fixed seed; boulders are intentionally dropped
//                  here, since they're driven by the live Rock entities instead).
//  • rockObstacles — the boulders, sourced from the live Rock entities so the dev
//                  editor can relocate/remove them and movement collision follows.
//  • propObstacles — imported concrete props (from props.json).
// `combined` is the flattened set the nav grid + depenetration read each tick.
type Circle = { x: number; z: number; radius: number };
const STATIC: Circle[] = OBSTACLES.filter((o) => !BOULDERS.includes(o)); // crates + house
let rockObstacles: Circle[] = [];
let propObstacles: Circle[] = [];
let combined: Circle[] = [...STATIC];

function rebuildCombined(): void {
  combined = [...STATIC, ...rockObstacles, ...propObstacles];
}

/** Every collision circle the nav grid + depenetration see. */
export function allObstacles(): ReadonlyArray<Circle> {
  return combined;
}

/** Replace the imported-prop collision circles + rebuild the nav grid. Replacing
 *  (not appending) keeps re-reads of props.json idempotent. */
export function setPropObstacles(circles: Circle[]): void {
  propObstacles = circles;
  rebuildCombined();
  buildGrid();
}

/** Replace the rock/boulder collision circles (from the live Rock entities) +
 *  rebuild the nav grid, so relocating/removing a rock updates pathfinding. */
export function setRockObstacles(circles: Circle[]): void {
  rockObstacles = circles;
  rebuildCombined();
  buildGrid();
}

function buildGrid() {
  const obs = allObstacles();
  for (let cz = 0; cz < GRID; cz++) {
    for (let cx = 0; cx < GRID; cx++) {
      const wx = cellCenter(cx);
      const wz = cellCenter(cz);
      let hit = false;
      for (const o of obs) {
        const r = o.radius + AGENT_RADIUS;
        if ((wx - o.x) ** 2 + (wz - o.z) ** 2 < r * r) {
          hit = true;
          break;
        }
      }
      blocked[cellIndex(cx, cz)] = hit ? 1 : 0;
    }
  }
}
buildGrid(); // once at module load (static obstacles)

function isBlockedCell(cx: number, cz: number): boolean {
  if (cx < 0 || cz < 0 || cx >= GRID || cz >= GRID) return false; // outside = open
  return blocked[cellIndex(cx, cz)] === 1;
}

/** Is a world point clear of all obstacles (for the agent)? */
export function isFreeWorld(x: number, z: number): boolean {
  return !isBlockedCell(worldToCell(x), worldToCell(z));
}

/** Straight-line visibility between two world points (no blocked cell in between). */
function lineOfSight(ax: number, az: number, bx: number, bz: number): boolean {
  const dx = bx - ax;
  const dz = bz - az;
  const dist = Math.hypot(dx, dz);
  const steps = Math.ceil(dist / (NAV_CELL * 0.5));
  for (let i = 0; i <= steps; i++) {
    const t = steps === 0 ? 0 : i / steps;
    if (!isFreeWorld(ax + dx * t, az + dz * t)) return false;
  }
  return true;
}

/** Nearest free world point to (x,z), searched outward over the grid. */
export function nearestFreeWorld(x: number, z: number): Pt {
  const sx = worldToCell(x);
  const sz = worldToCell(z);
  if (!isBlockedCell(sx, sz)) return { x, z };
  for (let r = 1; r < GRID; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const cx = sx + dx;
        const cz = sz + dz;
        if (!isBlockedCell(cx, cz)) return { x: cellCenter(cx), z: cellCenter(cz) };
      }
    }
  }
  return { x, z };
}

/** Push a point out of any obstacle it overlaps (collision safety net). */
export function depenetrate(x: number, z: number): Pt {
  let px = x;
  let pz = z;
  for (let iter = 0; iter < 2; iter++) {
    for (const o of allObstacles()) {
      const r = o.radius + AGENT_RADIUS;
      const dx = px - o.x;
      const dz = pz - o.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < r * r) {
        // Push to the circle's edge along the centre→point direction. If the point
        // sits exactly on the centre there's no direction to push, so pick a
        // deterministic one (+x) — otherwise an agent dropped dead-centre of a solid
        // object would stay stuck inside it forever.
        const d = Math.sqrt(d2);
        if (d > 1e-6) {
          px = o.x + (dx / d) * r;
          pz = o.z + (dz / d) * r;
        } else {
          px = o.x + r;
          pz = o.z;
        }
      }
    }
  }
  return { x: px, z: pz };
}

/**
 * True when an agent centred at (x, z) overlaps NO solid obstacle — the precise
 * circle test (house, crates, rocks, imported concrete props), not the grid
 * approximation. This is the postcondition every player spawn must satisfy:
 * if it holds, the player is provably not standing inside a concrete object.
 */
export function isClearWorld(x: number, z: number): boolean {
  for (const o of allObstacles()) {
    const r = o.radius + AGENT_RADIUS;
    if ((x - o.x) ** 2 + (z - o.z) ** 2 < r * r) return false;
  }
  return true;
}

const clampWorld = (v: number) => Math.max(-WORLD_SIZE, Math.min(WORLD_SIZE, v));

/**
 * Resolve a requested spawn/teleport point to one GUARANTEED clear of every
 * solid obstacle, so a player is never dropped inside a structure. Strategy:
 *   1. Snap to the nearest free nav cell, then depenetrate — handles the common
 *      case (a point near or inside a single obstacle like the house).
 *   2. Verify the result with the precise circle test. The grid snap already
 *      guarantees clearance in every normal case; this catches the degenerate
 *      one where overlapping structures left the point embedded.
 *   3. If still embedded, spiral outward from the request sampling points until
 *      one tests clear. Only a world walled in almost solid falls through to the
 *      best-effort depenetrated point.
 */
export function safeSpawnWorld(x: number, z: number): Pt {
  // Keep the request clear of the house's VISIBLE footprint first (see
  // HOUSE_SPAWN_CLEARANCE) — otherwise a restored save position drops you under
  // the model. Push radially out along the request's bearing from the house.
  let rx = x;
  let rz = z;
  const hx = rx - HOUSE_CENTER.x;
  const hz = rz - HOUSE_CENTER.z;
  const hd = Math.hypot(hx, hz);
  if (hd < HOUSE_SPAWN_CLEARANCE) {
    const ux = hd > 1e-6 ? hx / hd : 1; // dead-centre → deterministic +x bearing
    const uz = hd > 1e-6 ? hz / hd : 0;
    rx = clampWorld(HOUSE_CENTER.x + ux * HOUSE_SPAWN_CLEARANCE);
    rz = clampWorld(HOUSE_CENTER.z + uz * HOUSE_SPAWN_CLEARANCE);
  }
  const snapped = nearestFreeWorld(rx, rz);
  const best = depenetrate(snapped.x, snapped.z);
  if (isClearWorld(best.x, best.z)) return best;
  for (let ring = 1; ring <= GRID; ring++) {
    const rad = ring * NAV_CELL;
    const steps = Math.max(8, ring * 6);
    for (let s = 0; s < steps; s++) {
      const a = (s / steps) * Math.PI * 2;
      const cand = depenetrate(
        clampWorld(x + Math.cos(a) * rad),
        clampWorld(z + Math.sin(a) * rad),
      );
      if (isClearWorld(cand.x, cand.z)) return cand;
    }
  }
  return best; // world is essentially full — best effort
}

// --- A* ---
interface Node {
  cx: number;
  cz: number;
  g: number;
  f: number;
}

const NEIGHBORS = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

function astar(sx: number, sz: number, gx: number, gz: number): Pt[] | null {
  const start = cellIndex(sx, sz);
  const goal = cellIndex(gx, gz);
  if (start === goal) return [];

  const open: Node[] = [{ cx: sx, cz: sz, g: 0, f: 0 }];
  const gScore = new Map<number, number>([[start, 0]]);
  const cameFrom = new Map<number, number>();
  const closed = new Set<number>();
  const h = (cx: number, cz: number) => Math.hypot(cx - gx, cz - gz);

  while (open.length) {
    // pop lowest f (small grid → linear scan is fine)
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const cur = open.splice(bi, 1)[0];
    const curId = cellIndex(cur.cx, cur.cz);
    if (curId === goal) break;
    if (closed.has(curId)) continue;
    closed.add(curId);

    for (const [dx, dz, cost] of NEIGHBORS) {
      const nx = cur.cx + dx;
      const nz = cur.cz + dz;
      if (isBlockedCell(nx, nz)) continue;
      // prevent cutting across the corner of a blocked cell
      if (dx !== 0 && dz !== 0) {
        if (isBlockedCell(cur.cx + dx, cur.cz) || isBlockedCell(cur.cx, cur.cz + dz))
          continue;
      }
      const nId = cellIndex(nx, nz);
      if (closed.has(nId)) continue;
      const tentative = cur.g + cost;
      if (tentative < (gScore.get(nId) ?? Infinity)) {
        gScore.set(nId, tentative);
        cameFrom.set(nId, curId);
        open.push({ cx: nx, cz: nz, g: tentative, f: tentative + h(nx, nz) });
      }
    }
  }

  if (!cameFrom.has(goal)) return null;

  // reconstruct cell path
  const cells: number[] = [goal];
  let node = goal;
  while (cameFrom.has(node)) {
    node = cameFrom.get(node)!;
    cells.unshift(node);
  }
  return cells.map((id) => ({
    x: cellCenter(id % GRID),
    z: cellCenter(Math.floor(id / GRID)),
  }));
}

/** Greedily drop intermediate waypoints that the agent can reach in a straight line. */
function smooth(sx: number, sz: number, pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  let ax = sx;
  let az = sz;
  let i = 0;
  while (i < pts.length) {
    let j = pts.length - 1;
    for (; j > i; j--) {
      if (lineOfSight(ax, az, pts[j].x, pts[j].z)) break;
    }
    out.push(pts[j]);
    ax = pts[j].x;
    az = pts[j].z;
    i = j + 1;
  }
  return out;
}

/**
 * Compute a smoothed list of world waypoints from (sx,sz) to (gx,gz), routing
 * around obstacles. The agent is assumed to already be at the start, so the
 * start point is not included. The final waypoint is the exact goal when free.
 */
export function findPath(sx: number, sz: number, gx: number, gz: number): Pt[] {
  const goal = isFreeWorld(gx, gz) ? { x: gx, z: gz } : nearestFreeWorld(gx, gz);

  // Direct shot?
  if (lineOfSight(sx, sz, goal.x, goal.z)) return [goal];

  const start = nearestFreeWorld(sx, sz); // in case the agent is grazing an obstacle
  const cells = astar(
    worldToCell(start.x),
    worldToCell(start.z),
    worldToCell(goal.x),
    worldToCell(goal.z),
  );

  if (!cells || cells.length === 0) return [goal]; // fallback (depenetration prevents tunneling)

  const pts = cells.map((c) => ({ x: c.x, z: c.z }));
  pts[pts.length - 1] = goal; // end exactly on the requested point
  return smooth(sx, sz, pts);
}
