import {
  CRIT_CHANCE_MAX,
  MOVE_SPEED,
  PLAYER_ARMOR,
  PLAYER_ARMOR_PER_LEVEL,
  PLAYER_ATTACK,
  PLAYER_ATTACK_PER_LEVEL,
  PLAYER_CRIT_CHANCE,
  PLAYER_CRIT_PER_LEVEL,
  PLAYER_HP_PER_LEVEL,
  PLAYER_MAX_HP,
  PLAYER_SPEED_PER_LEVEL,
  Player,
  XP_DEATH_PENALTY,
  xpForLevel,
} from "@rpg/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { applyDeathXpPenalty, applyLevelStats } from "./leveling";
import { resetRealmPolicy, setRealmPolicy } from "./policy";

// Characterization tests for the death penalty: they pin today's 30%-of-total-XP
// math first (so the policy refactor demonstrably changed nothing by default),
// then cover the new realm-policy modes.

/** Total XP banked at `level` with `xp` progress (mirrors leveling.ts). */
function totalXp(level: number, xp: number): number {
  let sum = xp;
  for (let l = 1; l < level; l++) sum += xpForLevel(l);
  return sum;
}

/** Level + progress a total-XP amount re-derives to (independent walk). */
function deriveLevel(total: number): { level: number; xp: number } {
  let remaining = total;
  let level = 1;
  while (remaining >= xpForLevel(level)) {
    remaining -= xpForLevel(level);
    level += 1;
  }
  return { level, xp: Math.floor(remaining) };
}

/** A player whose stats are exactly what its level would have granted. */
function makeLeveledPlayer(level: number, xp: number): Player {
  const p = new Player();
  p.id = "p1";
  p.level = level;
  p.xp = xp;
  applyLevelStats(p);
  p.hp = p.maxHp;
  return p;
}

beforeEach(() => {
  resetRealmPolicy();
});

describe("applyLevelStats", () => {
  it("derives stats as base + per-level growth", () => {
    const p = makeLeveledPlayer(5, 0);
    expect(p.maxHp).toBe(PLAYER_MAX_HP + 4 * PLAYER_HP_PER_LEVEL);
    expect(p.attack).toBe(PLAYER_ATTACK + 4 * PLAYER_ATTACK_PER_LEVEL);
    expect(p.armor).toBe(PLAYER_ARMOR + 4 * PLAYER_ARMOR_PER_LEVEL);
    expect(p.critChance).toBe(Math.min(CRIT_CHANCE_MAX, PLAYER_CRIT_CHANCE + 4 * PLAYER_CRIT_PER_LEVEL));
    expect(p.moveSpeed).toBe(MOVE_SPEED + 4 * PLAYER_SPEED_PER_LEVEL);
  });

  it("level 1 means exactly the base stats", () => {
    const p = makeLeveledPlayer(1, 0);
    expect(p.maxHp).toBe(PLAYER_MAX_HP);
    expect(p.attack).toBe(PLAYER_ATTACK);
    expect(p.armor).toBe(PLAYER_ARMOR);
  });
});

describe("applyDeathXpPenalty — default policy (characterization)", () => {
  it("loses XP_DEATH_PENALTY of TOTAL XP and re-derives level + progress", () => {
    const p = makeLeveledPlayer(5, 50);
    const expected = deriveLevel(totalXp(5, 50) * (1 - XP_DEATH_PENALTY));
    applyDeathXpPenalty(p);
    expect(p.level).toBe(expected.level);
    expect(p.xp).toBe(expected.xp);
  });

  it("de-levels across a boundary and sheds the lost levels' stats", () => {
    // Level 2 with zero progress: 30% off total drops below the level-2 threshold.
    const p = makeLeveledPlayer(2, 0);
    applyDeathXpPenalty(p);
    expect(p.level).toBe(1);
    expect(p.maxHp).toBe(PLAYER_MAX_HP);
    expect(p.attack).toBe(PLAYER_ATTACK);
    expect(p.armor).toBe(PLAYER_ARMOR);
  });

  it("a level-1 player with no XP stays level 1", () => {
    const p = makeLeveledPlayer(1, 0);
    applyDeathXpPenalty(p);
    expect(p.level).toBe(1);
    expect(p.xp).toBe(0);
  });
});

describe("applyDeathXpPenalty — policy modes", () => {
  it('"none" leaves the player untouched', () => {
    setRealmPolicy({ death: { mode: "none" } });
    const p = makeLeveledPlayer(5, 50);
    const before = { level: p.level, xp: p.xp, maxHp: p.maxHp, attack: p.attack };
    applyDeathXpPenalty(p);
    expect({ level: p.level, xp: p.xp, maxHp: p.maxHp, attack: p.attack }).toEqual(before);
  });

  it('"hardcore" resets to a level-1 character with base stats', () => {
    setRealmPolicy({ death: { mode: "hardcore" } });
    const p = makeLeveledPlayer(8, 200);
    applyDeathXpPenalty(p);
    expect(p.level).toBe(1);
    expect(p.xp).toBe(0);
    expect(p.maxHp).toBe(PLAYER_MAX_HP);
    expect(p.attack).toBe(PLAYER_ATTACK);
    expect(p.armor).toBe(PLAYER_ARMOR);
    expect(p.critChance).toBe(PLAYER_CRIT_CHANCE);
    expect(p.moveSpeed).toBe(MOVE_SPEED);
  });

  it("xpPenalty 0 keeps level and progress intact", () => {
    setRealmPolicy({ death: { xpPenalty: 0 } });
    const p = makeLeveledPlayer(5, 50);
    applyDeathXpPenalty(p);
    expect(p.level).toBe(5);
    expect(p.xp).toBe(50);
  });

  it("xpPenalty 1 wipes all XP back to level 1", () => {
    setRealmPolicy({ death: { xpPenalty: 1 } });
    const p = makeLeveledPlayer(5, 50);
    applyDeathXpPenalty(p);
    expect(p.level).toBe(1);
    expect(p.xp).toBe(0);
    expect(p.maxHp).toBe(PLAYER_MAX_HP);
  });

  it("a custom fraction applies instead of the constant", () => {
    setRealmPolicy({ death: { xpPenalty: 0.1 } });
    const p = makeLeveledPlayer(6, 10);
    const expected = deriveLevel(totalXp(6, 10) * 0.9);
    applyDeathXpPenalty(p);
    expect(p.level).toBe(expected.level);
    expect(p.xp).toBe(expected.xp);
  });
});
