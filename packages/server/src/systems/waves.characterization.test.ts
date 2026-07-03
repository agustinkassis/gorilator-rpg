import {
  AnimState,
  GameState,
  GOBLIN_SPAWN_RANGE,
  House,
  HOUSE_COLLISION_RADIUS,
  Player,
  WAVE_SPAWN_DISTANCE,
} from "@rpg/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDevTuning, setDevTuning } from "./devTuning";
import { forceNextWave, makeGoblin, previousWave, resetWaves, waveSystem } from "./goblins";
import { serverPluginHost } from "./plugins/host";
import { installFixedRng } from "./rng";

// Characterization suite for the tower-defense wave scheduler. These assertions
// must pass UNCHANGED after the #73 extraction moves the scheduler into
// plugins/la-crypta-defense — only the import line may change.
//
// Tuning is pinned to small round numbers so pacing runs in a few simulated
// seconds; the seeded RNG is pinned to 0.5 so sizes/levels/delays are exact:
//   wave size  = base(3) + perPlayer(1)·alive + perWave(2)·(n−1), cap 6
//   level      = lo + floor(0.5·(hi−lo+1)),  lo=max(1,round(avg)), hi=max+floor(n/3)
//   delays     = [0, spread, 0.5·spread…] sorted → [0, 200, 200, 200, 400]
//   rest after wave n = min(6500, 5000 + 1000·(n−1))

const TICK = 0.1; // 100ms steps

function makePlayer(id: string, level: number): Player {
  const p = new Player();
  p.id = id;
  p.x = 0;
  p.z = 5;
  p.hp = 100;
  p.maxHp = 100;
  p.level = level;
  p.state = AnimState.IDLE;
  return p;
}

function makeWorld(levels: number[] = [2, 6]): GameState {
  const state = new GameState();
  installFixedRng(state, 0.5);
  const house = new House();
  house.id = "house-0";
  house.x = 0;
  house.z = 0;
  house.radius = HOUSE_COLLISION_RADIUS;
  house.maxHp = 300;
  house.hp = 300;
  house.alive = true;
  state.houses.set(house.id, house);
  levels.forEach((lvl, i) => {
    const p = makePlayer(`p${i + 1}`, lvl);
    state.players.set(p.id, p);
  });
  return state;
}

function tick(state: GameState, n = 1) {
  for (let i = 0; i < n; i++) waveSystem(state, TICK);
}

function waveEnemies(state: GameState, waveNumber: number) {
  const out: Array<{ level: number; kind: string; brain: string; x: number; z: number }> = [];
  state.enemies.forEach((e) => {
    if (e.waveNumber === waveNumber) out.push({ level: e.level, kind: e.kind, brain: e.brain, x: e.x, z: e.z });
  });
  return out;
}

