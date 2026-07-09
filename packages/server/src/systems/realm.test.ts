import { GameState, House } from "@rpg/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultRealmWorldConfig,
  realmWorldConfig,
  resetRealmWorldConfig,
  setRealmWorldConfig,
  shouldEndRealmForHomeObjective,
} from "./realm";

function stateWithHouse(alive = true): GameState {
  const state = new GameState();
  const house = new House();
  house.id = "house-0";
  house.alive = alive;
  house.hp = alive ? 100 : 0;
  house.maxHp = 100;
  state.houses.set(house.id, house);
  return state;
}

describe("realm world config", () => {
  afterEach(() => {
    resetRealmWorldConfig();
    vi.restoreAllMocks();
  });

  it("defaults to the La Crypta Defense objective for realms without config", () => {
    expect(realmWorldConfig()).toEqual(defaultRealmWorldConfig);
  });

  it("treats an empty event list as the open sandbox loop", () => {
    const world = setRealmWorldConfig(undefined, { enabled: [], autoStart: false });
    expect(world.homeObjective).toBe(false);
    expect(world.waves).toBe(false);
  });

  it("can keep the home objective while leaving wave autostart off", () => {
    const world = setRealmWorldConfig(undefined, {
      enabled: ["la-crypta-defense"],
      autoStart: false,
    });
    expect(world.homeObjective).toBe(true);
    expect(world.waves).toBe(false);
  });

  it("lets explicit world settings override event defaults", () => {
    const world = setRealmWorldConfig(
      { homeObjective: false, waves: false },
      { enabled: ["la-crypta-defense"], autoStart: true },
    );
    expect(world.homeObjective).toBe(false);
    expect(world.waves).toBe(false);
  });

  it("warns and ignores invalid world flags", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const world = setRealmWorldConfig({ homeObjective: "no", waves: 0 });
    expect(world).toEqual(defaultRealmWorldConfig);
    expect(console.warn).toHaveBeenCalledTimes(2);
  });
});

describe("sandbox scenario self-test", () => {
  afterEach(() => resetRealmWorldConfig());

  it("does not end a sandbox realm just because there is no house", () => {
    setRealmWorldConfig({ homeObjective: false, waves: false });
    expect(shouldEndRealmForHomeObjective(new GameState(), true)).toBe(false);
  });

  it("still ends a La Crypta Defense realm when the home objective disappears", () => {
    setRealmWorldConfig({ homeObjective: true, waves: true });
    expect(shouldEndRealmForHomeObjective(new GameState(), true)).toBe(true);
  });

  it("keeps a La Crypta Defense realm live while a home is standing", () => {
    setRealmWorldConfig({ homeObjective: true, waves: true });
    expect(shouldEndRealmForHomeObjective(stateWithHouse(true), true)).toBe(false);
  });
});
