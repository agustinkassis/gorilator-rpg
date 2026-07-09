import { AnimState } from "@rpg/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createScenarioSim, type ScenarioSim } from "../../testing/scenarioSim";
import { countItem } from "../inventory";
import { loadScenario } from "../scenario";

// The Feature Lab's worked DoD example (#68): scenarios/bot-arena.json + the
// headless harness = a bot self-test. THIS is the template every future
// feature's "bot self-test" artifact copies (docs/feature-lab.md):
//   load the scenario → runUntil the loop completes → assert over GameState.

describe("bot-arena scenario self-test", () => {
  let sim: ScenarioSim | undefined;
  afterEach(() => sim?.dispose());

  it("the aggro bot clears the staged goblins; the loot bot collects the bananas", () => {
    const scenario = loadScenario("bot-arena");
    expect(scenario).not.toBeNull();
    sim = createScenarioSim({ scenario: scenario! });

    // The stage: 3 goblins + 3 bananas + 2 bots (aggro + loot).
    expect(sim.state.enemies.size).toBe(3);
    expect(sim.state.bananas.size).toBe(3);
    expect(sim.state.players.size).toBe(2);
    expect(sim.state.timeScale).toBe(2); // accelerated lab

    const finished = sim.runUntil((state, s) => {
      let enemiesDown = true;
      state.enemies.forEach((e) => {
        if (e.hp > 0 && e.state !== AnimState.DEAD) enemiesDown = false;
      });
      return enemiesDown && state.bananas.size === 0 && s.events.some((ev) => ev.type === "damage");
    }, 60_000);
    expect(finished).toBe(true);

    // The loot bot banked the staged bananas.
    const lootBotId = [...sim.bots().entries()].find(([, r]) => r.behaviorId === "loot")?.[0];
    expect(lootBotId).toBeDefined();
    expect(countItem(sim.inventories.get(lootBotId!)!, "banana")).toBe(3);

    // Nobody's program crashed or timed out.
    for (const runtime of sim.bots().values()) {
      expect(runtime.status).toBe("running"); // loops run forever — never "failed"
    }

    // The fight actually went through the combat pipeline (damage broadcasts).
    expect(sim.events.filter((ev) => ev.type === "damage").length).toBeGreaterThan(0);
  });

  it("the same seed reproduces the same world evolution", () => {
    const scenario = loadScenario("bot-arena");
    const run = () => {
      const s = createScenarioSim({ scenario: scenario! });
      s.runFor(5_000);
      // Ids come from process-global counters (differ across runs) — snapshot
      // the physical state only.
      const snapshot: Array<[number, number, number]> = [];
      s.state.enemies.forEach((e) => snapshot.push([e.x, e.z, e.hp]));
      s.state.players.forEach((p) => snapshot.push([p.x, p.z, p.hp]));
      s.dispose();
      return JSON.stringify(snapshot.sort((a, b) => a[0] - b[0] || a[1] - b[1]));
    };
    expect(run()).toBe(run()); // seed 68 pins every roll (engineering.md §3)
  });
});
