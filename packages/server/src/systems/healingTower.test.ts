import {
  AnimState,
  GameState,
  type HealEvent,
  Player,
  SACRED_CIRCLE_HEAL_PER_SEC_MAX,
  SACRED_CIRCLE_HEAL_PER_SEC_MIN,
  SACRED_CIRCLE_RADIUS,
} from "@rpg/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sacredCircleHealSystem } from "./healingTower";

// Characterization for the Sacred Circle trickle-heal, extracted verbatim from
// GameRoom so the timeScale audit (#67) can pin it: dt is the SCALED tick delta,
// so a paused world (dt 0) heals nothing, and 2× time heals 2× per wall tick.
// Math.random pinned to 0.5 → healPerSec is exactly the min/max midpoint.

const HEAL_PER_SEC_MID =
  SACRED_CIRCLE_HEAL_PER_SEC_MIN +
  0.5 * (SACRED_CIRCLE_HEAL_PER_SEC_MAX - SACRED_CIRCLE_HEAL_PER_SEC_MIN);

function makePlayer(id: string, hp: number): Player {
  const p = new Player();
  p.id = id;
  p.x = 0;
  p.z = 0;
  p.hp = hp;
  p.maxHp = 100;
  p.state = AnimState.IDLE;
  return p;
}

describe("sacredCircleHealSystem characterization", () => {
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function run(dt: number, hp = 50, tower: { x: number; z: number } | null = { x: 0, z: 0 }) {
    const state = new GameState();
    const p = makePlayer("p1", hp);
    state.players.set("p1", p);
    const carry = new Map<string, number>();
    const heals: HealEvent[] = [];
    sacredCircleHealSystem(state, dt, tower, carry, (ev) => heals.push(ev));
    return { state, p, carry, heals };
  }

  it("heals exactly healPerSec·dt inside the circle", () => {
    const { p } = run(1);
    expect(p.hp).toBeCloseTo(50 + HEAL_PER_SEC_MID, 10);
  });

  it("dt 0 (paused) and missing tower heal nothing", () => {
    expect(run(0).p.hp).toBe(50);
    expect(run(1, 50, null).p.hp).toBe(50);
  });

  it("ignores players outside the radius, dead, or at full HP", () => {
    const { state, p, carry } = run(0); // build a harness, then drive manually
    p.x = SACRED_CIRCLE_RADIUS + 1;
    sacredCircleHealSystem(state, 1, { x: 0, z: 0 }, carry, () => {});
    expect(p.hp).toBe(50);

    p.x = 0;
    p.hp = 100;
    sacredCircleHealSystem(state, 1, { x: 0, z: 0 }, carry, () => {});
    expect(p.hp).toBe(100);

    p.hp = 0;
    sacredCircleHealSystem(state, 1, { x: 0, z: 0 }, carry, () => {});
    expect(p.hp).toBe(0);
  });

  it("accumulates fractional healing into whole-HP popups via the carry map", () => {
    const state = new GameState();
    const p = makePlayer("p1", 50);
    state.players.set("p1", p);
    const carry = new Map<string, number>();
    const heals: HealEvent[] = [];
    const dt = 0.05; // one 20Hz tick
    const perTick = HEAL_PER_SEC_MID * dt;

    let emitted = 0;
    let healedTotal = 0;
    for (let i = 0; i < 40; i++) {
      sacredCircleHealSystem(state, dt, { x: 0, z: 0 }, carry, (ev) => {
        emitted += ev.amount;
        expect(Number.isInteger(ev.amount)).toBe(true);
        heals.push(ev);
      });
      healedTotal += perTick;
    }
    expect(p.hp).toBeCloseTo(50 + healedTotal, 8);
    // Every popup is a whole number and the carry holds the sub-1HP remainder.
    expect(emitted + (carry.get("p1") ?? 0)).toBeCloseTo(healedTotal, 8);
    expect(carry.get("p1")!).toBeLessThan(1);
    expect(heals.length).toBeGreaterThan(0);
  });

  it("clamps the final heal at maxHp", () => {
    const { p } = run(60, 99); // a huge dt would overshoot without the clamp
    expect(p.hp).toBe(100);
  });
});
