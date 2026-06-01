import { Schema, type } from "@colyseus/schema";

/** A log dropped by a cut tree. Click it to walk over and collect it. */
export class Log extends Schema {
  @type("string") id = "";
  @type("number") x = 0;
  @type("number") z = 0;
}
