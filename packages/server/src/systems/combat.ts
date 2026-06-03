import {
  GameState,
  Player,
  Enemy,
  Tree,
  Rock,
  House,
  AnimState,
  DamageEvent,
  KillEvent,
  HealEvent,
  ATTACK_RANGE,
  ATTACK_COOLDOWN_MS,
  ATTACK_WINDUP_MS,
  ATTACK_VARIANCE,
  ARMOR_K,
  CRIT_MULTIPLIER,
  CRIT_KNOCKBACK_DISTANCE,
  DAMAGE_DIVISOR,
  HIT_STATE_MS,
  PLAYER_RESPAWN_MS,
  DUMMY_RESPAWN_MS,
  GOBLIN_RESPAWN_MS,
  WORLD_SIZE,
  AGENT_RADIUS,
  TREE_BANANA_DROP_CHANCE,
  ROCK_COLLISION_SCALE,
  HOUSE_REPAIR_MIN_HP,
  HOUSE_REPAIR_MAX_HP,
} from "@rpg/shared";
import { setDestination, placeAtFreeSpot } from "./movement";
import { nearestFreeWorld } from "./pathfinding";
import {
  onTreeCut,
  onTreeDamaged,
  onRockMined,
  onRockDamaged,
  dropEntityLoot,
  applyDamageDrops,
} from "./resources";
import { grantXp, killXp, applyDeathXpPenalty, EmitXp } from "./leveling";
import { spawnBanana } from "./bananas";

/** Anything that can be attacked or repaired by a player. */
type Target = Player | Enemy | Tree | Rock | House;
/** Damageable targets all have hp + armor. Houses are repaired instead. */
type Damageable = Player | Enemy | Tree | Rock;

/** Sink for damage events so the room can broadcast floating numbers to clients. */
export type EmitDamage = (ev: DamageEvent) => void;
export type EmitKill = (ev: KillEvent) => void;
export type EmitHeal = (ev: HealEvent) => void;
export type RepairInventory = {
  hasWood: (playerId: string) => boolean;
  consumeWood: (playerId: string) => boolean;
};

/**
 * Roll a hit: attacker's attack power, randomised ±ATTACK_VARIANCE, reduced by
 * the target's armor (diminishing returns), with a chance to crit.
 */
function rollDamage(
  attacker: Player,
  target: Damageable,
): { amount: number; crit: boolean } {
  const variance = 1 + (Math.random() * 2 - 1) * ATTACK_VARIANCE;
  const raw = attacker.attack * variance;
  const mitigation = target.armor / (target.armor + ARMOR_K);
  let dmg = raw * (1 - mitigation);
  const crit = Math.random() < attacker.critChance;
  if (crit) {
    // Per-player multiplier (set by berserker buff); fall back to global constant.
    const critMult = attacker.critMultiplier > 0 ? attacker.critMultiplier : CRIT_MULTIPLIER;
    dmg *= critMult;
  }
  return { amount: Math.max(1, Math.round(dmg / DAMAGE_DIVISOR)), crit };
}


function resolveTarget(state: GameState, id: string): Target | undefined {
  return (
    state.players.get(id) ??
    state.enemies.get(id) ??
    state.trees.get(id) ??
    state.rocks.get(id) ??
    state.houses.get(id)
  );
}

/** Bulky targets (rocks) carry a collision radius — you hit them from the surface,
 *  not the centre, so the reach must include it. Other targets are points. */
function targetRadius(t: Target): number {
  const r = (t as { radius?: number }).radius;
  if (t instanceof House) return typeof r === "number" ? r : 0;
  // Rocks carry a radius; use a fraction of it so the player walks right up to
  // the boulder to mine it (and ends up amid the stones it drops).
  return typeof r === "number" ? r * ROCK_COLLISION_SCALE : 0;
}

/** How close to a target's centre you can land a hit (its surface + melee reach). */
function attackReach(t: Target): number {
  return ATTACK_RANGE + targetRadius(t);
}

/** Dev Mode: a player with god mode on is immortal — all damage to it is skipped.
 *  Only Player carries `godMode`; on other Damageables this is undefined → false. */
export function isImmune(t: Damageable): boolean {
  return (t as Player).godMode === true;
}

/** A point just outside the target to walk toward (right up to bulky rocks). */
function approachPoint(attacker: Player, target: Target) {
  const dx = target.x - attacker.x;
  const dz = target.z - attacker.z;
  const dist = Math.hypot(dx, dz) || 1;
  const r = targetRadius(target);
  // walk to the edge of bulky obstacles (rock surface + agent), normal spacing otherwise
  const stand = r > 0 ? r + AGENT_RADIUS + 0.3 : ATTACK_RANGE * 0.7;
  return {
    x: target.x - (dx / dist) * stand,
    z: target.z - (dz / dist) * stand,
  };
}

