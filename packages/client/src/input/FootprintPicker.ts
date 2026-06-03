export interface MaskPoint {
  x: number;
  z: number;
}

export interface PickResult {
  id: string;
  kind: string;
}

export type CircleFootprint = {
  type: "circle";
  radius: number;
};

export type StructureMask = {
  type: "polygon";
  points: MaskPoint[];
};

export type FootprintShape = CircleFootprint | StructureMask;

export interface FootprintEntry extends PickResult {
  x: number;
  z: number;
  shape: FootprintShape;
  priority?: number;
  active?: boolean;
}

interface StoredFootprint extends FootprintEntry {
  key: string;
  bounds: Bounds;
  area: number;
}

interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface FootprintPickOptions {
  includeInactive?: boolean;
}

export const DEFAULT_HOUSE_MASK: StructureMask = {
  type: "polygon",
  points: [
    { x: -5.5, z: -5.5 },
    { x: 5.5, z: -5.5 },
    { x: 5.5, z: 5.5 },
    { x: -5.5, z: 5.5 },
  ],
};

const keyOf = (kind: string, id: string) => `${kind}:${id}`;

export function cloneStructureMask(mask: StructureMask): StructureMask {
  return { type: "polygon", points: mask.points.map((p) => ({ x: p.x, z: p.z })) };
}

export function normalizeStructureMask(raw: unknown): StructureMask | null {
  const obj = raw as { type?: unknown; points?: unknown } | null;
  if (!obj || obj.type !== "polygon" || !Array.isArray(obj.points)) return null;
  const points = obj.points
    .slice(0, 64)
    .map((p) => {
      const point = p as { x?: unknown; z?: unknown };
      const x = Number(point.x);
      const z = Number(point.z);
      return Number.isFinite(x) && Number.isFinite(z) ? { x, z } : null;
    })
    .filter((p): p is MaskPoint => !!p);
  return points.length >= 3 ? { type: "polygon", points } : null;
}

export function defaultStructureMask(kind: string): StructureMask {
  return kind === "house" ? cloneStructureMask(DEFAULT_HOUSE_MASK) : cloneStructureMask(DEFAULT_HOUSE_MASK);
}

export class FootprintPicker {
  private entries = new Map<string, StoredFootprint>();

  upsert(entry: FootprintEntry): void {
    if (!entry.id || !entry.kind) return;
    const shape = normalizeShape(entry.shape);
    if (!shape) {
      this.remove(entry.kind, entry.id);
      return;
    }
    const key = keyOf(entry.kind, entry.id);
    this.entries.set(key, {
      ...entry,
      key,
      shape,
      priority: entry.priority ?? 0,
      active: entry.active ?? true,
      bounds: worldBounds(entry.x, entry.z, shape),
      area: shapeArea(shape),
    });
  }

  remove(kind: string, id: string): void {
    this.entries.delete(keyOf(kind, id));
  }

  pick(point: MaskPoint, options: FootprintPickOptions = {}): PickResult | null {
    let best: StoredFootprint | null = null;
    let bestD2 = Infinity;
    for (const entry of this.entries.values()) {
      if (!options.includeInactive && entry.active === false) continue;
      if (!withinBounds(point, entry.bounds)) continue;
      if (!containsPoint(entry, point)) continue;
      const d2 = (point.x - entry.x) ** 2 + (point.z - entry.z) ** 2;
      if (!best || better(entry, d2, best, bestD2)) {
        best = entry;
        bestD2 = d2;
      }
    }
    return best ? { id: best.id, kind: best.kind } : null;
  }

  get(kind: string, id: string): FootprintEntry | null {
    const e = this.entries.get(keyOf(kind, id));
    if (!e) return null;
    return {
      id: e.id,
      kind: e.kind,
      x: e.x,
      z: e.z,
      shape: cloneShape(e.shape),
      priority: e.priority,
      active: e.active,
    };
  }

  clear(): void {
    this.entries.clear();
  }
}

function normalizeShape(shape: FootprintShape): FootprintShape | null {
  if (shape.type === "circle") {
    const radius = Number(shape.radius);
    return Number.isFinite(radius) && radius > 0 ? { type: "circle", radius } : null;
  }
  return normalizeStructureMask(shape);
}

function cloneShape(shape: FootprintShape): FootprintShape {
  return shape.type === "circle" ? { type: "circle", radius: shape.radius } : cloneStructureMask(shape);
}

function worldBounds(x: number, z: number, shape: FootprintShape): Bounds {
  if (shape.type === "circle") {
    return {
      minX: x - shape.radius,
      maxX: x + shape.radius,
      minZ: z - shape.radius,
      maxZ: z + shape.radius,
    };
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of shape.points) {
    minX = Math.min(minX, x + p.x);
    maxX = Math.max(maxX, x + p.x);
    minZ = Math.min(minZ, z + p.z);
    maxZ = Math.max(maxZ, z + p.z);
  }
  return { minX, maxX, minZ, maxZ };
}

function shapeArea(shape: FootprintShape): number {
  if (shape.type === "circle") return Math.PI * shape.radius * shape.radius;
  let sum = 0;
  for (let i = 0; i < shape.points.length; i++) {
    const a = shape.points[i];
    const b = shape.points[(i + 1) % shape.points.length];
    sum += a.x * b.z - b.x * a.z;
  }
  return Math.max(0.001, Math.abs(sum) / 2);
}

function withinBounds(point: MaskPoint, bounds: Bounds): boolean {
  return point.x >= bounds.minX && point.x <= bounds.maxX && point.z >= bounds.minZ && point.z <= bounds.maxZ;
}

function containsPoint(entry: StoredFootprint, point: MaskPoint): boolean {
  const lx = point.x - entry.x;
  const lz = point.z - entry.z;
  const shape = entry.shape;
  if (shape.type === "circle") return lx * lx + lz * lz <= shape.radius * shape.radius;
  return pointInPolygon(lx, lz, shape.points);
}

function pointInPolygon(x: number, z: number, points: MaskPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i];
    const b = points[j];
    if (pointOnSegment(x, z, a, b)) return true;
    const crosses = a.z > z !== b.z > z;
    if (crosses) {
      const atX = ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x;
      if (x < atX) inside = !inside;
    }
  }
  return inside;
}

function pointOnSegment(x: number, z: number, a: MaskPoint, b: MaskPoint): boolean {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  if (len2 <= 1e-8) return false;
  const t = ((x - a.x) * dx + (z - a.z) * dz) / len2;
  if (t < 0 || t > 1) return false;
  const px = a.x + dx * t;
  const pz = a.z + dz * t;
  return (x - px) ** 2 + (z - pz) ** 2 <= 0.03 * 0.03;
}

function better(a: StoredFootprint, aD2: number, b: StoredFootprint, bD2: number): boolean {
  const ap = a.priority ?? 0;
  const bp = b.priority ?? 0;
  if (ap !== bp) return ap > bp;
  if (Math.abs(aD2 - bD2) > 0.001) return aD2 < bD2;
  return a.area < b.area;
}
