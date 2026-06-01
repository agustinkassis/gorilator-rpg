import {
  GameState,
  Banana,
  Player,
  Enemy,
  House,
  AnimState,
  DamageEvent,
  BananaThrowEvent,
  BANANA_MAX,
  BANANA_RESPAWN_MS,
  BANANA_SPAWN_RANGE,
  BANANA_MIN_THROW,
  BANANA_MAX_THROW,
  BANANA_SPREAD,
  BANANA_AIM_RADIUS,
  BANANA_DAMAGE,
  BANANA_MIN_DAMAGE,
  BANANA_HIT_RADIUS,
  BANANA_FLIGHT_BASE_MS,
  BANANA_FLIGHT_PER_UNIT_MS,
  STONE_MIN_THROW,
  STONE_MAX_THROW,
  STONE_DAMAGE,
  STONE_MIN_DAMAGE,
  HIT_STATE_MS,
  PLAYER_RESPAWN_MS,
  DUMMY_RESPAWN_MS,
  GOBLIN_RESPAWN_MS,
  WORLD_SIZE,
  TREE_RADIUS,
} from "@rpg/shared";
import { nearestFreeWorld, allObstacles } from "./pathfinding";
import { grantXp, killXp, applyDeathXpPenalty, EmitXp } from "./leveling";

/** A banana mid-flight, resolved when its landing time arrives. */
interface InFlight {
  x: number;
  z: number;
  dmg: number;
  ownerId: string;
  landAt: number;
  item: "banana" | "stone";
}
interface BananaMeta {
  seq: number;
  clock: number; // ms accumulated, used to schedule landings
  respawn: number;
  inFlight: InFlight[];
}
const meta = new WeakMap<GameState, BananaMeta>();
function getMeta(state: GameState): BananaMeta {
  let m = meta.get(state);
  if (!m) {
    m = { seq: 0, clock: 0, respawn: BANANA_RESPAWN_MS, inFlight: [] };
    meta.set(state, m);
  }
  return m;
}

const clamp = (v: number) => Math.max(-WORLD_SIZE, Math.min(WORLD_SIZE, v));

export function spawnBanana(state: GameState, x?: number, z?: number): Banana {
  const m = getMeta(state);
  const b = new Banana();
  b.id = `banana-${m.seq++}`;
  const spot =
    x != null && z != null
      ? nearestFreeWorld(x, z)
      : nearestFreeWorld(
          (Math.random() * 2 - 1) * BANANA_SPAWN_RANGE,
          (Math.random() * 2 - 1) * BANANA_SPAWN_RANGE,
        );
  b.x = spot.x;
  b.z = spot.z;
  state.bananas.set(b.id, b);
  return b;
}

export function spawnInitialBananas(state: GameState) {
  getMeta(state);
  for (let i = 0; i < BANANA_MAX; i++) spawnBanana(state);
}

/**
 * A player threw a banana toward (tx,tz) at charge level `power` (0..1). The
 * mouse sets the *direction*; the charge sets the reach (MIN→MAX), damage and
 * speed. Aim assist: if a living character lies in the line of fire within the
 * charged reach, the banana homes onto them so the throw actually connects.
 * Otherwise it lands at the charged reach with a little spread. The hit + drop
 * resolve on landing.
 */
/**
 * First point along the segment O→L where the flight path enters a solid prop
 * (crate, boulder/rock or a standing tree), or null if the path is clear. Lets a
 * thrown banana stop at concrete objects instead of passing through them.
 */
function firstObstacleHit(
  state: GameState,
  ox: number,
  oz: number,
  lx: number,
  lz: number,
): { x: number; z: number } | null {
  const dx = lx - ox;
  const dz = lz - oz;
  const a = dx * dx + dz * dz;
  if (a < 1e-6) return null; // zero-length throw
  let bestT = Infinity;
  const consider = (cx: number, cz: number, r: number) => {
    const fx = ox - cx;
    const fz = oz - cz;
    const b = 2 * (fx * dx + fz * dz);
    const c = fx * fx + fz * fz - r * r;
    let disc = b * b - 4 * a * c;
    if (disc < 0) return; // path misses this circle
    disc = Math.sqrt(disc);
    const t = (-b - disc) / (2 * a); // entry point along the segment
    if (t > 0.02 && t <= 1 && t < bestT) bestT = t; // ignore props at the thrower's feet
  };
  // Crates + boulders are static; the mineable rocks share those boulder circles.
  for (const o of allObstacles()) consider(o.x, o.z, o.radius);
  // Standing trees block too (cut stumps don't).
  state.trees.forEach((t) => {
    if (t.alive) consider(t.x, t.z, TREE_RADIUS);
  });
  // Standing houses block too — a throw stops at the wall (and gets damaged there).
  state.houses.forEach((h) => {
    if (h.alive) consider(h.x, h.z, h.radius);
  });
  if (bestT === Infinity) return null;
  return { x: ox + dx * bestT, z: oz + dz * bestT };
}

