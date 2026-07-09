/**
 * The Gorilator plugin contract — the ONLY surface plugins compile against.
 *
 * Everything here is types + one version constant: no runtime imports, so the
 * module is safe in both the Node server and the browser client. The hosts that
 * implement these contexts live in packages/server/src/systems/plugins/ and
 * packages/client/src/plugins/. Author guide: docs/plugins.md.
 *
 * Versioning: PLUGIN_API_VERSION follows SemVer independently of the app —
 * additive hooks bump minor, breaking changes bump major, and the host refuses
 * to load a plugin whose `apiVersion` range doesn't cover the current major.
 */
import type { Enemy } from "../schema/Enemy";
import type { GameState } from "../schema/GameState";
import type { Player } from "../schema/Player";
import type { DevTuningKey } from "../types";

export const PLUGIN_API_VERSION = "1.1.0"; // 1.1: event modules (additive — ^1.0.0 plugins keep loading)

/** plugin.json — the manifest the host discovers a plugin by. */
export interface PluginManifest {
  /** Unique id; npm-published plugins use the `gorilator-plugin-*` convention. */
  name: string;
  version: string;
  /** Semver RANGE against PLUGIN_API_VERSION, e.g. "^1.0.0". Major must match. */
  apiVersion: string;
  description?: string;
  /** Author identity — an npub for community plugins. */
  author?: string;
  /** Relative path to the built server entry (ESM, default-exports ServerPlugin). */
  server?: string;
  /** Relative path to the built client entry (ESM, default-exports ClientPlugin). */
  client?: string;
  /** Relative paths to content JSON files (the no-code data tier). */
  content?: string[];
  /** Relative path to an assets dir served/copied with the client. */
  assets?: string;
  /** Declared capabilities, for listing/audit: brain | item | system | event | content | model | panel. */
  capabilities?: string[];
  /** Default true; realm.json's plugins.disabled list also disables by name. */
  enabled?: boolean;
}

// ---- server side ----

/** Lifecycle events fired by the host at the existing emit sites. */
export type GameEvent =
  | "player:spawn"
  | "entity:killed"
  | "entity:damaged" // 1.1: every damage event (how event modules hear objective hits)
  | "item:pickup"
  | "wave:start"
  | "wave:end"
  | "structure:destroyed"
  | "realm:start" // 1.1: a realm cycle began (fresh world, event may auto-start)
  | "realm:end"
  | "event:start" // 1.1: an event module started
  | "event:end" // 1.1: an event module ended (payload carries the outcome)
  | "objective:complete"; // 1.1: a module-defined objective was completed

export type GameEventHandler = (payload: Record<string, unknown>, state: GameState) => void;

/** World helpers handed to a custom brain so it doesn't reimplement targeting. */
export interface BrainWorld {
  /** Nearest living player and its distance, or null. */
  nearestPlayer(g: Enemy): { p: Player; d: number } | null;
  /** The defended home (first house), or null after it fell. */
  home(): { id: string; x: number; z: number; radius: number; scale: number } | null;
  /** Advance the enemy toward (x, z) at `speed`, with world clamping. */
  stepToward(g: Enemy, x: number, z: number, speed: number, dt: number): void;
}

/** A custom AI brain. Steers the enemy (state/targets/timers); the host's combat
 *  systems own damage resolution. The id becomes valid in every `brain` field of
 *  the content manifests (entity-features, npcs, spawners, waves). */
export type BrainFn = (g: Enemy, dt: number, state: GameState, world: BrainWorld) => void;

export interface ItemUseContext {
  state: GameState;
  /** Decrement the used slot (and clear it at 0) + push the inventory to the owner. */
  consume(): void;
  /** Broadcast a transient event to every client (e.g. "heal", "chat"). */
  broadcast(type: string, payload: unknown): void;
  /** Heal a player (clamped to maxHp) and broadcast the floating number. */
  heal(target: Player, amount: number): void;
  log(msg: string): void;
}

/** Item-use behavior (potion-style). Registered per ItemType id; a plugin may
 *  override a builtin id by registering it. */
export interface ItemBehavior {
  onUse(player: Player, slot: number, ctx: ItemUseContext): void;
}

export type SystemPhase = "pre" | "main" | "post";
/** A simulation system — same pure shape as the builtin ones. Runs inside a
 *  perf span (`plugin:<name>` in /api/perf + the F3 overlay). */
export type SystemFn = (state: GameState, dt: number) => void;

// ---- event modules (API 1.1) ----

/** How an event ended — carried on "event:end" and handed to onEnd. */
export interface EventOutcome {
  result: "victory" | "defeat" | "aborted";
  stats?: Record<string, unknown>; // e.g. { wave: 12 }
}

/** One wave-composition entry (the shape waves.json + plugin content packs use). */
export interface EventWaveEntry {
  kind: string;
  defId?: string;
  count: number;
  brain?: string;
  level?: number;
}

export interface SpawnEnemyOpts {
  kind: string; // "goblin" | "dummy" | a character defId (spawned as npc)
  x: number;
  z: number;
  level?: number;
  brain?: string;
  modelId?: string;
  waveNumber?: number; // stamps Enemy.waveNumber for HUD/kill accounting
}

