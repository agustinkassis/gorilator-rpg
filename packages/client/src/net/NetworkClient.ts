import { Client, type Room, getStateCallbacks } from "colyseus.js";
import type { NostrAuthPayload } from "./nostr";
import {
  type GameState,
  type Player,
  type Enemy,
  type Potion,
  type Tree,
  type Log,
  type Rock,
  type Stone,
  type Banana,
  type Item,
  type House,
  type Structure,
  type DamageEvent,
  type KillEvent,
  type HealEvent,
  type XpEvent,
  type BananaThrowEvent,
  type ChatEvent,
  type InventorySlot,
  ROOM_NAME,
  SERVER_PORT,
  NOSTR_TAKEOVER_CODE,
  type DevActionId,
  type DevTuningKey,
  type ScenarioInfoMessage,
} from "@rpg/shared";

export interface NetHandlers {
  onConnected(sessionId: string): void;
  onPlayerAdd(p: Player, id: string): void;
  onPlayerChange(p: Player, id: string): void;
  onPlayerRemove(id: string): void;
  onEnemyAdd(e: Enemy, id: string): void;
  onEnemyChange(e: Enemy, id: string): void;
  onEnemyRemove(id: string): void;
  onPotionAdd(p: Potion, id: string): void;
  onPotionChange(p: Potion, id: string): void;
  onPotionRemove(id: string): void;
  onTreeAdd(t: Tree, id: string): void;
  onTreeChange(t: Tree, id: string): void;
  onTreeRemove(id: string): void;
  onLogAdd(l: Log, id: string): void;
  onLogChange(l: Log, id: string): void;
  onLogRemove(id: string): void;
  onRockAdd(r: Rock, id: string): void;
  onRockChange(r: Rock, id: string): void;
  onRockRemove(id: string): void;
  onStoneAdd(s: Stone, id: string): void;
  onStoneChange(s: Stone, id: string): void;
  onStoneRemove(id: string): void;
  onBananaAdd(b: Banana, id: string): void;
  onBananaChange(b: Banana, id: string): void;
  onBananaRemove(id: string): void;
  onItemAdd(item: Item, id: string): void;
  onItemChange(item: Item, id: string): void;
  onItemRemove(id: string): void;
  onHouseAdd(h: House, id: string): void;
  onHouseChange(h: House, id: string): void;
  onHouseRemove(id: string): void;
  onStructureAdd(s: Structure, id: string): void;
  onStructureChange(s: Structure, id: string): void;
  onStructureRemove(id: string): void;
  onBananaThrow(ev: BananaThrowEvent): void;
  onDamage(ev: DamageEvent): void;
  onHeal(ev: HealEvent): void;
  onXp(ev: XpEvent): void;
  onChat(ev: ChatEvent): void;
  onInventory(slots: InventorySlot[]): void;
  onScenario?(info: ScenarioInfoMessage): void; // Feature Lab: the active scenario + its tweak knobs
  onWipe(ev: { wave: number; persist?: boolean }): void; // La Crypta fell → realm resets (persist = progression kept)
  onError(message: string): void;
  onKill(ev: KillEvent): void;
}