/** Reach + damage tuning per throwable item (a stone hits harder but flies less far). */
function throwStats(item: "banana" | "stone") {
  return item === "stone"
    ? { minThrow: STONE_MIN_THROW, maxThrow: STONE_MAX_THROW, minDmg: STONE_MIN_DAMAGE, maxDmg: STONE_DAMAGE }
    : { minThrow: BANANA_MIN_THROW, maxThrow: BANANA_MAX_THROW, minDmg: BANANA_MIN_DAMAGE, maxDmg: BANANA_DAMAGE };
}

export function planThrow(
  state: GameState,
  owner: Player,
  tx: number,
  tz: number,
  power: number,
  item: "banana" | "stone" = "banana",
): BananaThrowEvent {
  const m = getMeta(state);
  const p = Math.max(0, Math.min(1, power));
  const st = throwStats(item);
  const dx = tx - owner.x;
  const dz = tz - owner.z;
  const dlen = Math.hypot(dx, dz) || 1;
  const ux = dx / dlen;
  const uz = dz / dlen;
  const pow = owner.throwPower > 0 ? owner.throwPower : 1; // throw power grows with level
  const reach = (st.minThrow + (st.maxThrow - st.minThrow) * p) * pow; // charge & level -> reach

  // Aim assist: lock onto the first living character the throw line passes within
  // BANANA_AIM_RADIUS of, out to the charged reach (+ a little) — so aiming at a
  // character and charging enough reliably hits it instead of sailing past.
  let target: Player | Enemy | undefined;
  let bestAlong = Infinity;
  const maxAlong = reach * 1.2;
  const consider = (e: Player | Enemy) => {
    if (e.id === owner.id || e.hp <= 0 || e.state === AnimState.DEAD) return;
    const ex = e.x - owner.x;
    const ez = e.z - owner.z;
    const along = ex * ux + ez * uz; // projection onto the aim direction
    if (along < 0.3 || along > maxAlong) return; // behind the thrower or out of reach
    const perp = Math.abs(ex * uz - ez * ux); // perpendicular distance from the aim line
    if (perp > BANANA_AIM_RADIUS) return; // not in the line of fire
    if (along < bestAlong) {
      bestAlong = along;
      target = e;
    }
  };
  state.players.forEach(consider);
  state.enemies.forEach(consider);

  // The banana's intended LANDING — where the arc comes back down: a homed
  // character (aim-assist), else the charged-reach spot with a little spread.
  let landX: number;
  let landZ: number;
  if (target) {
    // home onto the target (tiny jitter, still well inside the hit radius)
    const j = Math.random() * 0.4;
    const a = Math.random() * Math.PI * 2;
    landX = clamp(target.x + Math.cos(a) * j);
    landZ = clamp(target.z + Math.sin(a) * j);
  } else {
    const aimX = owner.x + ux * reach;
    const aimZ = owner.z + uz * reach;
    const devMag = reach * BANANA_SPREAD * Math.random(); // small spread → accurate
    const devAng = Math.random() * Math.PI * 2;
    landX = clamp(aimX + Math.cos(devAng) * devMag);
    landZ = clamp(aimZ + Math.sin(devAng) * devMag);
  }

  // The arc + speed are drawn for the full flight TO that landing, so a homed
  // throw lobs down and lands ON its target. (Previously the arc was always the
  // full charged reach, so a throw at a nearby target only flew a small fraction
  // of a big high arc and struck it mid-air, well above it — the "banana hits way
  // above the goblin" bug.)
  const arcToX = landX;
  const arcToZ = landZ;

  // Only a concrete prop (tree, rock/boulder, crate) in the way clips the arc
  // short — the banana smacks it at whatever height the arc had reached there.
  let hitX = landX;
  let hitZ = landZ;
  const blocked = firstObstacleHit(state, owner.x, owner.z, landX, landZ);
  if (blocked) {
    hitX = blocked.x;
    hitZ = blocked.z;
  }

  // Damage ramps up steeply with charge (∝ p²) — a full-power throw hits far harder.
  const charge = p * p;
  const dmg = Math.max(
    st.minDmg,
    Math.round((st.minDmg + (st.maxDmg - st.minDmg) * charge) * pow),
  );

  const arcDist = Math.hypot(arcToX - owner.x, arcToZ - owner.z) || 1;
  const fullFlightMs =
    (BANANA_FLIGHT_BASE_MS + arcDist * BANANA_FLIGHT_PER_UNIT_MS) * (1.25 - 0.75 * charge);

  const hitDist = Math.hypot(hitX - owner.x, hitZ - owner.z);
  // same speed → reaches a (prop-clipped) hit point in proportionally less time
  const flightMs = fullFlightMs * (hitDist / arcDist);

  m.inFlight.push({ x: hitX, z: hitZ, dmg, ownerId: owner.id, landAt: m.clock + flightMs, item });
  // toX/toZ = where it actually stops; arcToX/arcToZ = its intended landing, so the
  // client draws a full arc that lands on the target (a prop clips it short).
  return { fromX: owner.x, fromZ: owner.z, toX: hitX, toZ: hitZ, flightMs, arcToX, arcToZ, item };
}

