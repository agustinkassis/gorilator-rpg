import { AnimState, type GameState } from "@rpg/shared";
import type { DevTuningValues } from "./devTuning";

/**
 * Per-event difficulty math (#64). Wave size and enemy levels scale with the
 * LIVE players — which means persistent veterans (progression survives wipes)
 * make fresh realm cycles brutal for newcomers. These knobs are the operator's
 * relief valve, all live-tunable (realm.json `tuning`, scenario manifests,
 * the Dev Mode sliders, `dev_tune`):
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
  tuning: DevTuningValues,
  eventMult = 1,
): WaveDifficulty {
  const { avg, max, alive } = playerLevelStats(state);
  const mult = Number.isFinite(eventMult) && eventMult > 0 ? eventMult : 1;

  const rawSize =
    tuning.waveSizeBase +
    tuning.waveSizePerPlayer * Math.max(1, alive) +
    tuning.waveSizePerWave * (waveNumber - 1);
  const size = Math.min(tuning.waveSizeMax, Math.round(rawSize * tuning.difficultySizeScale * mult));

  let levelLo = Math.max(1, Math.round(avg));
  // Legacy escalation is floor(wave/3); the scale stretches or flattens it.
  let levelHi =
    Math.max(levelLo, max) + Math.floor((waveNumber / 3) * tuning.difficultyLevelScale * mult);
  const cap = Math.round(tuning.difficultyLevelCap);
  if (cap > 0) {
    levelHi = Math.min(levelHi, cap);
    levelLo = Math.min(levelLo, levelHi);
  }
  return { size, levelLo, levelHi, alive };
}
