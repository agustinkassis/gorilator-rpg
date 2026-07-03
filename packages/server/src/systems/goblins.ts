import {
  type GameState,
  Enemy,
  type Player,
  type House,
  AnimState,
  type DamageEvent,
  GOBLIN_LEVEL,
  GOBLIN_CHASE_SPEED,
  GOBLIN_PATROL_SPEED,
  GOBLIN_LEASH,
  HIT_STATE_MS,
  GOBLIN_SPAWN_RANGE,
  ATTACK_VARIANCE,
  ARMOR_K,
  type BrainId,
  type BrainWorld,
} from "@rpg/shared";
import { nearestFreeWorld, depenetrate } from "./pathfinding";
import { applyDeathXpPenalty } from "./leveling";
import { dropEntityLoot, dropStructureLoot } from "./resources";
import type { EmitKill } from "./combat";
import { brainOf, configureEnemy } from "./enemyConfig";
import { devTuning } from "./devTuning";
import { rng } from "./rng";
import { serverPluginHost } from "./plugins/host";

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
  return Math.hypot(p.x - home.x, p.z - home.z) <= home.radius * (home.scale || 1) + GOBLIN_LEASH;
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

  // World helpers handed to plugin-registered brains (registerBrain) so custom
  // AI reuses the same targeting/steering primitives as the builtins.
  const world: BrainWorld = {
    nearestPlayer: (g) => nearestPlayer(state, g),
    home: () => {
      const h = homeOf(state);
      return h ? { id: h.id, x: h.x, z: h.z, radius: h.radius, scale: h.scale || 1 } : null;
    },
    stepToward: (g, x, z, speed, stepDt) => stepToward(g, x, z, speed, stepDt),
  };

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

    // Plugin-registered brains dispatch first (a plugin may also deliberately
    // override a builtin id). The timed states above (DEAD/HIT/ATTACK) already
    // ran, so a custom brain only steers — combat resolution stays host-owned.
    const pluginBrain = serverPluginHost.brains.get(brain);
    if (pluginBrain) {
      try {
        pluginBrain(g, dt, state, world);
      } catch (err) {
        console.error(`[plugins] brain "${brain}" failed:`, err);
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
      passivePatrol(state, g, dt);
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
      const reach = home.radius * (home.scale || 1) + tuning.enemyAttackRange;
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

function passivePatrol(state: GameState, g: Enemy, dt: number) {
  g.wanderTimer -= dt * 1000;
  const d = Math.hypot(g.targetX - g.x, g.targetZ - g.z);
  if (g.wanderTimer <= 0 || d < 0.8) {
    const roll = rng(state, "ai");
    const angle = roll() * Math.PI * 2;
    const r = roll() * (g.wanderRadius || GOBLIN_LEASH);
    g.targetX = clampRange((g.homeX || g.x) + Math.cos(angle) * r);
    g.targetZ = clampRange((g.homeZ || g.z) + Math.sin(angle) * r);
    g.wanderTimer = 1500 + roll() * 3500;
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
  if (d > house.radius * (house.scale || 1) + tuning.enemyAttackRange * 1.4) return; // shoved out of reach
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

  const variance = 1 + (rng(state, "combat")() * 2 - 1) * ATTACK_VARIANCE;
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
