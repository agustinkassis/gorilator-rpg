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
  DamageEvent,
  HealEvent,
  XpEvent,
  BananaThrowEvent,
  ChatEvent,
  InventorySlot,
  ROOM_NAME,
  SERVER_PORT,
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
  onBananaThrow(ev: BananaThrowEvent): void;
  onDamage(ev: DamageEvent): void;
  onHeal(ev: HealEvent): void;
  onXp(ev: XpEvent): void;
  onChat(ev: ChatEvent): void;
  onInventory(slots: InventorySlot[]): void;
  onError(message: string): void;
}

function defaultEndpoint(): string {
  // Production (Docker + Cloudflare): the server lives on its own subdomain over
  // 443, baked into the bundle at build time as VITE_SERVER_URL (e.g.
  // wss://api.example.com). Vite only exposes VITE_-prefixed env vars.
  const fromEnv = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (fromEnv) return fromEnv;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  // Dev: client is served on :5173, the Colyseus server runs on :2567.
  return `${proto}://${location.hostname}:${SERVER_PORT}`;
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

      room.onMessage("damage", (ev: DamageEvent) => handlers.onDamage(ev));
      room.onMessage("heal", (ev: HealEvent) => handlers.onHeal(ev));
      room.onMessage("xp", (ev: XpEvent) => handlers.onXp(ev));
      room.onMessage("banana_throw", (ev: BananaThrowEvent) => handlers.onBananaThrow(ev));
      room.onMessage("chat", (ev: ChatEvent) => handlers.onChat(ev));
      room.onMessage("inventory", (slots: InventorySlot[]) => handlers.onInventory(slots));

      room.onError((code, message) => {
        handlers.onError(`room error ${code}: ${message ?? ""}`);
      });
      room.onLeave(() => handlers.onError("disconnected"));
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
}
