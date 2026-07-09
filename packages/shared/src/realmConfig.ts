import type { DevTuningKey } from "./types";

/** Death policy names accepted in `realm.json` and Feature Lab scenario overlays. */
export const REALM_DEATH_MODES = ["none", "xp-penalty", "hardcore"] as const;
export type RealmDeathMode = (typeof REALM_DEATH_MODES)[number];

/**
 * Gameplay tuning keys that a realm can seed at room creation. This mirrors
 * `DevTuningKey`; the type assertion below makes `pnpm typecheck` fail if a
 * new live tuning key is added without deciding whether realm config supports it.
 */
export const REALM_TUNING_KEYS = [
  "waveFirstDelayMs",
  "waveIntervalBaseMs",
  "waveIntervalStepMs",
  "waveIntervalMaxMs",
  "waveSpawnSpreadMs",
  "waveSizeBase",
  "waveSizePerPlayer",
  "waveSizePerWave",
  "waveSizeMax",
  "goblinLiveCap",
  "playerAttackCooldownMs",
  "playerAttackWindupMs",
  "enemyAttackCooldownMs",
  "enemyAttackWindupMs",
  "enemyAttackRange",
  "enemyAggroRadius",
  "enemyDeaggroRadius",
  "goblinHouseDamage",
  "damageDivisor",
  "playerRespawnMs",
  "playerMaxHp",
  "playerAttack",
  "playerArmor",
  "playerCritChance",
  "playerMoveSpeed",
  "sprintSpeedMult",
  "hungerDrainPerMin",
  "starvationDamagePerSec",
  "foodHungerMult",
  "foodHpMult",
  "foodStaminaMult",
  "enemyMaxHp",
  "enemyAttack",
  "enemyMoveSpeed",
  "berserkerAttackMult",
  "berserkerDurationMs",
  "dropRateMult",
  "difficultySizeScale",
  "difficultyLevelScale",
  "difficultyLevelCap",
] as const satisfies readonly DevTuningKey[];

type AssertNever<T extends never> = T;
type _RealmTuningKeysCoverDevTuning = AssertNever<
  Exclude<DevTuningKey, (typeof REALM_TUNING_KEYS)[number]>
>;

export interface RealmPolicy {
  death: {
    /** What dying costs: nothing, a slice of total XP, or the whole character. */
    mode: RealmDeathMode;
    /** Fraction of TOTAL XP lost in "xp-penalty" mode (0..1). */
    xpPenalty: number;
  };
  progression: {
    /** Keep level/XP/stats when the realm wipes (La Crypta falls). */
    persistAcrossWipes: boolean;
    /** Keep inventories across a wipe (only meaningful with persistAcrossWipes). */
    keepInventoryOnWipe: boolean;
  };
}

/** Operator-authored subset of `RealmPolicy`; omitted fields use server defaults. */
export interface RealmPolicyConfig {
  death?: Partial<RealmPolicy["death"]>;
  progression?: Partial<RealmPolicy["progression"]>;
}

/** Initial values for the live Gameplay Options knobs. */
export type RealmTuningConfig = Partial<Record<DevTuningKey, number>>;

/** Per-realm plugin controls. */
export interface RealmPluginsConfig {
  disabled?: string[];
}

/** Open-realm / event-objective switches for a realm or scenario overlay. */
export interface RealmWorldConfig {
  homeObjective?: boolean;
  waves?: boolean;
}

/** Pluggable realm event controls. */
export interface RealmEventsConfig {
  enabled?: boolean | string[];
  autoStart?: boolean;
  module?: string;
  config?: Record<string, unknown>;
}

/**
 * The root `realm.json` shape. This is per-realm/per-fork configuration, not
 * saved player state: it seeds plugins, tuning, and death/progression policy
 * before a room starts. Runtime validation lives in `scripts/check-realm.mjs`
 * and is mandatory through the root `pnpm typecheck` script.
 */
export interface RealmConfig {
  name?: string;
  plugins?: RealmPluginsConfig;
  world?: RealmWorldConfig;
  events?: RealmEventsConfig;
  tuning?: RealmTuningConfig;
  policy?: RealmPolicyConfig;
}
