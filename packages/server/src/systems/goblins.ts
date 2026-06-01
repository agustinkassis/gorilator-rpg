import {
  GameState,
  Enemy,
  Player,
  AnimState,
  DamageEvent,
  GOBLIN_PACK_SIZE,
  GOBLIN_COUNT,
  GOBLIN_PACK_SPREAD,
  GOBLIN_MAX_HP,
  GOBLIN_LEVEL,
  GOBLIN_ATTACK,
  GOBLIN_ARMOR,
  GOBLIN_CRIT_CHANCE,
  GOBLIN_PATROL_SPEED,
  GOBLIN_CHASE_SPEED,
  GOBLIN_AGGRO_RADIUS,
  GOBLIN_DEAGGRO_RADIUS,
  GOBLIN_ATTACK_RANGE,
  GOBLIN_ATTACK_COOLDOWN_MS,
  GOBLIN_ATTACK_WINDUP_MS,
  HIT_STATE_MS,
  GOBLIN_WANDER_RADIUS,
  GOBLIN_SPAWN_RANGE,
  GOBLIN_SPAWN_BASE_MS,
  GOBLIN_SPAWN_MIN_MS,
  GOBLIN_CAP_BASE,
  GOBLIN_CAP_PER_PLAYER,
  GOBLIN_SPAWN_NEAR_MIN,
  GOBLIN_SPAWN_NEAR_MAX,
  ATTACK_VARIANCE,
  ARMOR_K,
  DAMAGE_DIVISOR,
  PLAYER_RESPAWN_MS,
  statsForLevel,
} from "@rpg/shared";
import { nearestFreeWorld, depenetrate } from "./pathfinding";

export type EmitDamage = (ev: DamageEvent) => void;

let seq = 0;

const GOBLIN_SAFE_RADIUS = 30; // keep goblins this far from the origin (player spawn)

/** Make one goblin at (x,z), its power derived from `level`. Returns it so the
 *  caller can override its first move target (e.g. send it after a player). */
function makeGoblin(
  state: GameState,
  x: number,
  z: number,
  wanderRadius: number,
  level: number = GOBLIN_LEVEL,
): Enemy {
  const spot = nearestFreeWorld(x, z);
  const g = new Enemy();
  g.id = `goblin-${seq++}`;
  g.kind = "goblin";
  g.x = spot.x;
  g.z = spot.z;
  g.homeX = spot.x;
  g.homeZ = spot.z;
  // combat power follows from the goblin's level (same per-level growth players get)
  const s = statsForLevel(
    { maxHp: GOBLIN_MAX_HP, attack: GOBLIN_ATTACK, armor: GOBLIN_ARMOR, critChance: GOBLIN_CRIT_CHANCE },
    level,
  );
  g.hp = s.maxHp;
  g.maxHp = s.maxHp;
  g.level = level;
  g.attack = s.attack;
  g.armor = s.armor;
  g.critChance = s.critChance;
  g.wanderRadius = wanderRadius;
  g.state = AnimState.WALK;
  pickPatrol(g);
  state.enemies.set(g.id, g);
  return g;
}

/** Spawn a lone guardian on the centre cross, plus enough roaming packs of three
 *  out in a ring (away from the origin so players don't spawn into a pack) to
 *  reach GOBLIN_COUNT goblins total. */
export function spawnGoblins(state: GameState) {
  makeGoblin(state, 0, 0, 0); // centre-cross guardian holds its spot

  let remaining = Math.max(0, GOBLIN_COUNT - 1); // the rest roam the map in packs
  while (remaining > 0) {
    const size = Math.min(GOBLIN_PACK_SIZE, remaining);
    remaining -= size;
    const ang = Math.random() * Math.PI * 2;
    const r = GOBLIN_SAFE_RADIUS + Math.random() * (GOBLIN_SPAWN_RANGE - GOBLIN_SAFE_RADIUS);
    const packX = Math.cos(ang) * r;
    const packZ = Math.sin(ang) * r;
    for (let k = 0; k < size; k++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.random() * GOBLIN_PACK_SPREAD;
      makeGoblin(state, packX + Math.cos(a) * d, packZ + Math.sin(a) * d, GOBLIN_WANDER_RADIUS);
    }
  }
}

/** Average + top level across the LIVE players — the tower-defense difficulty
 *  inputs (more/higher-level players → faster, stronger waves). */
function playerLevelStats(state: GameState): { avg: number; max: number; alive: number } {
  let sum = 0;
  let max = 1;
  let alive = 0;
  state.players.forEach((p) => {
    if (p.hp <= 0 || p.state === AnimState.DEAD) return;
    alive++;
    sum += p.level;
    if (p.level > max) max = p.level;
  });
  return { avg: alive > 0 ? sum / alive : 1, max, alive };
}

