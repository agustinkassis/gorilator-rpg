import {
  type DevTuningKey,
  WAVE_FIRST_DELAY_MS,
  WAVE_INTERVAL_BASE_MS,
  WAVE_INTERVAL_STEP_MS,
  WAVE_INTERVAL_MAX_MS,
  WAVE_SPAWN_SPREAD_MS,
  WAVE_SIZE_BASE,
  WAVE_SIZE_PER_PLAYER,
  WAVE_SIZE_PER_WAVE,
  WAVE_SIZE_MAX,
  GOBLIN_LIVE_CAP,
  ATTACK_COOLDOWN_MS,
  ATTACK_WINDUP_MS,
  GOBLIN_ATTACK_COOLDOWN_MS,
  GOBLIN_ATTACK_WINDUP_MS,
  GOBLIN_ATTACK_RANGE,
  GOBLIN_AGGRO_RADIUS,
  GOBLIN_DEAGGRO_RADIUS,
  GOBLIN_HOUSE_DAMAGE,
  DAMAGE_DIVISOR,
  PLAYER_RESPAWN_MS,
} from "@rpg/shared";

export type DevTuningValues = Record<DevTuningKey, number>;

export const devTuningDefaults: DevTuningValues = {
  waveFirstDelayMs: WAVE_FIRST_DELAY_MS,
  waveIntervalBaseMs: WAVE_INTERVAL_BASE_MS,
  waveIntervalStepMs: WAVE_INTERVAL_STEP_MS,
  waveIntervalMaxMs: WAVE_INTERVAL_MAX_MS,
  waveSpawnSpreadMs: WAVE_SPAWN_SPREAD_MS,
  waveSizeBase: WAVE_SIZE_BASE,
  waveSizePerPlayer: WAVE_SIZE_PER_PLAYER,
  waveSizePerWave: WAVE_SIZE_PER_WAVE,
  waveSizeMax: WAVE_SIZE_MAX,
  goblinLiveCap: GOBLIN_LIVE_CAP,
  playerAttackCooldownMs: ATTACK_COOLDOWN_MS,
  playerAttackWindupMs: ATTACK_WINDUP_MS,
  enemyAttackCooldownMs: GOBLIN_ATTACK_COOLDOWN_MS,
  enemyAttackWindupMs: GOBLIN_ATTACK_WINDUP_MS,
  enemyAttackRange: GOBLIN_ATTACK_RANGE,
  enemyAggroRadius: GOBLIN_AGGRO_RADIUS,
  enemyDeaggroRadius: GOBLIN_DEAGGRO_RADIUS,
  goblinHouseDamage: GOBLIN_HOUSE_DAMAGE,
  damageDivisor: DAMAGE_DIVISOR,
  playerRespawnMs: PLAYER_RESPAWN_MS,
};

const rules: Record<DevTuningKey, { min: number; max: number; integer?: boolean }> = {
  waveFirstDelayMs: { min: 0, max: 600_000, integer: true },
  waveIntervalBaseMs: { min: 0, max: 900_000, integer: true },
  waveIntervalStepMs: { min: 0, max: 300_000, integer: true },
  waveIntervalMaxMs: { min: 0, max: 1_800_000, integer: true },
  waveSpawnSpreadMs: { min: 0, max: 300_000, integer: true },
  waveSizeBase: { min: 0, max: 200, integer: true },
  waveSizePerPlayer: { min: 0, max: 50, integer: true },
  waveSizePerWave: { min: 0, max: 50, integer: true },
  waveSizeMax: { min: 1, max: 500, integer: true },
  goblinLiveCap: { min: 0, max: 500, integer: true },
  playerAttackCooldownMs: { min: 0, max: 10_000, integer: true },
  playerAttackWindupMs: { min: 0, max: 5_000, integer: true },
  enemyAttackCooldownMs: { min: 0, max: 20_000, integer: true },
  enemyAttackWindupMs: { min: 0, max: 10_000, integer: true },
  enemyAttackRange: { min: 0.2, max: 20 },
  enemyAggroRadius: { min: 0, max: 80 },
  enemyDeaggroRadius: { min: 0, max: 120 },
  goblinHouseDamage: { min: 0, max: 1_000 },
  damageDivisor: { min: 0.1, max: 100 },
  playerRespawnMs: { min: 0, max: 120_000, integer: true },
};

let current: DevTuningValues = { ...devTuningDefaults };

export function devTuning(): DevTuningValues {
  return current;
}

export function setDevTuning(key: DevTuningKey, raw: number): number | null {
  const rule = rules[key];
  if (!rule) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const clamped = Math.max(rule.min, Math.min(rule.max, n));
  current[key] = rule.integer ? Math.round(clamped) : clamped;
  return current[key];
}

export function resetDevTuning(): DevTuningValues {
  current = { ...devTuningDefaults };
  return current;
}
