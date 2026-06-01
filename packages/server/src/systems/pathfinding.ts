import { OBSTACLES, AGENT_RADIUS, NAV_CELL, WORLD_SIZE } from "@rpg/shared";

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

// The shared static obstacles, plus any registered at runtime (imported concrete
// props). Kept here so the nav grid + depenetration see them all.
type Circle = { x: number; z: number; radius: number };
const extraObstacles: Circle[] = [];

/** Every collision circle: the static set + any dynamically registered props. */
export function allObstacles(): ReadonlyArray<Circle> {
  return extraObstacles.length ? [...OBSTACLES, ...extraObstacles] : OBSTACLES;
}

/** Replace the runtime collision circles (imported concrete props) + rebuild the
 *  nav grid. Replacing (not appending) keeps re-reads of props.json idempotent. */
export function setPropObstacles(circles: Circle[]): void {
  extraObstacles.length = 0;
  extraObstacles.push(...circles);
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
        const d = Math.sqrt(d2) || 0.0001;
        px = o.x + (dx / d) * r;
        pz = o.z + (dz / d) * r;
      }
    }
  }
  return { x: px, z: pz };
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
