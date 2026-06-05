import { Schema, type } from "@colyseus/schema";
import { STRUCTURE_HP } from "../constants";

/** A destructible concrete prop (e.g. a goblin house). The prop `.glb` is the
 *  visual + a pathfinding obstacle; this synced entity (keyed by the prop id)
 *  carries its HP so players can attack and destroy it. HP/drops resolve per
 *  MODEL via entityFeatures, so every instance of a model shares them. */
export class Structure extends Schema {
  @type("string") id = "";
  @type("number") x = 0;
  @type("number") z = 0;
  @type("number") radius = 1; // footprint (the prop's collisionRadius)
  @type("number") hp = STRUCTURE_HP;
  @type("number") maxHp = STRUCTURE_HP;
  @type("boolean") alive = true;
  @type("string") modelId = ""; // the prop's .glb model (per-model feature key)
  armor = 0; // server-only: damage mitigation (0 = none); not synced
}
