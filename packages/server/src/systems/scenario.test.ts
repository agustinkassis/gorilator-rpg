import { GameState, Player, type ScenarioManifest, TIME_SCALE_MAX } from "@rpg/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { devTuning, resetDevTuning, setDevTuning } from "./devTuning";
import { makeInventory } from "./inventory";
import { realmEvents, resetRealmEvents, setRealmEvents } from "./realm";
import { installFixedRng } from "./rng";
import {
  applyScenarioConfig,
  applyScenarioPlayer,
  applyScenarioWorld,
  loadScenario,
  setActiveScenario,
} from "./scenario";

// Feature Lab scenario loader (#65): manifest loading + the three layers
// (config over realm tuning · world staging · fresh-player staging).

function freshState(): GameState {
  const state = new GameState();
  installFixedRng(state, 0.5);
  return state;
}

describe("scenario loader (#65)", () => {
  beforeEach(() => {
    resetDevTuning();
    resetRealmEvents();
  });
  afterEach(() => {
    setActiveScenario(null);
    resetDevTuning();
    resetRealmEvents();
  });

  it("loads a shipped manifest from scenarios/ (repo root)", () => {
    const m = loadScenario("baseline");
    expect(m).not.toBeNull();
    expect(m!.name).toBe("baseline");
    expect(m!.systems?.events).toBe(false);
  });

  it("rejects missing files and path-traversal names", () => {
    expect(loadScenario("no-such-scenario")).toBeNull();
    expect(loadScenario("../realm")).toBeNull();
    expect(loadScenario("a/b")).toBeNull();
  });

  it("config layer: scenario tuning wins over realm tuning; timeScale clamps", () => {
    setDevTuning("enemyMaxHp", 500); // "realm.json" layer
    const state = freshState();
    const m: ScenarioManifest = {
      name: "t",
      tuning: { enemyMaxHp: 20, playerAttack: 99 },
      timeScale: 99, // clamped to TIME_SCALE_MAX
    };
    applyScenarioConfig(state, m);
    expect(devTuning().enemyMaxHp).toBe(20);
    expect(devTuning().playerAttack).toBe(99);
    expect(state.timeScale).toBe(TIME_SCALE_MAX);
  });

  it("config layer: accepts legacy Hunger Lab sandbox flags", () => {
    const state = freshState();
    state.wavesEnabled = true;
    applyScenarioConfig(state, {
      name: "hunger",
      world: {
        wavesEnabled: false,
        laCryptaDefense: false,
        spawnersEnabled: false,
      },
      tuning: { hungerDrainPerMin: 6, starvationDamagePerSec: 1 },
      tweaks: ["hungerDrainPerMin", "starvationDamagePerSec"],
    });
    expect(realmEvents().enabled).toBe(false);
    expect(state.wavesEnabled).toBe(false);
    expect(devTuning().hungerDrainPerMin).toBe(6);
    expect(devTuning().starvationDamagePerSec).toBe(1);
  });

  it("config layer: events default OFF in a scenario; explicit true keeps them on", () => {
    const state = freshState();
    applyScenarioConfig(state, { name: "t" });
    expect(realmEvents().enabled).toBe(false);

    setRealmEvents({ enabled: true });
    applyScenarioConfig(state, { name: "t", systems: { events: true } });
    expect(realmEvents().enabled).toBe(true);
  });

  it("config layer: recognizes the spawners toggle; warns on unknown ones", () => {
    const state = freshState();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    applyScenarioConfig(state, { name: "t", systems: { spawners: false, volcanoes: true } });
    const warned = warn.mock.calls.map((c) => String(c[0]));
    expect(warned.some((m) => m.includes('"volcanoes"'))).toBe(true);
    expect(warned.some((m) => m.includes('"spawners"'))).toBe(false);
    warn.mockRestore();
    // spawnerSystem consults a module-global toggle — restore it for other tests.
    applyScenarioConfig(state, { name: "t", systems: { spawners: true } });
  });

  it("world layer: stages resources, ground items, npcs and enemies", () => {
    const state = freshState();
    const m: ScenarioManifest = {
      name: "t",
      world: {
        resources: [
          { type: "tree", x: 5, z: 5 },
          { kind: "bush", id: "cranberry_bush_0", x: 3, z: 4, scale: 0.75, hp: 24 },
          { type: "rock", x: -5, z: 5 },
          { type: "volcano", x: 0, z: 0 }, // unknown → warned + ignored
        ],
        groundItems: [{ item: "banana", x: 2, z: 0, count: 3 }],
        npcs: [{ defId: "gorila", x: -4, z: 3 }],
        enemies: [
          { kind: "goblin", x: 8, z: 0, level: 4 },
          { kind: "dummy", x: 9, z: 0 },
        ],
      },
    };
    applyScenarioWorld(state, m);
    expect(state.trees.size).toBe(2);
    const bush = state.trees.get("cranberry_bush_0");
    expect(bush?.kind).toBe("bush");
    expect(bush?.scale).toBe(0.75);
    expect(bush?.hp).toBe(24);
    expect(state.rocks.size).toBe(1);
    expect(state.bananas.size).toBe(3);
    expect(state.enemies.size).toBe(3); // 1 npc + 2 staged enemies

    const kinds = new Map<string, number>();
    state.enemies.forEach((e) => kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1));
    expect(kinds.get("npc")).toBe(1);
    expect(kinds.get("goblin")).toBe(1);
    expect(kinds.get("dummy")).toBe(1);
    state.enemies.forEach((e) => {
      if (e.kind === "goblin") expect(e.level).toBe(4);
    });
  });

  it("player layer: whitelisted stats, loadout replacement, safe defaults", () => {
    const p = new Player();
    p.id = "p1";
    p.hp = 100;
    p.maxHp = 100;
    const inv = makeInventory();
    inv[0] = { type: "banana", count: 5 }; // the starter loadout to replace
    const m: ScenarioManifest = {
      name: "t",
      player: {
        stats: { level: 5, maxHp: 200, hunger: 40, maxHunger: 100 },
        loadout: [{ item: "potion", count: 2 }],
        position: { x: 30, z: 40 }, // clear of the static centre obstacles
      },
    };
    applyScenarioPlayer(p, inv, m);
    expect(p.level).toBe(5);
    expect(p.maxHp).toBe(200);
    expect(p.hp).toBe(200); // hp follows maxHp when not pinned
    expect(p.hunger).toBe(40); // #72 batched fields are stageable
    expect(p.maxHunger).toBe(100);
    expect(inv.filter((s) => s.count > 0)).toEqual([{ type: "potion", count: 2 }]);
    expect(Math.hypot(p.x - 30, p.z - 40)).toBeLessThan(3); // placed at/near the spot
  });

  it("ignores non-whitelisted stat keys", () => {
    const p = new Player();
    p.id = "p1";
    const m = {
      name: "t",
      player: { stats: { godMode: 1, isAdmin: 1 } },
    } as unknown as ScenarioManifest;
    applyScenarioPlayer(p, makeInventory(), m);
    expect(p.godMode).toBe(false);
    expect(p.isAdmin).toBe(false);
  });
});
