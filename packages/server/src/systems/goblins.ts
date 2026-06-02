import {
  GameState,
  Enemy,
  Player,
  House,
  AnimState,
  DamageEvent,
  GOBLIN_MAX_HP,
  GOBLIN_LEVEL,
  GOBLIN_ATTACK,
  GOBLIN_ARMOR,
  GOBLIN_CRIT_CHANCE,
  GOBLIN_CHASE_SPEED,
  GOBLIN_AGGRO_RADIUS,
  GOBLIN_DEAGGRO_RADIUS,
  GOBLIN_ATTACK_RANGE,
  GOBLIN_ATTACK_COOLDOWN_MS,
  GOBLIN_ATTACK_WINDUP_MS,
  GOBLIN_HOUSE_DAMAGE,
  HIT_STATE_MS,
  GOBLIN_SPAWN_RANGE,
  WAVE_INTERVAL_BASE_MS,
  WAVE_INTERVAL_STEP_MS,
  WAVE_INTERVAL_MAX_MS,
  WAVE_FIRST_DELAY_MS,
  WAVE_SPAWN_DISTANCE,
  WAVE_SPAWN_ARC,
  WAVE_SIZE_BASE,
  WAVE_SIZE_PER_PLAYER,
  WAVE_SIZE_PER_WAVE,
  WAVE_SIZE_MAX,
  GOBLIN_LIVE_CAP,
  ATTACK_VARIANCE,
  ARMOR_K,
  DAMAGE_DIVISOR,
  PLAYER_RESPAWN_MS,
  statsForLevel,
} from "@rpg/shared";
import { nearestFreeWorld, depenetrate } from "./pathfinding";
import { applyDeathXpPenalty } from "./leveling";
import { dropStructureLoot } from "./resources";

export type EmitDamage = (ev: DamageEvent) => void;

let seq = 0;

const clampRange = (v: number) =>
  Math.max(-GOBLIN_SPAWN_RANGE, Math.min(GOBLIN_SPAWN_RANGE, v));

/** The home the goblins besiege: the first (oldest) standing house. MapSchema keeps
 *  insertion order, so this is "house-0" — the first model created. */
function homeOf(state: GameState): House | null {
  let home: House | null = null;
  state.houses.forEach((h) => {
    if (!home && h.alive) home = h;
  });
  return home;
}

/** Make one goblin at (x,z), its power derived from `level`, pointed at the home. */
export function makeGoblin(state: GameState, x: number, z: number, level: number = GOBLIN_LEVEL): Enemy {
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
  g.state = AnimState.WALK;
  const home = homeOf(state);
  g.targetX = home ? home.x : 0;
  g.targetZ = home ? home.z : 0;
  state.enemies.set(g.id, g);
  return g;
}

/** Average + top level across the LIVE players — the wave difficulty inputs (more/
 *  higher-level defenders → bigger, stronger waves). */
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

/** Spawn one wave: a horde a long march out from the home, fanned across an arc so
 *  it sieges from roughly one direction, every goblin pointed at the house. */
function spawnWave(state: GameState, waveNumber: number) {
  const home = homeOf(state);
  const hx = home ? home.x : 0;
  const hz = home ? home.z : 0;
  const { avg, max, alive } = playerLevelStats(state);
  const size = Math.min(
    WAVE_SIZE_MAX,
    WAVE_SIZE_BASE + WAVE_SIZE_PER_PLAYER * Math.max(1, alive) + WAVE_SIZE_PER_WAVE * (waveNumber - 1),
  );
  const baseAng = Math.random() * Math.PI * 2; // the horde approaches from ~one side
  const lo = Math.max(1, Math.round(avg));
  const hi = Math.max(lo, max) + Math.floor(waveNumber / 3); // escalate the level cap over time
  for (let i = 0; i < size; i++) {
    const ang = baseAng + (Math.random() - 0.5) * WAVE_SPAWN_ARC;
    const r = WAVE_SPAWN_DISTANCE * (0.9 + Math.random() * 0.2);
    const level = lo + Math.floor(Math.random() * (hi - lo + 1));
    makeGoblin(state, clampRange(hx + Math.cos(ang) * r), clampRange(hz + Math.sin(ang) * r), level);
  }
}

interface WaveClock {
  timer: number; // ms until the next wave
  number: number; // waves spawned so far
}
const waveClocks = new WeakMap<GameState, WaveClock>();

