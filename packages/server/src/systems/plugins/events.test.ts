import { type EventModuleContext, type EventOutcome, type EventModuleSpec, GameState } from "@rpg/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFixedRng } from "../rng";
import { EventRuntime, type RoomBridge } from "./events";
import { serverPluginHost } from "./host";

// The event-module runtime (plugin API 1.1): start/tick/command/end lifecycle,
// HUD field writes, idempotent end, and crash containment — a throwing module
// can never take down the 20Hz tick or double-fire the realm-end flow.

function makeBridge(state = new GameState()): RoomBridge & { ends: EventOutcome[]; broadcasts: unknown[] } {
  installFixedRng(state, 0.5);
  const ends: EventOutcome[] = [];
  const broadcasts: unknown[] = [];
  return {
    state,
    ends,
    broadcasts,
    broadcast: (type, payload) => broadcasts.push({ type, payload }),
    giveItem: () => true,
    grantXp: () => 0,
    onEventEnd: (outcome) => ends.push(outcome),
  };
}

describe("EventRuntime (#71)", () => {
  let runtime: EventRuntime;

  beforeEach(() => {
    runtime = new EventRuntime();
  });
  afterEach(() => {
    serverPluginHost.reset();
    vi.restoreAllMocks();
  });

  function register(spec: Partial<EventModuleSpec> & { id: string }): EventModuleSpec {
    const full: EventModuleSpec = { onStart: () => {}, ...spec };
    serverPluginHost.registerEventModule(full);
    return full;
  }

  it("start wires the context, writes eventId/label, fires event:start", () => {
    const seen: string[] = [];
    serverPluginHost.on("event:start", (p) => seen.push(String(p.eventId)));
    let gotCtx: EventModuleContext | null = null;
    register({
      id: "arena",
      label: "Arena Trial",
      config: { difficultyMult: 2, rounds: 3 },
      onStart: (ctx) => {
        gotCtx = ctx;
      },
    });
    const bridge = makeBridge();
    expect(runtime.start("arena", bridge, { rounds: 5 })).toBe(true);

    expect(bridge.state.eventId).toBe("arena");
    expect(bridge.state.eventLabel).toBe("Arena Trial");
    expect(seen).toEqual(["arena"]);
    expect(runtime.activeId()).toBe("arena");
    const ctx = gotCtx as unknown as EventModuleContext;
    expect(ctx.config).toEqual({ difficultyMult: 2, rounds: 5 }); // realm.json overrides spec defaults
    expect(ctx.rng("spawns")()).toBe(0.5); // seeded stream reaches the module
    expect(typeof ctx.tuning("waveSizeBase")).toBe("number");
  });

  it("refuses unknown modules and double-starts", () => {
    const bridge = makeBridge();
    expect(runtime.start("ghost", bridge)).toBe(false);
    register({ id: "a" });
    register({ id: "b" });
    expect(runtime.start("a", bridge)).toBe(true);
    expect(runtime.start("b", bridge)).toBe(false); // one active event at a time
  });

  it("setEventHud writes + clamps the synced HUD fields", () => {
    register({
      id: "arena",
      onStart: (ctx) => ctx.setEventHud({ label: "Wave 3", timerMs: 1500, progress: 2 }),
    });
    const bridge = makeBridge();
    runtime.start("arena", bridge);
    expect(bridge.state.eventLabel).toBe("Wave 3");
    expect(bridge.state.eventTimerMs).toBe(1500);
    expect(bridge.state.eventProgress).toBe(1); // clamped to 0..1
  });

  it("ticks the module with scaled dt; a throwing onTick is contained", () => {
    const dts: number[] = [];
    register({
      id: "arena",
      onTick: (_ctx, dt) => {
        dts.push(dt);
        if (dts.length === 2) throw new Error("boom");
      },
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    runtime.start("arena", makeBridge());
    runtime.tick(0.05);
    runtime.tick(0.1);
    runtime.tick(0.05);
    expect(dts).toEqual([0.05, 0.1, 0.05]); // still ticking after the throw
    expect(err).toHaveBeenCalled();
  });

  it("endEvent runs onEnd once, fires event:end, clears HUD, calls the bridge once", () => {
    const ended: unknown[] = [];
    serverPluginHost.on("event:end", (p) => ended.push(p));
    const onEnd = vi.fn();
    register({
      id: "arena",
      onStart: (ctx) => ctx.setEventHud({ timerMs: 9000, progress: 0.5 }),
      onTick: (ctx) => ctx.endEvent({ result: "defeat", stats: { wave: 7 } }),
      onEnd,
    });
    const bridge = makeBridge();
    runtime.start("arena", bridge);
    runtime.tick(0.05);
    runtime.tick(0.05); // ended — further ticks are no-ops
    runtime.end({ result: "aborted" }); // and a second end is ignored

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(ended).toEqual([{ eventId: "arena", result: "defeat", wave: 7 }]);
    expect(bridge.ends).toEqual([{ result: "defeat", stats: { wave: 7 } }]);
    expect(bridge.state.eventId).toBe("");
    expect(bridge.state.eventTimerMs).toBe(0);
    expect(bridge.state.eventProgress).toBe(0);
    expect(runtime.activeId()).toBe("");
  });

  it("after an end, the next realm cycle can start the module again", () => {
    register({ id: "arena", onTick: (ctx) => ctx.endEvent({ result: "defeat" }) });
    const bridge = makeBridge();
    runtime.start("arena", bridge);
    runtime.tick(0.05);
    expect(runtime.start("arena", bridge)).toBe(true); // restart for the new cycle
    expect(bridge.state.eventId).toBe("arena");
  });

  it("routes commands to onCommand; completeObjective fires the event", () => {
    const commands: string[] = [];
    const objectives: unknown[] = [];
    serverPluginHost.on("objective:complete", (p) => objectives.push(p));
    register({
      id: "arena",
      onCommand: (ctx, cmd) => {
        commands.push(cmd);
        if (cmd === "finish") ctx.completeObjective("boss-down", { boss: "gorila" });
      },
    });
    runtime.start("arena", makeBridge());
    runtime.command("force_next_wave");
    runtime.command("finish");
    expect(commands).toEqual(["force_next_wave", "finish"]);
    expect(objectives).toEqual([{ eventId: "arena", objectiveId: "boss-down", boss: "gorila" }]);
  });

  it("world mutators spawn into the live state", () => {
    register({
      id: "arena",
      onStart: (ctx) => {
        const e = ctx.world.spawnEnemy({ kind: "goblin", x: 5, z: 5, level: 3, waveNumber: 2 });
        expect(e.kind).toBe("goblin");
        expect(e.level).toBe(3);
        expect(e.waveNumber).toBe(2);
        const houseId = ctx.world.spawnStructure({ kind: "house", x: 0, z: 0, maxHp: 500 });
        expect(ctx.state.houses.get(houseId)?.maxHp).toBe(500);
        ctx.world.broadcast("chat", { text: "the trial begins" });
      },
    });
    const bridge = makeBridge();
    runtime.start("arena", bridge);
    expect(bridge.state.enemies.size).toBe(1);
    expect(bridge.state.houses.size).toBe(1);
    expect(bridge.broadcasts).toEqual([{ type: "chat", payload: { text: "the trial begins" } }]);
  });
});
