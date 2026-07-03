import {
  AnimState,
  GameState,
  type HealEvent,
  House,
  PLUGIN_API_VERSION,
  Player,
  type ServerPluginContext,
  TIME_SCALE_MAX,
  Tree,
  TREE_REGROW_MS,
} from "@rpg/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import laCryptaPlugin from "../../../../plugins/la-crypta-defense/src/server";
import {
  type HouseRegenTimers,
  houseRegenSystem,
} from "../../../../plugins/la-crypta-defense/src/house";
import { resetDevTuning, setDevTuning } from "./devTuning";
import { EventRuntime, type RoomBridge } from "./plugins/events";
import { serverPluginHost } from "./plugins/host";
import { installFixedRng } from "./rng";
import { treeRegrowSystem } from "./resources";

// #67 timeScale audit: every gameplay timer runs on the SCALED tick delta the
// GameRoom tick hands it (dt = deltaMs · timeScale / 1000). These equivalence
// tests pin the contract for representative timer systems: N ticks at 1× must
// equal N/2 ticks at 2×, and 0× (paused) must freeze all progress.
//
// Intentionally NOT scaled (wall-clock by design): the game-over intermission
// (state.restartTimerMs), Dev Mode ghost movement while paused, perf tracking,
// content watchFile reloads, Nostr challenge expiry, realm-tracker timestamps.

function stateWithTree(regrowTimer: number): { state: GameState; tree: Tree } {
  const state = new GameState();
  installFixedRng(state, 0.5);
  const tree = new Tree();
  tree.id = "tree-0";
  tree.alive = false;
  tree.hp = 0;
  tree.maxHp = 10;
  tree.regrowTimer = regrowTimer;
  state.trees.set(tree.id, tree);
  return { state, tree };
}

function pluginCtx(): ServerPluginContext {
  return {
    apiVersion: PLUGIN_API_VERSION,
    manifest: { name: "la-crypta-defense", version: "0.1.0", apiVersion: "^1.1.0" },
    registerBrain: (id, fn) => serverPluginHost.registerBrain(id, fn),
    registerItem: (id, behavior) => serverPluginHost.registerItem(id, behavior),
    registerSystem: (name, fn, opts) => serverPluginHost.registerSystem(name, fn, opts?.phase ?? "main"),
    registerEventModule: (spec) => serverPluginHost.registerEventModule(spec),
    on: (event, handler) => serverPluginHost.on(event, handler),
    registerContentLoader: () => {},
    log: () => {},
  };
}

describe("timeScale equivalence (#67)", () => {
  beforeEach(() => resetDevTuning());
  afterEach(() => {
    resetDevTuning();
    serverPluginHost.reset();
  });

  it("TIME_SCALE_MAX is the documented cap", () => {
    expect(TIME_SCALE_MAX).toBe(16);
  });

  it("tree regrow: 20 ticks at 1× ≡ 10 ticks at 2×; 0× freezes", () => {
    const oneX = stateWithTree(TREE_REGROW_MS);
    for (let i = 0; i < 20; i++) treeRegrowSystem(oneX.state, 0.05);

    const twoX = stateWithTree(TREE_REGROW_MS);
    for (let i = 0; i < 10; i++) treeRegrowSystem(twoX.state, 0.1);

    expect(twoX.tree.regrowTimer).toBeCloseTo(oneX.tree.regrowTimer, 8);

    const paused = stateWithTree(5000);
    for (let i = 0; i < 20; i++) treeRegrowSystem(paused.state, 0);
    expect(paused.tree.regrowTimer).toBe(5000);
    expect(paused.tree.alive).toBe(false);
  });

  it("house regen: 4s of 1× ticks ≡ 2s of 2× ticks; 0× freezes", () => {
    const drive = (stepMs: number, steps: number) => {
      const state = new GameState();
      installFixedRng(state, 0.5);
      const house = new House();
      house.id = "house-0";
      house.maxHp = 100_000;
      house.hp = 100;
      house.alive = true;
      state.houses.set(house.id, house);
      const timers: HouseRegenTimers = new Map();
      const noop = (_ev: HealEvent) => {};
      for (let i = 0; i < steps; i++) houseRegenSystem(state, stepMs, timers, noop);
      return house.hp;
    };
    // Same simulated 20s (idle window + regen) — different wall tick sizes.
    // The ramp rate quantizes per call (floor(regenMs/1000)), so coarser ticks
    // land within one ramp step of finer ones — equal up to that quantization.
    const fine = drive(100, 200);
    const coarse = drive(200, 100);
    expect(fine).toBeGreaterThan(100);
    expect(Math.abs(fine - coarse)).toBeLessThanOrEqual(5);
    expect(drive(0, 200)).toBe(100); // paused: scaledMs 0 → frozen
  });

  it("wave clock (event module): 10s of 1× ticks ≡ 5s of 2× ticks", async () => {
    await laCryptaPlugin.setup(pluginCtx());
    setDevTuning("waveFirstDelayMs", 60_000);

    const drive = (dt: number, steps: number): GameState => {
      const state = new GameState();
      installFixedRng(state, 0.5);
      const p = new Player();
      p.id = "p1";
      p.hp = 100;
      p.maxHp = 100;
      p.level = 1;
      p.state = AnimState.IDLE;
      state.players.set(p.id, p);
      const bridge: RoomBridge = {
        state,
        broadcast: () => {},
        giveItem: () => true,
        grantXp: () => 0,
        onEventEnd: () => {},
      };
      const runtime = new EventRuntime();
      runtime.start("la-crypta-defense", bridge);
      for (let i = 0; i < steps; i++) runtime.tick(dt);
      return state;
    };

    const oneX = drive(0.05, 200); // 10s at 1×
    const twoX = drive(0.1, 100); // the same 10s at 2×
    expect(twoX.waveTimerMs).toBeCloseTo(oneX.waveTimerMs, 5);
    expect(oneX.waveNumber).toBe(0);
  });
});