/** The rest after wave N — it grows so there's more time to rebuild as the siege
 *  escalates: 2.5 min, 3 min, 3.5 min … capped at WAVE_INTERVAL_MAX_MS. */
function intervalAfterWave(n: number): number {
  return Math.min(
    WAVE_INTERVAL_MAX_MS,
    WAVE_INTERVAL_BASE_MS + WAVE_INTERVAL_STEP_MS * Math.max(0, n - 1),
  );
}

/**
 * Tower-defense wave spawner. The first wave comes after a short grace; each
 * successive rest grows (intervalAfterWave) to leave more recovery time. The clock
 * FREEZES while nobody is alive to defend — so a wipe or a solo death never
 * shortcuts the long timer — and a wave is skipped while the live-goblin count is
 * already at the cap.
 */
export function waveSystem(state: GameState, dt: number) {
  let clock = waveClocks.get(state);
  if (!clock) {
    clock = { timer: WAVE_FIRST_DELAY_MS, number: 0 };
    waveClocks.set(state, clock);
  }

  const { alive } = playerLevelStats(state);
  if (alive === 0) {
    // nobody defending — hold the countdown in place (don't reset it to a grace)
    state.waveNumber = clock.number;
    state.waveTimerMs = Math.max(0, clock.timer);
    return;
  }

  clock.timer -= dt * 1000;
  if (clock.timer <= 0) {
    let living = 0;
    state.enemies.forEach((e) => {
      if (e.kind === "goblin" && e.state !== AnimState.DEAD) living++;
    });
    if (living < GOBLIN_LIVE_CAP) {
      clock.number += 1;
      spawnWave(state, clock.number);
    }
    clock.timer = intervalAfterWave(clock.number); // growing rest before the next wave
  }
  state.waveNumber = clock.number;
  state.waveTimerMs = Math.max(0, clock.timer);
}

/** Restart the wave clock for a fresh round (called after a wipe): the next wave is
 *  wave 1 again, after the first-wave grace. */
