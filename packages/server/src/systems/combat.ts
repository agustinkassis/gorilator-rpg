import {
  GameState,
  Player,
  Enemy,
  Tree,
  Rock,
  AnimState,
  DamageEvent,
  ATTACK_RANGE,
  ATTACK_COOLDOWN_MS,
  ATTACK_WINDUP_MS,
  ATTACK_VARIANCE,
  ARMOR_K,
  CRIT_MULTIPLIER,
  DAMAGE_DIVISOR,
  HIT_STATE_MS,
  PLAYER_RESPAWN_MS,
  DUMMY_RESPAWN_MS,
  GOBLIN_RESPAWN_MS,
  DUMMY_MAX_HP,
  DUMMY_ATTACK,
  DUMMY_ARMOR,
  DUMMY_CRIT_CHANCE,
  DUMMY_LEVEL,
  WORLD_SIZE,
  AGENT_RADIUS,
  TREE_BANANA_DROP_CHANCE,
  statsForLevel,
} from "@rpg/shared";
import { setDestination, placeAtFreeSpot } from "./movement";
import { onTreeCut, onRockMined } from "./resources";
import { grantXp, killXp, EmitXp } from "./leveling";
import { spawnBanana } from "./bananas";

/** Anything that can be attacked (player, enemy, tree, or rock). All have hp + armor. */
type Damageable = Player | Enemy | Tree | Rock;

/** Sink for damage events so the room can broadcast floating numbers to clients. */
export type EmitDamage = (ev: DamageEvent) => void;

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
  if (crit) dmg *= CRIT_MULTIPLIER;
  return { amount: Math.max(1, Math.round(dmg / DAMAGE_DIVISOR)), crit };
}

const DUMMY_SPOTS = [
  { x: 6, z: 0 },
  { x: -6, z: 4 },
  { x: 1, z: -7 },
];

export function spawnDummies(state: GameState) {
  const s = statsForLevel(
    { maxHp: DUMMY_MAX_HP, attack: DUMMY_ATTACK, armor: DUMMY_ARMOR, critChance: DUMMY_CRIT_CHANCE },
    DUMMY_LEVEL,
  );
  DUMMY_SPOTS.forEach((spot, i) => {
    const e = new Enemy();
    e.id = `dummy-${i}`;
    e.kind = "dummy";
    e.level = DUMMY_LEVEL;
    e.x = spot.x;
    e.z = spot.z;
    e.hp = s.maxHp;
    e.maxHp = s.maxHp;
    e.attack = s.attack;
    e.armor = s.armor;
    e.critChance = s.critChance;
    e.rotY = Math.atan2(-spot.x, -spot.z); // face roughly toward the centre
    state.enemies.set(e.id, e);
  });
}

function resolveTarget(state: GameState, id: string): Damageable | undefined {
  return (
    state.players.get(id) ??
    state.enemies.get(id) ??
    state.trees.get(id) ??
    state.rocks.get(id)
  );
}

/** Bulky targets (rocks) carry a collision radius — you hit them from the surface,
 *  not the centre, so the reach must include it. Other targets are points. */
function targetRadius(t: Damageable): number {
  const r = (t as { radius?: number }).radius;
  return typeof r === "number" ? r : 0;
}

/** How close to a target's centre you can land a hit (its surface + melee reach). */
function attackReach(t: Damageable): number {
  return ATTACK_RANGE + targetRadius(t);
}

/** A point just outside the target to walk toward (right up to bulky rocks). */
function approachPoint(attacker: Player, target: Damageable) {
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
  emitXp: EmitXp,
) {
  const dtMs = dt * 1000;

  state.players.forEach((p) => {
    if (p.attackCooldown > 0) p.attackCooldown -= dtMs;

    switch (p.state) {
      case AnimState.ATTACK:
        p.stateTimer -= dtMs;
        if (p.stateTimer <= 0) {
          connectHit(state, p, emitDamage, emitXp); // damage lands at the end of the wind-up
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

  // Dummies just tick their reaction / respawn timers. Goblins have their own
  // AI (goblinAiSystem) that owns their HIT/DEAD/respawn, so skip them here.
  state.enemies.forEach((e) => {
    if (e.kind === "goblin") return;
    if (e.state === AnimState.HIT) {
      e.stateTimer -= dtMs;
      if (e.stateTimer <= 0 && e.hp > 0) e.state = AnimState.IDLE;
    } else if (e.state === AnimState.DEAD) {
      e.respawnTimer -= dtMs;
      if (e.respawnTimer <= 0) {
        e.hp = e.maxHp;
        e.state = AnimState.IDLE;
      }
    }
  });
}

/** Apply damage from a completed swing, if the target is still valid and in range. */
function connectHit(
  state: GameState,
  attacker: Player,
  emitDamage: EmitDamage,
  emitXp: EmitXp,
) {
  const targetId = attacker.pendingHitId;
  attacker.pendingHitId = "";
  if (!targetId) return;

  const target = resolveTarget(state, targetId);
  if (!target || target.hp <= 0) return;

  const dx = target.x - attacker.x;
  const dz = target.z - attacker.z;
  if (Math.hypot(dx, dz) > attackReach(target) * 1.35) return; // target dodged out of range

  const { amount, crit } = rollDamage(attacker, target);
  target.hp = Math.max(0, target.hp - amount);
  emitDamage({ targetId, amount, crit });

  // Trees get cut, rocks get mined (the client shakes them via the damage event).
  const tree = state.trees.get(targetId);
  if (tree) {
    // every chop has a chance to shake a banana loose
    if (Math.random() < TREE_BANANA_DROP_CHANCE) spawnBanana(state, tree.x, tree.z);
    if (tree.hp <= 0) {
      onTreeCut(state, tree);
      grantXp(attacker, killXp(state, targetId), emitXp); // felling a tree grants XP
    }
    return;
  }
  const rock = state.rocks.get(targetId);
  if (rock) {
    if (rock.hp <= 0) {
      onRockMined(state, rock);
      grantXp(attacker, killXp(state, targetId), emitXp); // mining a rock grants XP
    }
    return;
  }

  const pe = target as Player | Enemy;
  if (pe.hp <= 0) {
    pe.state = AnimState.DEAD;
    if (state.players.has(targetId)) pe.respawnTimer = PLAYER_RESPAWN_MS;
    else
      pe.respawnTimer =
        state.enemies.get(targetId)?.kind === "goblin"
          ? GOBLIN_RESPAWN_MS
          : DUMMY_RESPAWN_MS;
    grantXp(attacker, killXp(state, targetId), emitXp); // the killer gains XP
  } else if (pe.state !== AnimState.ATTACK && pe.state !== AnimState.THROW) {
    // hurt animation — but a hit never interrupts an attack/throw in progress
    pe.state = AnimState.HIT;
    pe.stateTimer = HIT_STATE_MS;
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
