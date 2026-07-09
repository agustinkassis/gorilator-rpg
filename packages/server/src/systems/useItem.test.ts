import {
  AnimState,
  BERSERKER_ARMOR_MULT,
  BERSERKER_CRIT_CHANCE_ADD,
  BERSERKER_CRIT_DAMAGE_MULT,
  BERSERKER_HP_MULT,
  BERSERKER_SPEED_MULT,
  CRIT_MULTIPLIER,
  GameState,
  type InventorySlot,
  POTION_HEAL,
  Player,
} from "@rpg/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { devTuning, resetDevTuning } from "./devTuning";
import { serverPluginHost } from "./plugins/host";
import { type BerserkerBase, type UseItemDeps, useItemFromSlot } from "./useItem";

// Characterization tests for the use_item flow, extracted verbatim from the
// GameRoom message handler so the bot driver can consume items headlessly.
// They pin today's behavior: plugin dispatch precedence, potion heal clamping,
// and the berserker buff's base-stat snapshot / no-stack rules.

function makePlayer(id: string): Player {
  const p = new Player();
  p.id = id;
  p.hp = 50;
  p.maxHp = 100;
  p.attack = 10;
  p.armor = 4;
  p.critChance = 0.1;
  p.critMultiplier = 0;
  p.moveSpeed = 5;
  p.state = AnimState.IDLE;
  return p;
}

interface Harness {
  state: GameState;
  p: Player;
  inv: InventorySlot[];
  deps: UseItemDeps;
  berserkerBase: Map<string, BerserkerBase>;
  broadcasts: Array<{ type: string; payload: unknown }>;
  inventorySends: string[];
}

function makeHarness(slots: InventorySlot[]): Harness {
  const state = new GameState();
  const p = makePlayer("p1");
  state.players.set("p1", p);
  const inv = slots;
  const berserkerBase = new Map<string, BerserkerBase>();
  const broadcasts: Array<{ type: string; payload: unknown }> = [];
  const inventorySends: string[] = [];
  const deps: UseItemDeps = {
    inventories: new Map([["p1", inv]]),
    berserkerBase,
    sendInventory: (sid) => inventorySends.push(sid),
    broadcast: (type, payload) => broadcasts.push({ type, payload }),
  };
  return { state, p, inv, deps, berserkerBase, broadcasts, inventorySends };
}

