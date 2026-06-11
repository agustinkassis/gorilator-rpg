import {
  type GameState,
  type Player,
  type XpEvent,
  xpForLevel,
  CRIT_CHANCE_MAX,
  PLAYER_HP_PER_LEVEL,
  PLAYER_ATTACK_PER_LEVEL,
  PLAYER_ARMOR_PER_LEVEL,
  PLAYER_CRIT_PER_LEVEL,
  PLAYER_SPEED_PER_LEVEL,
  PLAYER_THROW_POWER_PER_LEVEL,
  MOVE_SPEED,
  PLAYER_MAX_HP,
  PLAYER_ATTACK,
  PLAYER_ARMOR,
  PLAYER_CRIT_CHANCE,
  DUMMY_XP_REWARD,
  GOBLIN_XP_REWARD,
  PLAYER_KILL_XP,
  TREE_XP_REWARD,
  ROCK_XP_REWARD,
  STRUCTURE_XP_REWARD,
} from "@rpg/shared";
import { realmPolicy } from "./policy";

/** Sink for XP events so the room can broadcast floating "+N XP" to clients. */
export type EmitXp = (ev: XpEvent) => void;

/**
 * Grant XP and resolve any level-ups (escalating curve). Each level makes the
 * character stronger across the board — more health, attack, armor, crit chance,
 * run speed and throw power — and tops them off. Returns how many levels gained.
 */
export function awardXp(p: Player, amount: number): number {
  if (amount <= 0 || p.maxHp <= 0) return 0;
  p.xp += amount;
  let gained = 0;
  while (p.xp >= xpForLevel(p.level)) {
    p.xp -= xpForLevel(p.level);
    p.level += 1;
    p.maxHp += PLAYER_HP_PER_LEVEL;
    p.attack += PLAYER_ATTACK_PER_LEVEL;
    p.armor += PLAYER_ARMOR_PER_LEVEL;
    p.critChance = Math.min(CRIT_CHANCE_MAX, p.critChance + PLAYER_CRIT_PER_LEVEL);
    p.moveSpeed += PLAYER_SPEED_PER_LEVEL;
    p.throwPower += PLAYER_THROW_POWER_PER_LEVEL;
    p.hp = p.maxHp; // a fresh level restores you to full
    gained += 1;
  }
  return gained;
}

/**
 * Grant XP from an action and surface a floating "+N XP" to clients. Mirrors
 * awardXp's guard so we only pop a number when XP was actually gained.
 */
export function grantXp(p: Player, amount: number, emitXp: EmitXp): number {
  if (amount <= 0 || p.maxHp <= 0) return 0;
  const levels = awardXp(p, amount);
  emitXp({ playerId: p.id, amount });
  return levels;
}

/** Total XP a player has banked: every completed level's requirement + current progress. */
function totalXp(level: number, xp: number): number {
  let sum = xp;
  for (let l = 1; l < level; l++) sum += xpForLevel(l);
  return sum;
}

/** Recompute a player's stats from its (possibly reduced) level — base + per-level
 *  growth — so de-leveling sheds exactly the stats those levels had granted. */
export function applyLevelStats(p: Player): void {
  const levels = Math.max(1, p.level) - 1;
  p.maxHp = PLAYER_MAX_HP + levels * PLAYER_HP_PER_LEVEL;
  p.attack = PLAYER_ATTACK + levels * PLAYER_ATTACK_PER_LEVEL;
  p.armor = PLAYER_ARMOR + levels * PLAYER_ARMOR_PER_LEVEL;
  p.critChance = Math.min(CRIT_CHANCE_MAX, PLAYER_CRIT_CHANCE + levels * PLAYER_CRIT_PER_LEVEL);
  p.moveSpeed = MOVE_SPEED + levels * PLAYER_SPEED_PER_LEVEL;
  p.throwPower = 1 + levels * PLAYER_THROW_POWER_PER_LEVEL;
}

/**
 * Death penalty, per the realm policy (realm.json `policy.death`):
 * - "none"       → death costs nothing.
 * - "xp-penalty" → lose `xpPenalty` of TOTAL XP (default XP_DEATH_PENALTY).
 *                  Re-deriving level + progress from what's left de-levels the
 *                  player when the loss crosses a level boundary, and the lost
 *                  levels' stat gains are shed with it.
 * - "hardcore"   → back to a level-1 character.
 * HP is refilled on respawn either way.
 */
export function applyDeathXpPenalty(p: Player): void {
  const { mode, xpPenalty } = realmPolicy().death;
  if (mode === "none") return;
  if (mode === "hardcore") {
    p.level = 1;
    p.xp = 0;
    applyLevelStats(p);
    return;
  }
  let remaining = totalXp(p.level, p.xp) * (1 - xpPenalty);
  let level = 1;
  while (remaining >= xpForLevel(level)) {
    remaining -= xpForLevel(level);
    level += 1;
  }
  p.level = level;
  p.xp = Math.floor(remaining);
  applyLevelStats(p); // shed any stats from levels just lost
}

/** XP an action on `victimId` is worth (enemy by kind, player, tree or rock). */
export function killXp(state: GameState, victimId: string): number {
  const e = state.enemies.get(victimId);
  if (e) return e.kind === "goblin" ? GOBLIN_XP_REWARD : DUMMY_XP_REWARD;
  if (state.players.has(victimId)) return PLAYER_KILL_XP;
  if (state.trees.has(victimId)) return TREE_XP_REWARD;
  if (state.rocks.has(victimId)) return ROCK_XP_REWARD;
  if (state.structures.has(victimId)) return STRUCTURE_XP_REWARD;
  return 0;
}
