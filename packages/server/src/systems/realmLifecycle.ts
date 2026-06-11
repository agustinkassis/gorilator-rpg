import { AnimState, PLAYER_MAX_STAMINA, type Player } from "@rpg/shared";
import type { DevTuningValues } from "./devTuning";

/**
 * Per-player reset when a new realm spins up after a wipe. What survives is the
 * realm policy's call (realm.json `policy.progression.persistAcrossWipes`):
 *
 * - persist=true (default): character progression — level, XP and the stats those
 *   levels granted — carries into the new realm. Only realm-scoped state resets.
 * - persist=false (legacy): back to a brand-new level-1 character with tuned
 *   base stats, exactly the original full-wipe behavior.
 *
 * Realm-scoped state always resets either way: timed buffs, timers, targets, the
 * death tally — and HP/stamina refill so everyone respawns ready to play.
 * Placement (placeAtFreeSpot + facing) stays in GameRoom, which owns the world.
 */
export function resetPlayerForNewRealm(p: Player, persist: boolean, tune: DevTuningValues): void {
  if (!persist) {
    p.level = 1;
    p.xp = 0;
    p.maxHp = tune.playerMaxHp;
    p.attack = tune.playerAttack;
    p.armor = tune.playerArmor;
    p.critChance = tune.playerCritChance;
    p.moveSpeed = tune.playerMoveSpeed;
    p.throwPower = 1;
  }
  p.maxStamina = PLAYER_MAX_STAMINA;
  p.stamina = PLAYER_MAX_STAMINA;
  p.godMode = false;
  p.berserkerMs = 0;
  p.critMultiplier = 0;
  p.sprinting = false;
  p.sprintHeld = false;
  p.exhausted = false;
  p.staminaRegen = 0;
  p.attackCooldown = 0;
  p.stateTimer = 0;
  p.respawnTimer = 0;
  p.attackTargetId = "";
  p.pendingHitId = "";
  p.pickupTargetId = "";
  p.deaths = 0; // fresh realm → reset the death tally
  p.hp = p.maxHp;
  p.state = AnimState.IDLE;
  p.prevDead = false;
}
