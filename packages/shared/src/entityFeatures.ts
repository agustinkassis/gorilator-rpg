export type BrainId = "idle" | "passive_patrol" | "war_seeker" | "attacks_home";

export interface CharacterStatsConfig {
  maxHp?: number;
  attack?: number;
  armor?: number;
  critChance?: number;
  moveSpeed?: number;
  throwPower?: number;
  level?: number;
  xp?: number;
}

export interface DropRuleConfig {
  item: string;
  quantity: number;
  probability: number;
  trigger: "kill" | "damage";
}

export interface SpawnRuleConfig {
  id: string;
  ownerId: string;
  type: string;
  modelId?: string;
  label?: string;
  intervalMs: number;
  cap: number;
  brain?: BrainId;
  stats?: CharacterStatsConfig;
}

export interface EntityFeatureConfig {
  hp?: number;
  brain?: BrainId;
  drops?: DropRuleConfig[];
  stats?: CharacterStatsConfig;
}

export interface EntityFeatureManifest {
  defaults?: Record<string, EntityFeatureConfig>;
  instances?: Record<string, EntityFeatureConfig>;
}
