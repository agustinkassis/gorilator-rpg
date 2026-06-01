import { Room, Client } from "@colyseus/core";
import {
  GameState,
  Player,
  AnimState,
  MoveMessage,
  AttackMessage,
  PickupMessage,
  InventoryMoveMessage,
  UseItemMessage,
  ThrowMessage,
  ChatMessage,
  CHAT_MAX_LEN,
  InventorySlot,
  ItemType,
  DamageEvent,
  XpEvent,
  POTION_HEAL,
  THROW_STATE_MS,
  THROW_RELEASE_FRACTION,
  BANANA_MAX_THROW,
  STARTING_BANANAS,
  TICK_RATE,
} from "@rpg/shared";
import { movementSystem, setDestination, placeAtFreeSpot } from "../systems/movement";
import {
  combatSystem,
  spawnDummies,
  handleAttack,
  clampToWorld,
} from "../systems/combat";
import { spawnInitialPotions, potionRespawnSystem } from "../systems/pickups";
import {
  spawnTrees,
  treeRegrowSystem,
  spawnRocks,
  rockRegrowSystem,
  itemPickupSystem,
  autoGrabSystem,
} from "../systems/resources";
import { makeInventory, addItem, moveItem, removeItem, countItem } from "../systems/inventory";
import { spawnInitialBananas, bananaSystem, planThrow } from "../systems/bananas";
import { spawnGoblins, goblinAiSystem, goblinSpawnSystem } from "../systems/goblins";
import { loadPropObstacles } from "../systems/props";
import { verifyNostrLogin, NostrJoinPayload, VerifiedNostr } from "../systems/nostr";

export class GameRoom extends Room<GameState> {
  maxClients = 16;

  /** Per-player inventory, kept off the synced state and sent only to its owner. */
  private inventories = new Map<string, InventorySlot[]>();

  /** Banana throws mid-windup: the banana launches once the pitch reaches its
   *  release point (THROW_RELEASE_FRACTION through the animation), not on input. */
  private pendingThrows = new Map<
    string,
    { power: number; timer: number; item: "banana" | "stone" }
  >();

  onCreate() {
    this.setState(new GameState());
    loadPropObstacles(); // collision for any imported "concrete" props (+ live reload)
    spawnDummies(this.state);
    spawnGoblins(this.state);
    spawnInitialPotions(this.state);
    spawnTrees(this.state);
    spawnRocks(this.state);
    spawnInitialBananas(this.state);

    this.onMessage("move", (client, msg: MoveMessage) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || p.state === AnimState.DEAD) return;
      p.attackTargetId = "";
      p.pickupTargetId = ""; // a manual move cancels any pursuit
      setDestination(p, clampToWorld(msg.x), clampToWorld(msg.z));
    });

    this.onMessage("attack", (client, msg: AttackMessage) => {
      const p = this.state.players.get(client.sessionId);
      if (p) p.pickupTargetId = "";
      handleAttack(this.state, client.sessionId, msg.targetId);
    });

    this.onMessage("pickup", (client, msg: PickupMessage) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || p.state === AnimState.DEAD) return;
      const target =
        this.state.logs.get(msg.id) ??
        this.state.stones.get(msg.id) ??
        this.state.potions.get(msg.id) ??
        this.state.bananas.get(msg.id);
      if (!target) return;
      p.attackTargetId = "";
      p.pickupTargetId = msg.id;
      setDestination(p, target.x, target.z);
    });

    this.onMessage("throw", (client, msg: ThrowMessage) => {
      const p = this.state.players.get(client.sessionId);
      const inv = this.inventories.get(client.sessionId);
      if (!p || !inv || p.state === AnimState.DEAD) return;
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
      const power = Math.max(0, Math.min(1, msg.power ?? 0));
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
      const inv = this.inventories.get(client.sessionId);
      const p = this.state.players.get(client.sessionId);
      if (!inv || !p || p.state === AnimState.DEAD) return;
      const slot = inv[msg.slot];
      if (!slot || slot.type !== "potion" || slot.count <= 0) return;
      if (p.hp >= p.maxHp) return; // don't waste a potion at full HP
      const heal = Math.min(POTION_HEAL, p.maxHp - p.hp);
      p.hp += heal;
      slot.count -= 1;
      if (slot.count <= 0) {
        slot.type = "";
        slot.count = 0;
      }
      this.broadcast("heal", { targetId: client.sessionId, amount: heal });
      this.sendInventory(client.sessionId);
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

    // Fixed-step authoritative simulation.
    this.setSimulationInterval((deltaMs) => {
      const dt = deltaMs / 1000;
      const emitDamage = (ev: DamageEvent) => this.broadcast("damage", ev);
      const emitXp = (ev: XpEvent) => this.broadcast("xp", ev);
      movementSystem(this.state, dt);
      combatSystem(this.state, dt, emitDamage, emitXp);
      goblinAiSystem(this.state, dt, emitDamage);
      goblinSpawnSystem(this.state, dt); // tower-defense waves scale with live players
      this.releasePendingThrows(deltaMs);
      treeRegrowSystem(this.state, dt);
      rockRegrowSystem(this.state, dt);
      potionRespawnSystem(this.state, dt);
      bananaSystem(this.state, dt, emitDamage, emitXp);
      const collect = (pid: string, type: ItemType) => {
        const inv = this.inventories.get(pid);
        if (inv) {
          addItem(inv, type, 1);
          this.sendInventory(pid);
        }
      };
      itemPickupSystem(this.state, dt, collect); // walk-onto a clicked item
      autoGrabSystem(this.state, collect); // auto-collect anything nearby
    }, 1000 / TICK_RATE);

    console.log(`[room] ${this.roomId} created`);
  }

  onJoin(client: Client, options?: { name?: string; nostr?: NostrJoinPayload }) {
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

    const angle = Math.random() * Math.PI * 2;
    const r = 12 + Math.random() * 4; // spawn clear of the centre-cross goblin
    placeAtFreeSpot(p, Math.cos(angle) * r, Math.sin(angle) * r);
    p.rotY = Math.atan2(-p.x, -p.z);
    p.hue = Math.floor(Math.random() * 360);

    this.state.players.set(client.sessionId, p);
    const inv = makeInventory();
    addItem(inv, "banana", STARTING_BANANAS); // spawn stocked so you can throw right away
    this.inventories.set(client.sessionId, inv);
    client.send("inventory", inv);

    console.log(
      `[room] ${p.name}${p.nostrVerified ? " ⚡nostr" : ""} joined ` +
        `(${this.state.players.size} online)`,
    );
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    this.inventories.delete(client.sessionId);
    this.pendingThrows.delete(client.sessionId);
    console.log(`[room] ${client.sessionId} left`);
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