export interface SpawnStructureOpts {
  kind: "house" | "structure";
  x: number;
  z: number;
  id?: string; // default: host-generated unique id
  maxHp?: number;
  radius?: number;
  scale?: number;
  modelId?: string;
}

/** Authoritative world mutators, host-owned and only handed to event modules
 *  (they need a live room bridge for broadcast/inventory/XP). */
export interface PluginWorld {
  /** Spawn an enemy (returns the live schema object; the caller may steer it). */
  spawnEnemy(opts: SpawnEnemyOpts): Enemy;
  /** Spawn a house/structure; returns its entity id. */
  spawnStructure(opts: SpawnStructureOpts): string;
  /** Add items to a player's inventory (owner-synced). False if unknown player. */
  giveItem(playerId: string, item: string, amount?: number): boolean;
  /** Grant XP (level-ups + popups ride the normal pipeline). Returns levels gained. */
  grantXp(playerId: string, amount: number): number;
  /** Broadcast a transient event to every client ("chat", custom types…). */
  broadcast(type: string, payload: unknown): void;
}

export interface EventHudPatch {
  label?: string; // GameState.eventLabel
  timerMs?: number; // GameState.eventTimerMs
  progress?: number; // GameState.eventProgress (0..1)
}

/** Everything an event module gets while it is running. */
export interface EventModuleContext {
  eventId: string;
  state: GameState;
  world: PluginWorld;
  /** Resolved config: spec.config ⊕ realm.json events.config (realm wins). */
  config: Record<string, unknown>;
  /** Live devTuning snapshot for a knob (realm.json/scenario/dev_tune-driven). */
  tuning(key: DevTuningKey): number;
  /** Seeded RNG stream (#70) — modules must not roll Math.random. */
  rng(stream: "combat" | "drops" | "spawns" | "ai" | "world" | "bots" | "misc"): () => number;
  /** The authored/plugin custom composition for a wave number, or null. */
  customWave(n: number): EventWaveEntry[] | null;
  /** Write the synced event HUD fields (label/timer/progress). */
  setEventHud(patch: EventHudPatch): void;
  /** Fire "objective:complete" with a module-defined objective id. */
  completeObjective(id: string, payload?: Record<string, unknown>): void;
  /** Fire any lifecycle event through the host bus (wave:start compat etc.). */
  emit(event: GameEvent, payload: Record<string, unknown>): void;
  /** End the event: onEnd → "event:end" → the host runs its realm-end flow. */
  endEvent(outcome: EventOutcome): void;
  log(msg: string): void;
}

/** A pluggable game loop (ROADMAP Phase 3): the host starts it per realm.json
 *  `events` config, ticks it inside a perf span (`event:<id>`), and owns the
 *  realm-end flow its endEvent triggers. */
export interface EventModuleSpec {
  id: string; // "la-crypta-defense"
  label?: string; // default HUD label (falls back to id)
  config?: Record<string, unknown>; // defaults; realm.json events.config overrides
  onStart(ctx: EventModuleContext): void;
  /** Scaled dt, same clock as SystemFn. */
  onTick?(ctx: EventModuleContext, dt: number): void;
  onEnd?(ctx: EventModuleContext, outcome: EventOutcome): void;
  /** Dev/admin command routing (e.g. force_next_wave). */
  onCommand?(ctx: EventModuleContext, command: string, payload?: Record<string, unknown>): void;
}

export interface ServerPluginContext {
  apiVersion: string;
  manifest: PluginManifest;
  registerBrain(id: string, fn: BrainFn): void;
  registerItem(id: string, behavior: ItemBehavior): void;
  registerSystem(name: string, fn: SystemFn, opts?: { phase?: SystemPhase }): void;
  /** 1.1: register a pluggable game loop (started per realm.json `events`). */
  registerEventModule(spec: EventModuleSpec): void;
  on(event: GameEvent, handler: GameEventHandler): void;
  /** Watch + parse a JSON file (resolved against the plugin dir) and re-apply on
   *  change — the same live-reload pipeline the builtin manifests use. */
  registerContentLoader(file: string, apply: (data: unknown) => void): void;
  log(msg: string): void;
}

export interface ServerPlugin {
  setup(ctx: ServerPluginContext): void | Promise<void>;
}

// ---- client side ----

/** A renderable item def (same shape the client item registry uses). */
export interface PluginItemDef {
  id: string;
  name: string;
  icon?: string; // emoji, or a /path | http(s) | data: image URL
  model?: string;
  stack?: number;
  worldScale?: number;
}

export interface DevPanelSpec {
  id: string;
  title: string;
  /** Mount UI into the host element; return a cleanup fn if needed. */
  mount(host: HTMLElement): void | (() => void);
}

export interface ClientPluginContext {
  apiVersion: string;
  manifest: PluginManifest;
  registerItemModel(def: PluginItemDef): void;
  /** Per-frame hook, runs inside a perf span (`plugin:<name>` in F3). */
  registerFrameSystem(name: string, fn: (dt: number) => void): void;
  registerDevPanel(spec: DevPanelSpec): void;
  log(msg: string): void;
}

export interface ClientPlugin {
  setup(ctx: ClientPluginContext): void | Promise<void>;
}
