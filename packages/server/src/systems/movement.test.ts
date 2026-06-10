import {
  AnimState,
  ARRIVE_THRESHOLD,
  GameState,
  HOUSE_RADIUS,
  MOVE_SPEED,
  OBSTACLES,
  Player,
} from "@rpg/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { devTuning, resetDevTuning } from "./devTuning";
import { ghostMovementSystem, movementSystem, placeAtFreeSpot, setDestination } from "./movement";

// Characterization of the movement pipeline (waypoints, sprint, ghost mode,
// spawn keep-out). The boulder field is deterministic, so a scanned free spot
// is stable across runs.

/** Find a spot whose 6-unit neighbourhood is clear of every collision circle. */
function freeSpot(): { x: number; z: number } {
  for (let x = 14; x < 60; x += 1) {
    for (let z = 14; z < 60; z += 1) {
      const clear = OBSTACLES.every((o) => Math.hypot(o.x - x, o.z - z) > o.radius + 8);
      if (clear) return { x, z };
    }
  }
  throw new Error("no free spot found — did the obstacle layout change?");
}

function makePlayer(id: string, x: number, z: number): Player {
  const p = new Player();
  p.id = id;
  p.x = x;
  p.z = z;
  p.hp = 100;
  p.maxHp = 100;
  p.moveSpeed = 0; // 0 → movementSystem falls back to MOVE_SPEED
  p.state = AnimState.IDLE;
  return p;
}

function makeState(p: Player): GameState {
  const state = new GameState();
  state.players.set(p.id, p);
  return state;
}

describe("movementSystem", () => {
  beforeEach(() => resetDevTuning());

  it("does nothing while paused (dt <= 0)", () => {
    const spot = freeSpot();
    const p = makePlayer("p1", spot.x, spot.z);
    p.path = [{ x: spot.x + 5, z: spot.z }];
    p.pathIndex = 0;
    movementSystem(makeState(p), 0);
    expect(p.x).toBe(spot.x);
    expect(p.state).toBe(AnimState.IDLE);
  });

  it("walks toward the current waypoint at MOVE_SPEED and faces it", () => {
    const spot = freeSpot();
    const p = makePlayer("p1", spot.x, spot.z);
    p.path = [{ x: spot.x + 5, z: spot.z }];
    p.pathIndex = 0;

    movementSystem(makeState(p), 0.1);
    expect(p.x).toBeCloseTo(spot.x + MOVE_SPEED * 0.1, 5);
    expect(p.z).toBeCloseTo(spot.z, 5);
    expect(p.state).toBe(AnimState.WALK);
    expect(p.rotY).toBeCloseTo(Math.atan2(5, 0), 5);
  });

  it("sprinting multiplies the step by the sprint speed multiplier", () => {
    const spot = freeSpot();
    const p = makePlayer("p1", spot.x, spot.z);
    p.path = [{ x: spot.x + 5, z: spot.z }];
    p.pathIndex = 0;
    p.sprinting = true;

    movementSystem(makeState(p), 0.1);
    expect(p.x).toBeCloseTo(spot.x + MOVE_SPEED * devTuning().sprintSpeedMult * 0.1, 5);
  });

  it("busy players (ATTACK/HIT/DEAD) don't walk", () => {
    const spot = freeSpot();
    for (const busy of [AnimState.ATTACK, AnimState.HIT, AnimState.DEAD]) {
      const p = makePlayer("p1", spot.x, spot.z);
      p.path = [{ x: spot.x + 5, z: spot.z }];
      p.pathIndex = 0;
      p.state = busy;
      movementSystem(makeState(p), 0.1);
      expect(p.x).toBeCloseTo(spot.x, 5);
      expect(p.state).toBe(busy);
    }
  });

  it("arriving inside ARRIVE_THRESHOLD finishes the path and idles", () => {
    const spot = freeSpot();
    const p = makePlayer("p1", spot.x, spot.z);
    p.state = AnimState.WALK;
    p.path = [{ x: spot.x + ARRIVE_THRESHOLD * 0.5, z: spot.z }];
    p.pathIndex = 0;

    movementSystem(makeState(p), 0.1);
    expect(p.path).toEqual([]);
    expect(p.pathIndex).toBe(0);
    expect(p.state).toBe(AnimState.IDLE);
  });
});

describe("ghostMovementSystem (Dev-Mode pause free-roam)", () => {
  it("glides an alive player straight toward its target at 3× speed", () => {
    const spot = freeSpot();
    const p = makePlayer("p1", spot.x, spot.z);
    p.targetX = spot.x + 50;
    p.targetZ = spot.z;

    ghostMovementSystem(makeState(p), 0.1);
    expect(p.x).toBeCloseTo(spot.x + MOVE_SPEED * 3 * 0.1, 5);
  });

  it("never moves dead players", () => {
    const spot = freeSpot();
    const p = makePlayer("p1", spot.x, spot.z);
    p.state = AnimState.DEAD;
    p.targetX = spot.x + 50;
    p.targetZ = spot.z;

    ghostMovementSystem(makeState(p), 0.1);
    expect(p.x).toBe(spot.x);
  });
});

describe("pathing helpers", () => {
  it("setDestination produces a path whose end becomes the move target", () => {
    const spot = freeSpot();
    const p = makePlayer("p1", spot.x, spot.z);
    setDestination(p, spot.x + 6, spot.z);
    expect(p.path.length).toBeGreaterThan(0);
    const last = p.path[p.path.length - 1];
    expect(p.targetX).toBe(last.x);
    expect(p.targetZ).toBe(last.z);
    expect(p.pathIndex).toBe(0);
  });

  it("placeAtFreeSpot never leaves a player inside the house footprint", () => {
    // Regression for the "spawned inside the house" bug: requesting the exact
    // centre of the house must relocate to a clear spot outside its radius.
    const p = makePlayer("p1", 0, 0);
    placeAtFreeSpot(p, 0, 0);
    expect(Math.hypot(p.x, p.z)).toBeGreaterThanOrEqual(HOUSE_RADIUS);
    expect(p.path).toEqual([]);
    expect(p.prevX).toBe(p.x);
    expect(p.prevZ).toBe(p.z);
  });

  it("placeAtFreeSpot preserves an already-free requested spot exactly", () => {
    const spot = freeSpot();
    const p = makePlayer("p1", 0, 0);
    placeAtFreeSpot(p, spot.x, spot.z);
    expect(p.x).toBeCloseTo(spot.x, 5);
    expect(p.z).toBeCloseTo(spot.z, 5);
  });
});