/** Client requested an attack on `targetId`: remember it and path into range. */
export function handleAttack(
  state: GameState,
  attackerId: string,
  targetId: string,
) {
  const attacker = state.players.get(attackerId);
  if (!attacker || attacker.state === AnimState.DEAD) return;
  if (attackerId === targetId) return;

  const target = resolveTarget(state, targetId);
  if (!target || target.hp <= 0) return;

  attacker.attackTargetId = targetId;
  const ap = approachPoint(attacker, target);
  setDestination(attacker, ap.x, ap.z);
}

/**
 * Drives all timed combat states (ATTACK windup, HIT reaction, DEAD/respawn) and
 * triggers auto-attacks when an attacker is in range and off cooldown.
 */
export function combatSystem(
  state: GameState,
  dt: number,
  emitDamage: EmitDamage,
  emitKill: EmitKill,
  emitXp: EmitXp,
  emitHeal?: EmitHeal,
  repairInventory?: RepairInventory,
) {
  const dtMs = dt * 1000;

  state.players.forEach((p) => {
    if (p.attackCooldown > 0) p.attackCooldown -= dtMs;

    switch (p.state) {
      case AnimState.ATTACK:
        p.stateTimer -= dtMs;
        if (p.stateTimer <= 0) {
          connectHit(state, p, emitDamage, emitKill, emitXp, emitHeal, repairInventory); // hit lands at the end of the wind-up
          p.state = AnimState.IDLE;
        }
        return;

      case AnimState.THROW:
        p.stateTimer -= dtMs; // rooted through the banana-throw (pitch) animation
        if (p.stateTimer <= 0) p.state = AnimState.IDLE;
        return;

      case AnimState.HIT:
        p.stateTimer -= dtMs;
        if (p.stateTimer <= 0) p.state = AnimState.IDLE;
        return;

      case AnimState.DEAD:
        p.respawnTimer -= dtMs;
        if (p.respawnTimer <= 0) respawnPlayer(p);
        return;
    }

    // Not busy: pursue / swing at a queued target.
    if (p.attackTargetId) {
      const target = resolveTarget(state, p.attackTargetId);
      if (!target || target.hp <= 0) {
        p.attackTargetId = "";
        return;
      }
      if (target instanceof House && (target.hp >= target.maxHp || !repairInventory?.hasWood(p.id))) {
        p.attackTargetId = "";
        return;
      }
      const dx = target.x - p.x;
      const dz = target.z - p.z;
      const dist = Math.hypot(dx, dz);
      if (dist <= attackReach(target)) {
        if (p.attackCooldown <= 0) {
          p.rotY = Math.atan2(dx, dz);
          p.state = AnimState.ATTACK;
          p.stateTimer = ATTACK_WINDUP_MS;
          p.attackCooldown = ATTACK_COOLDOWN_MS;
          p.pendingHitId = p.attackTargetId;
        }
      } else if (p.path.length === 0) {
        // Arrived but still out of range (e.g. approach point was relocated) —
        // recompute a path that closes the remaining distance.
        const ap = approachPoint(p, target);
        setDestination(p, ap.x, ap.z);
      }
    }
  });

  // Enemy HIT/DEAD/brain timers are owned by goblinAiSystem, which now drives all
  // enemy brains (idle dummies included).
}