function defaultEndpoint(): string {
  // Legacy split-host deploys can bake an explicit server URL at build time
  // as VITE_SERVER_URL (e.g. wss://server.example.com).
  // Vite only exposes VITE_-prefixed env vars.
  const fromEnv = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (fromEnv) return fromEnv;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  // Production deploys: one server serves the client AND the WebSocket, so dial
  // the page's own host + port.
  if (import.meta.env.VITE_SAME_ORIGIN) return `${proto}://${location.host}`;
  // Dev or explicit --client-port runs: the client is served on its own port
  // while the Colyseus server listens on another port of the same host.
  const serverPort = (import.meta.env.VITE_SERVER_PORT as string | undefined) || String(SERVER_PORT);
  return `${proto}://${location.hostname}:${serverPort}`;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        window.clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export class NetworkClient {
  private client: Client;
  private endpoint: string;
  room?: Room<GameState>;
  /** Set during an intentional logout so onLeave doesn't flash a "disconnected" toast. */
  private leaving = false;
  /** In-flight nostr_upgrade round-trips, keyed by request id (so concurrent
   *  upgrades + a disconnect mid-flight settle the right promise). */
  private upgradeResolvers = new Map<
    string,
    { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(endpoint: string = defaultEndpoint()) {
    this.endpoint = endpoint;
    this.client = new Client(endpoint);
  }

  /** Intentionally leave the current room (logout). Suppresses the leave toast. */
  async leave(): Promise<void> {
    this.leaving = true;
    try {
      await this.room?.leave(true);
    } catch {
      /* already gone */
    }
    this.room = undefined;
  }

  /**
   * Upgrade the current (e.g. anonymous) session to a Nostr identity in place —
   * send a freshly-signed kind-22242 auth; the server verifies + attaches the npub
   * to the live player (keeping current progress). Resolves on the server's ack.
   */
  upgradeNostr(payload: NostrAuthPayload): Promise<void> {
    const room = this.room;
    if (!room) return Promise.reject(new Error("not connected"));
    const id = (globalThis.crypto?.randomUUID?.() ?? `up_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.upgradeResolvers.delete(id);
        reject(new Error("server didn't respond"));
      }, 12000);
      this.upgradeResolvers.set(id, { resolve, reject, timer });
      room.send("nostr_upgrade", { ...payload, id });
    });
  }

  /** The server's HTTP(S) base (the WebSocket endpoint with ws→http), for the
   *  REST API — the perf overlay polls `${httpBase()}/api/perf`, etc. */
  httpBase(): string {
    return this.endpoint.replace(/^ws/, "http");
  }

  async connect(
    handlers: NetHandlers,
    options: { name?: string; nostr?: NostrAuthPayload; scenario?: string } = {},
  ): Promise<void> {
    let phase = "join room";
    try {
      const room = await this.client.joinOrCreate<GameState>(ROOM_NAME, options);
      this.room = room;
      handlers.onConnected(room.sessionId);

      const $ = getStateCallbacks(room);
      let resolveLocalPlayer: (() => void) | undefined;
      const localPlayerReady = new Promise<void>((resolve) => {
        resolveLocalPlayer = resolve;
      });

      phase = "bind players";
      const seenPlayers = new Set<string>();
      const bindPlayer = (player: Player, id: string) => {
        if (seenPlayers.has(id)) return;
        seenPlayers.add(id);
        handlers.onPlayerAdd(player, id);
        $(player).onChange(() => handlers.onPlayerChange(player, id));
        if (id === room.sessionId) resolveLocalPlayer?.();
      };
      $(room.state).players.onAdd(bindPlayer);
      room.state.players?.forEach((player, id) => bindPlayer(player, id));
      $(room.state).players.onRemove((_player, id) => {
        seenPlayers.delete(id);
        handlers.onPlayerRemove(id);
      });

      phase = "bind enemies";
      const seenEnemies = new Set<string>();
      const bindEnemy = (enemy: Enemy, id: string) => {
        if (seenEnemies.has(id)) return;
        seenEnemies.add(id);
        handlers.onEnemyAdd(enemy, id);
        $(enemy).onChange(() => handlers.onEnemyChange(enemy, id));
      };
      $(room.state).enemies.onAdd(bindEnemy);
      room.state.enemies?.forEach((enemy, id) => bindEnemy(enemy, id));
      $(room.state).enemies.onRemove((_enemy, id) => {
        seenEnemies.delete(id);
        handlers.onEnemyRemove(id);
      });

      phase = "bind potions";
      const seenPotions = new Set<string>();
      const bindPotion = (potion: Potion, id: string) => {
        if (seenPotions.has(id)) return;
        seenPotions.add(id);
        handlers.onPotionAdd(potion, id);
        $(potion).onChange(() => handlers.onPotionChange(potion, id));
      };
      $(room.state).potions.onAdd(bindPotion);
      room.state.potions?.forEach((potion, id) => bindPotion(potion, id));
      $(room.state).potions.onRemove((_potion, id) => {
        seenPotions.delete(id);
        handlers.onPotionRemove(id);
      });

      phase = "bind trees";
      const seenTrees = new Set<string>();
      const bindTree = (tree: Tree, id: string) => {
        if (seenTrees.has(id)) return;
        seenTrees.add(id);
        handlers.onTreeAdd(tree, id);
        $(tree).onChange(() => handlers.onTreeChange(tree, id));
      };
      $(room.state).trees.onAdd(bindTree);
      room.state.trees?.forEach((tree, id) => bindTree(tree, id));
      $(room.state).trees.onRemove((_tree, id) => {
        seenTrees.delete(id);
        handlers.onTreeRemove(id);
      });

      phase = "bind logs";
      const seenLogs = new Set<string>();
      const bindLog = (log: Log, id: string) => {
        if (seenLogs.has(id)) return;
        seenLogs.add(id);
        handlers.onLogAdd(log, id);
        $(log).onChange(() => handlers.onLogChange(log, id));
      };
      $(room.state).logs.onAdd(bindLog);
      room.state.logs?.forEach((log, id) => bindLog(log, id));
      $(room.state).logs.onRemove((_log, id) => {
        seenLogs.delete(id);
        handlers.onLogRemove(id);
      });

      phase = "bind rocks";
      const seenRocks = new Set<string>();
      const bindRock = (rock: Rock, id: string) => {
        if (seenRocks.has(id)) return;
        seenRocks.add(id);
        handlers.onRockAdd(rock, id);
        $(rock).onChange(() => handlers.onRockChange(rock, id));
      };
      $(room.state).rocks.onAdd(bindRock);
      room.state.rocks?.forEach((rock, id) => bindRock(rock, id));
      $(room.state).rocks.onRemove((_rock, id) => {
        seenRocks.delete(id);
        handlers.onRockRemove(id);
      });

      phase = "bind stones";
      const seenStones = new Set<string>();
      const bindStone = (stone: Stone, id: string) => {
        if (seenStones.has(id)) return;
        seenStones.add(id);
        handlers.onStoneAdd(stone, id);
        $(stone).onChange(() => handlers.onStoneChange(stone, id));
      };
      $(room.state).stones.onAdd(bindStone);
      room.state.stones?.forEach((stone, id) => bindStone(stone, id));
      $(room.state).stones.onRemove((_stone, id) => {
        seenStones.delete(id);
        handlers.onStoneRemove(id);
      });

      phase = "bind bananas";
      const seenBananas = new Set<string>();
      const bindBanana = (banana: Banana, id: string) => {
        if (seenBananas.has(id)) return;
        seenBananas.add(id);
        handlers.onBananaAdd(banana, id);
        $(banana).onChange(() => handlers.onBananaChange(banana, id));
      };
      $(room.state).bananas.onAdd(bindBanana);
      room.state.bananas?.forEach((banana, id) => bindBanana(banana, id));
      $(room.state).bananas.onRemove((_banana, id) => {
        seenBananas.delete(id);
        handlers.onBananaRemove(id);
      });

      phase = "bind generic items";
      const seenItems = new Set<string>();
      const bindItem = (item: Item, id: string) => {
        if (seenItems.has(id)) return;
        seenItems.add(id);
        handlers.onItemAdd(item, id);
        $(item).onChange(() => handlers.onItemChange(item, id));
      };
      if (room.state.items) {
        $(room.state).items.onAdd(bindItem);
        room.state.items.forEach((item, id) => bindItem(item, id));
        $(room.state).items.onRemove((_item, id) => {
          seenItems.delete(id);
          handlers.onItemRemove(id);
        });
      }

      phase = "bind houses";
      const seenHouses = new Set<string>();
      const bindHouse = (house: House, id: string) => {
        if (seenHouses.has(id)) return;
        seenHouses.add(id);
        handlers.onHouseAdd(house, id);
        $(house).onChange(() => handlers.onHouseChange(house, id));
      };
      $(room.state).houses.onAdd(bindHouse);
      room.state.houses?.forEach((house, id) => bindHouse(house, id));
      $(room.state).houses.onRemove((_house, id) => {
        seenHouses.delete(id);
        handlers.onHouseRemove(id);
      });

      phase = "bind structures";
      const seenStructures = new Set<string>();
      const bindStructure = (s: Structure, id: string) => {
        if (seenStructures.has(id)) return;
        seenStructures.add(id);
        handlers.onStructureAdd(s, id);
        $(s).onChange(() => handlers.onStructureChange(s, id));
      };
      $(room.state).structures.onAdd(bindStructure);
      room.state.structures?.forEach((s, id) => bindStructure(s, id));
      $(room.state).structures.onRemove((_s, id) => {
        seenStructures.delete(id);
        handlers.onStructureRemove(id);
      });

      phase = "bind messages";
      room.onMessage("damage", (ev: DamageEvent) => handlers.onDamage(ev));
      room.onMessage("kill", (ev: KillEvent) => handlers.onKill(ev));
      room.onMessage("heal", (ev: HealEvent) => handlers.onHeal(ev));
      room.onMessage("xp", (ev: XpEvent) => handlers.onXp(ev));
      room.onMessage("banana_throw", (ev: BananaThrowEvent) => handlers.onBananaThrow(ev));
      room.onMessage("chat", (ev: ChatEvent) => handlers.onChat(ev));
      room.onMessage("inventory", (slots: InventorySlot[]) => handlers.onInventory(slots));
      room.onMessage("scenario", (info: ScenarioInfoMessage) => handlers.onScenario?.(info));
      room.onMessage("wipe", (ev: { wave: number; persist?: boolean }) => handlers.onWipe(ev));
      room.onMessage("nostr_upgrade_result", (res: { id?: string; ok: boolean; error?: string }) => {
        const p = this.upgradeResolvers.get(res.id ?? "");
        if (!p) return;
        this.upgradeResolvers.delete(res.id ?? "");
        clearTimeout(p.timer);
        if (res.ok) p.resolve();
        else p.reject(new Error(res.error || "login rejected"));
      });

      room.onError((code, message) => {
        handlers.onError(`room error ${code}: ${message ?? ""}`);
      });
      room.onLeave((code) => {
        // Fail any in-flight nostr_upgrade so it doesn't hang until the timeout.
        for (const [, p] of this.upgradeResolvers) {
          clearTimeout(p.timer);
          p.reject(new Error("disconnected"));
        }
        this.upgradeResolvers.clear();
        if (this.leaving) return; // intentional logout — no toast
        // The server kicks this session when the same npub logs in elsewhere.
        handlers.onError(
          code === NOSTR_TAKEOVER_CODE
            ? "logged in from another window — this session was closed"
            : "disconnected",
        );
      });

      phase = "wait for local player";
      await withTimeout(localPlayerReady, 8000, "timed out waiting for local player state");
    } catch (err) {
      const message = err instanceof Error ? `${phase}: ${err.message}` : `${phase}: failed to connect to server`;
      handlers.onError(message);
      throw new Error(message);
    }
  }

  sendMove(x: number, z: number, gz?: number) {
    this.room?.send("move", gz !== undefined ? { x, z, gz } : { x, z });
  }

  sendAttack(targetId: string) {
    this.room?.send("attack", { targetId });
  }

  sendPickup(id: string) {
    this.room?.send("pickup", { id });
  }

  sendInventoryMove(from: number, to: number) {
    this.room?.send("inventory_move", { from, to });
  }

  sendUseItem(slot: number) {
    this.room?.send("use_item", { slot });
  }

  sendThrow(x: number, z: number, power: number, item: "banana" | "stone" = "banana") {
    this.room?.send("throw", { x, z, power, item });
  }

  sendChat(text: string) {
    this.room?.send("chat", { text });
  }

  /** Report SPACE held (sprint on) / released (sprint off). */
  sendSprint(on: boolean) {
    this.room?.send("sprint", { on });
  }

  /** "Kill yourself" (game menu): die now + respawn (no XP penalty). */
  sendSuicide() {
    this.room?.send("suicide");
  }

  // ---- Dev Mode (in-game editor) ----
  /** Toggle the local player's immortality. */
  sendGodMode(on: boolean) {
    this.room?.send("dev_god", { on });
  }

  /** Relocate a synced world object (tree/rock/potion/dummy). */
  sendDevMove(kind: string, id: string, x: number, z: number) {
    this.room?.send("dev_move", { kind, id, x, z });
  }

  /** Create a synced world object and return the client-chosen id for focusing it. */
  sendDevSpawn(kind: string, x: number, z: number): string {
    const safe = kind.replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
    const id = `dev-${safe}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    this.room?.send("dev_spawn", { kind, id, x, z });
    return id;
  }

  /** Delete a synced world object (persisted server-side). */
  sendDevDelete(kind: string, id: string) {
    this.room?.send("dev_delete", { kind, id });
  }

  /** Set one editable field on a synced world object. */
  sendDevSet(kind: string, id: string, field: string, value: number | boolean | string) {
    this.room?.send("dev_set", { kind, id, field, value });
  }

  /** Grant an item stack to the local player's inventory. */
  sendDevGiveItem(type: string, amount = 1) {
    this.room?.send("dev_give_item", { type, amount });
  }

  /** Dev-only: overwrite a specific inventory slot (empty type clears it). */
  sendDevSetSlot(slot: number, type: string, count: number) {
    this.room?.send("dev_set_slot", { slot, type, count });
  }

  /** Set the simulation speed (1 = normal, 0 = paused, 2 = double, …). */
  sendDevTime(scale: number) {
    this.room?.send("dev_time", { scale });
  }

  /** Trigger one high-level Dev Mode gameplay command. */
  sendDevAction(action: DevActionId) {
    this.room?.send("dev_action", { action });
  }

  /** Override one runtime gameplay tuning value for this server process. */
  sendDevTune(key: DevTuningKey, value: number) {
    this.room?.send("dev_tune", { key, value });
  }

  /** Spawn/clear scripted bot players (Feature Lab #68; devSender-gated). */
  sendDevBot(op: "spawn" | "clear", behavior?: string, count?: number) {
    this.room?.send("dev_bot", { op, behavior, count });
  }

  // ---- Admin (Esc menu → Admin; the server enforces the ADMIN_NPUBS allowlist) ----
  /** Stop/resume the tower-defense wave clock. */
  sendAdminWaves(enabled: boolean) {
    this.room?.send("admin_waves", { enabled });
  }

  /** Kick a player or scripted bot out of the realm (big map → player list). */
  sendAdminKick(playerId: string) {
    this.room?.send("admin_kick", { playerId });
  }

  /** Switch one spawners.json spawner on/off at runtime. */
  sendAdminSpawner(id: string, enabled: boolean) {
    this.room?.send("admin_spawner", { id, enabled });
  }
}