describe("useItemFromSlot characterization", () => {
  beforeEach(() => {
    resetDevTuning();
  });
  afterEach(() => {
    serverPluginHost.reset();
    vi.restoreAllMocks();
  });

  it("potion heals min(POTION_HEAL, missing hp), consumes, broadcasts, syncs", () => {
    const h = makeHarness([{ type: "potion", count: 2 }]);
    useItemFromSlot(h.state, "p1", 0, h.deps);
    const heal = Math.min(POTION_HEAL, 100 - 50);
    expect(h.p.hp).toBe(50 + heal);
    expect(h.inv[0]).toEqual({ type: "potion", count: 1 });
    expect(h.broadcasts).toEqual([{ type: "heal", payload: { targetId: "p1", amount: heal } }]);
    expect(h.inventorySends).toEqual(["p1"]);
  });

  it("last potion clears the slot to empty", () => {
    const h = makeHarness([{ type: "potion", count: 1 }]);
    useItemFromSlot(h.state, "p1", 0, h.deps);
    expect(h.inv[0]).toEqual({ type: "", count: 0 });
  });

  it("potion at full HP is a no-op (no consume, no broadcast)", () => {
    const h = makeHarness([{ type: "potion", count: 1 }]);
    h.p.hp = h.p.maxHp;
    useItemFromSlot(h.state, "p1", 0, h.deps);
    expect(h.inv[0]).toEqual({ type: "potion", count: 1 });
    expect(h.broadcasts).toHaveLength(0);
    expect(h.inventorySends).toHaveLength(0);
  });

  it("dead players, empty slots, and unknown sessions are ignored", () => {
    const h = makeHarness([{ type: "potion", count: 1 }]);
    h.p.state = AnimState.DEAD;
    useItemFromSlot(h.state, "p1", 0, h.deps);
    expect(h.inv[0].count).toBe(1);

    h.p.state = AnimState.IDLE;
    useItemFromSlot(h.state, "p1", 3, h.deps); // no such slot
    useItemFromSlot(h.state, "ghost", 0, h.deps); // no such session
    expect(h.broadcasts).toHaveLength(0);
  });

  it("berserker applies multipliers, snapshots base stats, keeps HP fraction", () => {
    const h = makeHarness([{ type: "berserker_potion", count: 1 }]);
    const before = {
      attack: h.p.attack,
      armor: h.p.armor,
      critChance: h.p.critChance,
      critMultiplier: h.p.critMultiplier,
      moveSpeed: h.p.moveSpeed,
      maxHp: h.p.maxHp,
    };
    useItemFromSlot(h.state, "p1", 0, h.deps);

    expect(h.berserkerBase.get("p1")).toEqual(before);
    expect(h.p.attack).toBe(before.attack * devTuning().berserkerAttackMult);
    expect(h.p.armor).toBe(before.armor * BERSERKER_ARMOR_MULT);
    expect(h.p.critChance).toBe(Math.min(1, before.critChance + BERSERKER_CRIT_CHANCE_ADD));
    // critMultiplier 0 falls back to the shared CRIT_MULTIPLIER base.
    expect(h.p.critMultiplier).toBe(CRIT_MULTIPLIER * BERSERKER_CRIT_DAMAGE_MULT);
    expect(h.p.moveSpeed).toBe(before.moveSpeed * BERSERKER_SPEED_MULT);
    expect(h.p.maxHp).toBe(Math.round(before.maxHp * BERSERKER_HP_MULT));
    // 50/100 = half health → still half health of the boosted pool.
    expect(h.p.hp).toBe(Math.min(h.p.maxHp, Math.round(0.5 * h.p.maxHp)));
    expect(h.p.berserkerMs).toBe(devTuning().berserkerDurationMs);
    expect(h.inv[0]).toEqual({ type: "", count: 0 });
  });

  it("berserker never stacks while the buff is running", () => {
    const h = makeHarness([{ type: "berserker_potion", count: 2 }]);
    h.p.berserkerMs = 5000;
    useItemFromSlot(h.state, "p1", 0, h.deps);
    expect(h.inv[0].count).toBe(2);
    expect(h.berserkerBase.size).toBe(0);
  });

  it("food restores hunger/HP/stamina, consumes, broadcasts, and syncs", () => {
    const h = makeHarness([{ type: "wild_berry", count: 2 }]);
    h.p.hunger = 30;
    h.p.maxHunger = 100;
    h.p.hp = 90;
    h.p.maxHp = 100;
    h.p.stamina = 40;
    h.p.maxStamina = 100;
    useItemFromSlot(h.state, "p1", 0, h.deps);

    expect(h.p.hunger).toBe(48);
    expect(h.p.hp).toBe(94);
    expect(h.p.stamina).toBe(48);
    expect(h.inv[0]).toEqual({ type: "wild_berry", count: 1 });
    expect(h.broadcasts).toEqual([
      {
        type: "food",
        payload: {
          playerId: "p1",
          item: "wild_berry",
          hungerRestored: 18,
          fromHunger: 30,
          toHunger: 48,
          durationMs: 4000,
        },
      },
      { type: "heal", payload: { targetId: "p1", amount: 4 } },
    ]);
    expect(h.inventorySends).toEqual(["p1"]);
  });

  it("food is not wasted when all affected meters are full or the item is not edible", () => {
    const full = makeHarness([{ type: "wild_berry", count: 1 }]);
    full.p.hunger = full.p.maxHunger;
    full.p.hp = full.p.maxHp;
    full.p.stamina = full.p.maxStamina;
    useItemFromSlot(full.state, "p1", 0, full.deps);
    expect(full.inv[0]).toEqual({ type: "wild_berry", count: 1 });
    expect(full.broadcasts).toHaveLength(0);

    const invalid = makeHarness([{ type: "log", count: 1 }]);
    invalid.p.hunger = 10;
    useItemFromSlot(invalid.state, "p1", 0, invalid.deps);
    expect(invalid.inv[0]).toEqual({ type: "log", count: 1 });
    expect(invalid.broadcasts).toHaveLength(0);
  });

  it("a plugin-registered behavior overrides the builtin id and gets a working ctx", () => {
    const h = makeHarness([{ type: "potion", count: 2 }]);
    const seen: string[] = [];
    serverPluginHost.registerItem("potion", {
      onUse: (player, _slot, ctx) => {
        seen.push(player.id);
        ctx.heal(player, 7);
        ctx.consume();
        ctx.broadcast("custom", { ok: true });
      },
    });
    useItemFromSlot(h.state, "p1", 0, h.deps);
    expect(seen).toEqual(["p1"]);
    expect(h.p.hp).toBe(57); // plugin heal, not POTION_HEAL
    expect(h.inv[0]).toEqual({ type: "potion", count: 1 });
    expect(h.broadcasts).toEqual([
      { type: "heal", payload: { targetId: "p1", amount: 7 } },
      { type: "custom", payload: { ok: true } },
    ]);
  });

  it("a throwing plugin behavior is contained (logged, no state change)", () => {
    const h = makeHarness([{ type: "potion", count: 1 }]);
    serverPluginHost.registerItem("potion", {
      onUse: () => {
        throw new Error("boom");
      },
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    useItemFromSlot(h.state, "p1", 0, h.deps);
    expect(err).toHaveBeenCalled();
    expect(h.p.hp).toBe(50);
    expect(h.inv[0].count).toBe(1);
  });
});
