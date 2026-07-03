import { AnimState, type DevTuningKey, GameState, Player, playerLevelStats, waveDifficulty } from "@rpg/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { devTuning, resetDevTuning, setDevTuning } from "./devTuning";

const tune = (k: DevTuningKey) => devTuning()[k];

// #64 per-event difficulty config. The knobs exist because progression now
// persists across wipes: veterans inflate playerLevelStats and fresh cycles
// get brutal for newcomers. At the defaults every formula must reduce EXACTLY
// to the legacy behavior (also pinned by waves.characterization.test.ts).

function world(levels: number[], dead: number[] = []): GameState {
  const state = new GameState();
  levels.forEach((lvl, i) => {
    const p = new Player();
    p.id = `p${i}`;
    p.level = lvl;
    p.hp = dead.includes(i) ? 0 : 100;
    p.maxHp = 100;
    p.state = dead.includes(i) ? AnimState.DEAD : AnimState.IDLE;
    state.players.set(p.id, p);
  });
  return state;
}

describe("waveDifficulty (#64)", () => {
  beforeEach(() => resetDevTuning());
  afterEach(() => resetDevTuning());

  it("playerLevelStats counts only live players", () => {
    const state = world([2, 6, 10], [2]); // the level-10 veteran is dead
    expect(playerLevelStats(state)).toEqual({ avg: 4, max: 6, alive: 2 });
    expect(playerLevelStats(world([]))).toEqual({ avg: 1, max: 1, alive: 0 });
  });

  it("defaults reproduce the legacy formulas exactly", () => {
    const t = devTuning();
    const state = world([2, 6]);
    for (const n of [1, 2, 5, 9]) {
      const d = waveDifficulty(state, n, tune);
      const legacySize = Math.min(
        t.waveSizeMax,
        t.waveSizeBase + t.waveSizePerPlayer * 2 + t.waveSizePerWave * (n - 1),
      );
      expect(d.size).toBe(legacySize);
      expect(d.levelLo).toBe(4); // round(avg(2,6))
      expect(d.levelHi).toBe(6 + Math.floor(n / 3)); // max + legacy escalation
    }
  });

  it("difficultySizeScale scales the size before the waveSizeMax cap", () => {
    setDevTuning("waveSizeBase", 4);
    setDevTuning("waveSizePerPlayer", 1);
    setDevTuning("waveSizePerWave", 0);
    setDevTuning("waveSizeMax", 100);
    const state = world([3]);
    setDevTuning("difficultySizeScale", 2);
    expect(waveDifficulty(state, 1, tune).size).toBe(10); // (4+1)·2
    setDevTuning("difficultySizeScale", 0.5);
    expect(waveDifficulty(state, 1, tune).size).toBe(3); // round(2.5)
    setDevTuning("difficultySizeScale", 5);
    setDevTuning("waveSizeMax", 12);
    expect(waveDifficulty(state, 1, tune).size).toBe(12); // cap still wins
  });

  it("difficultyLevelScale stretches/flattens the escalation", () => {
    const state = world([5]);
    setDevTuning("difficultyLevelScale", 0); // fresh cycles never escalate
    expect(waveDifficulty(state, 9, tune).levelHi).toBe(5);
    setDevTuning("difficultyLevelScale", 3);
    expect(waveDifficulty(state, 3, tune).levelHi).toBe(5 + 3);
  });

  it("difficultyLevelCap hard-caps the roll range (lo follows)", () => {
    const state = world([20, 30]);
    setDevTuning("difficultyLevelCap", 10);
    const d = waveDifficulty(state, 6, tune);
    expect(d.levelHi).toBe(10);
    expect(d.levelLo).toBe(10); // lo (25) clamped down to hi
  });

  it("the event multiplier layers on top of the knobs", () => {
    setDevTuning("waveSizeBase", 4);
    setDevTuning("waveSizePerPlayer", 0);
    setDevTuning("waveSizePerWave", 0);
    setDevTuning("waveSizeMax", 100);
    const state = world([3]);
    expect(waveDifficulty(state, 1, tune, 2).size).toBe(8);
    setDevTuning("difficultySizeScale", 2);
    expect(waveDifficulty(state, 1, tune, 2).size).toBe(16); // knobs × event
    expect(waveDifficulty(state, 1, tune, 0).size).toBe(8); // invalid mult → 1
  });
});
