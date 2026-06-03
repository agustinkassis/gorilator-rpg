import { Schema, type } from "@colyseus/schema";
import { AnimState } from "../types";
import type { BrainId } from "../entityFeatures";
import {
  DUMMY_MAX_HP,
  DUMMY_ATTACK,
  DUMMY_ARMOR,
  DUMMY_CRIT_CHANCE,
} from "../constants";

/**
 * A hostile entity. "dummy" = a stationary training dummy; "goblin" = a roaming
 * AI enemy that patrols, chases when you get close, attacks in melee, and gives
 * up if you put enough distance between you (see goblinAiSystem).
 */
export class Enemy extends Schema {
  @type("string") id = "";
  @type("string") kind = "dummy"; // "dummy" | "goblin" | "npc" — broad gameplay bucket
  @type("string") modelId = ""; // custom CharacterDef id; empty uses the built-in kind model
  @type("string") displayName = ""; // optional nameplate override for custom characters
  @type("string") brain: BrainId | "" = ""; // empty = default for kind
  @type("number") x = 0;
  @type("number") z = 0;
  @type("number") rotY = 0;
  @type("number") hp = DUMMY_MAX_HP;
  @type("number") maxHp = DUMMY_MAX_HP;
  @type("number") level = 1; // shown on the name label; sets the XP it drops
  @type("number") xp = 0;
  @type("string") state: AnimState = AnimState.IDLE;

  // combat stats
  @type("number") attack = DUMMY_ATTACK;
  @type("number") armor = DUMMY_ARMOR;
  @type("number") critChance = DUMMY_CRIT_CHANCE;
  @type("number") moveSpeed = 0; // 0 ⇒ use the brain's default movement speed
  @type("number") throwPower = 1;

  // ---- server-only (not synced) ----
  stateTimer = 0;
  respawnTimer = 0;
  // goblin AI
  targetX = 0; // current move target (patrol point or chased player)
  targetZ = 0;
  homeX = 0; // patrol anchor (leashes wandering, and the respawn spot)
  homeZ = 0;
  aiTargetId = ""; // the player being chased / attacked
  attackCooldown = 0;
  wanderTimer = 0; // until the next patrol point is picked
  wanderRadius = 14; // how far it roams from home (small for the centre guardian)
  aggro = false; // chasing a player vs patrolling

  // ---- dev-spawner overrides (0 / "" ⇒ use the global goblin defaults) ----
  spawnerId = ""; // which dev spawner produced this goblin ("" = wave / initial)
  aggroRadius = 0; // pull-off-home range
  chaseSpeed = 0; // units/sec while chasing/marching
  atkCooldownMs = 0; // ms between swings
  houseDamage = 0; // damage per swing on the home
}
