import { Schema, type, MapSchema, ArraySchema } from "@colyseus/schema";
import { Player } from "./Player";
import { Enemy } from "./Enemy";
import { Potion } from "./Potion";
import { Tree } from "./Tree";
import { Log } from "./Log";
import { Rock } from "./Rock";
import { Stone } from "./Stone";
import { Banana } from "./Banana";
import { House } from "./House";
import { Structure } from "./Structure";
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
  @type({ map: Structure }) structures = new MapSchema<Structure>();

  // Dev Mode time control: simulation speed multiplier (1 = normal, 0 = paused,
  // 2 = double speed, …). The server scales its tick dt by this; clients mirror it.
  @type("number") timeScale = 1;

  // Tower-defense wave tracking (synced so every client's home HUD can show
  // "Wave N · next in Xs").
  @type("number") waveNumber = 0;
  @type("number") waveTimerMs = 0; // ms until the next wave spawns
  @type("boolean") waveActive = false; // true while the current wave is spawning or alive

  // Realm-over intermission: when La Crypta falls the realm ends and this counts
  // down (ms) to the next realm. > 0 means "game over — restarting" (the world is
  // frozen and every client shows the restart countdown); 0 means a realm is live.
  @type("number") restartTimerMs = 0;

  // Admin runtime controls (Esc menu → Admin, ADMIN_NPUBS only). While false the
  // wave clock holds in place (queued goblins stay queued); resuming continues
  // the countdown where it stopped.
  @type("boolean") wavesEnabled = true;
  // Spawner ids (spawners.json) an admin has switched off; their countdowns
  // freeze rather than reset, so re-enabling resumes mid-interval.
  @type(["string"]) disabledSpawnerIds = new ArraySchema<string>();

  // Event modules (plugin API 1.1): the active realm event. The host writes
  // eventId on start/end; the module drives the HUD fields via setEventHud.
  // Empty id = no event running (open sandbox). Part of the ONE batched Phase 3
  // schema change (#72) — do not add further @type fields outside a planned batch.
  @type("string") eventId = "";
  @type("string") eventLabel = "";
  @type("number") eventTimerMs = 0;
  @type("number") eventProgress = 0; // 0..1, module-defined (La Crypta: house HP fraction)
}
