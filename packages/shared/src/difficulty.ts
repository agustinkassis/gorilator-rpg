import type { GameState } from "./schema/GameState";
import { AnimState, type DevTuningKey } from "./types";

/**
 * Per-event difficulty math (#64) — shared so both the core and event-module
 * plugins (which compile against @rpg/shared only) use the same curve. Wave
 * size and enemy levels scale with the LIVE players — which means persistent
 * veterans (progression survives wipes) make fresh realm cycles brutal for
 * newcomers. These knobs are the operator's relief valve, all live-tunable
 * (realm.json `tuning`, scenario manifests, the Dev Mode sliders, `dev_tune`):
 *
 *   difficultySizeScale   ×N on the wave size (before the waveSizeMax cap)
 *   difficultyLevelScale  ×N on the per-wave level-cap escalation (0 = never escalate)
 *   difficultyLevelCap    hard ceiling on spawned enemy levels (0 = uncapped)
 *
 * An event module may layer its own multiplier on top via its config block
 * (realm.json `events.config.difficultyMult`) — passed here as `eventMult`.
 * At the defaults (1 / 1 / 0, eventMult 1) every formula reduces EXACTLY to
 * the legacy behavior pinned by waves.characterization.test.ts.
 */

/** Read one live tuning knob (the server passes `(k) => devTuning()[k]`;
 *  event modules pass `ctx.tuning`). */
export type TuningReader = (key: DevTuningKey) => number;

/** Average + top level across the LIVE players — the wave difficulty inputs
 *  (more/higher-level defenders → bigger, stronger waves). */
export function playerLevelStats(state: GameState): { avg: number; max: number; alive: number } {
  let sum = 0;
  let max = 1;
  let alive = 0;
  state.players.forEach((p) => {
    if (p.hp <= 0 || p.state === AnimState.DEAD) return;
    alive++;
    sum += p.level;
    if (p.level > max) max = p.level;
  });
  return { avg: alive > 0 ? sum / alive : 1, max, alive };
}

export interface WaveDifficulty {
  size: number; // units in this wave (already capped at waveSizeMax)
  levelLo: number; // inclusive level roll range for spawned units
  levelHi: number;
  alive: number; // live defenders (callers use it to freeze the clock)
}

export function waveDifficulty(
  state: GameState,
  waveNumber: number,
  tune: TuningReader,
  eventMult = 1,
): WaveDifficulty {
  const { avg, max, alive } = playerLevelStats(state);
  const mult = Number.isFinite(eventMult) && eventMult > 0 ? eventMult : 1;

  const rawSize =
    tune("waveSizeBase") +
    tune("waveSizePerPlayer") * Math.max(1, alive) +
    tune("waveSizePerWave") * (waveNumber - 1);
  const size = Math.min(tune("waveSizeMax"), Math.round(rawSize * tune("difficultySizeScale") * mult));

  let levelLo = Math.max(1, Math.round(avg));
  // Legacy escalation is floor(wave/3); the scale stretches or flattens it.
  let levelHi =
    Math.max(levelLo, max) + Math.floor((waveNumber / 3) * tune("difficultyLevelScale") * mult);
  const cap = Math.round(tune("difficultyLevelCap"));
  if (cap > 0) {
    levelHi = Math.min(levelHi, cap);
    levelLo = Math.min(levelLo, levelHi);
  }
  return { size, levelLo, levelHi, alive };
}
