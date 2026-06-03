import { Schema, type, MapSchema } from "@colyseus/schema";
import { Player } from "./Player";
import { Enemy } from "./Enemy";
import { Potion } from "./Potion";
import { Tree } from "./Tree";
import { Log } from "./Log";
import { Rock } from "./Rock";
import { Stone } from "./Stone";
import { Banana } from "./Banana";
import { House } from "./House";
import { Item } from "./Item";

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
  @type({ map: Item }) items = new MapSchema<Item>();
  @type({ map: House }) houses = new MapSchema<House>();

  // Dev Mode time control: simulation speed multiplier (1 = normal, 0 = paused,
  // 2 = double speed, …). The server scales its tick dt by this; clients mirror it.
  @type("number") timeScale = 1;

  // Tower-defense wave tracking (synced so every client's home HUD can show
  // "Wave N · next in Xs").
  @type("number") waveNumber = 0;
  @type("number") waveTimerMs = 0; // ms until the next wave spawns

  // Realm-over intermission: when La Crypta falls the realm ends and this counts
  // down (ms) to the next realm. > 0 means "game over — restarting" (the world is
  // frozen and every client shows the restart countdown); 0 means a realm is live.
  @type("number") restartTimerMs = 0;
}
