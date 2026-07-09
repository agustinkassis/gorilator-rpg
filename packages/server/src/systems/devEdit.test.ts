import { GameState } from "@rpg/shared";
import { describe, expect, it } from "vitest";
import { devDelete, devMove, devSet, devSpawn } from "./devEdit";

describe("devEdit resource spawns", () => {
  it("spawns bushes as tree-backed resources with bush defaults", () => {
    const state = new GameState();

    const spawned = devSpawn(state, "bush", "test-bush", 2, 3);

    expect(spawned).toEqual({ kind: "bush", id: "test-bush" });
    const bush = state.trees.get("test-bush");
    expect(bush?.kind).toBe("bush");
    expect(bush?.maxHp).toBe(24);
    expect(bush?.alive).toBe(true);

    expect(devMove(state, "bush", "test-bush", 4, 5)).toBe(true);
    expect(bush?.x).toBe(4);
    expect(bush?.z).toBe(5);

    expect(devSet(state, "bush", "test-bush", "maxHp", 30)).toBe(true);
    expect(bush?.maxHp).toBe(30);

    expect(devDelete(state, "bush", "test-bush")).toBe(true);
    expect(state.trees.has("test-bush")).toBe(false);
  });
});
