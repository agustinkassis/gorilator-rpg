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
  SprintMessage,
  DevGodMessage,
  DevMoveMessage,
  DevDeleteMessage,
  DevSetMessage,
  DevTimeMessage,
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
  NOSTR_TAKEOVER_CODE,
} from "@rpg/shared";
import { movementSystem, setDestination, placeAtFreeSpot } from "../systems/movement";
import { staminaSystem } from "../systems/stamina";
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
import { spawnHouse } from "../systems/houses";
import { loadPropObstacles } from "../systems/props";
import { devMove, devDelete, devSet } from "../systems/devEdit";
import { verifyNostrLogin, NostrJoinPayload, VerifiedNostr } from "../systems/nostr";

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
    spawnHouse(this.state);

    this.onMessage("move", (client, msg: MoveMessage) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || p.state === AnimState.DEAD) return;
      p.attackTargetId = "";
      p.pickupTargetId = ""; // a manual move cancels any pursuit
      setDestination(p, clampToWorld(msg.x), clampToWorld(msg.z));
    });

    // Hold-to-sprint: record SPACE held/released. staminaSystem decides whether
    // that actually translates into a sprint (moving + has stamina + not winded).
    this.onMessage("sprint", (client, msg: SprintMessage) => {
      const p = this.state.players.get(client.sessionId);
      if (p) p.sprintHeld = !!msg?.on;
    });

    this.onMessage("attack", (client, msg: AttackMessage) => {
      const p = this.state.players.get(client.sessionId);
      if (p) p.pickupTargetId = "";
      handleAttack(this.state, client.sessionId, msg.targetId);
    });

    // Dev Mode: toggle the sender's immortality. Turning it on while dead also
    // revives them, so entering Dev Mode never strands you on the respawn screen.
    this.onMessage("dev_god", (client, msg: DevGodMessage) => {
      const p = this.state.players.get(client.sessionId);
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
    this.onMessage("dev_move", (_client, msg: DevMoveMessage) => {
      if (msg) devMove(this.state, msg.kind, msg.id, msg.x, msg.z);
    });
    this.onMessage("dev_delete", (_client, msg: DevDeleteMessage) => {
      if (msg) devDelete(this.state, msg.kind, msg.id);
    });
    this.onMessage("dev_set", (_client, msg: DevSetMessage) => {
      if (msg) devSet(this.state, msg.kind, msg.id, msg.field, msg.value);
    });
    // Pause / set game speed: scales the simulation for everyone (0 = paused).
    this.onMessage("dev_time", (_client, msg: DevTimeMessage) => {
      const s = Number(msg?.scale);
      this.state.timeScale = Number.isFinite(s) ? Math.max(0, Math.min(8, s)) : 1;
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

    // Fixed-step authoritative simulation. Dev Mode's time control scales every
    // system's dt by `timeScale` (0 = fully paused, 2 = double speed, …) so the
    // whole game freezes/slows/speeds for everyone. Direct edits (dev_move etc.)
    // still apply while paused since they mutate state outside this loop.
    this.setSimulationInterval((deltaMs) => {
      const scaledMs = deltaMs * this.state.timeScale;
      const dt = scaledMs / 1000;
      const emitDamage = (ev: DamageEvent) => this.broadcast("damage", ev);
      const emitXp = (ev: XpEvent) => this.broadcast("xp", ev);
      staminaSystem(this.state, dt); // sets p.sprinting; movement reads it for the speed boost
      movementSystem(this.state, dt);
      combatSystem(this.state, dt, emitDamage, emitXp);
      goblinAiSystem(this.state, dt, emitDamage);
      goblinSpawnSystem(this.state, dt); // tower-defense waves scale with live players
      this.releasePendingThrows(scaledMs);
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

    // Single session per nostr identity: if this npub is already playing here,
    // kick that session and inherit its place + stats + inventory (newest wins).
    const takeover = nostr ? this.takeOverSameNpub(client.sessionId, nostr.pubkey) : null;

    if (takeover) {
      p.x = takeover.x;
      p.z = takeover.z;
      p.rotY = takeover.rotY;
      p.maxHp = takeover.maxHp;
      p.hp = takeover.hp > 0 ? takeover.hp : takeover.maxHp; // don't arrive dead
      p.maxStamina = takeover.maxStamina;
      p.stamina = takeover.stamina;
      p.level = takeover.level;
      p.xp = takeover.xp;
      p.attack = takeover.attack;
      p.armor = takeover.armor;
      p.critChance = takeover.critChance;
      p.moveSpeed = takeover.moveSpeed;
      p.throwPower = takeover.throwPower;
      p.hue = takeover.hue;
      p.targetX = p.x;
      p.targetZ = p.z;
      p.prevX = p.x;
      p.prevZ = p.z;
      p.state = AnimState.IDLE;
    } else {
      const angle = Math.random() * Math.PI * 2;
      const r = 12 + Math.random() * 4; // spawn clear of the centre-cross goblin
      placeAtFreeSpot(p, Math.cos(angle) * r, Math.sin(angle) * r);
      p.rotY = Math.atan2(-p.x, -p.z);
      p.hue = Math.floor(Math.random() * 360);
    }

    this.state.players.set(client.sessionId, p);

    // Inherit the old session's inventory, or stock a fresh one with bananas.
    const inv = takeover?.inventory ?? makeInventory();
    if (!takeover?.inventory) addItem(inv, "banana", STARTING_BANANAS);
    this.inventories.set(client.sessionId, inv);
    client.send("inventory", inv);

    console.log(
      `[room] ${p.name}${p.nostrVerified ? " ⚡nostr" : ""} ` +
        `${takeover ? "took over" : "joined"} (${this.state.players.size} online)`,
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
