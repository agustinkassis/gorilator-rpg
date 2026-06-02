import { Client, Room, getStateCallbacks } from "colyseus.js";
import type { NostrAuthPayload } from "./nostr";
import {
  GameState,
  Player,
  Enemy,
  Potion,
  Tree,
  Log,
  Rock,
  Stone,
  Banana,
  House,
  DamageEvent,
  HealEvent,
  XpEvent,
  BananaThrowEvent,
  ChatEvent,
  InventorySlot,
  ROOM_NAME,
  SERVER_PORT,
  NOSTR_TAKEOVER_CODE,
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
  onPotionRemove(id: string): void;
  onTreeAdd(t: Tree, id: string): void;
  onTreeChange(t: Tree, id: string): void;
  onTreeRemove(id: string): void;
  onLogAdd(l: Log, id: string): void;
  onLogRemove(id: string): void;
  onRockAdd(r: Rock, id: string): void;
  onRockChange(r: Rock, id: string): void;
  onRockRemove(id: string): void;
  onStoneAdd(s: Stone, id: string): void;
  onStoneRemove(id: string): void;
  onBananaAdd(b: Banana, id: string): void;
  onBananaRemove(id: string): void;
  onHouseAdd(h: House, id: string): void;
  onHouseChange(h: House, id: string): void;
  onHouseRemove(id: string): void;
  onBananaThrow(ev: BananaThrowEvent): void;
  onDamage(ev: DamageEvent): void;
  onHeal(ev: HealEvent): void;
  onXp(ev: XpEvent): void;
  onChat(ev: ChatEvent): void;
  onInventory(slots: InventorySlot[]): void;
  onWipe(ev: { wave: number }): void; // La Crypta fell → round wiped to scratch
  onError(message: string): void;
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

export class NetworkClient {
  private client: Client;
  room?: Room<GameState>;

  constructor(endpoint: string = defaultEndpoint()) {
    this.client = new Client(endpoint);
  }

  async connect(
    handlers: NetHandlers,
    options: { name?: string; nostr?: NostrAuthPayload } = {},
  ): Promise<void> {
    try {
      const room = await this.client.joinOrCreate<GameState>(ROOM_NAME, options);
      this.room = room;
      handlers.onConnected(room.sessionId);

      const $ = getStateCallbacks(room);

      $(room.state).players.onAdd((player, id) => {
        handlers.onPlayerAdd(player, id);
        $(player).onChange(() => handlers.onPlayerChange(player, id));
      });
      $(room.state).players.onRemove((_player, id) => {
        handlers.onPlayerRemove(id);
      });

      $(room.state).enemies.onAdd((enemy, id) => {
        handlers.onEnemyAdd(enemy, id);
        $(enemy).onChange(() => handlers.onEnemyChange(enemy, id));
      });
      $(room.state).enemies.onRemove((_enemy, id) => {
        handlers.onEnemyRemove(id);
      });

      $(room.state).potions.onAdd((potion, id) => handlers.onPotionAdd(potion, id));
      $(room.state).potions.onRemove((_potion, id) => handlers.onPotionRemove(id));

      $(room.state).trees.onAdd((tree, id) => {
        handlers.onTreeAdd(tree, id);
        $(tree).onChange(() => handlers.onTreeChange(tree, id));
      });
      $(room.state).trees.onRemove((_tree, id) => handlers.onTreeRemove(id));

      $(room.state).logs.onAdd((log, id) => handlers.onLogAdd(log, id));
      $(room.state).logs.onRemove((_log, id) => handlers.onLogRemove(id));

      $(room.state).rocks.onAdd((rock, id) => {
        handlers.onRockAdd(rock, id);
        $(rock).onChange(() => handlers.onRockChange(rock, id));
      });
      $(room.state).rocks.onRemove((_rock, id) => handlers.onRockRemove(id));

      $(room.state).stones.onAdd((stone, id) => handlers.onStoneAdd(stone, id));
      $(room.state).stones.onRemove((_stone, id) => handlers.onStoneRemove(id));

      $(room.state).bananas.onAdd((banana, id) => handlers.onBananaAdd(banana, id));
      $(room.state).bananas.onRemove((_banana, id) => handlers.onBananaRemove(id));

      $(room.state).houses.onAdd((house, id) => {
        handlers.onHouseAdd(house, id);
        $(house).onChange(() => handlers.onHouseChange(house, id));
      });
      $(room.state).houses.onRemove((_house, id) => handlers.onHouseRemove(id));

      room.onMessage("damage", (ev: DamageEvent) => handlers.onDamage(ev));
      room.onMessage("heal", (ev: HealEvent) => handlers.onHeal(ev));
      room.onMessage("xp", (ev: XpEvent) => handlers.onXp(ev));
      room.onMessage("banana_throw", (ev: BananaThrowEvent) => handlers.onBananaThrow(ev));
      room.onMessage("chat", (ev: ChatEvent) => handlers.onChat(ev));
      room.onMessage("inventory", (slots: InventorySlot[]) => handlers.onInventory(slots));
      room.onMessage("wipe", (ev: { wave: number }) => handlers.onWipe(ev));

      room.onError((code, message) => {
        handlers.onError(`room error ${code}: ${message ?? ""}`);
      });
      room.onLeave((code) => {
        // The server kicks this session when the same npub logs in elsewhere.
        handlers.onError(
          code === NOSTR_TAKEOVER_CODE
            ? "logged in from another window — this session was closed"
            : "disconnected",
        );
      });
    } catch (err) {
      handlers.onError(
        err instanceof Error ? err.message : "failed to connect to server",
      );
      throw err;
    }
  }

  sendMove(x: number, z: number) {
    this.room?.send("move", { x, z });
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

  /** Delete a synced world object (persisted server-side). */
  sendDevDelete(kind: string, id: string) {
    this.room?.send("dev_delete", { kind, id });
  }

  /** Set one editable field on a synced world object. */
  sendDevSet(kind: string, id: string, field: string, value: number | boolean | string) {
    this.room?.send("dev_set", { kind, id, field, value });
  }

  /** Set the simulation speed (1 = normal, 0 = paused, 2 = double, …). */
  sendDevTime(scale: number) {
    this.room?.send("dev_time", { scale });
  }
}
