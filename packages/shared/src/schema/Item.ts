import { Schema, type } from "@colyseus/schema";

/** A dev-authored generic pickup lying in the world. */
export class Item extends Schema {
  @type("string") id = "";
  @type("string") itemId = "";
  @type("number") x = 0;
  @type("number") z = 0;
}
