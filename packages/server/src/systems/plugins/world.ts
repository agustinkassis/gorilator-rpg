import {
  type BrainId,
  Enemy,
  type EventOutcome,
  type GameState,
  HOUSE_COLLISION_RADIUS,
  HOUSE_HP,
  House,
  type PluginWorld,
  type SpawnEnemyOpts,
  type SpawnStructureOpts,
  Structure,
  STRUCTURE_HP,
} from "@rpg/shared";
import { configureEnemy } from "../enemyConfig";
import { entityHp } from "../entityFeatures";
import { nearestFreeWorld } from "../pathfinding";

/**
 * The room capabilities an event module needs from GameRoom. Handed to
 * eventRuntime.start(); tests use a stub. Everything a module mutates flows
 * through here or through the schema state — it never touches room internals.
 */
export interface RoomBridge {
  state: GameState;
  broadcast(type: string, payload: unknown): void;
  /** addItem + owner-only inventory sync; false when the player is unknown. */
  giveItem(playerId: string, item: string, amount: number): boolean;
  /** leveling.grantXp + the +XP popup broadcast; returns levels gained. */
  grantXp(playerId: string, amount: number): number;
  /** The event ended → the room runs its realm-end flow (wipe/intermission). */
  onEventEnd(outcome: EventOutcome): void;
}

let seq = 0;

/** Host-owned world mutators (API 1.1) — the ONLY spawn/give surface an event
 *  module gets. Mirrors the core spawn paths (configureEnemy + nearestFreeWorld,
 *  spawnHouse defaults) so plugin-spawned entities behave exactly like core ones. */
export function makePluginWorld(bridge: RoomBridge): PluginWorld {
  const state = bridge.state;
  return {
    spawnEnemy(opts: SpawnEnemyOpts): Enemy {
      const kind = opts.kind || "goblin";
      const spot = nearestFreeWorld(opts.x, opts.z);
      const e = new Enemy();
      const cfgKind = kind === "goblin" || kind === "dummy" ? kind : "npc";
      configureEnemy(e, {
        kind: cfgKind,
        id: `ev-${seq++}`,
        x: spot.x,
        z: spot.z,
        modelId: cfgKind === "npc" ? (opts.modelId ?? kind) : opts.modelId,
        brain: opts.brain as BrainId | undefined,
        stats: opts.level != null ? { level: opts.level } : undefined,
      });
      e.waveNumber = Math.max(0, Math.round(opts.waveNumber ?? 0));
      state.enemies.set(e.id, e);
      return e;
    },

    spawnStructure(opts: SpawnStructureOpts): string {
      if (opts.kind === "house") {
        const h = new House();
        h.id = opts.id ?? `house-${seq++}`;
        h.x = opts.x;
        h.z = opts.z;
        h.scale = opts.scale ?? 1;
        h.radius = opts.radius ?? HOUSE_COLLISION_RADIUS;
        h.maxHp = opts.maxHp ?? entityHp("house", h.id, undefined, HOUSE_HP);
        h.hp = h.maxHp;
        h.alive = true;
        state.houses.set(h.id, h);
        return h.id;
      }
      const s = new Structure();
      s.id = opts.id ?? `ev-structure-${seq++}`;
      s.x = opts.x;
      s.z = opts.z;
      s.scale = opts.scale ?? 1;
      s.radius = opts.radius ?? 1;
      s.modelId = opts.modelId ?? "";
      s.maxHp = opts.maxHp ?? entityHp("structure", s.id, s.modelId, STRUCTURE_HP);
      s.hp = s.maxHp;
      s.alive = true;
      state.structures.set(s.id, s);
      return s.id;
    },

    giveItem: (playerId, item, amount = 1) => bridge.giveItem(playerId, item, amount),
    grantXp: (playerId, amount) => bridge.grantXp(playerId, amount),
    broadcast: (type, payload) => bridge.broadcast(type, payload),
  };
}
