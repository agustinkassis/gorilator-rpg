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

export const PLUGIN_API_VERSION = "1.0.0";

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
  | "item:pickup"
  | "wave:start"
  | "wave:end"
  | "structure:destroyed"
  | "realm:end";

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

export interface ServerPluginContext {
  apiVersion: string;
  manifest: PluginManifest;
  registerBrain(id: string, fn: BrainFn): void;
  registerItem(id: string, behavior: ItemBehavior): void;
  registerSystem(name: string, fn: SystemFn, opts?: { phase?: SystemPhase }): void;
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
