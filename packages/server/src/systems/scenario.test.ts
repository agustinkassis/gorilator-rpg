import { GameState, House, Item, Player } from "@rpg/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { makeInventory } from "./inventory";
import { devTuning, resetDevTuning } from "./devTuning";
import {
  applyScenarioPlayer,
  applyScenarioTuning,
  applyScenarioWorld,
  parseScenario,
  scenarioLaCryptaDefenseEnabled,
  scenarioSpawnersEnabled,
  scenarioWavesEnabled,
} from "./scenario";

describe("scenario v1", () => {
  beforeEach(() => resetDevTuning());

  it("parses and applies tuning plus pinned tweaks", () => {
    const scenario = parseScenario(
      {
        name: "Hunger Lab",
        tuning: { hungerDrainPerMin: 42 },
        tweaks: ["hungerDrainPerMin", "foodHungerMult", "hungerDrainPerMin"],
      },
      "hunger",
    );
    expect(scenario?.name).toBe("hunger-lab");
    expect(scenario?.tweaks).toEqual(["hungerDrainPerMin", "foodHungerMult"]);
    expect(scenarioWavesEnabled(scenario)).toBe(false);
    expect(scenarioLaCryptaDefenseEnabled(scenario)).toBe(false);
    expect(scenarioSpawnersEnabled(scenario)).toBe(false);
    expect(scenarioWavesEnabled(null)).toBe(true);
    expect(scenarioLaCryptaDefenseEnabled(null)).toBe(true);
    expect(scenarioSpawnersEnabled(null)).toBe(true);
    applyScenarioTuning(scenario);
    expect(devTuning().hungerDrainPerMin).toBe(42);
  });

  it("applies world sandbox flags, clears pickups, and stages ground food", () => {
    const scenario = parseScenario(
      {
        world: {
          clearPickups: true,
          wavesEnabled: false,
          laCryptaDefense: false,
          spawnersEnabled: false,
          resources: [{ kind: "bush", id: "cranberry_bush_0", x: 3, z: 4, scale: 0.75, hp: 24 }],
          groundItems: [{ item: "wild_berry", x: 1, z: 2, count: 2 }],
        },
      },
      "hunger",
    );
    const state = new GameState();
    const old = new Item();
    old.id = "old";
    old.itemId = "wild_berry";
    state.items.set(old.id, old);
    const house = new House();
    house.id = "house-0";
    state.houses.set(house.id, house);
    state.wavesEnabled = true;
    applyScenarioWorld(state, scenario);
    expect(state.wavesEnabled).toBe(false);
    expect(state.houses.size).toBe(0);
    const bush = state.trees.get("cranberry_bush_0");
    expect(bush?.kind).toBe("bush");
    expect(bush?.scale).toBe(0.75);
    expect(bush?.hp).toBe(24);
    expect(state.items.size).toBe(2);
    const itemIds: string[] = [];
    state.items.forEach((item) => itemIds.push(item.itemId));
    expect(itemIds.every((id) => id === "wild_berry")).toBe(true);
  });

  it("applies player stats and replaces loadout", () => {
    const scenario = parseScenario(
      {
        player: {
          position: { x: 3, z: 4 },
          stats: { hunger: 25, maxHunger: 80, hp: 40, maxHp: 90 },
          loadout: [{ item: "trail_ration", count: 2 }],
        },
      },
      "hunger",
    );
    const p = new Player();
    const inv = makeInventory();
    inv[0] = { type: "banana", count: 5 };
    expect(applyScenarioPlayer(p, inv, scenario)).toBe(true);
    expect(p.hunger).toBe(25);
    expect(p.maxHunger).toBe(80);
    expect(p.hp).toBe(40);
    expect(inv[0]).toEqual({ type: "trail_ration", count: 2 });
  });
});
