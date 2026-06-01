import { Schema, type } from "@colyseus/schema";
import { POTION_HEAL } from "../constants";

/** A health potion pickup lying in the world. */
export class Potion extends Schema {
  @type("string") id = "";
  @type("number") x = 0;
  @type("number") z = 0;
  @type("number") heal = POTION_HEAL;
}
