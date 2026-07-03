import type { CommunityEntityType } from "./constants";
import type { CharacterStatsConfig } from "./entityFeatures";

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

// Item types that can sit in the inventory. Built-ins keep their special
// gameplay behavior; dev-authored items use arbitrary safe string ids.
export type BuiltinItemType = "log" | "potion" | "stone" | "banana" | "berserker_potion";
export type ItemType = BuiltinItemType | (string & {});

export interface InventorySlot {
  type: ItemType | "";
  count: number;
}

export interface PlayerSaveRealm {
  id: string;
  startedAt: number;
  wave: number;
}

/**
 * The full recoverable state of a player, stored as the JSON content of the
 * nostr save event (kind NOSTR_SAVE_KIND, d = saveDTag(pubkey)). The SERVER signs
 * + writes it (with its NOSTR_NSEC key) on level-up / death / logout, and reads
 * it back to restore a returning npub.
 */
export interface PlayerSave {
  v: number; // save schema version
  playerPubkey?: string;
  realm?: PlayerSaveRealm;
  reason?: string;
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

// ---- Community entities (Nostr kind GORILATOR_ENTITY_KIND) ----
// A player-published, portable game entity. All asset paths are ABSOLUTE Blossom
// URLs (content-addressed by sha256) so any other client can download them. This
// is the JSON `content` of the kind-30333 event; see docs/community-entities.md.

/** A single asset hosted on Blossom, referenced by URL + content hash. */
export interface CommunityEntityAsset {
  url: string; // absolute Blossom URL (…/<sha256>[.ext])
  sha256: string; // hex sha-256 of the bytes (Blossom content address)
  size: number; // bytes
  mime: string; // e.g. "model/gltf-binary", "image/webp"
}

/** A custom character's portable payload: base rig + per-action animation clips. */
export interface CommunityCharacterPayload {
  baseModel: CommunityEntityAsset;
  anims: Record<string, { asset: CommunityEntityAsset; speed?: number; yawFix?: number }>;
  yaw: number; // base orientation (radians)
  scale: number;
}

/** A structure/prop's portable payload: one model + placement physics. */
export interface CommunityStructurePayload {
  model: CommunityEntityAsset;
  scale: number;
  collisionRadius?: number;
  hp?: number;
}

/** An inventory item's portable payload: icon + optional world model. */
export interface CommunityItemPayload {
  icon?: CommunityEntityAsset;
  model?: CommunityEntityAsset;
  stack: number;
  worldScale: number;
}

/**
 * Local bookkeeping stamped on a def once it has been published to — or imported
 * from — the community (Nostr kind GORILATOR_ENTITY_KIND). Lets the Library show
 * "published" / "by @owner" and re-publish to the same replaceable address.
 */
export interface CommunityProvenance {
  pubkey: string; // author of the community event
  d: string; // the event's d tag (entityDTag(id))
  ts: number; // last publish/import time (epoch ms)
  imported?: boolean; // true → this local def was imported FROM the community
}

/**
 * The full portable definition of a community entity (the kind-30333 event
 * `content`). Exactly one of `character` / `structure` / `item` is set, matching
 * `type`. `stats` carries combat tuning where it applies (characters/structures).
 */
export interface CommunityEntity {
  v: 1; // content schema version
  type: CommunityEntityType;
  id: string; // stable entity id (also the d-tag suffix, see entityDTag)
  name: string;
  description: string;
  preview?: CommunityEntityAsset; // thumbnail image (so non-3D consumers can render a card)
  character?: CommunityCharacterPayload;
  structure?: CommunityStructurePayload;
  item?: CommunityItemPayload;
  stats?: CharacterStatsConfig;
  ts: number; // publish time (epoch ms)
}

// Client -> server message payloads.
export interface MoveMessage {
  x: number;
  z: number;
  gz?: number; // Dev ghost mode: the client's camera zoom → server scales the ghost glide speed
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
// These mutate authoritative state and are intended for the dev-only editor.
// Server-side they are open to every client ONLY on an explicit dev/test
// server (NODE_ENV=development|test or GORILATOR_TEST=1); on any other server
// — production builds AND the env-less `gorilator` CLI install — they require
// a Nostr-verified admin (ADMIN_NPUBS). See server systems/devAuth.ts.

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

/** Create a synced world object near a ground point. */
export interface DevSpawnMessage {
  kind: string;
  id: string;
  x: number;
  z: number;
}

/** Set a single editable field on a synced world object (e.g. rock.radius). */
export interface DevSetMessage {
  kind: string;
  id: string;
  field: string;
  value: number | boolean | string;
}

/** Grant an inventory item to the sender (dev-authored item testing). */
export interface DevGiveItemMessage {
  type: string;
  amount?: number;
}

/** Dev-only: overwrite a specific inventory slot with an item + count
 *  (empty `type` clears the slot). */
export interface DevSetSlotMessage {
  slot: number;
  type: string;
  count: number;
}

/** Set the simulation speed (1 = normal, 0 = paused, 2 = double, …). */
export interface DevTimeMessage {
  scale: number;
}

export type DevActionId =
  | "reset_realm"
  | "force_next_wave"
  | "previous_wave"
  | "kill_all_enemies"
  | "kick_players"
  | "level_up_player";

/** Trigger one high-level dev-only gameplay action. */
export interface DevActionMessage {
  action: DevActionId;
}

export type DevTuningKey =
  | "waveFirstDelayMs"
  | "waveIntervalBaseMs"
  | "waveIntervalStepMs"
  | "waveIntervalMaxMs"
  | "waveSpawnSpreadMs"
  | "waveSizeBase"
  | "waveSizePerPlayer"
  | "waveSizePerWave"
  | "waveSizeMax"
  | "goblinLiveCap"
  | "playerAttackCooldownMs"
  | "playerAttackWindupMs"
  | "enemyAttackCooldownMs"
  | "enemyAttackWindupMs"
  | "enemyAttackRange"
  | "enemyAggroRadius"
  | "enemyDeaggroRadius"
  | "goblinHouseDamage"
  | "damageDivisor"
  | "playerRespawnMs"
  | "playerMaxHp"
  | "playerAttack"
  | "playerArmor"
  | "playerCritChance"
  | "playerMoveSpeed"
  | "sprintSpeedMult"
  | "enemyMaxHp"
  | "enemyAttack"
  | "enemyMoveSpeed"
  | "berserkerAttackMult"
  | "berserkerDurationMs"
  | "dropRateMult"
  | "difficultySizeScale"
  | "difficultyLevelScale"
  | "difficultyLevelCap";

/** Runtime-only dev tuning override for gameplay constants. */
export interface DevTuneMessage {
  key: DevTuningKey;
  value: number;
}

/** Hold-to-sprint intent: `on` while SPACE is held, `off` on release. The server
 *  owns the actual sprint (drains stamina, applies the speed boost). */
export interface SprintMessage {
  on: boolean;
}

/** Admin-only (Esc menu → Admin): pause/resume the tower-defense wave clock.
 *  The server rejects it unless the sender's verified pubkey is in ADMIN_NPUBS. */
export interface AdminWavesMessage {
  enabled: boolean;
}

/** Admin-only (Esc menu → Admin): switch one spawners.json spawner on/off at
 *  runtime. Same ADMIN_NPUBS gate as AdminWavesMessage. */
export interface AdminSpawnerMessage {
  id: string;
  enabled: boolean;
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
  dev_spawn: DevSpawnMessage;
  dev_move: DevMoveMessage;
  dev_delete: DevDeleteMessage;
  dev_set: DevSetMessage;
  dev_give_item: DevGiveItemMessage;
  dev_set_slot: DevSetSlotMessage;
  dev_time: DevTimeMessage;
  dev_action: DevActionMessage;
  dev_tune: DevTuneMessage;
  admin_waves: AdminWavesMessage;
  admin_spawner: AdminSpawnerMessage;
};

// Server -> client: emitted every time a hit lands, so clients can pop a
// floating damage number (crits are styled differently).
export interface DamageEvent {
  targetId: string;
  amount: number;
  crit: boolean;
}

// Server -> client: emitted only when a player dies to a killer. Goblin/enemy
// deaths stay silent in the kill feed.
export interface KillEvent {
  killerId: string;
  killerName: string;
  killerKind: "player" | "goblin";
  victimId: string;
  victimName: string;
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
