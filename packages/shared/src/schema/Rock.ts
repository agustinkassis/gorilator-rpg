import { Schema, type } from "@colyseus/schema";
import { ROCK_HP, ROCK_ARMOR } from "../constants";

/** A mineable boulder. Attack it to mine it; it drops stone and stays mined out until the realm resets. */
export class Rock extends Schema {
  @type("string") id = "";
  @type("number") x = 0;
  @type("number") z = 0;
  @type("number") rotY = 0;
  @type("number") scale = 1;
  @type("number") radius = 1.4; // visual size (matches its nav collision)
  @type("number") hp = ROCK_HP;
  @type("number") maxHp = ROCK_HP;
  @type("boolean") alive = true; // false = mined-out rubble
  @type("number") armor = ROCK_ARMOR;

  // ---- server-only ----
  regrowTimer = 0;
  damageSinceStone = 0; // accumulates mining damage; sheds a stone each STONE_DROP_DAMAGE
}
