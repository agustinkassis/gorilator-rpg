import {
  GameState,
  Player,
  XpEvent,
  xpForLevel,
  HP_PER_LEVEL,
  ATTACK_PER_LEVEL,
  ARMOR_PER_LEVEL,
  CRIT_PER_LEVEL,
  CRIT_CHANCE_MAX,
  SPEED_PER_LEVEL,
  THROW_POWER_PER_LEVEL,
  DUMMY_XP_REWARD,
  GOBLIN_XP_REWARD,
  PLAYER_KILL_XP,
  TREE_XP_REWARD,
  ROCK_XP_REWARD,
} from "@rpg/shared";

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
    p.maxHp += HP_PER_LEVEL;
    p.attack += ATTACK_PER_LEVEL;
    p.armor += ARMOR_PER_LEVEL;
    p.critChance = Math.min(CRIT_CHANCE_MAX, p.critChance + CRIT_PER_LEVEL);
    p.moveSpeed += SPEED_PER_LEVEL;
    p.throwPower += THROW_POWER_PER_LEVEL;
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

/** XP an action on `victimId` is worth (enemy by kind, player, tree or rock). */
export function killXp(state: GameState, victimId: string): number {
  const e = state.enemies.get(victimId);
  if (e) return e.kind === "goblin" ? GOBLIN_XP_REWARD : DUMMY_XP_REWARD;
  if (state.players.has(victimId)) return PLAYER_KILL_XP;
  if (state.trees.has(victimId)) return TREE_XP_REWARD;
  if (state.rocks.has(victimId)) return ROCK_XP_REWARD;
  return 0;
}