describe("wave scheduler characterization", () => {
  beforeEach(() => {
    resetDevTuning();
    setDevTuning("waveFirstDelayMs", 1000);
    setDevTuning("waveSpawnSpreadMs", 400);
    setDevTuning("waveIntervalBaseMs", 5000);
    setDevTuning("waveIntervalStepMs", 1000);
    setDevTuning("waveIntervalMaxMs", 6500);
    setDevTuning("waveSizeBase", 3);
    setDevTuning("waveSizePerPlayer", 1);
    setDevTuning("waveSizePerWave", 2);
    setDevTuning("waveSizeMax", 6);
    setDevTuning("goblinLiveCap", 8);
  });
  afterEach(() => {
    resetDevTuning();
    serverPluginHost.reset();
  });

  it("waits waveFirstDelayMs, then schedules wave 1 and spreads spawns over waveSpawnSpreadMs", () => {
    const state = makeWorld();
    tick(state, 9); // 900ms — still inside the grace
    expect(state.waveNumber).toBe(0);
    expect(state.waveTimerMs).toBeCloseTo(100, 5);
    expect(state.enemies.size).toBe(0);

    tick(state); // 1000ms — wave 1 scheduled, rest timer restarts
    expect(state.waveNumber).toBe(1);
    expect(state.waveTimerMs).toBe(5000);
    expect(state.waveActive).toBe(true);
    expect(state.enemies.size).toBe(0); // queued, not yet spawned

    tick(state); // delay-0 unit lands
    expect(state.enemies.size).toBe(1);
    tick(state); // the three 200ms units land
    expect(state.enemies.size).toBe(4);
    tick(state, 2); // the 400ms straggler lands
    expect(state.enemies.size).toBe(5); // size = 3 + 1·2 + 2·0

    for (const e of waveEnemies(state, 1)) {
      expect(e.kind).toBe("goblin");
      expect(e.brain).toBe("attacks_home");
      // lo=round(avg(2,6))=4, hi=max(6)+floor(1/3)=6 → 4+floor(0.5·3)=5
      expect(e.level).toBe(5);
      const d = Math.hypot(e.x, e.z);
      expect(d).toBeGreaterThan(WAVE_SPAWN_DISTANCE * 0.5); // a long march out…
      expect(d).toBeLessThanOrEqual(GOBLIN_SPAWN_RANGE * Math.SQRT2 + 0.001); // …within the world
    }
  });

  it("fires wave:start on the activity edge and wave:end when the wave dies out", () => {
    const state = makeWorld();
    const started: unknown[] = [];
    const ended: unknown[] = [];
    serverPluginHost.on("wave:start", (payload) => started.push(payload));
    serverPluginHost.on("wave:end", (payload) => ended.push(payload));

    tick(state, 16); // schedule + fully spawn wave 1
    expect(started).toEqual([{ wave: 1 }]);
    expect(ended).toEqual([]);

    state.enemies.forEach((e) => {
      e.hp = 0;
      e.state = AnimState.DEAD;
    });
    tick(state);
    expect(ended).toEqual([{ wave: 1 }]);
    expect(state.waveActive).toBe(false);
    expect(started).toHaveLength(1); // no re-fire while inactive
  });

  it("freezes the countdown when nobody can defend or waves are admin-disabled", () => {
    const state = makeWorld();
    tick(state, 5);
    const held = state.waveTimerMs;

    state.players.forEach((p) => {
      p.hp = 0;
      p.state = AnimState.DEAD;
    });
    tick(state, 10);
    expect(state.waveTimerMs).toBeCloseTo(held, 5);
    expect(state.waveNumber).toBe(0);

    state.players.forEach((p) => {
      p.hp = 100;
      p.state = AnimState.IDLE;
    });
    state.wavesEnabled = false;
    tick(state, 10);
    expect(state.waveTimerMs).toBeCloseTo(held, 5);
  });

  it("caps wave size at waveSizeMax and scales it with alive players + wave number", () => {
    const state = makeWorld();
    setDevTuning("waveIntervalBaseMs", 200); // shorten the rest so wave 2 arrives fast
    setDevTuning("waveIntervalStepMs", 0);
    tick(state, 16); // wave 1 fully out (5 goblins)
    expect(waveEnemies(state, 1)).toHaveLength(5);

    state.enemies.forEach((e) => {
      e.hp = 0;
      e.state = AnimState.DEAD; // clear the live-cap path for wave 2
    });
    tick(state, 12); // rest elapses + wave 2 spreads out
    // size = 3 + 1·2 + 2·1 = 7 → capped at 6
    expect(waveEnemies(state, 2)).toHaveLength(6);
  });

  it("excludes dead players from the difficulty inputs", () => {
    const state = makeWorld([2, 6]);
    const p2 = state.players.get("p2");
    if (p2) {
      p2.hp = 0;
      p2.state = AnimState.DEAD;
    }
    tick(state, 16);
    const wave = waveEnemies(state, 1);
    expect(wave).toHaveLength(4); // 3 + 1·1 + 0
    for (const e of wave) expect(e.level).toBe(2); // lo=hi=2 (only the level-2 defender counts)
  });

  it("holds the next wave while the live-goblin count is at the cap", () => {
    const state = makeWorld();
    setDevTuning("goblinLiveCap", 3);
    for (let i = 0; i < 3; i++) makeGoblin(state, 20 + i, 20, 1);
    tick(state, 10); // the first-wave grace elapses at the cap
    expect(state.waveNumber).toBe(0); // skipped — no wave scheduled
    expect(state.enemies.size).toBe(3);
    expect(state.waveTimerMs).toBe(5000); // rest timer restarted anyway
  });

  it("grows the rest interval per wave and caps it: 5000 → 6000 → 6500", () => {
    const state = makeWorld();
    forceNextWave(state);
    expect(state.waveTimerMs).toBe(5000);
    forceNextWave(state);
    expect(state.waveTimerMs).toBe(6000);
    forceNextWave(state);
    expect(state.waveTimerMs).toBe(6500);
    forceNextWave(state);
    expect(state.waveTimerMs).toBe(6500); // capped
  });

  it("escalates the wave level cap over time (wave 3 rolls above the top defender)", () => {
    const state = makeWorld();
    forceNextWave(state);
    forceNextWave(state);
    forceNextWave(state); // wave 3: hi = 6 + floor(3/3) = 7 → 4+floor(0.5·4) = 6
    const wave3 = waveEnemies(state, 3);
    expect(wave3.length).toBeGreaterThan(0); // the delay-0 unit spawns synchronously
    for (const e of wave3) expect(e.level).toBe(6);
  });

  it("forceNextWave advances immediately; previousWave rewinds and drops the queue", () => {
    const state = makeWorld();
    forceNextWave(state);
    expect(state.waveNumber).toBe(1);
    const spawned = state.enemies.size;
    expect(spawned).toBeGreaterThan(0); // the delay-0 unit is already out

    previousWave(state);
    expect(state.waveNumber).toBe(0);
    expect(state.waveTimerMs).toBe(5000); // intervalAfterWave(0)
    tick(state, 10); // queued spawns were dropped — nothing else lands
    expect(state.enemies.size).toBe(spawned);

    previousWave(state); // no-op at wave 0
    expect(state.waveNumber).toBe(0);
  });

  it("resetWaves restarts the clock for a fresh round", () => {
    const state = makeWorld();
    forceNextWave(state);
    resetWaves(state);
    expect(state.waveNumber).toBe(0);
    expect(state.waveTimerMs).toBe(1000); // back to the first-wave grace
    expect(state.waveActive).toBe(false);
  });
});
