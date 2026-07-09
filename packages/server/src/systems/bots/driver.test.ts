import { AnimState, Enemy, GameState, type InventorySlot } from "@rpg/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { combatSystem } from "../combat";
import { devTuning, resetDevTuning } from "../devTuning";
import { movementSystem } from "../movement";
import { installFixedRng } from "../rng";
import { registerBuiltinBotBehaviors } from "./behaviors";
import {
  type BotIO,
  botStatuses,
  botSystem,
  clearBots,
  eat,
  isKnownBotBehavior,
  loop,
  moveTo,
  attackNearest,
  registerBotBehavior,
  resetBotPrograms,
  seq,
  spawnBot,
  waitFor,
} from "./driver";

// Bot driver v1 (#68): registry, spawn parity with fresh joins, primitives
// driven through the REAL movement/combat systems, combinators, timeouts.

const noop = () => {};

function harness() {
  const state = new GameState();
  installFixedRng(state, 0.5);
  const inventories = new Map<string, InventorySlot[]>();
  const used: Array<{ botId: string; slot: number }> = [];
  const io: BotIO = {
    useItem: (botId, slot) => {
      used.push({ botId, slot });
      const inv = inventories.get(botId);
      const s = inv?.[slot];
      if (s && s.count > 0) s.count -= 1;
    },
    inventory: (botId) => inventories.get(botId),
  };
  const tick = (n = 1, dt = 0.05) => {
    for (let i = 0; i < n; i++) {
      botSystem(state, dt, io);
      movementSystem(state, dt);
      combatSystem(state, dt, noop, noop, noop, noop);
    }
  };
  return { state, inventories, io, used, tick };
}

