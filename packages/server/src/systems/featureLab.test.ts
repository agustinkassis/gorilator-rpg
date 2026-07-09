import { AnimState, GameState, Player } from "@rpg/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { devTuning, resetDevTuning } from "./devTuning";
import {
  applyFeatureLabPlayerScenario,
  applyFeatureLabScenario,
  featureLabScenario,
} from "./featureLab";
import { realmPolicy, resetRealmPolicy } from "./policy";

describe("Feature Lab scenario overlay", () => {
  beforeEach(() => {
    resetDevTuning();
    resetRealmPolicy();
    delete process.env.GORILATOR_SCENARIO;
  });

  afterEach(() => {
    resetDevTuning();
    resetRealmPolicy();
    delete process.env.GORILATOR_SCENARIO;
  });

  it("loads a scenario manifest as a policy/tuning/timeScale overlay", () => {
    process.env.GORILATOR_SCENARIO = "persistence-legacy-wipe";
    const state = new GameState();

    const scenario = applyFeatureLabScenario(state);

    expect(scenario?.name).toBe("persistence-legacy-wipe");
    expect(featureLabScenario()?.name).toBe("persistence-legacy-wipe");
    expect(realmPolicy().progression.persistAcrossWipes).toBe(false);
    expect(realmPolicy().progression.keepInventoryOnWipe).toBe(false);
    expect(devTuning().waveSizeBase).toBe(1);
    expect(devTuning().waveSizePerPlayer).toBe(0);
    expect(devTuning().waveSizePerWave).toBe(0);
    expect(state.timeScale).toBe(1);
  });

  it("seeds the death penalty lab player and attacker pack", () => {
    process.env.GORILATOR_SCENARIO = "death-penalty-l10";
    const state = new GameState();

    const scenario = applyFeatureLabScenario(state);
    const player = new Player();
    player.id = "p1";
    player.name = "Tester";
    state.players.set(player.id, player);
    applyFeatureLabPlayerScenario(state, player);

    expect(scenario?.name).toBe("death-penalty-l10");
    expect(realmPolicy().death.xpPenalty).toBe(0.12);
    expect(state.wavesEnabled).toBe(false);
    expect(player.level).toBe(10);
    expect(player.xp).toBe(1200);
    expect(player.hp).toBe(260);
    expect(player.maxHp).toBeGreaterThan(player.hp);
    expect(state.enemies.size).toBe(5);
    state.enemies.forEach((enemy) => {
      expect(enemy.kind).toBe("goblin");
      expect(enemy.level).toBe(12);
      expect(enemy.brain).toBe("war_seeker");
      expect(enemy.aiTargetId).toBe(player.id);
      expect(enemy.state).toBe(AnimState.WALK);
    });
  });
});