/** Keep the map stocked with bananas and resolve any that have just landed. */
export function bananaSystem(
  state: GameState,
  dt: number,
  emitDamage: (ev: DamageEvent) => void,
  emitXp: EmitXp,
) {
  const m = getMeta(state);
  const dtMs = dt * 1000;
  m.clock += dtMs;

  if (state.bananas.size < BANANA_MAX) {
    m.respawn -= dtMs;
    if (m.respawn <= 0) {
      spawnBanana(state);
      m.respawn = BANANA_RESPAWN_MS;
    }
  } else {
    m.respawn = BANANA_RESPAWN_MS;
  }

  for (let i = m.inFlight.length - 1; i >= 0; i--) {
    const f = m.inFlight[i];
    if (m.clock < f.landAt) continue;
    m.inFlight.splice(i, 1);
    landBanana(state, f, emitDamage, emitXp);
  }
}

function landBanana(
  state: GameState,
  f: InFlight,
  emitDamage: (ev: DamageEvent) => void,
  emitXp: EmitXp,
) {
  // hit the nearest living player/enemy near the landing (never the thrower)
  let target: Player | Enemy | undefined;
  let best = BANANA_HIT_RADIUS * BANANA_HIT_RADIUS;
  const consider = (e: Player | Enemy) => {
    if (e.id === f.ownerId || e.hp <= 0 || e.state === AnimState.DEAD) return;
    if ((e as Player).godMode) return; // Dev Mode: immortal players are never hit
    const d2 = (e.x - f.x) ** 2 + (e.z - f.z) ** 2;
    if (d2 < best) {
      best = d2;
      target = e;
    }
  };
  state.players.forEach(consider);
  state.enemies.forEach(consider);

  if (target) {
    target.hp = Math.max(0, target.hp - f.dmg);
    emitDamage({ targetId: target.id, amount: f.dmg, crit: false });
    if (target.hp <= 0) {
      target.state = AnimState.DEAD;
      if (state.players.has(target.id)) {
        target.respawnTimer = PLAYER_RESPAWN_MS;
        applyDeathXpPenalty(target as Player); // dying costs 30% of XP (can de-level)
      } else
        target.respawnTimer =
          state.enemies.get(target.id)?.kind === "goblin"
            ? GOBLIN_RESPAWN_MS
            : DUMMY_RESPAWN_MS;
      const thrower = state.players.get(f.ownerId);
      if (thrower) grantXp(thrower, killXp(state, target.id), emitXp); // the thrower gains XP
    } else if (target.state !== AnimState.ATTACK && target.state !== AnimState.THROW) {
      // play the hurt animation — but never interrupt an attack/throw in progress
      target.state = AnimState.HIT;
      target.stateTimer = HIT_STATE_MS;
    }
  } else {
    // No character at the landing — did the throw strike a house? (It clips at the
    // wall via firstObstacleHit, so the landing sits on the house's edge.)
    let house: House | undefined;
    let hbest = Infinity;
    state.houses.forEach((h) => {
      if (!h.alive) return;
      const reach = h.radius + BANANA_HIT_RADIUS;
      const d2 = (h.x - f.x) ** 2 + (h.z - f.z) ** 2;
      if (d2 <= reach * reach && d2 < hbest) {
        hbest = d2;
        house = h;
      }
    });
    if (house) {
      house.hp = Math.max(0, house.hp - f.dmg);
      emitDamage({ targetId: house.id, amount: f.dmg, crit: false });
      if (house.hp <= 0) {
        house.alive = false;
        state.houses.delete(house.id); // collapsed — stops blocking throws; client hides it
      }
    }
  }

  // a thrown banana drops to the floor as a collectible; a thrown stone shatters
  if (f.item === "banana") spawnBanana(state, f.x, f.z);
}
