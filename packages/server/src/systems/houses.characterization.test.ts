import {
  GameState,
  type HealEvent,
  HOUSE_CENTER,
  HOUSE_COLLISION_RADIUS,
  HOUSE_HP,
  HOUSE_REGEN_FULL_MS,
  HOUSE_REGEN_IDLE_MS,
  House,
} from "@rpg/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { entityHp } from "./entityFeatures";
import { type HouseRegenTimers, houseRegenSystem, noteHouseDamage, spawnHouse } from "./houses";

// Characterization suite for the La Crypta objective (spawn + regen). These
// assertions must pass UNCHANGED after the #73 extraction moves this code into
// plugins/la-crypta-defense — only the import line may change.

function makeHouse(hp: number, maxHp = 300): { state: GameState; house: House } {
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
  return { state, house };
}

describe("house characterization", () => {
  let timers: HouseRegenTimers;
  let heals: HealEvent[];
  const emitHeal = (ev: HealEvent) => heals.push(ev);

  beforeEach(() => {
    timers = new Map();
    heals = [];
  });

  it("spawnHouse stands La Crypta at the map centre with the configured HP", () => {
    const state = new GameState();
    spawnHouse(state);
    const h = state.houses.get("house-0");
    expect(h).toBeDefined();
    expect(h!.x).toBe(HOUSE_CENTER.x);
    expect(h!.z).toBe(HOUSE_CENTER.z);
    expect(h!.radius).toBe(HOUSE_COLLISION_RADIUS);
    // entity-features.json may override the default — pin whatever it resolves to.
    expect(h!.maxHp).toBe(entityHp("house", "house-0", undefined, HOUSE_HP));
    expect(h!.hp).toBe(h!.maxHp);
    expect(h!.alive).toBe(true);
  });

  /** Drive the regen system in realistic 100ms ticks. */
  function run(state: GameState, ms: number) {
    for (let t = 0; t < ms; t += 100) houseRegenSystem(state, 100, timers, emitHeal);
  }

  it("no regen until the idle window elapses; damage resets the window", () => {
    const { state, house } = makeHouse(100);
    run(state, HOUSE_REGEN_IDLE_MS - 100); // right up to the threshold: nothing
    expect(house.hp).toBe(100);

    run(state, 1000); // cross the threshold — healing begins
    expect(house.hp).toBeGreaterThan(100);

    // A fresh hit resets the idle window — healing stops again.
    const healedHp = house.hp;
    noteHouseDamage(state, timers, "house-0");
    run(state, 1000);
    expect(house.hp).toBe(healedHp);
  });

  it("regen rate ramps over time (later seconds heal more than the first)", () => {
    const { state, house } = makeHouse(10, 1000);
    run(state, HOUSE_REGEN_IDLE_MS); // burn the idle window (regen clock barely started)
    const start = house.hp;
    run(state, 2000);
    const firstStretch = house.hp - start;
    run(state, 2000);
    const secondStretch = house.hp - start - firstStretch;
    expect(firstStretch).toBeGreaterThan(0);
    expect(secondStretch).toBeGreaterThan(firstStretch); // the ramp
  });

  it("snaps to full HP once regen has run HOUSE_REGEN_FULL_MS", () => {
    const { state, house } = makeHouse(1, 100_000); // far too much to trickle-heal
    run(state, HOUSE_REGEN_IDLE_MS + HOUSE_REGEN_FULL_MS + 200);
    expect(house.hp).toBe(house.maxHp);
    expect(timers.has("house-0")).toBe(false); // full → timer GC'd
  });

  it("emits integer heal popups that sum to the healed total", () => {
    const { state, house } = makeHouse(100, 1000);
    houseRegenSystem(state, HOUSE_REGEN_IDLE_MS, timers, emitHeal);
    for (let i = 0; i < 50; i++) houseRegenSystem(state, 100, timers, emitHeal);
    const emitted = heals.reduce((sum, ev) => sum + ev.amount, 0);
    for (const ev of heals) {
      expect(ev.targetId).toBe("house-0");
      expect(Number.isInteger(ev.amount)).toBe(true);
    }
    expect(emitted).toBeGreaterThan(0);
    // Whole-number popups; at most 1 HP of carry outstanding vs. the actual heal.
    expect(Math.abs(house.hp - 100 - emitted)).toBeLessThanOrEqual(1);
  });

  it("dead, missing, and indestructible (maxHp 0) houses never regen; timers GC", () => {
    const { state, house } = makeHouse(100, 100_000); // huge pool — no full-heal snap
    run(state, HOUSE_REGEN_IDLE_MS + 1000);
    expect(timers.has("house-0")).toBe(true);

    house.alive = false;
    houseRegenSystem(state, 1000, timers, emitHeal);
    expect(timers.has("house-0")).toBe(false);

    // A timer for a house that no longer exists is swept.
    timers.set("ghost", { idleMs: 0, regenMs: 0, healCarry: 0, emitCarry: 0, emitMs: 0 } as never);
    houseRegenSystem(state, 100, timers, emitHeal);
    expect(timers.has("ghost")).toBe(false);

    const indestructible = makeHouse(0, 0);
    const t2: HouseRegenTimers = new Map();
    houseRegenSystem(indestructible.state, HOUSE_REGEN_IDLE_MS + 5000, t2, emitHeal);
    expect(indestructible.house.hp).toBe(0);
  });

  it("zero/negative delta is a no-op", () => {
    const { state, house } = makeHouse(100);
    houseRegenSystem(state, 0, timers, emitHeal);
    houseRegenSystem(state, -50, timers, emitHeal);
    expect(house.hp).toBe(100);
    expect(timers.size).toBe(0);
  });
});
