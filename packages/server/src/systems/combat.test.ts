import {
  AnimState,
  ARMOR_K,
  ATTACK_RANGE,
  DUMMY_RESPAWN_MS,
  Enemy,
  GameState,
  Player,
  WORLD_SIZE,
} from "@rpg/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clampToWorld, combatSystem, handleAttack, isImmune } from "./combat";
import { devTuning, resetDevTuning } from "./devTuning";
import { installFixedRng } from "./rng";

// Characterization tests for the player-attack flow (queue → windup → connect).
// They pin today's behavior so the plugin-registry refactor of GameRoom/goblins
// can be verified against an unchanged damage pipeline.
// The seeded RNG is pinned to 0.5 (installFixedRng): attack variance = ±0 and
// (with critChance 0) no crits, so the damage roll is exactly
// attack · (1 − armor/(armor+ARMOR_K)) / divisor.

function makePlayer(id: string, x: number, z: number): Player {
  const p = new Player();
  p.id = id;
  p.x = x;
  p.z = z;
  p.hp = 100;
  p.maxHp = 100;
  p.attack = 10;
  p.armor = 0;
  p.critChance = 0;
  p.state = AnimState.IDLE;
  return p;
}

function makeDummy(id: string, x: number, z: number, hp = 50): Enemy {
  const e = new Enemy();
  e.id = id;
  e.kind = "dummy";
  e.x = x;
  e.z = z;
  e.hp = hp;
  e.maxHp = hp;
  e.armor = 10;
  e.attack = 0;
  e.state = AnimState.IDLE;
  return e;
}

function makeState(p: Player, e?: Enemy): GameState {
  const state = new GameState();
  installFixedRng(state, 0.5); // every gameplay roll returns 0.5 — deterministic damage
  state.players.set(p.id, p);
  if (e) state.enemies.set(e.id, e);
  return state;
}

const noop = () => {};

/** Damage a 0.5-pinned, crit-free swing must deal to `armor` with `attack`. */
function expectedDamage(attack: number, armor: number): number {
  const mitigation = armor / (armor + ARMOR_K);
  return Math.max(1, Math.round((attack * (1 - mitigation)) / devTuning().damageDivisor));
}

describe("combat characterization", () => {
  beforeEach(() => {
    resetDevTuning();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("clampToWorld clamps to ±WORLD_SIZE", () => {
    expect(clampToWorld(WORLD_SIZE + 10)).toBe(WORLD_SIZE);
    expect(clampToWorld(-WORLD_SIZE - 10)).toBe(-WORLD_SIZE);
    expect(clampToWorld(3)).toBe(3);
  });

  it("isImmune is true only for god-mode players", () => {
    const p = makePlayer("p1", 0, 10);
    expect(isImmune(p)).toBe(false);
    p.godMode = true;
    expect(isImmune(p)).toBe(true);
    expect(isImmune(makeDummy("e1", 0, 12))).toBe(false);
  });

  it("handleAttack queues the target and walks toward it", () => {
    const p = makePlayer("p1", 0, 10);
    const e = makeDummy("e1", 0, 18);
    const state = makeState(p, e);

    handleAttack(state, "p1", "e1");
    expect(p.attackTargetId).toBe("e1");
    // The approach point sits between the attacker and the target.
    expect(p.targetZ).toBeGreaterThan(10);
    expect(p.targetZ).toBeLessThan(18);
  });

  it("ignores self-attacks, dead attackers, and dead targets", () => {
    const p = makePlayer("p1", 0, 10);
    const e = makeDummy("e1", 0, 12, 0); // already dead
    const state = makeState(p, e);

    handleAttack(state, "p1", "p1");
    expect(p.attackTargetId).toBe("");

    handleAttack(state, "p1", "e1"); // hp <= 0
    expect(p.attackTargetId).toBe("");

    const live = makeDummy("e2", 0, 12);
    state.enemies.set("e2", live);
    p.state = AnimState.DEAD;
    handleAttack(state, "p1", "e2");
    expect(p.attackTargetId).toBe("");
  });

  it("an in-range swing winds up, then lands the exact mitigated damage", () => {
    const p = makePlayer("p1", 0, 10);
    const e = makeDummy("e1", 0, 10 + ATTACK_RANGE * 0.5);
    const state = makeState(p, e);
    p.attackTargetId = "e1";

    const damageEvents: Array<{ targetId: string; amount: number; crit: boolean }> = [];
    const emitDamage = (ev: { targetId: string; amount: number; crit: boolean }) =>
      damageEvents.push(ev);

    // Tick 1: in range + off cooldown → enter ATTACK windup.
    combatSystem(state, 0.05, emitDamage, noop, noop);
    expect(p.state).toBe(AnimState.ATTACK);
    expect(p.stateTimer).toBe(devTuning().playerAttackWindupMs);
    expect(p.attackCooldown).toBe(devTuning().playerAttackCooldownMs);
    expect(damageEvents).toHaveLength(0); // nothing lands during the windup

    // Tick 2: windup elapses → the hit connects.
    combatSystem(state, (devTuning().playerAttackWindupMs + 1) / 1000, emitDamage, noop, noop);
    const expected = expectedDamage(p.attack, e.armor);
    expect(damageEvents).toEqual([{ targetId: "e1", amount: expected, crit: false }]);
    expect(e.hp).toBe(50 - expected);
    expect(p.state).toBe(AnimState.IDLE);
    // The surviving dummy flinches.
    expect(e.state).toBe(AnimState.HIT);
  });

  it("a lethal swing kills the dummy and schedules its respawn", () => {
    const p = makePlayer("p1", 0, 10);
    const e = makeDummy("e1", 0, 10 + ATTACK_RANGE * 0.5, 1);
    const state = makeState(p, e);
    p.attackTargetId = "e1";

    const kills: unknown[] = [];
    combatSystem(state, 0.05, noop, (ev) => kills.push(ev), noop);
    combatSystem(state, (devTuning().playerAttackWindupMs + 1) / 1000, noop, (ev) => kills.push(ev), noop);

    expect(e.hp).toBe(0);
    expect(e.state).toBe(AnimState.DEAD);
    expect(e.respawnTimer).toBe(DUMMY_RESPAWN_MS);
    // Kill broadcasts are only emitted for player victims.
    expect(kills).toHaveLength(0);
  });

  it("drops the queued target once it dies", () => {
    const p = makePlayer("p1", 0, 10);
    const e = makeDummy("e1", 0, 12, 0);
    const state = makeState(p, e);
    p.attackTargetId = "e1";

    combatSystem(state, 0.05, noop, noop, noop);
    expect(p.attackTargetId).toBe("");
    expect(p.state).toBe(AnimState.IDLE);
  });
});
