import { Schema, type } from "@colyseus/schema";

/** A stone dropped by a mined rock. Click it to walk over and collect it. */
export class Stone extends Schema {
  @type("string") id = "";
  @type("number") x = 0;
  @type("number") z = 0;
}
