import { Schema, type } from "@colyseus/schema";
import { AnimState } from "../types";
import {
  PLAYER_MAX_HP,
  PLAYER_ATTACK,
  PLAYER_ARMOR,
  PLAYER_CRIT_CHANCE,
  MOVE_SPEED,
} from "../constants";

/**
 * One connected player. Fields decorated with `@type` are synchronized to every
 * client automatically by Colyseus. Plain fields below the synced block are
 * server-only bookkeeping and never leave the server.
 */
export class Player extends Schema {
  @type("string") id = "";
  @type("string") name = "";
  @type("number") x = 0;
  @type("number") z = 0;
  @type("number") rotY = 0; // facing, radians around the Y axis
  @type("number") hp = PLAYER_MAX_HP;
  @type("number") maxHp = PLAYER_MAX_HP;
  @type("string") state: AnimState = AnimState.IDLE;
  @type("number") hue = 0; // 0..360, per-player colour tint

  // nostr identity — empty / false for anonymous players. The server only ever
  // sets these after verifying a signed challenge + profile event on join, so a
  // non-empty `pubkey` here is a server-vouched, signature-proven identity.
  @type("string") pubkey = ""; // hex (32-byte) nostr public key
  @type("boolean") nostrVerified = false;
  @type("string") picture = ""; // avatar URL from the kind-0 profile
  @type("string") nip05 = ""; // nip-05 identifier from the profile, if any

  // progression
  @type("number") level = 1;
  @type("number") xp = 0; // progress within the current level (see xpForLevel)

  // combat stats
  @type("number") attack = PLAYER_ATTACK;
  @type("number") armor = PLAYER_ARMOR;
  @type("number") critChance = PLAYER_CRIT_CHANCE;
  @type("number") moveSpeed = MOVE_SPEED; // run speed, units/sec (grows with level)
  @type("number") throwPower = 1; // banana reach & damage multiplier (grows with level)

  // ---- server-only (not synced) ----
  targetX = 0;
  targetZ = 0;
  path: Array<{ x: number; z: number }> = []; // waypoints from the pathfinder
  pathIndex = 0; // current waypoint
  attackCooldown = 0; // ms remaining before the next swing is allowed
  stateTimer = 0; // ms remaining in a timed state (ATTACK/HIT)
  respawnTimer = 0; // ms remaining while DEAD
  attackTargetId = ""; // entity we are pursuing/attacking
  pendingHitId = ""; // damage to apply when the current swing connects
  pickupTargetId = ""; // log we are walking over to collect
}
