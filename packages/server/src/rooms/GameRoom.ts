import { performance } from "node:perf_hooks";
import { Room, type Client } from "@colyseus/core";
import {
  GameState,
  Player,
  AnimState,
  type MoveMessage,
  type AttackMessage,
  type PickupMessage,
  type InventoryMoveMessage,
  type UseItemMessage,
  type ThrowMessage,
  type ChatMessage,
  type SprintMessage,
  type DevGodMessage,
  type DevSpawnMessage,
  type DevMoveMessage,
  type DevDeleteMessage,
  type DevSetMessage,
  type DevGiveItemMessage,
  type DevSetSlotMessage,
  type DevTimeMessage,
  type DevActionMessage,
  type DevTuneMessage,
  type AdminWavesMessage,
  type AdminSpawnerMessage,
  CHAT_MAX_LEN,
  INV_SLOTS,
  type InventorySlot,
  type ItemType,
  type DamageEvent,
  type KillEvent,
  type XpEvent,
  ROCK_COLLISION_SCALE,
  THROW_STATE_MS,
  THROW_RELEASE_FRACTION,
  BANANA_MAX_THROW,
  STARTING_BANANAS,
  xpForLevel,
  REALM_RESTART_MS,
  TICK_RATE,
  NOSTR_TAKEOVER_CODE,
  type HealEvent,
  type PlayerSave,
} from "@rpg/shared";
import { movementSystem, ghostMovementSystem, setDestination, placeAtFreeSpot } from "../systems/movement";
import { staminaSystem } from "../systems/stamina";
import {
  combatSystem,
  handleAttack,
  clampToWorld,
} from "../systems/combat";
import { spawnInitialPotions, potionRespawnSystem } from "../systems/pickups";
import {
  spawnTrees,
  treeRegrowSystem,
  spawnRocks,
  itemPickupSystem,
  autoGrabSystem,
  resetResources,
  applyResourceConfig,
} from "../systems/resources";
import { makeInventory, addItem, moveItem, removeItem, countItem } from "../systems/inventory";
import { spawnInitialBananas, bananaSystem, planThrow } from "../systems/bananas";
import { goblinAiSystem, waveSystem, resetWaves, forceNextWave, previousWave } from "../systems/goblins";
import { realmTracker, type RealmPlayer } from "../systems/realms";
import { separationSystem } from "../systems/separation";
import { houseRegenSystem, noteHouseDamage, spawnHouse, type HouseRegenTimers } from "../systems/houses";
import { healingTowerPosition, sacredCircleHealSystem } from "../systems/healingTower";
import { useItemFromSlot, type BerserkerBase, type UseItemDeps } from "../systems/useItem";
import { loadPropObstacles, onPropsChange } from "../systems/props";
import { applyStructures } from "../systems/structures";
import { loadSpawners, resetSpawners, spawnerSystem, spawnerExists } from "../systems/spawners";
import { loadWaves } from "../systems/waves";
import { loadResourceDrops } from "../systems/resourceDrops";
import { loadStructureLoot } from "../systems/structureDrops";
import { loadEntityFeatures } from "../systems/entityFeatures";
import { loadAuthoredNpcs, syncAuthoredNpcs } from "../systems/npcs";
import { setRockObstacles } from "../systems/pathfinding";
import { canUseDevCommands } from "../systems/devAuth";
import { devSpawn, devMove, devDelete, devSet } from "../systems/devEdit";
import { devTuning, setDevTuning } from "../systems/devTuning";
import { perfTracker } from "../systems/perf";
import { grantXp } from "../systems/leveling";
import { verifyNostrLogin, type NostrJoinPayload, type VerifiedNostr } from "../systems/nostr";
import { isAdmin } from "../systems/admins";
import { fetchServerSave, buildServerSave, ServerSaver } from "../systems/nostrSave";
import { serverPluginHost } from "../systems/plugins/host";
import { loadServerPlugins } from "../systems/plugins/loader";
import { initNostrContent } from "../systems/plugins/nostrContent";
import { applyRealmConfig } from "../systems/realm";
import { realmPolicy } from "../systems/policy";
import { resetPlayerForNewRealm } from "../systems/realmLifecycle";

/** A kicked session's gameplay state, handed to the new login that takes it over. */
interface TakeoverState {
  x: number;
  z: number;
  rotY: number;
  hp: number;
  maxHp: number;
  stamina: number;
  maxStamina: number;
  level: number;
  xp: number;
  attack: number;
  armor: number;
  critChance: number;
  moveSpeed: number;
  throwPower: number;
  hue: number;
  inventory?: InventorySlot[];
}

export class GameRoom extends Room<GameState> {
  maxClients = 16;

  /** Per-player inventory, kept off the synced state and sent only to its owner. */
  private inventories = new Map<string, InventorySlot[]>();

  /** Pre-buff stats saved when a berserker potion is consumed; restored on expiry. */
  private berserkerBase = new Map<string, BerserkerBase>();

  /** Fractional sacred-circle healing is accumulated into whole-HP popups. */
  private sacredHealCarry = new Map<string, number>();

  /** La Crypta regen timers reset every time the house receives damage. */
  private houseRegen: HouseRegenTimers = new Map();

  /** Signs + publishes Nostr-logged-in players' progress with the SERVER key. */
  private serverSaver = new ServerSaver();
  /** Per-session level/death watermark, so the tick can persist a save the
   *  moment a Nostr player levels up or dies (keyed by sessionId). */
  private saveTrack = new Map<string, { level: number; dead: boolean }>();

  /** Banana throws mid-windup: the banana launches once the pitch reaches its
   *  release point (THROW_RELEASE_FRACTION through the animation), not on input. */
  private pendingThrows = new Map<
    string,
    { power: number; timer: number; item: "banana" | "stone" }
  >();

  /** True while La Crypta (the home) stands; flips on collapse so the tick fires the
   *  wipe exactly once, then back to true once the home is rebuilt. */
  private homeStanding = true;

  private healingTower = healingTowerPosition();

  /** Throttles the realm-tracker snapshot (it doesn't need every 20Hz tick). */
  private realmTick = 0;

