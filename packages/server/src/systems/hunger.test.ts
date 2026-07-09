import { AnimState, GameState, Player } from "@rpg/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDevTuning, setDevTuning } from "./devTuning";
import { hungerSystem } from "./hunger";
import { resetRealmPolicy, setRealmPolicy } from "./policy";

function stateWithPlayer(): { state: GameState; player: Player } {
  const state = new GameState();
  const player = new Player();
  player.id = "p1";
  player.hp = 100;
  player.maxHp = 100;
  player.hunger = 100;
  player.maxHunger = 100;
  state.players.set(player.id, player);
  return { state, player };
}

describe("hungerSystem", () => {
  beforeEach(() => {
    resetDevTuning();
    resetRealmPolicy();
  });

  it("drains hunger using scaled dt", () => {
    const { state, player } = stateWithPlayer();
    setDevTuning("hungerDrainPerMin", 60);
    hungerSystem(state, 2);
    expect(player.hunger).toBe(98);
  });

  it("does not drain while paused or dead", () => {
    const { state, player } = stateWithPlayer();
    setDevTuning("hungerDrainPerMin", 60);
    hungerSystem(state, 0);
    expect(player.hunger).toBe(100);
    player.state = AnimState.DEAD;
    hungerSystem(state, 10);
    expect(player.hunger).toBe(100);
  });

  it("damages and kills starving players", () => {
    setRealmPolicy({ death: { mode: "none" } });
    const { state, player } = stateWithPlayer();
    player.hunger = 0;
    player.hp = 10;
    setDevTuning("starvationDamagePerSec", 4);
    hungerSystem(state, 2);
    expect(player.hp).toBe(2);
    hungerSystem(state, 1);
    expect(player.hp).toBe(0);
    expect(player.state).toBe(AnimState.DEAD);
    expect(player.respawnTimer).toBeGreaterThanOrEqual(0);
  });
});
