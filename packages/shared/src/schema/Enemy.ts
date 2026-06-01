import { Schema, type } from "@colyseus/schema";
import { AnimState } from "../types";
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
  @type("string") kind = "dummy"; // "dummy" | "goblin" — picks the model + behaviour
  @type("number") x = 0;
  @type("number") z = 0;
  @type("number") rotY = 0;
  @type("number") hp = DUMMY_MAX_HP;
  @type("number") maxHp = DUMMY_MAX_HP;
  @type("number") level = 1; // shown on the name label; sets the XP it drops
  @type("string") state: AnimState = AnimState.IDLE;

  // combat stats
  @type("number") attack = DUMMY_ATTACK;
  @type("number") armor = DUMMY_ARMOR;
  @type("number") critChance = DUMMY_CRIT_CHANCE;

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
}