const clampRange = (v: number) =>
  Math.max(-GOBLIN_SPAWN_RANGE, Math.min(GOBLIN_SPAWN_RANGE, v));

/** Spawn one fresh goblin closing in on a random live player. Its level is rolled
 *  between the party average and the top player's level — never above the
 *  strongest player, but climbing as the party levels up. */
function spawnAttacker(state: GameState, avg: number, max: number) {
  const targets: Player[] = [];
  state.players.forEach((p) => {
    if (p.hp > 0 && p.state !== AnimState.DEAD) targets.push(p);
  });
  if (targets.length === 0) return;
  const target = targets[Math.floor(Math.random() * targets.length)];

  const lo = Math.max(1, Math.round(avg));
  const hi = Math.max(lo, max);
  const level = lo + Math.floor(Math.random() * (hi - lo + 1));

  // appear on a ring just beyond the give-up range, then march at the player
  const ang = Math.random() * Math.PI * 2;
  const r = GOBLIN_SPAWN_NEAR_MIN + Math.random() * (GOBLIN_SPAWN_NEAR_MAX - GOBLIN_SPAWN_NEAR_MIN);
  const g = makeGoblin(
    state,
    clampRange(target.x + Math.cos(ang) * r),
    clampRange(target.z + Math.sin(ang) * r),
    GOBLIN_WANDER_RADIUS,
    level,
  );
  const dest = nearestFreeWorld(target.x, target.z); // head straight for its prey
  g.targetX = dest.x;
  g.targetZ = dest.z;
}

interface SpawnClock {
  timer: number;
}
const spawnClocks = new WeakMap<GameState, SpawnClock>();

/**
 * Tower-defense goblin spawner. Goblins spawn on a timer that quickens with the
 * number of LIVE players (interval = base / livePlayers, floored), up to a cap
 * that also grows per player — so a bigger, higher-level party faces faster,
 * stronger waves. Idle while nobody is alive to fight.
 */
export function goblinSpawnSystem(state: GameState, dt: number) {
  let clock = spawnClocks.get(state);
  if (!clock) {
    clock = { timer: GOBLIN_SPAWN_BASE_MS };
    spawnClocks.set(state, clock);
  }

  const { avg, max, alive } = playerLevelStats(state);
  if (alive === 0) {
    clock.timer = GOBLIN_SPAWN_BASE_MS; // nobody to menace — hold fire
    return;
  }

  clock.timer -= dt * 1000;
  if (clock.timer > 0) return;
  clock.timer = Math.max(GOBLIN_SPAWN_MIN_MS, GOBLIN_SPAWN_BASE_MS / alive);

  // count only LIVE goblins toward the cap (fading corpses don't block new waves)
  let living = 0;
  state.enemies.forEach((e) => {
    if (e.kind === "goblin" && e.state !== AnimState.DEAD) living++;
  });
  if (living >= GOBLIN_CAP_BASE + GOBLIN_CAP_PER_PLAYER * alive) return;

  spawnAttacker(state, avg, max);
}

/** Choose a fresh patrol point. Roamers wander off from wherever they currently
 *  are — a free roam across the whole map, not tethered to a home turf. The lone
 *  centre guardian (wanderRadius 0) stays anchored to its cross. */
function pickPatrol(g: Enemy) {
  const a = Math.random() * Math.PI * 2;
  const r = 2 + Math.random() * g.wanderRadius;
  const ax = g.wanderRadius > 0 ? g.x : g.homeX;
  const az = g.wanderRadius > 0 ? g.z : g.homeZ;
  const lim = GOBLIN_SPAWN_RANGE; // stay within the playable scatter area
  const tx = Math.max(-lim, Math.min(lim, ax + Math.cos(a) * r));
  const tz = Math.max(-lim, Math.min(lim, az + Math.sin(a) * r));
  const spot = nearestFreeWorld(tx, tz);
  g.targetX = spot.x;
  g.targetZ = spot.z;
  g.wanderTimer = 4000 + Math.random() * 4000;
}

/** Steer the goblin toward (tx,tz); returns the distance it had to go. */
function stepToward(g: Enemy, tx: number, tz: number, speed: number, dt: number): number {
  const dx = tx - g.x;
  const dz = tz - g.z;
  const d = Math.hypot(dx, dz);
  if (d > 0.05) {
    const s = Math.min(d, speed * dt);
    g.x += (dx / d) * s;
    g.z += (dz / d) * s;
    g.rotY = Math.atan2(dx, dz);
  }
  const fixed = depenetrate(g.x, g.z); // never end up inside an obstacle
  g.x = fixed.x;
  g.z = fixed.z;
  return d;
}

