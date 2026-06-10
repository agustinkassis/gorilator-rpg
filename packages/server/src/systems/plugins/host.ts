import type {
  BrainFn,
  BuiltinBrainId,
  GameEvent,
  GameEventHandler,
  GameState,
  ItemBehavior,
  SystemFn,
  SystemPhase,
} from "@rpg/shared";

/**
 * The server-side plugin registries. Builtin behavior is NOT routed through here
 * — the battle-tested brain/item code paths stay inline in goblins.ts/GameRoom —
 * but every dispatch site checks this host FIRST, so a plugin can add new ids
 * (or deliberately override a builtin id by registering it).
 */
export const BUILTIN_BRAINS: readonly BuiltinBrainId[] = [
  "idle",
  "passive_patrol",
  "war_seeker",
  "attacks_home",
];

export const BUILTIN_ITEM_BEHAVIORS: readonly string[] = ["potion", "berserker_potion"];

class ServerPluginHost {
  readonly brains = new Map<string, BrainFn>();
  readonly items = new Map<string, ItemBehavior>();
  readonly systems: Record<SystemPhase, Array<{ name: string; fn: SystemFn }>> = {
    pre: [],
    main: [],
    post: [],
  };
  private readonly events = new Map<GameEvent, GameEventHandler[]>();

  /** Valid value for a manifest `brain` field: a builtin or a registered plugin brain. */
  isKnownBrain(id: string): boolean {
    return (BUILTIN_BRAINS as readonly string[]).includes(id) || this.brains.has(id);
  }

  registerBrain(id: string, fn: BrainFn): void {
    this.brains.set(id, fn);
  }

  registerItem(id: string, behavior: ItemBehavior): void {
    this.items.set(id, behavior);
  }

  registerSystem(name: string, fn: SystemFn, phase: SystemPhase = "main"): void {
    this.systems[phase].push({ name, fn });
  }

  on(event: GameEvent, handler: GameEventHandler): void {
    const list = this.events.get(event) ?? [];
    list.push(handler);
    this.events.set(event, list);
  }

  /** Fire an event to every handler. A throwing plugin handler is logged and
   *  skipped — it can never take down the 20Hz tick. */
  fire(event: GameEvent, payload: Record<string, unknown>, state: GameState): void {
    const handlers = this.events.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(payload, state);
      } catch (err) {
        console.error(`[plugins] "${event}" handler failed:`, err);
      }
    }
  }

  /** Test/realm-restart hook: drop everything plugins registered. */
  reset(): void {
    this.brains.clear();
    this.items.clear();
    this.systems.pre.length = 0;
    this.systems.main.length = 0;
    this.systems.post.length = 0;
    this.events.clear();
  }
}

export const serverPluginHost = new ServerPluginHost();
