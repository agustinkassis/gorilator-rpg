/**
 * Seeded deterministic RNG service (engineering.md §3).
 *
 * One seed per realm cycle, split into independent named streams so adding a
 * roll in one concern never shifts another concern's sequence. The service is
 * keyed by the GameState object (WeakMap injection — the same pattern as the
 * wave clock), so pure `(state, dt)` system signatures stay unchanged:
 *
 *   const roll = rng(state, "drops");   // Math.random-compatible () => [0,1)
 *
 * Seed priority: scenario manifest `seed` → GORILATOR_SEED env → random.
 * Tests pin every stream with `installFixedRng(state, 0.5)` instead of spying
 * on Math.random. gameplay code MUST NOT call Math.random directly — rng.test.ts
 * greps the source tree to enforce it.
 */

export type Rng = () => number;
export type RngStream = "combat" | "drops" | "spawns" | "ai" | "world" | "bots" | "misc";
export type SeedSource = "scenario" | "env" | "random";

interface RngService {
  seed: number;
  source: SeedSource;
  streams: Map<string, Rng>;
  fixed?: number; // test hook: every stream returns this value
}

// Keyed loosely by `object` so hand-built mock states in tests work too.
const services = new WeakMap<object, RngService>();

/** MurmurHash3-style string mixer → 32-bit seed. */
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/** mulberry32: tiny, fast, solid-enough PRNG for gameplay rolls. */
function mulberry32(a: number): Rng {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeService(seed: number, source: SeedSource): RngService {
  return { seed: seed >>> 0, source, streams: new Map() };
}

/** (Re)seed the cycle RNG for this state. Returns the seed actually used. */
export function seedRng(state: object, seed?: number, source: SeedSource = "random"): number {
  const s = seed !== undefined && Number.isFinite(seed) ? seed >>> 0 : randomSeed();
  services.set(state, makeService(s, seed !== undefined ? source : "random"));
  return s;
}

/** The seed + source behind this state's RNG (for /api/status + realm records). */
export function rngSeedInfo(state: object): { seed: number; source: SeedSource } | null {
  const svc = services.get(state);
  return svc ? { seed: svc.seed, source: svc.source } : null;
}

/** The named stream's generator for this state (lazily seeded at random). */
export function rng(state: object, name: RngStream): Rng {
  let svc = services.get(state);
  if (!svc) {
    svc = makeService(randomSeed(), "random");
    services.set(state, svc);
  }
  if (svc.fixed !== undefined) {
    const v = svc.fixed;
    return () => v;
  }
  let stream = svc.streams.get(name);
  if (!stream) {
    stream = mulberry32(xmur3(`${svc.seed}:${name}`)());
    svc.streams.set(name, stream);
  }
  return stream;
}

/** TEST HOOK: every stream on this state returns `value` (default 0.5). */
export function installFixedRng(state: object, value = 0.5): void {
  const svc = makeService(0, "random");
  svc.fixed = value;
  services.set(state, svc);
}

/** Resolve the cycle seed: scenario manifest → GORILATOR_SEED env → random. */
export function resolveCycleSeed(scenarioSeed?: number): { seed: number; source: SeedSource } {
  if (scenarioSeed !== undefined && Number.isFinite(scenarioSeed)) {
    return { seed: scenarioSeed >>> 0, source: "scenario" };
  }
  const env = Number(process.env.GORILATOR_SEED);
  if (process.env.GORILATOR_SEED && Number.isFinite(env)) {
    return { seed: env >>> 0, source: "env" };
  }
  return { seed: randomSeed(), source: "random" };
}

function randomSeed(): number {
  // The one sanctioned Math.random call in server gameplay code: minting a
  // fresh cycle seed when nothing pinned one.
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}
