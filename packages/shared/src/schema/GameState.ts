import { Schema, type, MapSchema } from "@colyseus/schema";
import { Player } from "./Player";
import { Enemy } from "./Enemy";
import { Potion } from "./Potion";
import { Tree } from "./Tree";
import { Log } from "./Log";
import { Rock } from "./Rock";
import { Stone } from "./Stone";
import { Banana } from "./Banana";

/** Root synchronized state for a game room. */
export class GameState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
  @type({ map: Enemy }) enemies = new MapSchema<Enemy>();
  @type({ map: Potion }) potions = new MapSchema<Potion>();
  @type({ map: Tree }) trees = new MapSchema<Tree>();
  @type({ map: Log }) logs = new MapSchema<Log>();
  @type({ map: Rock }) rocks = new MapSchema<Rock>();
  @type({ map: Stone }) stones = new MapSchema<Stone>();
  @type({ map: Banana }) bananas = new MapSchema<Banana>();
}