export function resetWaves(state: GameState) {
  const clock = waveClocks.get(state);
  if (clock) {
    clock.timer = WAVE_FIRST_DELAY_MS;
    clock.number = 0;
  }
  state.waveNumber = 0;
  state.waveTimerMs = WAVE_FIRST_DELAY_MS;
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
 * Drive every goblin: by default it MARCHES on the home and batters the house when
 * it arrives — but a defender who comes within aggro range pulls it off the house
 * to fight, until that player dies or breaks away (past the deaggro range), then it
 * resumes the march. HIT/DEAD are entered by combat; we tick those here.
 */
export function goblinAiSystem(state: GameState, dt: number, emitDamage: EmitDamage) {
  const dtMs = dt * 1000;
  const remove: string[] = [];
  const home = homeOf(state);

  state.enemies.forEach((g) => {
    if (g.kind !== "goblin") return;
    if (g.attackCooldown > 0) g.attackCooldown -= dtMs;

    // dead → corpse lingers, then the goblin is removed (a felled wave is consumed)
    if (g.state === AnimState.DEAD) {
      g.respawnTimer -= dtMs;
      if (g.respawnTimer <= 0) remove.push(g.id);
      return;
    }
    // struck → flinch, then re-engage
    if (g.state === AnimState.HIT) {
      g.stateTimer -= dtMs;
      if (g.stateTimer <= 0) {
        g.state = AnimState.IDLE;
        g.aggro = true; // whoever hit me is a defender worth fighting
      }
      return;
    }
    // mid-swing → land the hit (on a player or the house) at the end of the wind-up
    if (g.state === AnimState.ATTACK) {
      g.stateTimer -= dtMs;
      if (g.stateTimer <= 0) {
        connectGoblinAttack(state, g, emitDamage);
        g.state = AnimState.IDLE;
      }
      return;
    }

    const near = nearestPlayer(state, g);

    // ---- Priority 1: a defender to fight ----
    // Stay locked on a player while it's within the give-up range; otherwise a
    // player who steps inside the aggro radius pulls the goblin off the house.
    let engaging = false;
    if (g.aggro && near && near.d <= GOBLIN_DEAGGRO_RADIUS) engaging = true;
    else if (near && near.d <= (g.aggroRadius || GOBLIN_AGGRO_RADIUS)) {
      g.aggro = true;
      engaging = true;
    } else if (g.aggro) {
      g.aggro = false; // lost them — back to the march
      g.aiTargetId = "";
    }

    if (engaging && near) {
      g.aiTargetId = near.p.id;
      if (near.d <= GOBLIN_ATTACK_RANGE) {
        g.rotY = Math.atan2(near.p.x - g.x, near.p.z - g.z);
        if (g.attackCooldown <= 0) {
          g.state = AnimState.ATTACK;
          g.stateTimer = GOBLIN_ATTACK_WINDUP_MS;
          g.attackCooldown = g.atkCooldownMs || GOBLIN_ATTACK_COOLDOWN_MS;
        } else {
          g.state = AnimState.IDLE; // in range, on cooldown
        }
      } else {
        stepToward(g, near.p.x, near.p.z, (g.chaseSpeed || GOBLIN_CHASE_SPEED), dt);
        g.state = AnimState.WALK;
      }
      return;
    }

    // ---- Priority 2: march on the home and attack it ----
    if (home) {
      const reach = home.radius + GOBLIN_ATTACK_RANGE;
      const d = Math.hypot(home.x - g.x, home.z - g.z);
      if (d <= reach) {
        g.rotY = Math.atan2(home.x - g.x, home.z - g.z);
        if (g.attackCooldown <= 0) {
          g.aiTargetId = home.id; // mark this swing as a house hit
          g.state = AnimState.ATTACK;
          g.stateTimer = GOBLIN_ATTACK_WINDUP_MS;
          g.attackCooldown = g.atkCooldownMs || GOBLIN_ATTACK_COOLDOWN_MS;
        } else {
          g.state = AnimState.IDLE;
        }
      } else {
        // walk to the house's edge (stop at the wall, not the centre)
        const ux = (home.x - g.x) / d;
        const uz = (home.z - g.z) / d;
        stepToward(g, home.x - ux * reach, home.z - uz * reach, (g.chaseSpeed || GOBLIN_CHASE_SPEED), dt);
        g.state = AnimState.WALK;
      }
    } else {
      // home has fallen → hunt the nearest defender, or stand idle
      if (near) {
        g.aggro = true;
        g.aiTargetId = near.p.id;
      } else {
        g.state = AnimState.IDLE;
      }
    }
  });

  for (const id of remove) state.enemies.delete(id); // clear felled goblins after the sweep
}

/** Dispatch a landed goblin swing to its target — the house, or a player. */
function connectGoblinAttack(state: GameState, g: Enemy, emitDamage: EmitDamage) {
  if (state.houses.has(g.aiTargetId)) connectGoblinHouseHit(state, g, emitDamage);
  else connectGoblinHit(state, g, emitDamage);
}

/** Resolve a goblin's swing at the house: chip its HP; collapse it at 0. */
function connectGoblinHouseHit(state: GameState, g: Enemy, emitDamage: EmitDamage) {
  const house = state.houses.get(g.aiTargetId);
  if (!house || !house.alive) return;
  if (house.maxHp <= 0) return; // dev-set HP 0 ⇒ indestructible: swing connects but deals no damage
  const d = Math.hypot(house.x - g.x, house.z - g.z);
  if (d > house.radius + GOBLIN_ATTACK_RANGE * 1.4) return; // shoved out of reach
  const dmg = g.houseDamage || GOBLIN_HOUSE_DAMAGE; // per-spawner override
  house.hp = Math.max(0, house.hp - dmg);
  emitDamage({ targetId: house.id, amount: dmg, crit: false });
  if (house.hp <= 0) {
    house.alive = false;
    dropStructureLoot(state, "house", house.x, house.z); // spill its loot table on collapse
    state.houses.delete(house.id); // collapsed — stops blocking throws; client hides it
  }
}

/** Resolve a goblin's swing at the chased player if still in reach. */
function connectGoblinHit(state: GameState, g: Enemy, emitDamage: EmitDamage) {
  const target = state.players.get(g.aiTargetId);
  if (!target || target.hp <= 0 || target.state === AnimState.DEAD) return;
  if (target.godMode) return; // Dev Mode: immortal players take no goblin damage
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
    applyDeathXpPenalty(target); // dying costs 30% of XP (can de-level)
  } else if (target.state !== AnimState.ATTACK && target.state !== AnimState.THROW) {
    // play the hurt animation on the player — but never interrupt their own
    // attack/throw (so it can't cancel an action mid-swing).
    target.state = AnimState.HIT;
    target.stateTimer = HIT_STATE_MS;
  }
}
