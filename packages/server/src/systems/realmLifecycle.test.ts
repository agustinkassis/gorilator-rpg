import {
  AnimState,
  PLAYER_MAX_HUNGER,
  PLAYER_MAX_STAMINA,
  RESPAWN_HUNGER_FRACTION,
  Player,
} from "@rpg/shared";
import { describe, expect, it } from "vitest";
import { devTuningDefaults } from "./devTuning";
import { resetPlayerForNewRealm } from "./realmLifecycle";

// resetPlayerForNewRealm is the extracted per-player half of startNewRealm().
// persist=false is a characterization of the original full-wipe block;
// persist=true is the new default where progression survives the realm reset.

/** A mid-run veteran: leveled stats, an active berserker-adjacent mess of
 *  realm-scoped state, currently dead. */
function makeVeteran(): Player {
  const p = new Player();
  p.id = "p1";
  p.level = 7;
  p.xp = 123;
  p.maxHp = 500;
  p.hp = 42;
  p.attack = 90;
  p.armor = 40;
  p.critChance = 0.4;
  p.moveSpeed = 6.9;
  p.throwPower = 1.9;
  p.maxStamina = PLAYER_MAX_STAMINA;
  p.stamina = 3;
  p.maxHunger = PLAYER_MAX_HUNGER;
  p.hunger = 2;
  p.godMode = true;
  p.berserkerMs = 5000;
  p.critMultiplier = 5;
  p.sprinting = true;
  p.sprintHeld = true;
  p.exhausted = true;
  p.staminaRegen = 0.5;
  p.attackCooldown = 100;
  p.stateTimer = 10;
  p.respawnTimer = 1000;
  p.attackTargetId = "g1";
  p.pendingHitId = "g1";
  p.pickupTargetId = "i1";
  p.deaths = 3;
  p.state = AnimState.DEAD;
  p.prevDead = true;
  return p;
}

/** The realm-scoped cleanup both branches must perform. */
function expectRealmStateCleared(p: Player): void {
  expect(p.stamina).toBe(PLAYER_MAX_STAMINA);
  expect(p.maxStamina).toBe(PLAYER_MAX_STAMINA);
  expect(p.hunger).toBeGreaterThanOrEqual(p.maxHunger * RESPAWN_HUNGER_FRACTION);
  expect(p.godMode).toBe(false);
  expect(p.berserkerMs).toBe(0);
  expect(p.critMultiplier).toBe(0);
  expect(p.sprinting).toBe(false);
  expect(p.sprintHeld).toBe(false);
  expect(p.exhausted).toBe(false);
  expect(p.staminaRegen).toBe(0);
  expect(p.attackCooldown).toBe(0);
  expect(p.stateTimer).toBe(0);
  expect(p.respawnTimer).toBe(0);
  expect(p.attackTargetId).toBe("");
  expect(p.pendingHitId).toBe("");
  expect(p.pickupTargetId).toBe("");
  expect(p.deaths).toBe(0);
  expect(p.hp).toBe(p.maxHp);
  expect(p.state).toBe(AnimState.IDLE);
  expect(p.prevDead).toBe(false);
}

describe("resetPlayerForNewRealm — persist=true (new default)", () => {
  it("keeps progression and refreshes realm-scoped state", () => {
    const p = makeVeteran();
    resetPlayerForNewRealm(p, true, devTuningDefaults);
    expect(p.level).toBe(7);
    expect(p.xp).toBe(123);
    expect(p.maxHp).toBe(500);
    expect(p.attack).toBe(90);
    expect(p.armor).toBe(40);
    expect(p.critChance).toBe(0.4);
    expect(p.moveSpeed).toBe(6.9);
    expect(p.throwPower).toBe(1.9);
    expectRealmStateCleared(p);
  });
});

describe("resetPlayerForNewRealm — persist=false (legacy wipe, characterization)", () => {
  it("resets to a level-1 character with tuned base stats", () => {
    const p = makeVeteran();
    resetPlayerForNewRealm(p, false, devTuningDefaults);
    expect(p.level).toBe(1);
    expect(p.xp).toBe(0);
    expect(p.maxHp).toBe(devTuningDefaults.playerMaxHp);
    expect(p.attack).toBe(devTuningDefaults.playerAttack);
    expect(p.armor).toBe(devTuningDefaults.playerArmor);
    expect(p.critChance).toBe(devTuningDefaults.playerCritChance);
    expect(p.moveSpeed).toBe(devTuningDefaults.playerMoveSpeed);
    expect(p.throwPower).toBe(1);
    expectRealmStateCleared(p);
  });

  it("honors live tuning overrides for the fresh character", () => {
    const p = makeVeteran();
    resetPlayerForNewRealm(p, false, { ...devTuningDefaults, playerMaxHp: 250, playerAttack: 99 });
    expect(p.maxHp).toBe(250);
    expect(p.attack).toBe(99);
    expect(p.hp).toBe(250); // refilled to the new max
  });
});