function nearestPlayer(state: GameState, g: Enemy): { p: Player; d: number } | null {
  let best: Player | null = null;
  let bd = Infinity;
  state.players.forEach((p) => {
    if (p.hp <= 0 || p.state === AnimState.DEAD) return;
    const d = Math.hypot(p.x - g.x, p.z - g.z);
    if (d < bd) {
      bd = d;
      best = p;
    }
  });
  return best ? { p: best, d: bd } : null;
}

/**
 * Drive every goblin's behaviour: patrol → chase (player within aggro radius) →
 * attack (in melee, off cooldown) → give up (player beyond the deaggro radius).
 * HIT/DEAD are entered by the player's combat (connectHit); we tick those here.
 */
export function goblinAiSystem(state: GameState, dt: number, emitDamage: EmitDamage) {
  const dtMs = dt * 1000;
  const remove: string[] = [];
  state.enemies.forEach((g) => {
    if (g.kind !== "goblin") return;
    if (g.attackCooldown > 0) g.attackCooldown -= dtMs;

    // dead → corpse lingers, then the goblin is removed (tower-defense: a felled
    // wave is consumed, not respawned — the spawner brings the next one).
    if (g.state === AnimState.DEAD) {
      g.respawnTimer -= dtMs;
      if (g.respawnTimer <= 0) remove.push(g.id);
      return;
    }
    // struck → flinch, then retaliate
    if (g.state === AnimState.HIT) {
      g.stateTimer -= dtMs;
      if (g.stateTimer <= 0) {
        g.state = AnimState.IDLE;
        g.aggro = true;
      }
      return;
    }
    // mid-swing → land the hit at the end of the wind-up
    if (g.state === AnimState.ATTACK) {
      g.stateTimer -= dtMs;
      if (g.stateTimer <= 0) {
        connectGoblinHit(state, g, emitDamage);
        g.state = AnimState.IDLE;
      }
      return;
    }

    const near = nearestPlayer(state, g);

    if (g.aggro) {
      // give up only if the player gets far away (no home leash — goblins roam free)
      if (!near || near.d > GOBLIN_DEAGGRO_RADIUS) {
        g.aggro = false;
        g.aiTargetId = "";
        pickPatrol(g); // resume roaming from where it is
        g.state = AnimState.WALK;
        return;
      }
      g.aiTargetId = near.p.id;
      if (near.d <= GOBLIN_ATTACK_RANGE) {
        g.rotY = Math.atan2(near.p.x - g.x, near.p.z - g.z); // face the target
        if (g.attackCooldown <= 0) {
          g.state = AnimState.ATTACK;
          g.stateTimer = GOBLIN_ATTACK_WINDUP_MS;
          g.attackCooldown = GOBLIN_ATTACK_COOLDOWN_MS;
        } else {
          g.state = AnimState.IDLE; // in range, waiting on cooldown
        }
      } else {
        stepToward(g, near.p.x, near.p.z, GOBLIN_CHASE_SPEED, dt); // chase
        g.state = AnimState.WALK;
      }
    } else {
      // patrolling — but snap to chasing if a player wanders into the aggro radius
      if (near && near.d <= GOBLIN_AGGRO_RADIUS) {
        g.aggro = true;
        g.aiTargetId = near.p.id;
        return;
      }
      g.wanderTimer -= dtMs;
      const dist = stepToward(g, g.targetX, g.targetZ, GOBLIN_PATROL_SPEED, dt);
      if (dist < 0.6 || g.wanderTimer <= 0) pickPatrol(g);
      g.state = AnimState.WALK;
    }
  });

  for (const id of remove) state.enemies.delete(id); // clear felled goblins after the sweep
}

/** Resolve a goblin's swing: damage the chased player if still in reach. */
function connectGoblinHit(state: GameState, g: Enemy, emitDamage: EmitDamage) {
  const target = state.players.get(g.aiTargetId);
  if (!target || target.hp <= 0 || target.state === AnimState.DEAD) return;
  const d = Math.hypot(target.x - g.x, target.z - g.z);
  if (d > GOBLIN_ATTACK_RANGE * 1.4) return; // player stepped out of reach (dodged)

  const variance = 1 + (Math.random() * 2 - 1) * ATTACK_VARIANCE;
  const raw = g.attack * variance;
  const mitigation = target.armor / (target.armor + ARMOR_K);
  const dmg = Math.max(1, Math.round((raw * (1 - mitigation)) / DAMAGE_DIVISOR));

  target.hp = Math.max(0, target.hp - dmg);
  emitDamage({ targetId: target.id, amount: dmg, crit: false });
  if (target.hp <= 0) {
    target.state = AnimState.DEAD;
    target.respawnTimer = PLAYER_RESPAWN_MS;
  } else if (target.state !== AnimState.ATTACK && target.state !== AnimState.THROW) {
    // play the hurt animation on the player — but never interrupt their own
    // attack/throw (so it can't cancel an action mid-swing).
    target.state = AnimState.HIT;
    target.stateTimer = HIT_STATE_MS;
  }
}
