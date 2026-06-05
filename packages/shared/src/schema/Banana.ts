import { Schema, type } from "@colyseus/schema";

/** A banana lying on the floor. Click it to walk over and collect it (then you
 * can throw it with SPACE). Bananas spawn randomly and also land here when
 * thrown. */
export class Banana extends Schema {
  @type("string") id = "";
  @type("number") x = 0;
  @type("number") z = 0;
  @type("number") rotY = 0;
  @type("number") scale = 1;
}