  /** Sessions whose denied dev_* attempt was already logged (anti log-flood). */
  private devDenied = new Set<string>();

  async onCreate() {
    this.setState(new GameState());
    loadPropObstacles(); // collision for any imported "concrete" props (+ live reload)
    onPropsChange(() => applyStructures(this.state)); // re-sync destructible structures on props edit
    loadEntityFeatures(() => {
      applyResourceConfig(this.state);
      applyStructures(this.state); // per-model HP edits re-stamp every structure instance
    });
    loadSpawners(); // dev-placed goblin spawners (+ live reload of spawners.json)
    loadWaves(); // dev-authored custom wave compositions (+ live reload of waves.json)
    // per-kind tree/rock drop config (+ live reload of resources.json). The callback
    // re-applies the configured HP to every existing tree/rock on each edit.
    loadResourceDrops(() => applyResourceConfig(this.state));
    loadStructureLoot(); // per-structure loot tables dropped on destroy (+ live reload of structures.json)
    spawnInitialPotions(this.state);
    spawnTrees(this.state);
    spawnRocks(this.state);
    applyResourceConfig(this.state); // stamp configured HP onto the freshly-spawned resources
    applyStructures(this.state); // build destructible structures from the loaded concrete props
    this.refreshRockObstacles(); // boulders collide via the live Rock entities now
    spawnInitialBananas(this.state);
    spawnHouse(this.state);
    loadAuthoredNpcs(this.state);

    // Deterministic test mode (e2e smoke tests, `pnpm bench` scenarios): no goblin
    // waves, so room state only changes when a test drives it. Uses the existing
    // devTuning knobs — every other system runs exactly as in production.
    // realm.json (per-realm/fork config): seed the live tuning knobs before any
    // mode-specific overrides. Absent file = current defaults, untouched.
    applyRealmConfig();

    if (process.env.GORILATOR_TEST === "1") {
      setDevTuning("waveSizeBase", 0);
      setDevTuning("waveSizePerPlayer", 0);
      setDevTuning("waveSizePerWave", 0);
      // The pre-created bench/e2e room has no clients — without this, Colyseus
      // auto-disposes it mid-benchmark and the capture never completes.
      this.autoDispose = false;
      console.log("[room] GORILATOR_TEST=1 — goblin waves disabled for a reproducible room");
    }

    // Discover + load server plugins (plugins/ + gorilator-plugin-* packages):
    // brains, item behaviors, tick systems, event listeners, content packs.
    // Idempotent across realm restarts; a failing plugin is skipped, never fatal.
    await loadServerPlugins();
    initNostrContent(); // kind-30333 realm packs (REALM_PACK_AUTHORS env) — no-op when unset

    this.onMessage("move", (client, msg: MoveMessage) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || p.state === AnimState.DEAD) return;
      p.attackTargetId = "";
      p.pickupTargetId = ""; // a manual move cancels any pursuit
      if (this.state.timeScale === 0) {
        // paused → ghost free-roam: fly straight to the point (no pathfinding,
        // ignoring obstacles); ghostMovementSystem glides there, faster the more
        // the client is zoomed out (msg.gz = the camera zoom factor, 1..6).
        p.path = [];
        p.targetX = clampToWorld(msg.x);
        p.targetZ = clampToWorld(msg.z);
        p.ghostSpeedMult = Math.max(1, Math.min(6, Number(msg.gz) || 1));
        return;
      }
      setDestination(p, clampToWorld(msg.x), clampToWorld(msg.z));
    });

    // Hold-to-sprint: record SPACE held/released. staminaSystem decides whether
    // that actually translates into a sprint (moving + has stamina + not winded).
    this.onMessage("sprint", (client, msg: SprintMessage) => {
      const p = this.state.players.get(client.sessionId);
      if (p) p.sprintHeld = !!msg?.on;
    });

    this.onMessage("attack", (client, msg: AttackMessage) => {
      if (this.state.timeScale === 0) return; // game paused — ignore attack input
      const p = this.state.players.get(client.sessionId);
      if (p) p.pickupTargetId = "";
      handleAttack(this.state, client.sessionId, msg.targetId);
    });

    // "Kill yourself" (game menu): a voluntary death → the normal respawn flow brings
    // you back. No XP penalty (it's a deliberate self-respawn, not a combat death).
    this.onMessage("suicide", (client) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || p.state === AnimState.DEAD) return; // already dead — nothing to do
      // A deliberate self-kill ALWAYS works — even with Dev-Mode god mode on. You
      // explicitly asked to die, so immortality shouldn't veto it; god mode is
      // cleared so the DEAD countdown can run, and the normal respawn flow brings
      // you back to full HP at a free spot.
      p.godMode = false;
      p.hp = 0;
      p.state = AnimState.DEAD;
      p.respawnTimer = devTuning().playerRespawnMs;
      p.attackTargetId = "";
      p.pendingHitId = "";
      p.pickupTargetId = "";
    });

    // Dev Mode: toggle the sender's immortality. Turning it on while dead also
    // revives them, so entering Dev Mode never strands you on the respawn screen.
    // The whole dev_* family below goes through devSender(): open on an explicit
    // dev/test server, admin-only otherwise (see systems/devAuth.ts).
    this.onMessage("dev_god", (client, msg: DevGodMessage) => {
      const p = this.devSender(client);
      if (!p) return;
      p.godMode = !!msg?.on;
      if (p.godMode) {
        p.hp = p.maxHp;
        if (p.state === AnimState.DEAD) {
          p.state = AnimState.IDLE;
          p.respawnTimer = 0;
        }
      }
    });

    // Dev Mode world edits — relocate / delete / retune a synced entity. They
    // mutate authoritative state and sync to every client. Runtime-only (the
    // world regenerates each restart); authored props persist via props.json.
    this.onMessage("dev_spawn", (client, msg: DevSpawnMessage) => {
      if (!msg || !this.devSender(client)) return;
      const spawned = devSpawn(this.state, msg.kind, msg.id, msg.x, msg.z);
      if (spawned?.kind === "rock") this.refreshRockObstacles();
    });
    this.onMessage("dev_move", (client, msg: DevMoveMessage) => {
      if (!msg || !this.devSender(client)) return;
      devMove(this.state, msg.kind, msg.id, msg.x, msg.z);
      if (msg.kind === "rock") this.refreshRockObstacles(); // collision follows the rock
    });
    this.onMessage("dev_delete", (client, msg: DevDeleteMessage) => {
      if (!msg || !this.devSender(client)) return;
      devDelete(this.state, msg.kind, msg.id);
      if (msg.kind === "rock") this.refreshRockObstacles(); // drop its collision too
    });
    this.onMessage("dev_set", (client, msg: DevSetMessage) => {
      if (!msg || !this.devSender(client)) return;
      devSet(this.state, msg.kind, msg.id, msg.field, msg.value);
      if (msg.kind === "rock" && msg.field === "scale") this.refreshRockObstacles();
    });
    this.onMessage("dev_give_item", (client, msg: DevGiveItemMessage) => {
      if (!this.devSender(client)) return;
      const inv = this.inventories.get(client.sessionId);
      const type = String(msg?.type || "").trim();
      if (!inv || !/^[a-z0-9_-]{1,48}$/.test(type)) return;
      addItem(inv, type, Math.max(1, Math.min(999, Math.round(Number(msg.amount) || 1))));
      this.sendInventory(client.sessionId);
    });
    // Dev-only: directly overwrite one inventory slot (empty type clears it).
    this.onMessage("dev_set_slot", (client, msg: DevSetSlotMessage) => {
      if (!this.devSender(client)) return;
      const inv = this.inventories.get(client.sessionId);
      const slot = Math.trunc(Number(msg?.slot));
      if (!inv || !Number.isInteger(slot) || slot < 0 || slot >= INV_SLOTS) return;
      const type = String(msg?.type || "").trim();
      if (!type) {
        inv[slot] = { type: "", count: 0 };
      } else {
        if (!/^[a-z0-9_-]{1,48}$/.test(type)) return;
        const count = Math.max(1, Math.min(999, Math.round(Number(msg.count) || 1)));
        inv[slot] = { type: type as ItemType, count };
      }
      this.sendInventory(client.sessionId);
    });
    // Pause / set game speed: scales the simulation for everyone (0 = paused).
    this.onMessage("dev_time", (client, msg: DevTimeMessage) => {
      if (!this.devSender(client)) return;
      const s = Number(msg?.scale);
      this.state.timeScale = Number.isFinite(s) ? Math.max(0, Math.min(8, s)) : 1;
    });
    this.onMessage("dev_tune", (client, msg: DevTuneMessage) => {
      if (!msg || !this.devSender(client)) return;
      const applied = setDevTuning(msg.key, msg.value);
      if (applied == null) return;
      if (msg.key === "waveFirstDelayMs" && this.state.waveNumber === 0) resetWaves(this.state);
    });
    this.onMessage("dev_action", (client, msg: DevActionMessage) => {
      if (!msg || !this.devSender(client)) return;
      this.handleDevAction(client, msg.action);
    });

    // Admin controls (Esc menu → Admin). Unlike the dev_* family these are
    // server-authorized: the sender's pubkey was signature-verified on join and
    // must be in the ADMIN_NPUBS allowlist.
    this.onMessage("admin_waves", (client, msg: AdminWavesMessage) => {
      const p = this.adminSender(client);
      if (!p || !msg) return;
      this.state.wavesEnabled = !!msg.enabled;
      console.log(`[admin] ${p.name} ${this.state.wavesEnabled ? "resumed" : "stopped"} waves`);
    });
    this.onMessage("admin_spawner", (client, msg: AdminSpawnerMessage) => {
      const p = this.adminSender(client);
      const id = String(msg?.id || "");
      if (!p || !id || !spawnerExists(id)) return;
      const disabled = this.state.disabledSpawnerIds;
      const at = disabled.indexOf(id);
      if (msg.enabled && at >= 0) disabled.splice(at, 1);
      else if (!msg.enabled && at < 0) disabled.push(id);
      console.log(`[admin] ${p.name} ${msg.enabled ? "enabled" : "disabled"} spawner ${id}`);
    });

    this.onMessage("pickup", (client, msg: PickupMessage) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || p.state === AnimState.DEAD) return;
      if (this.state.timeScale === 0) return; // game paused — ignore pickup input
      const target =
        this.state.logs.get(msg.id) ??
        this.state.stones.get(msg.id) ??
        this.state.potions.get(msg.id) ??
        this.state.bananas.get(msg.id) ??
        this.state.items.get(msg.id);
      if (!target) return;
      p.attackTargetId = "";
      p.pickupTargetId = msg.id;
      setDestination(p, target.x, target.z);
    });

    this.onMessage("throw", (client, msg: ThrowMessage) => {
      const p = this.state.players.get(client.sessionId);
      const inv = this.inventories.get(client.sessionId);
      if (!p || !inv || p.state === AnimState.DEAD) return;
      if (this.state.timeScale === 0) return; // game paused — ignore throw input
      if (p.state === AnimState.THROW) return; // already mid-throw
      const item = msg.item === "stone" ? "stone" : "banana"; // the throwables
      if (countItem(inv, item) <= 0) return; // need one of that item to throw
      removeItem(inv, item, 1); // each throw consumes one
      this.sendInventory(client.sessionId);
      // Turn to face the aim and start the pitch (rooted, synced to everyone). The
      // banana itself launches later, at the pitch's release point.
      p.rotY = Math.atan2(clampToWorld(msg.x) - p.x, clampToWorld(msg.z) - p.z);
      p.state = AnimState.THROW;
      p.stateTimer = THROW_STATE_MS;
      p.attackTargetId = ""; // a throw cancels any queued attack
      const requestedPower = Number(msg.power ?? 0);
      const power = Number.isFinite(requestedPower)
        ? Math.max(0, Math.min(1, requestedPower))
        : 0;
      this.pendingThrows.set(client.sessionId, {
        power,
        item,
        timer: THROW_STATE_MS * THROW_RELEASE_FRACTION,
      });
    });

    this.onMessage("inventory_move", (client, msg: InventoryMoveMessage) => {
      const inv = this.inventories.get(client.sessionId);
      if (!inv) return;
      moveItem(inv, msg.from, msg.to);
      this.sendInventory(client.sessionId);
    });

    this.onMessage("use_item", (client, msg: UseItemMessage) => {
      useItemFromSlot(this.state, client.sessionId, msg.slot, this.useItemDeps());
    });

    // Chat: trim/clamp the line and re-broadcast it to everyone (sender included),
    // tagged with the sender's authoritative name. Dead players may still chat.
    this.onMessage("chat", (client, msg: ChatMessage) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      const text = (msg?.text ?? "").replace(/\s+/g, " ").trim().slice(0, CHAT_MAX_LEN);
      if (!text) return;
      this.broadcast("chat", { playerId: client.sessionId, name: p.name, text });
    });

    // In-game Nostr login: a live (anonymous) session proves an npub with the same
    // signed-challenge as join, and we "upgrade" its identity IN PLACE — current
    // progress is kept (we attach the npub; we don't reload a different save), so
    // the player can publish community entities + persist under their key.
    this.onMessage("nostr_upgrade", (client, msg: NostrJoinPayload & { id?: string }) => {
      const reqId = msg?.id;
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      let nostr: VerifiedNostr;
      try {
        nostr = verifyNostrLogin(msg);
      } catch (err) {
        const reason = err instanceof Error ? err.message : "verification failed";
        console.warn(`[nostr] in-game upgrade rejected ${client.sessionId}: ${reason}`);
        client.send("nostr_upgrade_result", { id: reqId, ok: false, error: reason });
        return;
      }
      // Idempotent: already this npub → succeed without touching anything.
      if (p.nostrVerified && p.pubkey === nostr.pubkey) {
        client.send("nostr_upgrade_result", { id: reqId, ok: true, pubkey: nostr.pubkey });
        return;
      }
      // Kick any OTHER live session on this npub (don't inherit its state — this
      // session keeps the progress it already has).
      this.takeOverSameNpub(client.sessionId, nostr.pubkey);
      p.pubkey = nostr.pubkey;
      p.nostrVerified = true;
      p.picture = nostr.picture;
      p.nip05 = nostr.nip05;
      p.name = (nostr.name || p.name).slice(0, 24);
      this.saveTrack.set(client.sessionId, { level: p.level, dead: p.state === AnimState.DEAD });
      realmTracker.noteNpub(p.pubkey);
      this.persistSave(client.sessionId, p, "login"); // persist current progress under the npub
      console.log(`[room] ${p.name} ⚡ logged in in-game (npub ${nostr.pubkey.slice(0, 8)}…)`);
      client.send("nostr_upgrade_result", { id: reqId, ok: true, pubkey: nostr.pubkey });
    });

    // Fixed-step authoritative simulation. Dev Mode's time control scales every
    // system's dt by `timeScale` (0 = fully paused, 2 = double speed, …) so the
    // whole game freezes/slows/speeds for everyone. Direct edits (dev_move etc.)
    // still apply while paused since they mutate state outside this loop.
    this.setSimulationInterval((deltaMs) => {
      const tickStart = performance.now();
      // Record this tick's wall time + entity counts into the perf tracker (powers
      // GET /api/perf, the F3 overlay's server line, and PERF_LOG=1 JSONL logs).
      const recordTick = () =>
        perfTracker.recordTick(performance.now() - tickStart, {
          players: this.state.players.size,
          enemies: this.state.enemies.size,
          entities: this.entityCount(),
        });

      // Realm over (La Crypta fell): freeze the whole world and tick down the
      // intermission. When it hits zero the next realm spins up from scratch.
      if (this.state.restartTimerMs > 0) {
        this.state.restartTimerMs = Math.max(0, this.state.restartTimerMs - deltaMs);
        if (this.state.restartTimerMs === 0) this.startNewRealm();
        recordTick();
        return; // no gameplay runs during the game-over countdown
      }

      const scaledMs = deltaMs * this.state.timeScale;
      const dt = scaledMs / 1000;
      const emitDamage = (ev: DamageEvent) => {
        noteHouseDamage(this.state, this.houseRegen, ev.targetId);
        this.broadcast("damage", ev);
      };
      const emitKill = (ev: KillEvent) => this.broadcast("kill", ev);
      const emitXp = (ev: XpEvent) => this.broadcast("xp", ev);
      const emitHeal = (ev: HealEvent) => this.broadcast("heal", ev);
      const repairInventory = {
        hasWood: (pid: string) => countItem(this.inventories.get(pid) ?? [], "log") > 0,
        consumeWood: (pid: string) => {
          const inv = this.inventories.get(pid);
          if (!inv || removeItem(inv, "log", 1) < 1) return false;
          this.sendInventory(pid);
          return true;
        },
      };
      // Plugin tick systems run per phase, each inside its own perf span
      // (`plugin:<name>` in /api/perf + F3) and a try/catch — a throwing plugin
      // never takes down the 20Hz tick.
      const runPluginSystems = (phase: "pre" | "main" | "post") => {
        for (const s of serverPluginHost.systems[phase]) {
          perfTracker.span(`plugin:${s.name}`, () => {
            try {
              s.fn(this.state, dt);
            } catch (err) {
              console.error(`[plugins] system "${s.name}" failed:`, err);
            }
          });
        }
      };
      runPluginSystems("pre");
      // Each system runs inside a perf span so a tick-time spike traces to the exact
      // culprit (the `tag:*` rows in the server summary / analyzer).
      perfTracker.span("stamina", () => staminaSystem(this.state, dt)); // sets p.sprinting; movement reads it for the speed boost
      perfTracker.span("movement", () => movementSystem(this.state, dt));
      // Paused: normal movement is frozen, but the local player roams as a ghost
      // at REAL (unscaled) time — decoupled from the game clock.
      if (this.state.timeScale === 0) ghostMovementSystem(this.state, deltaMs / 1000);
      perfTracker.span("combat", () =>
        combatSystem(this.state, dt, emitDamage, emitKill, emitXp, emitHeal, repairInventory),
      );
      perfTracker.span("goblinAi", () => goblinAiSystem(this.state, dt, emitDamage, emitKill));
      if (this.state.timeScale > 0)
        perfTracker.span("separation", () => separationSystem(this.state)); // fan attackers out — no stacking on one tile
      perfTracker.span("waves", () => waveSystem(this.state, dt)); // tower-defense: a horde besieges the house every WAVE_INTERVAL_MS
      perfTracker.span("sacredCircleHeal", () =>
        sacredCircleHealSystem(this.state, dt, this.healingTower, this.sacredHealCarry, emitHeal),
      );
      perfTracker.span("spawners", () => spawnerSystem(this.state, dt)); // dev-placed object spawners (coexist with waves)
      runPluginSystems("main");
      this.releasePendingThrows(scaledMs);
      perfTracker.span("resources", () => {
        treeRegrowSystem(this.state, dt);
        potionRespawnSystem(this.state, dt);
      });
      perfTracker.span("bananas", () => bananaSystem(this.state, dt, emitDamage, emitKill, emitHeal, emitXp));
      perfTracker.span("houseRegen", () => houseRegenSystem(this.state, scaledMs, this.houseRegen, emitHeal));
      const collect = (pid: string, type: ItemType) => {
        const inv = this.inventories.get(pid);
        if (inv) {
          addItem(inv, type, 1);
          this.sendInventory(pid);
          serverPluginHost.fire("item:pickup", { playerId: pid, item: type }, this.state);
        }
      };
      // Skip pickups while paused: the dev's ghost roams over items but must NOT
      // collect them. Auto-grab / walk-onto are proximity-based (no dt), so a
      // scaled dt of 0 won't stop them — gate the whole span on the clock instead.
      if (this.state.timeScale > 0)
        perfTracker.span("pickups", () => {
          itemPickupSystem(this.state, dt, collect); // walk-onto a clicked item
          autoGrabSystem(this.state, collect); // auto-collect anything nearby
        });
      // Tally each death the instant a player flips into the DEAD state (any cause).
      this.state.players.forEach((p, sid) => {
        const dead = p.state === AnimState.DEAD;
        if (dead && !p.prevDead) {
          p.deaths++;
          serverPluginHost.fire(
            "entity:killed",
            { victimId: sid, victimKind: "player", victimName: p.name },
            this.state,
          );
        }
        p.prevDead = dead;
      });
      // Same edge detection for enemies — catches every death cause (melee,
      // throws, plugin systems) at one chokepoint.
      this.state.enemies.forEach((e) => {
        const dead = e.state === AnimState.DEAD || e.hp <= 0;
        if (dead && !e.prevDead) {
          serverPluginHost.fire(
            "entity:killed",
            { victimId: e.id, victimKind: e.kind, modelId: e.modelId, x: e.x, z: e.z },
            this.state,
          );
        }
        e.prevDead = dead;
      });
      // Berserker potion tick: count down the timed buff and restore base stats on expiry.
      this.state.players.forEach((p, sid) => {
        if (p.berserkerMs <= 0) return;
        p.berserkerMs = Math.max(0, p.berserkerMs - scaledMs);
        if (p.berserkerMs === 0) {
          const base = this.berserkerBase.get(sid);
          if (base) {
            p.attack = base.attack;
            p.armor = base.armor;
            p.critChance = base.critChance;
            p.critMultiplier = base.critMultiplier;
            p.moveSpeed = base.moveSpeed;
            const prevMaxHp = p.maxHp;
            p.maxHp = base.maxHp;
            // Scale current HP proportionally down; never kill the player on expiry
            if (prevMaxHp > 0) p.hp = Math.max(1, Math.round(p.hp * (base.maxHp / prevMaxHp)));
            if (p.hp > p.maxHp) p.hp = p.maxHp;
            this.berserkerBase.delete(sid);
          }
        }
      });
      this.checkHomeFall(); // La Crypta fell? → end the realm + restart per the realm policy
      this.detectSaveTriggers(); // persist Nostr progress on level-up / death
      if (++this.realmTick >= TICK_RATE) {
        this.realmTick = 0;
        this.reportRealm(); // ~1/s: feed the realm tracker (start/accumulate/abandon)
      }
      runPluginSystems("post");
      recordTick();
    }, 1000 / TICK_RATE);

    console.log(`[room] ${this.roomId} created`);
  }

  /** Feed the realm tracker a snapshot (~1/s): it starts a realm when the first
   *  defender is alive, accumulates joined npubs/waves, and ends it when the room
   *  empties. (La Crypta falling ends it explicitly from resetRound.) */
  private reportRealm() {
    let live = 0;
    const npubs: string[] = [];
    const players: RealmPlayer[] = [];
    this.state.players.forEach((p) => {
      const alive = p.hp > 0 && p.state !== AnimState.DEAD;
      if (alive) live++;
      if (p.pubkey) {
        npubs.push(p.pubkey);
        players.push({ pubkey: p.pubkey, name: p.name, level: p.level, alive });
      }
    });
    realmTracker.update({
      connected: this.state.players.size,
      live,
      wave: this.state.waveNumber,
      npubs,
      players,
    });
  }

  /** The room capabilities item-use needs (also handed to the bot driver's IO). */
  private useItemDeps(): UseItemDeps {
    return {
      inventories: this.inventories,
      berserkerBase: this.berserkerBase,
      sendInventory: (sid) => this.sendInventory(sid),
      broadcast: (type, payload) => this.broadcast(type, payload),
    };
  }

  /** Detect La Crypta collapsing (no standing house) and end the realm once. */
  private checkHomeFall() {
    let standing = false;
    this.state.houses.forEach((h) => {
      if (h.alive) standing = true;
    });
    if (this.homeStanding && !standing) {
      this.homeStanding = false;
      this.endRealm();
    }
  }

  /**
   * La Crypta has fallen → the realm is OVER. Every defender falls with it, the
   * besieging horde is cleared, and a countdown begins (state.restartTimerMs). The
   * tick freezes all gameplay until it elapses, then startNewRealm() spins up the
   * next realm. A "wipe" event lets clients flash the defeat banner; the synced
   * restartTimerMs drives the "next realm in N" overlay on every screen.
   */
  private endRealm() {
    const wave = this.state.waveNumber;
    const persist = realmPolicy().progression.persistAcrossWipes;

    // Snapshot living progress first — the "realm-end" save is what carries a
    // Nostr player's progression across the wipe (and must run while the realm
    // tracker still points at the ending realm).
    this.state.players.forEach((p, sid) => {
      if (p.pubkey && p.nostrVerified) this.persistSave(sid, p, "realm-end");
    });

    // Everyone dies with the home (they respawn when the next realm starts).
    this.state.players.forEach((p, sid) => {
      p.hp = 0;
      p.state = AnimState.DEAD;
      p.respawnTimer = 0; // the intermission, not the per-player timer, gates respawn
      p.attackTargetId = "";
      p.pendingHitId = "";
      p.pickupTargetId = "";
      p.path = [];
      p.pathIndex = 0;
      // This forced defeat-death shouldn't persist as a Nostr save regression.
      if (this.saveTrack.has(sid)) this.saveTrack.set(sid, { level: p.level, dead: true });
    });

    this.state.enemies.clear(); // disperse the horde so the game-over screen is calm
    this.state.restartTimerMs = REALM_RESTART_MS; // freezes the world + starts the countdown
    realmTracker.homeFell(); // this realm is over (a fresh one starts after the countdown)

    serverPluginHost.fire("realm:end", { wave }, this.state);
    this.broadcast("wipe", { wave, persist }); // defeat banner (copy branches on persist)
    console.log(`[room] La Crypta fell on wave ${wave} — next realm in ${REALM_RESTART_MS / 1000}s`);
  }

  /**
   * The intermission has elapsed → spin up a new realm: the whole world
   * regenerates, La Crypta is rebuilt and the wave clock restarts. Whether the
   * players' progression survives is the realm policy's call — by default level,
   * XP, stats and inventory persist; with persistAcrossWipes=false everyone
   * respawns as a fresh level-1 character with a starter inventory (legacy wipe).
   */
  private startNewRealm() {
    this.pendingThrows.clear();
    // Restore any live berserker buffs to base stats BEFORE dropping the map —
    // otherwise the buffed attack/maxHp would be baked into persistent stats
    // (drink a potion right before the fall → keep the buff forever).
    this.berserkerBase.forEach((base, sid) => {
      const p = this.state.players.get(sid);
      if (!p) return;
      p.attack = base.attack;
      p.armor = base.armor;
      p.critChance = base.critChance;
      p.critMultiplier = base.critMultiplier;
      p.moveSpeed = base.moveSpeed;
      p.maxHp = base.maxHp; // HP refills to maxHp in the reset below
    });
    this.berserkerBase.clear();
    this.sacredHealCarry.clear();
    this.houseRegen.clear();
    this.state.timeScale = 1;

    // Regenerate the whole world from scratch: clear runtime entities, rebuild
    // first-realm resources/pickups, rebuild La Crypta, re-apply authored NPCs,
    // and restart every wave/spawner interval.
    this.state.enemies.clear();
    this.state.houses.clear();
    setRockObstacles([]); // match first-room resource placement before rocks exist
    resetResources(this.state); // trees/rocks rebuilt; dropped logs/stones/items cleared
    spawnInitialPotions(this.state);
    spawnInitialBananas(this.state);
    this.refreshRockObstacles(); // rocks are alive again → their collision is back
    spawnHouse(this.state);
    syncAuthoredNpcs(this.state);
    resetWaves(this.state, true);
    resetSpawners();

    const policy = realmPolicy();
    const persist = policy.progression.persistAcrossWipes;
    this.state.players.forEach((p, sid) => {
      resetPlayerForNewRealm(p, persist, devTuning());
      // Respawn ALIVE at a fresh spot. The DEAD→IDLE flip plays the lightning-
      // strike respawn on every client (placeAtFreeSpot sets x/z + targets + path).
      const angle = Math.random() * Math.PI * 2;
      const r = 12 + Math.random() * 4;
      placeAtFreeSpot(p, Math.cos(angle) * r, Math.sin(angle) * r);
      p.rotY = Math.atan2(-p.x, -p.z);
      // Watermark at the player's ACTUAL level — seeding {level: 1} under
      // persistence would fire a bogus "level-up" save on the next tick.
      if (this.saveTrack.has(sid)) this.saveTrack.set(sid, { level: p.level, dead: false });
    });

    if (persist && policy.progression.keepInventoryOnWipe) {
      // Inventories survive the wipe — just refresh every client's view.
      this.inventories.forEach((_inv, sid) => this.sendInventory(sid));
    } else {
      // Fresh empty inventory for everyone; players collect bananas/flasks in-world.
      this.inventories.forEach((_inv, sid) => {
        const inv = makeInventory();
        addItem(inv, "banana", STARTING_BANANAS);
        this.inventories.set(sid, inv);
        this.sendInventory(sid);
      });
    }
    this.homeStanding = true;
    this.realmTick = 0;
    this.state.restartTimerMs = 0;

    console.log(
      persist
        ? `[room] new realm started — world reset, character progression kept`
        : `[room] new realm started — everyone respawned from scratch`,
    );
  }

  /** The sender's Player, but only when their server-vouched pubkey is a
   *  configured admin (silently drops the message otherwise). Stricter than
   *  devSender: the admin_* family stays admin-only even on dev/test servers. */
  private adminSender(client: Client): Player | null {
    const p = this.state.players.get(client.sessionId);
    return p?.nostrVerified && isAdmin(p.pubkey) ? p : null;
  }

  /** Resolve the sender of a dev_* message — or undefined when they may not
   *  use the Dev Mode family on this server. Open to everyone on an explicit
   *  dev/test server; admin-only (ADMIN_NPUBS) everywhere else, including the
   *  env-less `gorilator` CLI install (policy: systems/devAuth.ts). A denial
   *  is logged once per session so a hostile client can't flood the log. */
  private devSender(client: Client): Player | undefined {
    const p = this.state.players.get(client.sessionId);
    if (p && canUseDevCommands(p)) return p;
    if (!this.devDenied.has(client.sessionId)) {
      this.devDenied.add(client.sessionId);
      console.warn(
        `[room] dev_* denied for ${p?.name ?? "?"} (${client.sessionId}) — ` +
          `not a verified admin on a non-dev server`,
      );
    }
    return undefined;
  }

  private handleDevAction(client: Client, action: DevActionMessage["action"]) {
    switch (action) {
      case "reset_realm":
        this.state.restartTimerMs = 0;
        this.startNewRealm();
        this.reportRealm();
        break;
      case "force_next_wave":
        forceNextWave(this.state);
        break;
      case "previous_wave":
        previousWave(this.state);
        break;
      case "kill_all_enemies":
        this.state.enemies.clear();
        break;
      case "kick_players":
        // Disconnect everyone except the dev issuing the command.
        for (const c of this.clients.slice()) {
          if (c.sessionId !== client.sessionId) c.leave();
        }
        break;
      case "level_up_player": {
        const p = this.state.players.get(client.sessionId);
        if (!p) return;
        const needed = Math.max(1, xpForLevel(p.level) - p.xp);
        grantXp(p, needed, (ev) => this.broadcast("xp", ev));
        break;
      }
    }
  }

  async onJoin(client: Client, options?: { name?: string; nostr?: NostrJoinPayload }) {
    // Nostr login (optional). If the client supplied a signed challenge, verify
    // it server-side; a bad signature or replayed/expired challenge rejects the
    // join. Anonymous (name-only) joins skip this entirely.
    let nostr: VerifiedNostr | null = null;
    if (options?.nostr) {
      try {
        nostr = verifyNostrLogin(options.nostr);
      } catch (err) {
        const reason = err instanceof Error ? err.message : "verification failed";
        console.warn(`[nostr] rejected ${client.sessionId}: ${reason}`);
        throw new Error(`Nostr login failed: ${reason}`);
      }
    }

    const p = new Player();
    p.id = client.sessionId;
    if (nostr) {
      // The pubkey + profile are now server-vouched (signature-proven).
      p.pubkey = nostr.pubkey;
      p.nostrVerified = true;
      p.isAdmin = isAdmin(nostr.pubkey);
      p.picture = nostr.picture;
      p.nip05 = nostr.nip05;
      p.name = (
        options?.name?.trim() ||
        nostr.name ||
        `npub-${nostr.pubkey.slice(0, 8)}`
      ).slice(0, 24);
    } else {
      p.name = options?.name?.trim() || `Knight-${client.sessionId.substring(0, 4)}`;
    }

    // Single session per nostr identity: if this npub is already playing here,
    // kick that session and inherit its (fresher-than-any-save) live state. If
    // it's NOT live, recover the player's last server-signed save off the relays
    // (bounded, so a slow relay just yields a fresh spawn instead of stalling
    // the join). Both carry the same fields, so one restore path handles either.
    const takeover = nostr ? this.takeOverSameNpub(client.sessionId, nostr.pubkey) : null;
    const savedState = nostr && !takeover ? await fetchServerSave(nostr.pubkey) : null;
    const restore: TakeoverState | PlayerSave | null = takeover ?? savedState ?? null;

    if (restore) {
      // Route the saved/inherited position through the free-spot check so
      // reconnecting never drops you INSIDE a solid object you'd be stuck in.
      placeAtFreeSpot(p, restore.x, restore.z);
      p.rotY = restore.rotY;
      p.maxHp = restore.maxHp;
      p.hp = restore.hp > 0 ? restore.hp : restore.maxHp; // don't arrive dead
      p.maxStamina = restore.maxStamina;
      p.stamina = restore.stamina;
      p.level = restore.level;
      p.xp = restore.xp;
      p.attack = restore.attack;
      p.armor = restore.armor;
      p.critChance = restore.critChance;
      p.moveSpeed = restore.moveSpeed;
      p.throwPower = restore.throwPower;
      p.hue = restore.hue;
      p.state = AnimState.IDLE;
    } else {
      const angle = Math.random() * Math.PI * 2;
      const r = 12 + Math.random() * 4; // spawn clear of the centre-cross goblin
      placeAtFreeSpot(p, Math.cos(angle) * r, Math.sin(angle) * r);
      p.rotY = Math.atan2(-p.x, -p.z);
      p.hue = Math.floor(Math.random() * 360);
      // Fresh (non-restored) joiners pick up the current tuned starting stats,
      // so Gameplay Options changes apply live without a server restart.
      const tune = devTuning();
      p.maxHp = tune.playerMaxHp;
      p.hp = tune.playerMaxHp;
      p.attack = tune.playerAttack;
      p.armor = tune.playerArmor;
      p.critChance = tune.playerCritChance;
      p.moveSpeed = tune.playerMoveSpeed;
    }

    this.state.players.set(client.sessionId, p);
    serverPluginHost.fire(
      "player:spawn",
      { playerId: client.sessionId, name: p.name, pubkey: p.pubkey },
      this.state,
    );
    this.reportRealm(); // ensure a live realm exists before any immediate save trigger
    realmTracker.noteNpub(p.pubkey); // track the npub in the live realm (no-op for anon / no realm)

    // Inherit the old session's / saved inventory, or start empty.
    const inv = restore?.inventory ?? makeInventory();
    if (!restore?.inventory) {
      addItem(inv, "banana", STARTING_BANANAS);
    }
    this.inventories.set(client.sessionId, inv);
    client.send("inventory", inv);

    // Track this Nostr player's level/death watermark so the tick can persist a
    // save the moment they level up or die.
    if (nostr) this.saveTrack.set(client.sessionId, { level: p.level, dead: false });

    const how = takeover ? "took over" : savedState ? "recovered" : "joined";
    console.log(
      `[room] ${p.name}${p.nostrVerified ? " ⚡nostr" : ""} ${how} ` +
        `(lv ${p.level}, ${this.state.players.size} online)`,
    );
  }

  /**
   * Single session per nostr identity. If `pubkey` is already playing in this
   * room under a different session, snapshot that session's place + stats +
   * inventory, kick it (the newest login has priority), and return the snapshot
   * for the new player to inherit. Returns null for anonymous / first-time keys.
   */
  private takeOverSameNpub(newSessionId: string, pubkey: string): TakeoverState | null {
    if (!pubkey) return null;
    let oldSid: string | null = null;
    let snap: TakeoverState | null = null;
    for (const [sid, existing] of this.state.players) {
      if (sid === newSessionId || existing.pubkey !== pubkey) continue;
      oldSid = sid;
      snap = {
        x: existing.x,
        z: existing.z,
        rotY: existing.rotY,
        hp: existing.hp,
        maxHp: existing.maxHp,
        stamina: existing.stamina,
        maxStamina: existing.maxStamina,
        level: existing.level,
        xp: existing.xp,
        attack: existing.attack,
        armor: existing.armor,
        critChance: existing.critChance,
        moveSpeed: existing.moveSpeed,
        throwPower: existing.throwPower,
        hue: existing.hue,
        inventory: this.inventories.get(sid),
      };
      break;
    }
    if (!snap || !oldSid) return null;
    // Stop tracking the kicked session's saves immediately (its onLeave fires
    // async; clearing here avoids a stray save for a session being taken over).
    this.saveTrack.delete(oldSid);
    // Kick the old session — onLeave removes its player/inventory/throws, and we
    // already captured everything the new session inherits.
    this.clients.find((c) => c.sessionId === oldSid)?.leave(NOSTR_TAKEOVER_CODE);
    console.log(
      `[room] npub ${pubkey.slice(0, 8)}… re-logged in → kicked ${oldSid}, ` +
        `${newSessionId} takes over`,
    );
    return snap;
  }

  onLeave(client: Client) {
    // Persist a Nostr player's final state on the way out (the "logout" save).
    // This covers tab-close too: the dropped socket fires onLeave server-side,
    // which is more reliable than a client `beforeunload` ever was.
    const p = this.state.players.get(client.sessionId);
    if (p?.pubkey && p.nostrVerified) this.persistSave(client.sessionId, p, "logout");

    this.state.players.delete(client.sessionId);
    this.inventories.delete(client.sessionId);
    this.pendingThrows.delete(client.sessionId);
    this.saveTrack.delete(client.sessionId);
    this.berserkerBase.delete(client.sessionId);
    this.devDenied.delete(client.sessionId);
    console.log(`[room] ${client.sessionId} left`);
  }

  /** Each tick: for every tracked (Nostr-logged-in) player, persist a save the
   *  instant they level up or die — the moments worth recovering from. */
  private detectSaveTriggers(): void {
    if (this.saveTrack.size === 0) return;
    for (const [sid, track] of this.saveTrack) {
      const p = this.state.players.get(sid);
      if (!p) continue;
      const dead = p.state === AnimState.DEAD;
      const leveledUp = p.level > track.level;
      const justDied = dead && !track.dead;
      track.level = p.level;
      track.dead = dead;
      if (leveledUp) this.persistSave(sid, p, "level-up");
      else if (justDied) this.persistSave(sid, p, "death");
    }
  }

  /** Snapshot a player + its inventory and enqueue a server-signed save
   *  (coalesced per pubkey, so overlapping triggers never double-publish). */
  private persistSave(sid: string, p: Player, reason: string): void {
    if (!p.pubkey) return;
    this.serverSaver.save(
      p.pubkey,
      buildServerSave(p, this.inventories.get(sid) ?? [], {
        realm: realmTracker.playerSaveRealm(),
        reason,
      }),
      reason,
    );
  }

  /** Total synced entities across every collection — the "world size" the perf
   *  tracker pairs with each tick's cost (so a tick-time trend reads against load). */
  private entityCount(): number {
    const s = this.state;
    return (
      s.players.size +
      s.enemies.size +
      s.trees.size +
      s.rocks.size +
      s.logs.size +
      s.stones.size +
      s.potions.size +
      s.bananas.size +
      s.items.size +
      s.houses.size
    );
  }

  /** Rebuild the pathfinding rock obstacles from the live Rock entities (all of
   *  them, alive or mined, so mined rocks still block). Run on startup and after
   *  the dev editor relocates/removes a rock. */
  private refreshRockObstacles() {
    const circles: { x: number; z: number; radius: number }[] = [];
    // collision footprint is a fraction of the visual radius, so players can walk
    // right up to a boulder (and reach the stones it drops) instead of being held
    // off at arm's length.
    this.state.rocks.forEach((r) =>
      circles.push({ x: r.x, z: r.z, radius: r.radius * (r.scale || 1) * ROCK_COLLISION_SCALE }),
    );
    setRockObstacles(circles);
  }

  /** Launch any banana whose pitch has reached its release point, in the
   *  direction the thrower is now facing. */
  private releasePendingThrows(deltaMs: number) {
    this.pendingThrows.forEach((pt, sid) => {
      pt.timer -= deltaMs;
      if (pt.timer > 0) return;
      this.pendingThrows.delete(sid);
      const p = this.state.players.get(sid);
      if (!p || p.state === AnimState.DEAD) return; // died mid-windup
      // throw along the character's current facing (rotY = atan2(dx, dz))
      const aimX = clampToWorld(p.x + Math.sin(p.rotY) * BANANA_MAX_THROW);
      const aimZ = clampToWorld(p.z + Math.cos(p.rotY) * BANANA_MAX_THROW);
      const ev = planThrow(this.state, p, aimX, aimZ, pt.power, pt.item);
      this.broadcast("banana_throw", ev);
    });
  }

  private sendInventory(sessionId: string) {
    const inv = this.inventories.get(sessionId);
    if (!inv) return;
    const client = this.clients.find((c) => c.sessionId === sessionId);
    client?.send("inventory", inv);
  }
}
