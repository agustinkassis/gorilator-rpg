import {
  AnimState,
  BrainId,
  CharacterStatsConfig,
  Enemy,
  DUMMY_ATTACK,
  DUMMY_ARMOR,
  DUMMY_CRIT_CHANCE,
  DUMMY_LEVEL,
  DUMMY_MAX_HP,
  GOBLIN_ATTACK,
  GOBLIN_ARMOR,
  GOBLIN_CHASE_SPEED,
  GOBLIN_CRIT_CHANCE,
  GOBLIN_LEVEL,
  GOBLIN_MAX_HP,
  SPEED_PER_LEVEL,
  THROW_POWER_PER_LEVEL,
  statsForLevel,
} from "@rpg/shared";
import { entityBrain, entityFeature, entityStats } from "./entityFeatures";

const KIND_DEFAULTS: Record<string, {
  level: number;
  maxHp: number;
  attack: number;
  armor: number;
  critChance: number;
  moveSpeed: number;
  throwPower: number;
  brain: BrainId;
}> = {
  goblin: {
    level: GOBLIN_LEVEL,
    maxHp: GOBLIN_MAX_HP,
    attack: GOBLIN_ATTACK,
    armor: GOBLIN_ARMOR,
    critChance: GOBLIN_CRIT_CHANCE,
    moveSpeed: GOBLIN_CHASE_SPEED,
    throwPower: 1,
    brain: "attacks_home",
  },
  dummy: {
    level: DUMMY_LEVEL,
    maxHp: DUMMY_MAX_HP,
    attack: DUMMY_ATTACK,
    armor: DUMMY_ARMOR,
    critChance: DUMMY_CRIT_CHANCE,
    moveSpeed: 0,
    throwPower: 1,
    brain: "idle",
  },
  npc: {
    level: DUMMY_LEVEL,
    maxHp: DUMMY_MAX_HP,
    attack: DUMMY_ATTACK,
    armor: DUMMY_ARMOR,
    critChance: DUMMY_CRIT_CHANCE,
    moveSpeed: GOBLIN_CHASE_SPEED,
    throwPower: 1,
    brain: "idle",
  },
};

export function defaultBrainFor(kind: string): BrainId {
  return KIND_DEFAULTS[kind]?.brain ?? "idle";
}

export function brainOf(e: Enemy): BrainId {
  return (e.brain as BrainId | "") || entityBrain(e.kind, e.id, e.modelId, defaultBrainFor(e.kind));
}

export function configureEnemy(
  e: Enemy,
  opts: {
    kind: string;
    id: string;
    x: number;
    z: number;
    modelId?: string;
    displayName?: string;
    brain?: BrainId;
    stats?: CharacterStatsConfig;
  },
): Enemy {
  const kind = opts.kind || "dummy";
  const defaults = KIND_DEFAULTS[kind] ?? KIND_DEFAULTS.npc;
  const feature = entityFeature(kind, opts.id, opts.modelId);
  const manifestStats = entityStats(kind, opts.id, opts.modelId);
  const stats = { ...manifestStats, ...(opts.stats ?? {}) };
  const level = Math.max(1, Math.round(Number(stats.level ?? defaults.level) || defaults.level));
  const hpBase =
    feature.hp !== undefined
      ? Math.max(0, Number(feature.hp) || 0)
      : Math.max(0, Number(stats.maxHp ?? defaults.maxHp) || defaults.maxHp);

  e.id = opts.id;
  e.kind = kind;
  e.modelId = opts.modelId ?? "";
  e.displayName = opts.displayName ?? "";
  e.brain = opts.brain ?? feature.brain ?? defaults.brain;
  e.x = opts.x;
  e.z = opts.z;
  e.homeX = opts.x;
  e.homeZ = opts.z;
  e.targetX = opts.x;
  e.targetZ = opts.z;
  e.level = level;
  e.xp = Math.max(0, Math.round(Number(stats.xp ?? 0) || 0));

  if (hpBase <= 0) {
    e.hp = 0;
    e.maxHp = 0;
  } else {
    const scaled = statsForLevel(
      {
        maxHp: hpBase,
        attack: Number(stats.attack ?? defaults.attack) || defaults.attack,
        armor: Number(stats.armor ?? defaults.armor) || defaults.armor,
        critChance: Number(stats.critChance ?? defaults.critChance) || defaults.critChance,
      },
      level,
    );
    e.maxHp = scaled.maxHp;
    e.hp = scaled.maxHp;
    e.attack = scaled.attack;
    e.armor = scaled.armor;
    e.critChance = scaled.critChance;
  }
  e.moveSpeed =
    Math.max(0, Number(stats.moveSpeed ?? defaults.moveSpeed) || defaults.moveSpeed) +
    (level - 1) * SPEED_PER_LEVEL;
  e.throwPower =
    Math.max(0, Number(stats.throwPower ?? defaults.throwPower) || defaults.throwPower) +
    (level - 1) * THROW_POWER_PER_LEVEL;
  e.state = brainOf(e) === "idle" ? AnimState.IDLE : AnimState.WALK;
  return e;
}

