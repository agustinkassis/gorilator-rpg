// Animation / entity states. The server is authoritative over which state an
// entity is in; clients map the synced state onto an animation clip.
export enum AnimState {
  IDLE = "IDLE",
  WALK = "WALK",
  ATTACK = "ATTACK",
  THROW = "THROW",
  HIT = "HIT",
  DEAD = "DEAD",
}

// Item types that can sit in the inventory.
export type ItemType = "log" | "potion" | "stone" | "banana";

export interface InventorySlot {
  type: ItemType | "";
  count: number;
}

/**
 * The full recoverable state of a player, stored as the JSON content of the
 * nostr save event (kind NOSTR_SAVE_KIND, d = saveDTag(pubkey)). The SERVER signs
 * + writes it (with its NOSTR_NSEC key) on level-up / death / logout, and reads
 * it back to restore a returning npub.
 */
export interface PlayerSave {
  v: number; // save schema version
  level: number;
  xp: number;
  hp: number;
  maxHp: number;
  stamina: number;
  maxStamina: number;
  x: number;
  z: number;
  rotY: number; // orientation
  attack: number;
  armor: number;
  critChance: number;
  moveSpeed: number;
  throwPower: number;
  hue: number;
  inventory: InventorySlot[];
  ts?: number; // wall-clock save time (ms)
}

// Client -> server message payloads.
export interface MoveMessage {
  x: number;
  z: number;
}

export interface AttackMessage {
  targetId: string;
}

/** Walk to a world item (log or potion) and pick it up into the inventory. */
export interface PickupMessage {
  id: string;
}

/** Rearrange the inventory grid (swap/merge two slots). */
export interface InventoryMoveMessage {
  from: number;
  to: number;
}

/** Consume/use the item in an inventory slot (e.g. drink a potion). */
export interface UseItemMessage {
  slot: number;
}

/** Throw a throwable item (banana or stone) toward a world point (mouse
 *  direction); `power` (0..1, the charge level) sets the distance, damage, speed. */
export interface ThrowMessage {
  x: number;
  z: number;
  power: number;
  item?: ItemType; // "banana" (default) or "stone"
}

/** Send a line of chat to everyone in the room (the server re-broadcasts it). */
export interface ChatMessage {
  text: string;
}

// ---- Dev Mode (in-game world editor) ----
// These mutate authoritative state and are intended for the dev-only editor;
// they are unguarded like the other dev tooling in this demo.

/** Toggle the sender's immortality (no damage while on). */
export interface DevGodMessage {
  on: boolean;
}

/** Relocate a synced world object (tree/rock/potion/dummy) to a ground point. */
export interface DevMoveMessage {
  kind: string; // tree | rock | potion | enemy | ...
  id: string;
  x: number;
  z: number;
}

/** Remove a synced world object from the world (persisted). */
export interface DevDeleteMessage {
  kind: string;
  id: string;
}

/** Set a single editable field on a synced world object (e.g. rock.radius). */
export interface DevSetMessage {
  kind: string;
  id: string;
  field: string;
  value: number | boolean | string;
}

/** Set the simulation speed (1 = normal, 0 = paused, 2 = double, …). */
export interface DevTimeMessage {
  scale: number;
}

/** Hold-to-sprint intent: `on` while SPACE is held, `off` on release. The server
 *  owns the actual sprint (drains stamina, applies the speed boost). */
export interface SprintMessage {
  on: boolean;
}

export type ClientMessages = {
  move: MoveMessage;
  attack: AttackMessage;
  pickup: PickupMessage;
  inventory_move: InventoryMoveMessage;
  use_item: UseItemMessage;
  throw: ThrowMessage;
  chat: ChatMessage;
  sprint: SprintMessage;
  dev_god: DevGodMessage;
  dev_move: DevMoveMessage;
  dev_delete: DevDeleteMessage;
  dev_set: DevSetMessage;
  dev_time: DevTimeMessage;
};

// Server -> client: emitted every time a hit lands, so clients can pop a
// floating damage number (crits are styled differently).
export interface DamageEvent {
  targetId: string;
  amount: number;
  crit: boolean;
}

// Server -> client: emitted when a player is healed (e.g. by a potion).
export interface HealEvent {
  targetId: string;
  amount: number;
}

// Server -> client: emitted when a player gains XP from an action (a kill, a
// felled tree, a mined rock) so clients can pop a floating "+N XP" over them.
export interface XpEvent {
  playerId: string;
  amount: number;
}

// Server -> client: a chat line, re-broadcast to everyone in the room. Clients
// pop a speech bubble over the sender and append the line to the chat log.
export interface ChatEvent {
  playerId: string;
  name: string; // the sender's display name (resolved server-side)
  text: string;
}

// Server -> client: animate a thrown banana arcing from the thrower to where it
// lands (deviated by distance). The landed banana then appears as a synced item.
export interface BananaThrowEvent {
  fromX: number;
  fromZ: number;
  toX: number; // where the banana actually stops (a prop surface, or the full landing)
  toZ: number;
  flightMs: number; // time to reach toX/toZ at the (charge-set) speed
  arcToX: number; // the full intended target — arc/speed are drawn as if heading here
  arcToZ: number; // (equals toX/toZ when nothing blocked the throw)
  item: ItemType; // what was thrown — the client renders the matching projectile
}