/** Apply damage from a completed swing, if the target is still valid and in range. */
function connectHit(
  state: GameState,
  attacker: Player,
  emitDamage: EmitDamage,
  emitKill: EmitKill,
  emitXp: EmitXp,
  emitHeal?: EmitHeal,
  repairInventory?: RepairInventory,
) {
  const targetId = attacker.pendingHitId;
  attacker.pendingHitId = "";
  if (!targetId) return;

  const target = resolveTarget(state, targetId);
  if (!target || target.hp <= 0) return;
  if (!(target instanceof House) && isImmune(target)) return; // Dev Mode: an immortal player takes no damage

  const dx = target.x - attacker.x;
  const dz = target.z - attacker.z;
  if (Math.hypot(dx, dz) > attackReach(target) * 1.35) return; // target dodged out of range

  if (target instanceof House) {
    if (target.hp >= target.maxHp) return;
    if (!repairInventory?.consumeWood(attacker.id)) return;
    const roll = HOUSE_REPAIR_MIN_HP + Math.floor(Math.random() * (HOUSE_REPAIR_MAX_HP - HOUSE_REPAIR_MIN_HP + 1));
    const amount = Math.min(roll, target.maxHp - target.hp);
    if (amount <= 0) return;
    target.hp += amount;
    emitHeal?.({ targetId, amount });
    return;
  }

  const { amount, crit } = rollDamage(attacker, target);
  target.hp = Math.max(0, target.hp - amount);
  emitDamage({ targetId, amount, crit });

  // Trees get cut, rocks get mined (the client shakes them via the damage event).
  const tree = state.trees.get(targetId);
  if (tree) {
    // every chop has a chance to shake a banana loose
    if (Math.random() < TREE_BANANA_DROP_CHANCE) spawnBanana(state, tree.x, tree.z);
    onTreeDamaged(state, tree, amount); // progressive-drop trees shed as they're chopped
    if (tree.hp <= 0) {
      onTreeCut(state, tree); // kill-drop trees yield their full amount here
      grantXp(attacker, killXp(state, targetId), emitXp); // felling a tree grants XP
    }
    return;
  }
  const rock = state.rocks.get(targetId);
  if (rock) {
    onRockDamaged(state, rock, amount); // progressive-drop rocks shed items while mined
    if (rock.hp <= 0) {
      onRockMined(state, rock); // kill-drop rocks yield their full amount here
      grantXp(attacker, killXp(state, targetId), emitXp); // mining a rock grants XP
    }
    return;
  }

  const pe = target as Player | Enemy;
  const enemyTarget = state.enemies.get(targetId);
  const characterKind = enemyTarget?.kind ?? (state.players.has(targetId) ? "player" : "enemy");
  const characterModelId = enemyTarget?.modelId;
  applyDamageDrops(
    state,
    pe,
    characterKind,
    targetId,
    characterModelId,
    pe.x,
    pe.z,
    pe.maxHp,
    amount,
    1.2,
  );
  if (crit) applyKnockback(pe, attacker.x, attacker.z); // a crit blows the target back
  if (pe.hp <= 0) {
    pe.state = AnimState.DEAD;
    if (state.players.has(targetId)) {
      pe.respawnTimer = PLAYER_RESPAWN_MS;
      applyDeathXpPenalty(pe as Player); // dying costs 30% of XP (can de-level)
      emitKill({
        killerId: attacker.id,
        killerName: attacker.name || "Player",
        killerKind: "player",
        victimId: targetId,
        victimName: (pe as Player).name || "Player",
      });
    } else
      pe.respawnTimer =
        state.enemies.get(targetId)?.kind === "goblin"
          ? GOBLIN_RESPAWN_MS
          : DUMMY_RESPAWN_MS;
    grantXp(attacker, killXp(state, targetId), emitXp); // the killer gains XP
    dropEntityLoot(state, characterKind, targetId, characterModelId, pe.x, pe.z, 1.2);
  } else if (pe.state !== AnimState.ATTACK && pe.state !== AnimState.THROW) {
    // hurt animation — but a hit never interrupts an attack/throw in progress
    pe.state = AnimState.HIT;
    pe.stateTimer = HIT_STATE_MS;
  }
}

/** A crit knocks the struck character back, away from the attacker — a hard shove
 *  to a free spot. Clears a player's path so they don't instantly stroll back;
 *  goblins just resume their march from the new spot. The client lerps to the new
 *  position, so it reads as a fast slide. */
function applyKnockback(target: Player | Enemy, fromX: number, fromZ: number) {
  const dx = target.x - fromX;
  const dz = target.z - fromZ;
  const len = Math.hypot(dx, dz);
  if (len < 1e-3) return; // attacker on top of target → no direction to shove
  const spot = nearestFreeWorld(
    clampToWorld(target.x + (dx / len) * CRIT_KNOCKBACK_DISTANCE),
    clampToWorld(target.z + (dz / len) * CRIT_KNOCKBACK_DISTANCE),
  );
  target.x = spot.x;
  target.z = spot.z;
  if ("path" in target) {
    const p = target as Player;
    p.path = [];
    p.pathIndex = 0;
    p.targetX = spot.x;
    p.targetZ = spot.z;
  }
}

function respawnPlayer(p: Player) {
  p.hp = p.maxHp; // full heal, keeping any maxHp gained from leveling up
  const angle = Math.random() * Math.PI * 2;
  const r = 12 + Math.random() * 4; // spawn clear of the centre-cross goblin's reach
  placeAtFreeSpot(p, Math.cos(angle) * r, Math.sin(angle) * r);
  p.state = AnimState.IDLE;
  p.attackTargetId = "";
  p.pendingHitId = "";
  p.stateTimer = 0;
}

/** Clamp a requested move target to the playable area. */
export function clampToWorld(v: number): number {
  return Math.max(-WORLD_SIZE, Math.min(WORLD_SIZE, v));
}
