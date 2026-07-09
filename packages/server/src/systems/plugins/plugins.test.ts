import {
  AnimState,
  Enemy,
  GameState,
  PLUGIN_API_VERSION,
  Player,
  type BrainWorld,
  type ServerPluginContext,
} from "@rpg/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import arenaPlugin from "../../../../../plugins/example-arena/src/server";
import { apiVersionCompatible } from "./discovery";
import { BUILTIN_BRAINS, serverPluginHost } from "./host";

// Integration test: the worked-example plugin (plugins/example-arena) loaded
// against the real host registries — proving the whole seam (registerBrain /
// registerItem / events) works without touching packages/*/src.

function makeCtx(): ServerPluginContext {
  return {
    apiVersion: PLUGIN_API_VERSION,
    manifest: { name: "example-arena", version: "0.1.0", apiVersion: "^1.0.0" },
    registerBrain: (id, fn) => serverPluginHost.registerBrain(id, fn),
    registerItem: (id, behavior) => serverPluginHost.registerItem(id, behavior),
    registerSystem: (name, fn, opts) => serverPluginHost.registerSystem(name, fn, opts?.phase ?? "main"),
    registerEventModule: (spec) => serverPluginHost.registerEventModule(spec),
    on: (event, handler) => serverPluginHost.on(event, handler),
    registerContentLoader: () => {},
    log: () => {},
  };
}

function makeWorld(state: GameState): BrainWorld {
  return {
    nearestPlayer: (g) => {
      let best: { p: Player; d: number } | null = null;
      state.players.forEach((p) => {
        const d = Math.hypot(p.x - g.x, p.z - g.z);
        if (!best || d < best.d) best = { p, d };
      });
      return best;
    },
    home: () => null,
    stepToward: (g, x, z, speed, dt) => {
      const dx = x - g.x;
      const dz = z - g.z;
      const dist = Math.hypot(dx, dz) || 1;
      const step = Math.min(dist, speed * dt);
      g.x += (dx / dist) * step;
      g.z += (dz / dist) * step;
    },
  };
}

describe("plugin host + example-arena", () => {
  beforeEach(async () => {
    serverPluginHost.reset();
    await arenaPlugin.setup(makeCtx());
  });
  afterEach(() => serverPluginHost.reset());

  it("api version gate accepts ^1 ranges and rejects other majors", () => {
    expect(apiVersionCompatible("^1.0.0")).toBe(true);
    expect(apiVersionCompatible("1.x")).toBe(true);
    expect(apiVersionCompatible("^2.0.0")).toBe(false);
    expect(apiVersionCompatible("")).toBe(false);
  });

  it("registers the kamikaze brain and the arena_horn item", () => {
    expect(serverPluginHost.isKnownBrain("kamikaze")).toBe(true);
    expect(serverPluginHost.items.has("arena_horn")).toBe(true);
    for (const builtin of BUILTIN_BRAINS) expect(serverPluginHost.isKnownBrain(builtin)).toBe(true);
    expect(serverPluginHost.isKnownBrain("nonsense")).toBe(false);
  });

  it("kamikaze rushes the nearest player and detonates on contact", () => {
    const state = new GameState();
    const p = new Player();
    p.id = "p1";
    p.x = 0;
    p.z = 0;
    p.hp = 100;
    p.maxHp = 100;
    state.players.set("p1", p);
    const g = new Enemy();
    g.id = "k1";
    g.kind = "goblin";
    g.x = 10;
    g.z = 0;
    g.hp = 5;
    g.maxHp = 5;
    state.enemies.set("k1", g);

    const brain = serverPluginHost.brains.get("kamikaze");
    expect(brain).toBeDefined();
    const world = makeWorld(state);

    // It closes the distance…
    brain?.(g, 0.5, state, world);
    expect(g.x).toBeLessThan(10);
    expect(g.state).toBe(AnimState.WALK);

    // …and detonates on contact: the player takes blast damage, the bomber dies.
    g.x = 1;
    brain?.(g, 0.05, state, world);
    expect(p.hp).toBeLessThan(100);
    expect(g.hp).toBe(0);
    expect(g.state).toBe(AnimState.DEAD);
  });

  it("arena_horn consumes a charge, heals the blower, and taunts in chat", () => {
    const state = new GameState();
    const p = new Player();
    p.id = "p1";
    p.name = "Tester";
    p.hp = 50;
    p.maxHp = 100;
    state.players.set("p1", p);

    let consumed = 0;
    const broadcasts: Array<{ type: string; payload: unknown }> = [];
    serverPluginHost.items.get("arena_horn")?.onUse(p, 0, {
      state,
      consume: () => {
        consumed += 1;
      },
      broadcast: (type, payload) => broadcasts.push({ type, payload }),
      heal: (target, amount) => {
        target.hp = Math.min(target.maxHp, target.hp + amount);
      },
      log: () => {},
    });

    expect(consumed).toBe(1);
    expect(p.hp).toBe(60);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].type).toBe("chat");
  });

  it("event handlers run isolated — one throwing handler never blocks the rest", () => {
    const state = new GameState();
    const seen: string[] = [];
    serverPluginHost.on("entity:killed", () => {
      throw new Error("bad plugin");
    });
    serverPluginHost.on("entity:killed", (payload) => seen.push(String(payload.victimId)));

    serverPluginHost.fire("entity:killed", { victimId: "x1", victimKind: "goblin" }, state);
    expect(seen).toEqual(["x1"]);
  });
});
