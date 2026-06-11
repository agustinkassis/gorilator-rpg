import { Schema, type } from "@colyseus/schema";
import { TREE_HP, TREE_ARMOR } from "../constants";

/** A choppable tree. Attack it to cut it down; it drops logs and later regrows. */
export class Tree extends Schema {
  @type("string") id = "";
  @type("number") x = 0;
  @type("number") z = 0;
  @type("number") rotY = 0;
  @type("number") scale = 1;
  @type("number") hp = TREE_HP;
  @type("number") maxHp = TREE_HP;
  @type("boolean") alive = true; // false = a stump waiting to regrow
  @type("number") armor = TREE_ARMOR; // used by the shared damage formula

  // ---- server-only ----
  regrowTimer = 0;
  damageSinceDrop = 0; // accumulates chop damage; sheds an item each (hp/amount) when the drop is progressive
}
