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
  GOBLIN_PATROL_SPEED,
  GOBLIN_LEASH,
  HIT_STATE_MS,
  GOBLIN_SPAWN_RANGE,
  WAVE_SPAWN_DISTANCE,
  WAVE_SPAWN_ARC,
  ATTACK_VARIANCE,
  ARMOR_K,
  statsForLevel,
  type BrainId,
} from "@rpg/shared";
import { nearestFreeWorld, depenetrate } from "./pathfinding";
import { applyDeathXpPenalty } from "./leveling";
import { dropEntityLoot, dropStructureLoot } from "./resources";
import type { EmitKill } from "./combat";
import { brainOf, configureEnemy } from "./enemyConfig";
import { devTuning } from "./devTuning";
import { customWave, type WaveEntry } from "./waves";

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
export function makeGoblin(
  state: GameState,
  x: number,
  z: number,
  level: number = GOBLIN_LEVEL,
  waveNumber = 0,
): Enemy {
  const spot = nearestFreeWorld(x, z);
  const g = new Enemy();
  configureEnemy(g, { kind: "goblin", id: `goblin-${seq++}`, x: spot.x, z: spot.z, stats: { level } });
  g.waveNumber = Math.max(0, Math.round(waveNumber));
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

interface ScheduledGoblin {
  delayMs: number;
  x: number;
  z: number;
  level: number;
  kind?: string; // custom-wave override (defaults to a plain goblin)
  defId?: string; // character def id when kind is a custom character
  brain?: BrainId;
}

/** Spawn one scheduled unit: a plain goblin (the fast path), or a custom-wave
 *  entry (specific kind/character + brain), all pointed at the home. */
function spawnScheduled(state: GameState, g: ScheduledGoblin, waveNumber: number): Enemy {
  const kind = g.kind || "goblin";
  if (kind === "goblin" && !g.brain) return makeGoblin(state, g.x, g.z, g.level, waveNumber);
  const spot = nearestFreeWorld(g.x, g.z);
  const e = new Enemy();
  const cfgKind = kind === "goblin" || kind === "dummy" ? kind : "npc";
  configureEnemy(e, {
    kind: cfgKind,
    id: `wave-${seq++}`,
    x: spot.x,
    z: spot.z,
    modelId: cfgKind === "npc" ? g.defId ?? kind : undefined,
    brain: g.brain ?? "attacks_home",
    stats: g.level != null ? { level: g.level } : undefined,
  });
  e.waveNumber = Math.max(0, Math.round(waveNumber));
  const home = homeOf(state);
  e.targetX = home ? home.x : 0;
  e.targetZ = home ? home.z : 0;
  state.enemies.set(e.id, e);
  return e;
}

/** Build a custom (dev-authored) wave: each entry → `count` units of a kind, with
 *  an optional brain (default attacks_home) and level, fanned across the spawn arc. */
function scheduleCustomWave(state: GameState, waveNumber: number, entries: WaveEntry[]): ScheduledGoblin[] {
  const tuning = devTuning();
  const home = homeOf(state);
  const hx = home ? home.x : 0;
  const hz = home ? home.z : 0;
  const units: Array<{ kind: string; defId?: string; brain?: BrainId; level?: number }> = [];
  for (const e of entries) for (let i = 0; i < e.count; i++) units.push(e);
  const total = units.length;
  if (total <= 0) return [];
  const baseAng = Math.random() * Math.PI * 2;
  const { avg, max } = playerLevelStats(state);
  const lo = Math.max(1, Math.round(avg));
  const hi = Math.max(lo, max) + Math.floor(waveNumber / 3);
  const delays =
    total === 1
      ? [0]
      : [
          0,
          tuning.waveSpawnSpreadMs,
          ...Array.from({ length: total - 2 }, () => Math.random() * tuning.waveSpawnSpreadMs),
        ].sort((a, b) => a - b);
  const out: ScheduledGoblin[] = [];
  for (let i = 0; i < total; i++) {
    const u = units[i];
    const ang = baseAng + (Math.random() - 0.5) * WAVE_SPAWN_ARC * 1.25;
    const r = WAVE_SPAWN_DISTANCE * (0.78 + Math.random() * 0.44);
    out.push({
      delayMs: delays[i],
      x: clampRange(hx + Math.cos(ang) * r),
      z: clampRange(hz + Math.sin(ang) * r),
      level: u.level ?? lo + Math.floor(Math.random() * (hi - lo + 1)),
      kind: u.kind,
      defId: u.defId,
      brain: u.brain,
    });
  }
  return out;
}

/** Build one wave: a horde a long march out from the home, fanned across an arc so
 *  it sieges from roughly one direction, but scheduled over time instead of dumped
 *  all at once. The first goblin is immediate, the last is +40s, and the rest land
 *  randomly between those endpoints so the final experience stays predictable. */
function scheduleWave(state: GameState, waveNumber: number): ScheduledGoblin[] {
  const custom = customWave(waveNumber);
  if (custom) return scheduleCustomWave(state, waveNumber, custom); // dev-authored override
  const tuning = devTuning();
  const home = homeOf(state);
  const hx = home ? home.x : 0;
  const hz = home ? home.z : 0;
  const { avg, max, alive } = playerLevelStats(state);
  const size = Math.min(
    tuning.waveSizeMax,
    tuning.waveSizeBase + tuning.waveSizePerPlayer * Math.max(1, alive) + tuning.waveSizePerWave * (waveNumber - 1),
  );
  if (size <= 0) return [];
  const baseAng = Math.random() * Math.PI * 2; // the horde approaches from ~one side
  const lo = Math.max(1, Math.round(avg));
  const hi = Math.max(lo, max) + Math.floor(waveNumber / 3); // escalate the level cap over time
  const delays =
    size === 1
      ? [0]
      : [
          0,
          tuning.waveSpawnSpreadMs,
          ...Array.from({ length: size - 2 }, () => Math.random() * tuning.waveSpawnSpreadMs),
        ].sort((a, b) => a - b);
  const wave: ScheduledGoblin[] = [];
  for (let i = 0; i < size; i++) {
    const ang = baseAng + (Math.random() - 0.5) * WAVE_SPAWN_ARC * 1.25;
    const r = WAVE_SPAWN_DISTANCE * (0.78 + Math.random() * 0.44);
    const level = lo + Math.floor(Math.random() * (hi - lo + 1));
    wave.push({
      delayMs: delays[i],
      x: clampRange(hx + Math.cos(ang) * r),
      z: clampRange(hz + Math.sin(ang) * r),
      level,
    });
  }
  return wave;
}

interface WaveClock {
  timer: number; // ms until the next wave
  number: number; // waves spawned so far
  pending: ScheduledGoblin[]; // goblins queued for the current wave
}
const waveClocks = new WeakMap<GameState, WaveClock>();

function liveWaveGoblins(state: GameState, waveNumber: number): number {
  let live = 0;
  state.enemies.forEach((e) => {
    if (e.kind === "goblin" && e.waveNumber === waveNumber && e.state !== AnimState.DEAD) live++;
  });
  return live;
}

function syncWaveState(state: GameState, clock: WaveClock) {
  state.waveNumber = clock.number;
  state.waveTimerMs = Math.max(0, clock.timer);
  state.waveActive =
    clock.number > 0 && (clock.pending.length > 0 || liveWaveGoblins(state, clock.number) > 0);
}

/** The rest after wave N — it grows so there's more time to rebuild as the siege
 *  escalates: 2.5 min, 3 min, 3.5 min … capped at WAVE_INTERVAL_MAX_MS. */
function intervalAfterWave(n: number): number {
  const tuning = devTuning();
  return Math.min(
    tuning.waveIntervalMaxMs,
    tuning.waveIntervalBaseMs + tuning.waveIntervalStepMs * Math.max(0, n - 1),
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
  const tuning = devTuning();
  let clock = waveClocks.get(state);
  if (!clock) {
    clock = { timer: tuning.waveFirstDelayMs, number: 0, pending: [] };
    waveClocks.set(state, clock);
  }

  const { alive } = playerLevelStats(state);
  if (alive === 0) {
    // nobody defending — hold the countdown in place (don't reset it to a grace)
    syncWaveState(state, clock);
    return;
  }

  const dtMs = dt * 1000;
  if (clock.pending.length > 0) {
    clock.pending.forEach((g) => (g.delayMs -= dtMs));
    const ready = clock.pending.filter((g) => g.delayMs <= 0);
    clock.pending = clock.pending.filter((g) => g.delayMs > 0);
    ready.forEach((g) => spawnScheduled(state, g, clock.number));
  }

  clock.timer -= dtMs;
  if (clock.timer <= 0) {
    let living = 0;
    state.enemies.forEach((e) => {
      if (e.kind === "goblin" && e.state !== AnimState.DEAD) living++;
    });
    if (living < tuning.goblinLiveCap && clock.pending.length === 0) {
      clock.number += 1;
      clock.pending = scheduleWave(state, clock.number);
    }
    clock.timer = intervalAfterWave(clock.number); // growing rest before the next wave
  }
  syncWaveState(state, clock);
}

/** Restart the wave clock for a fresh round (called after a wipe): the next wave is
 *  wave 1 again, after the first-wave grace. */
export function resetWaves(state: GameState, resetSpawnIds = false) {
  if (resetSpawnIds) seq = 0;
  const firstDelay = devTuning().waveFirstDelayMs;
  const clock = waveClocks.get(state);
  if (clock) {
    clock.timer = firstDelay;
    clock.number = 0;
    clock.pending = [];
  }
  state.waveNumber = 0;
  state.waveTimerMs = firstDelay;
  state.waveActive = false;
}

export function forceNextWave(state: GameState) {
  let clock = waveClocks.get(state);
  if (!clock) {
    clock = { timer: devTuning().waveFirstDelayMs, number: 0, pending: [] };
    waveClocks.set(state, clock);
  }
  clock.number += 1;
  clock.pending = scheduleWave(state, clock.number);
  const ready = clock.pending.filter((g) => g.delayMs <= 0);
  clock.pending = clock.pending.filter((g) => g.delayMs > 0);
  ready.forEach((g) => spawnScheduled(state, g, clock.number));
  clock.timer = intervalAfterWave(clock.number);
  syncWaveState(state, clock);
}

/** Dev-only: rewind the wave counter by one (drops any queued spawns and resets
 *  the rest timer for the new, lower wave number). No-op at wave 0. */
export function previousWave(state: GameState) {
  const clock = waveClocks.get(state);
  if (!clock || clock.number <= 0) return;
  clock.number -= 1;
  clock.pending = [];
  clock.timer = intervalAfterWave(clock.number);
  syncWaveState(state, clock);
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

function isDefendingHome(home: House | null, p: Player): boolean {
  if (!home) return true;
  return Math.hypot(p.x - home.x, p.z - home.z) <= home.radius + GOBLIN_LEASH;
}

/**
 * Drive every goblin: by default it MARCHES on the home and batters the house when
 * it arrives — but a defender who comes within aggro range pulls it off the house
 * to fight, until that player dies, breaks away (past the deaggro range), or leaves
 * La Crypta's defensive area, then it resumes the march. HIT/DEAD are entered by
 * combat; we tick those here.
 */
export function goblinAiSystem(state: GameState, dt: number, emitDamage: EmitDamage, emitKill: EmitKill) {
  const dtMs = dt * 1000;
  const remove: string[] = [];
  const home = homeOf(state);

  state.enemies.forEach((g) => {
    const brain = brainOf(g);
    if (g.attackCooldown > 0) g.attackCooldown -= dtMs;

    // dead → corpse lingers, then either respawns at home or is consumed by a wave.
    if (g.state === AnimState.DEAD) {
      g.respawnTimer -= dtMs;
      if (g.respawnTimer <= 0) {
        if (g.kind === "goblin" && brain === "attacks_home") remove.push(g.id);
        else respawnEnemy(g, brain);
      }
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
        connectEnemyAttack(state, g, emitDamage, emitKill);
        g.state = AnimState.IDLE;
      }
      return;
    }

    if (brain === "idle") {
      g.aggro = false;
      g.aiTargetId = "";
      g.state = AnimState.IDLE;
      return;
    }

    if (brain === "passive_patrol") {
      passivePatrol(g, dt);
      return;
    }

    const near = nearestPlayer(state, g);

    if (brain === "war_seeker") {
      if (near) engagePlayer(g, near.p, near.d, dt);
      else g.state = AnimState.IDLE;
      return;
    }

    const tuning = devTuning();
    // ---- Priority 1: a defender to fight ----
    // Stay locked on a player while it's within the give-up range; otherwise a
    // player who steps inside the aggro radius pulls the goblin off the house.
    // Defenders who run too far from La Crypta stop being worth chasing.
    let engaging = false;
    const nearIsDefending = near && isDefendingHome(home, near.p);
    if (g.aggro && nearIsDefending && near.d <= tuning.enemyDeaggroRadius) engaging = true;
    else if (nearIsDefending && near.d <= (g.aggroRadius || tuning.enemyAggroRadius)) {
      g.aggro = true;
      engaging = true;
    } else if (g.aggro) {
      g.aggro = false; // lost them — back to the march
      g.aiTargetId = "";
    }

    if (engaging && near) {
      engagePlayer(g, near.p, near.d, dt);
      return;
    }

    // ---- Priority 2: march on the home and attack it ----
    if (home) {
      const reach = home.radius + tuning.enemyAttackRange;
      const d = Math.hypot(home.x - g.x, home.z - g.z);
      if (d <= reach) {
        g.rotY = Math.atan2(home.x - g.x, home.z - g.z);
        if (g.attackCooldown <= 0) {
          g.aiTargetId = home.id; // mark this swing as a house hit
          g.state = AnimState.ATTACK;
          g.stateTimer = tuning.enemyAttackWindupMs;
          g.attackCooldown = g.atkCooldownMs || tuning.enemyAttackCooldownMs;
        } else {
          g.state = AnimState.IDLE;
        }
      } else {
        // walk to the house's edge (stop at the wall, not the centre)
        const ux = (home.x - g.x) / d;
        const uz = (home.z - g.z) / d;
        stepToward(g, home.x - ux * reach, home.z - uz * reach, enemySpeed(g, GOBLIN_CHASE_SPEED), dt);
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

function enemySpeed(g: Enemy, fallback: number): number {
  return g.moveSpeed || g.chaseSpeed || fallback;
}

function engagePlayer(g: Enemy, p: Player, d: number, dt: number) {
  const tuning = devTuning();
  g.aiTargetId = p.id;
  if (d <= tuning.enemyAttackRange) {
    g.rotY = Math.atan2(p.x - g.x, p.z - g.z);
    if (g.attackCooldown <= 0) {
      g.state = AnimState.ATTACK;
      g.stateTimer = tuning.enemyAttackWindupMs;
      g.attackCooldown = g.atkCooldownMs || tuning.enemyAttackCooldownMs;
    } else {
      g.state = AnimState.IDLE;
    }
  } else {
    stepToward(g, p.x, p.z, enemySpeed(g, GOBLIN_CHASE_SPEED), dt);
    g.state = AnimState.WALK;
  }
}

function passivePatrol(g: Enemy, dt: number) {
  g.wanderTimer -= dt * 1000;
  const d = Math.hypot(g.targetX - g.x, g.targetZ - g.z);
  if (g.wanderTimer <= 0 || d < 0.8) {
    const angle = Math.random() * Math.PI * 2;
    const r = Math.random() * (g.wanderRadius || GOBLIN_LEASH);
    g.targetX = clampRange((g.homeX || g.x) + Math.cos(angle) * r);
    g.targetZ = clampRange((g.homeZ || g.z) + Math.sin(angle) * r);
    g.wanderTimer = 1500 + Math.random() * 3500;
  }
  stepToward(g, g.targetX, g.targetZ, enemySpeed(g, GOBLIN_PATROL_SPEED), dt);
  g.state = AnimState.WALK;
}

function respawnEnemy(g: Enemy, brain: ReturnType<typeof brainOf>) {
  g.hp = g.maxHp;
  g.x = g.homeX;
  g.z = g.homeZ;
  g.targetX = g.homeX;
  g.targetZ = g.homeZ;
  g.aiTargetId = "";
  g.aggro = false;
  g.attackCooldown = 0;
  g.stateTimer = 0;
  g.state = brain === "idle" ? AnimState.IDLE : AnimState.WALK;
}

/** Dispatch a landed goblin swing to its target — the house, or a player. */
function connectEnemyAttack(state: GameState, g: Enemy, emitDamage: EmitDamage, emitKill: EmitKill) {
  if (state.houses.has(g.aiTargetId)) connectGoblinHouseHit(state, g, emitDamage);
  else connectGoblinHit(state, g, emitDamage, emitKill);
}

/** Resolve a goblin's swing at the house: chip its HP; collapse it at 0. */
function connectGoblinHouseHit(state: GameState, g: Enemy, emitDamage: EmitDamage) {
  const tuning = devTuning();
  const house = state.houses.get(g.aiTargetId);
  if (!house || !house.alive) return;
  if (house.maxHp <= 0) return; // dev-set HP 0 ⇒ indestructible: swing connects but deals no damage
  const d = Math.hypot(house.x - g.x, house.z - g.z);
  if (d > house.radius + tuning.enemyAttackRange * 1.4) return; // shoved out of reach
  const dmg = g.houseDamage || tuning.goblinHouseDamage; // per-spawner override
  house.hp = Math.max(0, house.hp - dmg);
  emitDamage({ targetId: house.id, amount: dmg, crit: false });
  if (house.hp <= 0) {
    house.alive = false;
    dropStructureLoot(state, "house", house.x, house.z); // spill its loot table on collapse
    state.houses.delete(house.id); // collapsed — stops blocking throws; client hides it
  }
}

/** Resolve a goblin's swing at the chased player if still in reach. */
function connectGoblinHit(state: GameState, g: Enemy, emitDamage: EmitDamage, emitKill: EmitKill) {
  const tuning = devTuning();
  const target = state.players.get(g.aiTargetId);
  if (!target || target.hp <= 0 || target.state === AnimState.DEAD) return;
  if (target.godMode) return; // Dev Mode: immortal players take no goblin damage
  const d = Math.hypot(target.x - g.x, target.z - g.z);
  if (d > tuning.enemyAttackRange * 1.4) return; // player stepped out of reach (dodged)

  const variance = 1 + (Math.random() * 2 - 1) * ATTACK_VARIANCE;
  const raw = g.attack * variance;
  const mitigation = target.armor / (target.armor + ARMOR_K);
  const dmg = Math.max(1, Math.round((raw * (1 - mitigation)) / tuning.damageDivisor));

  target.hp = Math.max(0, target.hp - dmg);
  emitDamage({ targetId: target.id, amount: dmg, crit: false });
  if (target.hp <= 0) {
    target.state = AnimState.DEAD;
    target.respawnTimer = tuning.playerRespawnMs;
    applyDeathXpPenalty(target); // dying costs 30% of XP (can de-level)
    dropEntityLoot(state, "player", target.id, undefined, target.x, target.z, 1.2);
    emitKill({
      killerId: g.id,
      killerName: "Goblin",
      killerKind: "goblin",
      victimId: target.id,
      victimName: target.name || "Player",
    });
  } else if (target.state !== AnimState.ATTACK && target.state !== AnimState.THROW) {
    // play the hurt animation on the player — but never interrupt their own
    // attack/throw (so it can't cancel an action mid-swing).
    target.state = AnimState.HIT;
    target.stateTimer = HIT_STATE_MS;
  }
}
