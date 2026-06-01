import { Schema, type } from "@colyseus/schema";
import { HOUSE_HP, HOUSE_COLLISION_RADIUS } from "../constants";

/** A destructible building. Thrown bananas/stones chip its HP; at 0 it collapses
 *  (the server removes it, so it stops blocking throws and the client hides it). */
export class House extends Schema {
  @type("string") id = "";
  @type("number") x = 0;
  @type("number") z = 0;
  @type("number") radius = HOUSE_COLLISION_RADIUS; // footprint a thrown item collides with
  @type("number") hp = HOUSE_HP;
  @type("number") maxHp = HOUSE_HP;
  @type("boolean") alive = true;
}
