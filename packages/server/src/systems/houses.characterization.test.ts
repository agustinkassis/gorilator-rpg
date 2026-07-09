import {
  GameState,
  type HealEvent,
  HOUSE_COLLISION_RADIUS,
  HOUSE_REGEN_FULL_MS,
  HOUSE_REGEN_IDLE_MS,
  HOUSE_REGEN_MAX_PER_SEC,
  House,
} from "@rpg/shared";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type HouseRegenTimers,
  houseRegenSystem,
  noteHouseDamage,
  timersFor,
} from "../../../../plugins/la-crypta-defense/src/house";

// Characterization suite for the La Crypta regen — written against the
// pre-extraction core (systems/houses.ts) and preserved VERBATIM in its
// assertions across the #73 move into plugins/la-crypta-defense. (The house
// SPAWN parity is pinned in waves.characterization.test.ts through the real
// event runtime, since HP now resolves via the host's spawnStructure.)

function makeHouse(hp: number, maxHp = 300): { state: GameState; house: House; timers: HouseRegenTimers } {
  const state = new GameState();
  const house = new House();
  house.id = "house-0";
  house.x = 0;
  house.z = 0;
  house.radius = HOUSE_COLLISION_RADIUS;
  house.maxHp = maxHp;
  house.hp = hp;
  house.alive = true;
  state.houses.set(house.id, house);
  return { state, house, timers: timersFor(state) };
}

describe("house regen characterization", () => {
  let heals: HealEvent[];
  const emitHeal = (ev: HealEvent) => heals.push(ev);

  beforeEach(() => {
    heals = [];
  });

  /** Drive the regen system in realistic 100ms ticks. */
  function run(state: GameState, timers: HouseRegenTimers, ms: number) {
    for (let t = 0; t < ms; t += 100) houseRegenSystem(state, 100, timers, emitHeal);
  }

  it("no regen until the idle window elapses; damage resets the window", () => {
    const { state, house, timers } = makeHouse(100);
    run(state, timers, HOUSE_REGEN_IDLE_MS - 100); // right up to the threshold: nothing
    expect(house.hp).toBe(100);

    run(state, timers, 1000); // cross the threshold — healing begins
    expect(house.hp).toBeGreaterThan(100);

    // A fresh hit resets the idle window — healing stops again. (noteHouseDamage
    // is wired to the host's entity:damaged chokepoint; same semantics as the
    // old direct call, 0-damage pokes included.)
    const healedHp = house.hp;
    noteHouseDamage(state, "house-0");
    run(state, timers, 1000);
    expect(house.hp).toBe(healedHp);
  });

  it("regen rate ramps over time (later seconds heal more than the first)", () => {
    const { state, house, timers } = makeHouse(10, 1000);
    run(state, timers, HOUSE_REGEN_IDLE_MS); // burn the idle window (regen clock barely started)
    const start = house.hp;
    run(state, timers, 2000);
    const firstStretch = house.hp - start;
    run(state, timers, 2000);
    const secondStretch = house.hp - start - firstStretch;
    expect(firstStretch).toBeGreaterThan(0);
    expect(secondStretch).toBeGreaterThan(firstStretch); // the ramp
  });

  it("snaps to full HP once regen has run HOUSE_REGEN_FULL_MS", () => {
    const { state, house, timers } = makeHouse(1, 100_000); // far too much to trickle-heal
    run(state, timers, HOUSE_REGEN_IDLE_MS + HOUSE_REGEN_FULL_MS + 200);
    expect(house.hp).toBe(house.maxHp);
    expect(timers.has("house-0")).toBe(false); // full → timer GC'd
  });

  it("emits integer heal popups that sum to the healed total", () => {
    const { state, house, timers } = makeHouse(100, 1000);
    run(state, timers, HOUSE_REGEN_IDLE_MS);
    for (let i = 0; i < 50; i++) houseRegenSystem(state, 100, timers, emitHeal);
    const emitted = heals.reduce((sum, ev) => sum + ev.amount, 0);
    for (const ev of heals) {
      expect(ev.targetId).toBe("house-0");
      expect(Number.isInteger(ev.amount)).toBe(true);
    }
    expect(emitted).toBeGreaterThan(0);
    // Popups batch ~1/s: the outstanding remainder is at most one un-flushed
    // emit window (≤ max rate · 1s) plus the sub-1HP fractional carry.
    const residual = house.hp - 100 - emitted;
    expect(residual).toBeGreaterThanOrEqual(0);
    expect(residual).toBeLessThanOrEqual(HOUSE_REGEN_MAX_PER_SEC + 1);
  });

  it("dead, missing, and indestructible (maxHp 0) houses never regen; timers GC", () => {
    const { state, house, timers } = makeHouse(100, 100_000); // huge pool — no full-heal snap
    run(state, timers, HOUSE_REGEN_IDLE_MS + 1000);
    expect(timers.has("house-0")).toBe(true);

    house.alive = false;
    houseRegenSystem(state, 1000, timers, emitHeal);
    expect(timers.has("house-0")).toBe(false);

    // A timer for a house that no longer exists is swept.
    timers.set("ghost", { idleMs: 0, regenMs: 0, healCarry: 0, emitCarry: 0, emitMs: 0 } as never);
    houseRegenSystem(state, 100, timers, emitHeal);
    expect(timers.has("ghost")).toBe(false);

    const indestructible = makeHouse(0, 0);
    houseRegenSystem(indestructible.state, HOUSE_REGEN_IDLE_MS + 5000, indestructible.timers, emitHeal);
    expect(indestructible.house.hp).toBe(0);
  });

  it("zero/negative delta is a no-op", () => {
    const { state, house, timers } = makeHouse(100);
    houseRegenSystem(state, 0, timers, emitHeal);
    houseRegenSystem(state, -50, timers, emitHeal);
    expect(house.hp).toBe(100);
    expect(timers.size).toBe(0);
  });
});