describe("bot driver (#68)", () => {
  beforeEach(() => {
    resetDevTuning();
    registerBuiltinBotBehaviors();
  });
  afterEach(() => {
    resetDevTuning();
  });

  it("builtin behaviors are registered and listed", () => {
    for (const id of ["wander", "aggro", "loot", "eat_when_low"]) {
      expect(isKnownBotBehavior(id)).toBe(true);
    }
    expect(isKnownBotBehavior("nope")).toBe(false);
  });

  it("spawnBot mirrors a fresh join: tuned stats, free spot, loadout, player:spawn", () => {
    const { state, inventories } = harness();
    const bot = spawnBot(state, inventories, {
      behavior: "wander",
      name: "Testy",
      position: { x: 30, z: 30 },
      loadout: [{ item: "potion", count: 2 }],
      stats: { level: 3 },
    });
    expect(bot).not.toBeNull();
    expect(state.players.get(bot!.id)).toBe(bot);
    expect(bot!.name).toBe("Testy");
    expect(bot!.level).toBe(3);
    expect(bot!.maxHp).toBe(devTuning().playerMaxHp);
    expect(Math.hypot(bot!.x - 30, bot!.z - 30)).toBeLessThan(3);
    const inv = inventories.get(bot!.id);
    expect(inv?.filter((s) => s.count > 0)).toEqual([{ type: "potion", count: 2 }]);
    expect(botStatuses(state).get(bot!.id)?.status).toBe("running");

    expect(spawnBot(state, inventories, { behavior: "ghost-behavior" })).toBeNull();
  });

  it("moveTo walks the bot to the target through the real movement system", () => {
    const { state, inventories, tick } = harness();
    registerBotBehavior("goto", () => moveTo(40, 40));
    const bot = spawnBot(state, inventories, { behavior: "goto", position: { x: 30, z: 30 } })!;
    tick(600); // plenty of 50ms steps at default move speed
    expect(Math.hypot(bot.x - 40, bot.z - 40)).toBeLessThanOrEqual(1.5);
    expect(botStatuses(state).get(bot.id)?.status).toBe("done");
  });

  it("dt 0 (paused) freezes bot programs", () => {
    const { state, inventories, io } = harness();
    registerBotBehavior("goto", () => moveTo(40, 40));
    const bot = spawnBot(state, inventories, { behavior: "goto", position: { x: 30, z: 30 } })!;
    const x = bot.x;
    for (let i = 0; i < 20; i++) botSystem(state, 0, io);
    expect(bot.x).toBe(x);
    expect(bot.path.length).toBe(0); // no destination was ever issued
  });

  it("attackNearest kills a staged enemy through the real combat pipeline", () => {
    const { state, inventories, tick } = harness();
    registerBotBehavior("kill_once", () => attackNearest(60));
    const bot = spawnBot(state, inventories, { behavior: "kill_once", position: { x: 30, z: 30 } })!;
    const e = new Enemy();
    e.id = "e1";
    e.kind = "dummy";
    e.x = 34;
    e.z = 30;
    e.hp = 10;
    e.maxHp = 10;
    e.armor = 0;
    e.attack = 0;
    e.state = AnimState.IDLE;
    state.enemies.set(e.id, e);

    tick(400);
    expect(e.hp).toBe(0);
    expect(e.state).toBe(AnimState.DEAD);
    expect(botStatuses(state).get(bot.id)?.status).toBe("done");
    void bot;
  });

  it("eat consumes via the IO surface; fails with an empty inventory", () => {
    const { state, inventories, io, used } = harness();
    registerBotBehavior("sip", () => eat("potion"));
    const fed = spawnBot(state, inventories, {
      behavior: "sip",
      position: { x: 30, z: 30 },
      loadout: [{ item: "potion", count: 1 }],
    })!;
    const hungry = spawnBot(state, inventories, { behavior: "sip", position: { x: 32, z: 30 } })!;
    botSystem(state, 0.05, io);
    expect(used).toEqual([{ botId: fed.id, slot: 0 }]);
    expect(botStatuses(state).get(fed.id)?.status).toBe("done");
    expect(botStatuses(state).get(hungry.id)?.status).toBe("failed");
  });

  it("seq runs steps in order; loop repeats; timeouts surface as failed", () => {
    const { state, inventories, io } = harness();
    const order: string[] = [];
    const mark = (label: string) => ({
      reset() {},
      tick() {
        order.push(label);
        return "done" as const;
      },
    });
    registerBotBehavior("marks", () => seq(mark("a"), waitFor(100), mark("b")));
    const bot = spawnBot(state, inventories, { behavior: "marks", position: { x: 30, z: 30 } })!;
    for (let i = 0; i < 4; i++) botSystem(state, 0.05, io);
    expect(order).toEqual(["a", "b"]);
    expect(botStatuses(state).get(bot.id)?.status).toBe("done");

    // A loop never finishes on its own…
    const looper = spawnBot(state, inventories, { behavior: "wander", position: { x: 40, z: 40 } })!;
    for (let i = 0; i < 10; i++) botSystem(state, 0.05, io);
    expect(botStatuses(state).get(looper.id)?.status).toBe("running");

    // …and an unreachable moveTo times out instead of hanging forever.
    registerBotBehavior("stuck", () => moveTo(30, 30, 0.0001, 500));
    const stuck = spawnBot(state, inventories, { behavior: "stuck", position: { x: 60, z: 60 } })!;
    for (let i = 0; i < 15; i++) botSystem(state, 0.05, io); // 750ms sim > 500ms timeout
    expect(botStatuses(state).get(stuck.id)?.status).toBe("failed");
  });

  it("resetBotPrograms restarts; clearBots removes players + inventories", () => {
    const { state, inventories, io } = harness();
    registerBotBehavior("goto2", () => moveTo(40, 40));
    const bot = spawnBot(state, inventories, { behavior: "goto2", position: { x: 40, z: 40 } })!;
    botSystem(state, 0.05, io);
    expect(botStatuses(state).get(bot.id)?.status).toBe("done"); // already there
    resetBotPrograms(state);
    expect(botStatuses(state).get(bot.id)?.status).toBe("running");

    clearBots(state, inventories);
    expect(state.players.size).toBe(0);
    expect(inventories.size).toBe(0);
    expect(botStatuses(state).size).toBe(0);
  });

  it("a throwing behavior is contained and marked failed", () => {
    const { state, inventories, io } = harness();
    registerBotBehavior("bomb", () => ({
      reset() {},
      tick() {
        throw new Error("boom");
      },
    }));
    const bot = spawnBot(state, inventories, { behavior: "bomb", position: { x: 30, z: 30 } })!;
    botSystem(state, 0.05, io);
    expect(botStatuses(state).get(bot.id)?.status).toBe("failed");
    botSystem(state, 0.05, io); // and it never runs again
  });
});
