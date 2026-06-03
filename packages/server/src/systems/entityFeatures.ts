import { existsSync, readFileSync, watchFile } from "fs";
import { resolve } from "path";
import {
  BrainId,
  CharacterStatsConfig,
  DropRuleConfig,
  EntityFeatureConfig,
  EntityFeatureManifest,
  DUMMY_MAX_HP,
  DUMMY_ATTACK,
  DUMMY_ARMOR,
  DUMMY_CRIT_CHANCE,
  GOBLIN_MAX_HP,
  GOBLIN_ATTACK,
  GOBLIN_ARMOR,
  GOBLIN_CRIT_CHANCE,
  GOBLIN_CHASE_SPEED,
  PLAYER_MAX_HP,
  PLAYER_ATTACK,
  PLAYER_ARMOR,
  PLAYER_CRIT_CHANCE,
  MOVE_SPEED,
  TREE_HP,
  ROCK_HP,
  HOUSE_HP,
} from "@rpg/shared";

const PUBLIC_DIRS = [
  resolve(process.cwd(), "packages/client/public"),
  resolve(process.cwd(), "../client/public"),
  resolve(process.cwd(), "client/public"),
];

function file(): string | null {
  const d = PUBLIC_DIRS.find((p) => existsSync(p));
  return d ? resolve(d, "entity-features.json") : null;
}

const DEFAULTS: Required<Pick<EntityFeatureManifest, "defaults" | "instances">> = {
  defaults: {
    tree: {
      hp: TREE_HP,
      drops: [{ item: "log", quantity: 1, probability: 1, trigger: "kill" }],
    },
    rock: {
      hp: ROCK_HP,
      drops: [{ item: "stone", quantity: 11, probability: 1, trigger: "damage" }],
    },
    house: {
      hp: HOUSE_HP,
      drops: [],
    },
    dummy: {
      brain: "idle",
      hp: DUMMY_MAX_HP,
      stats: {
        maxHp: DUMMY_MAX_HP,
        attack: DUMMY_ATTACK,
        armor: DUMMY_ARMOR,
        critChance: DUMMY_CRIT_CHANCE,
        moveSpeed: 0,
        throwPower: 1,
        level: 1,
      },
      drops: [],
    },
    goblin: {
      brain: "attacks_home",
      hp: GOBLIN_MAX_HP,
      stats: {
        maxHp: GOBLIN_MAX_HP,
        attack: GOBLIN_ATTACK,
        armor: GOBLIN_ARMOR,
        critChance: GOBLIN_CRIT_CHANCE,
        moveSpeed: GOBLIN_CHASE_SPEED,
        throwPower: 1,
        level: 2,
      },
      drops: [
        { item: "potion", quantity: 1, probability: 0.6, trigger: "kill" },
        { item: "berserker_potion", quantity: 1, probability: 0.16, trigger: "kill" },
      ],
    },
    npc: {
      brain: "idle",
      hp: DUMMY_MAX_HP,
      stats: {
        maxHp: DUMMY_MAX_HP,
        attack: DUMMY_ATTACK,
        armor: DUMMY_ARMOR,
        critChance: DUMMY_CRIT_CHANCE,
        moveSpeed: MOVE_SPEED * 0.8,
        throwPower: 1,
        level: 1,
      },
      drops: [],
    },
    player: {
      hp: PLAYER_MAX_HP,
      stats: {
        maxHp: PLAYER_MAX_HP,
        attack: PLAYER_ATTACK,
        armor: PLAYER_ARMOR,
        critChance: PLAYER_CRIT_CHANCE,
        moveSpeed: MOVE_SPEED,
        throwPower: 1,
        level: 1,
      },
    },
  },
  instances: {},
};

let manifest: EntityFeatureManifest = {};
let onChange: (() => void) | null = null;

function applyFrom(path: string): void {
  try {
    manifest = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) || {} : {};
    console.log(
      `[entityFeatures] ${Object.keys(manifest.defaults ?? {}).length} default(s), ` +
        `${Object.keys(manifest.instances ?? {}).length} instance override(s) loaded`,
    );
  } catch (e) {
    console.warn("[entityFeatures] failed to read entity-features.json", e);
  }
}

export function loadEntityFeatures(cb?: () => void): void {
  onChange = cb ?? null;
  const path = file();
  if (!path) {
    onChange?.();
    return;
  }
  applyFrom(path);
  onChange?.();
  watchFile(path, { interval: 1500 }, () => {
    applyFrom(path);
    onChange?.();
  });
}

function mergeFeature(kind: string, id?: string, modelId?: string): EntityFeatureConfig {
  const defaults = manifest.defaults ?? {};
  const instances = manifest.instances ?? {};
  const chain = [
    DEFAULTS.defaults[kind],
    defaults[kind],
    modelId ? defaults[modelId] : undefined,
    id ? instances[id] : undefined,
  ].filter(Boolean) as EntityFeatureConfig[];
  const out: EntityFeatureConfig = {};
  for (const cfg of chain) {
    if (cfg.hp !== undefined) out.hp = Number(cfg.hp);
    if (cfg.brain) out.brain = cfg.brain;
    if (cfg.drops) out.drops = cfg.drops;
    if (cfg.stats) out.stats = { ...(out.stats ?? {}), ...cfg.stats };
  }
  return out;
}

export function entityFeature(kind: string, id?: string, modelId?: string): EntityFeatureConfig {
  return mergeFeature(kind, id, modelId);
}

export function entityHp(kind: string, id: string | undefined, modelId: string | undefined, fallback: number): number {
  const hp = entityFeature(kind, id, modelId).hp;
  if (hp === undefined || !Number.isFinite(hp)) return fallback;
  return Math.max(0, Math.round(hp));
}

export function entityBrain(
  kind: string,
  id?: string,
  modelId?: string,
  fallback: BrainId = "idle",
): BrainId {
  return entityFeature(kind, id, modelId).brain ?? fallback;
}

export function entityStats(kind: string, id?: string, modelId?: string): CharacterStatsConfig {
  return entityFeature(kind, id, modelId).stats ?? {};
}

export function entityDrops(kind: string, id?: string, modelId?: string): DropRuleConfig[] {
  return normalizeDrops(entityFeature(kind, id, modelId).drops ?? []);
}

export function normalizeDrops(rules: DropRuleConfig[]): DropRuleConfig[] {
  return rules
    .slice(0, 40)
    .map<DropRuleConfig>((r) => ({
      item: String(r.item || "stone"),
      quantity: Math.max(0, Math.round(Number(r.quantity) || 0)),
      probability: Math.max(0, Math.min(1, Number(r.probability) || 0)),
      trigger: r.trigger === "damage" ? "damage" : "kill",
    }))
    .filter((r) => r.quantity > 0 && r.probability > 0);
}
