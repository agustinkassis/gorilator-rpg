import {
  AnimState,
  type GameState,
  type InventorySlot,
  Player,
  type ScenarioBotSpec,
} from "@rpg/shared";
import { handleAttack, clampToWorld } from "../combat";
import { devTuning } from "../devTuning";
import { addItem, makeInventory } from "../inventory";
import { placeAtFreeSpot, setDestination } from "../movement";
import { rng } from "../rng";
import { serverPluginHost } from "../plugins/host";

/**
 * Bot driver v1 (#68, docs/feature-lab.md): scripted simulated players that run
 * SERVER-SIDE. Bots are ordinary Player entries in state.players (`bot-<n>`) —
 * every existing system (movement, combat, stamina, pickups) treats them like
 * players and real clients render them — created by mirroring the fresh-join
 * branch of onJoin. Zero schema changes; bookkeeping lives here.
 *
 * Behaviors compose primitives (moveTo, pickupNearest, attackNearest, eat,
 * waitFor…) with seq/loop/waitUntil. Two run modes:
 *   headless — a scenario + bots + assertions is a vitest case (createScenarioSim)
 *   live     — the dev_bot message / a scenario's bots[] block spawns them in the room
 *
 * Every primitive carries a sim-time timeout → "failed" surfaces in
 * botStatuses() instead of hanging a test. State assertions over GameState,
 * never pixels (docs/TESTING.md).
 */

export type BotStepResult = "running" | "done" | "failed";

/** One resettable behavior step (closures hold per-bot progress). */
export interface BotStep {
  tick(state: GameState, bot: Player, io: BotIO, dt: number): BotStepResult;
  reset(): void;
}

/** The two things a bot can't do through pure state mutation. */
export interface BotIO {
  useItem(botId: string, slot: number): void;
  inventory(botId: string): InventorySlot[] | undefined;
  say?(botId: string, text: string): void;
}

export interface BotRuntime {
  id: string;
  behaviorId: string;
  status: BotStepResult;
}

const DEFAULT_TIMEOUT_MS = 20_000;

// ---- behavior registry (mirrors serverPluginHost.brains) ----

const registry = new Map<string, () => BotStep>();

export function registerBotBehavior(id: string, make: () => BotStep): void {
  registry.set(id, make);
}

export function isKnownBotBehavior(id: string): boolean {
  return registry.has(id);
}

export function botBehaviorIds(): string[] {
  return [...registry.keys()];
}

/** Test hook: drop every registered behavior (builtins re-register on demand). */
export function resetBotRegistry(): void {
  registry.clear();
}

// ---- lifecycle ----

interface BotRec {
  runtime: BotRuntime;
  step: BotStep;
  player: Player;
}

const botsByState = new WeakMap<GameState, Map<string, BotRec>>();
let botSeq = 0;

function botsFor(state: GameState): Map<string, BotRec> {
  let map = botsByState.get(state);
  if (!map) {
    map = new Map();
    botsByState.set(state, map);
  }
  return map;
}

/** Spawn one scripted player — mirrors onJoin's fresh-join branch (tuned
 *  starting stats, free spawn spot, inventory) and fires player:spawn. */
export function spawnBot(
  state: GameState,
  inventories: Map<string, InventorySlot[]>,
  opts: ScenarioBotSpec,
): Player | null {
  const make = registry.get(opts.behavior);
  if (!make) {
    console.warn(`[bots] unknown behavior "${opts.behavior}" (known: ${botBehaviorIds().join(", ")})`);
    return null;
  }
  const id = `bot-${botSeq++}`;
  const p = new Player();
  p.id = id;
  p.name = (opts.name ?? `Bot ${botSeq}`).slice(0, 24);

  const tune = devTuning();
  p.maxHp = tune.playerMaxHp;
  p.hp = tune.playerMaxHp;
  p.attack = tune.playerAttack;
  p.armor = tune.playerArmor;
  p.critChance = tune.playerCritChance;
  p.moveSpeed = tune.playerMoveSpeed;

  const roll = rng(state, "bots");
  if (opts.position) {
    placeAtFreeSpot(p, Number(opts.position.x) || 0, Number(opts.position.z) || 0);
  } else {
    const angle = roll() * Math.PI * 2;
    const r = 12 + roll() * 4;
    placeAtFreeSpot(p, Math.cos(angle) * r, Math.sin(angle) * r);
  }
  p.rotY = Math.atan2(-p.x, -p.z);
  p.hue = Math.floor(roll() * 360);

  for (const [key, value] of Object.entries(opts.stats ?? {})) {
    if (!["level", "hp", "maxHp", "attack", "armor", "moveSpeed"].includes(key)) continue;
    const n = Number(value);
    if (Number.isFinite(n)) (p as unknown as Record<string, number>)[key] = n;
  }
  if (opts.stats?.maxHp !== undefined && opts.stats.hp === undefined) p.hp = p.maxHp;

  const inv = makeInventory();
  for (const entry of opts.loadout ?? []) {
    addItem(inv, String(entry.item), Math.max(1, Math.round(Number(entry.count) || 1)));
  }

  state.players.set(id, p);
  inventories.set(id, inv);
  serverPluginHost.fire("player:spawn", { playerId: id, name: p.name, pubkey: "" }, state);

  botsFor(state).set(id, {
    runtime: { id, behaviorId: opts.behavior, status: "running" },
    step: make(),
    player: p,
  });
  return p;
}

export function clearBots(state: GameState, inventories: Map<string, InventorySlot[]>): void {
  const map = botsFor(state);
  for (const id of map.keys()) {
    state.players.delete(id);
    inventories.delete(id);
  }
  map.clear();
}

/** Remove ONE bot (admin kick). False when the id isn't a scripted bot. */
export function removeBot(
  state: GameState,
  inventories: Map<string, InventorySlot[]>,
  botId: string,
): boolean {
  const map = botsFor(state);
  if (!map.has(botId)) return false;
  map.delete(botId);
  state.players.delete(botId);
  inventories.delete(botId);
  return true;
}

/** Restart every bot's program (bots survive a realm wipe like players do). */
export function resetBotPrograms(state: GameState): void {
  for (const rec of botsFor(state).values()) {
    rec.step.reset();
    rec.runtime.status = "running";
  }
}

/** The assertion surface: each bot's program status. */
export function botStatuses(state: GameState): ReadonlyMap<string, BotRuntime> {
  const out = new Map<string, BotRuntime>();
  for (const [id, rec] of botsFor(state)) out.set(id, rec.runtime);
  return out;
}

/** Main-phase system (perf span "bots" in the room tick). Early-outs when no
 *  bots or the world is paused; dead bots resume after the normal respawn. */
export function botSystem(state: GameState, dt: number, io: BotIO): void {
  if (dt <= 0) return;
  const map = botsByState.get(state);
  if (!map || map.size === 0) return;
  for (const rec of map.values()) {
    if (rec.runtime.status !== "running") continue;
    const bot = rec.player;
    if (bot.state === AnimState.DEAD) continue;
    try {
      rec.runtime.status = rec.step.tick(state, bot, io, dt);
    } catch (err) {
      console.error(`[bots] "${rec.runtime.behaviorId}" (${rec.runtime.id}) failed:`, err);
      rec.runtime.status = "failed";
    }
  }
}

// ---- primitives ----

/** Walk to (x,z); done on arrival, failed after the sim-time timeout. */
export function moveTo(x: number, z: number, eps = 1.5, timeoutMs = DEFAULT_TIMEOUT_MS): BotStep {
  let issued = false;
  let elapsed = 0;
  return {
    reset() {
      issued = false;
      elapsed = 0;
    },
    tick(_state, bot, _io, dt) {
      elapsed += dt * 1000;
      if (Math.hypot(bot.x - x, bot.z - z) <= eps) return "done";
      if (elapsed > timeoutMs) return "failed";
      if (!issued) {
        setDestination(bot, clampToWorld(x), clampToWorld(z));
        issued = true;
      }
      return "running";
    },
  };
}

/** Wander: walk to a seeded random spot within `radius` of the current spot. */
export function moveToRandomNearby(radius = 10, timeoutMs = DEFAULT_TIMEOUT_MS): BotStep {
  let inner: BotStep | null = null;
  return {
    reset() {
      inner = null;
    },
    tick(state, bot, io, dt) {
      if (!inner) {
        const roll = rng(state, "bots");
        const ang = roll() * Math.PI * 2;
        const r = 2 + roll() * radius;
        inner = moveTo(bot.x + Math.cos(ang) * r, bot.z + Math.sin(ang) * r, 1.5, timeoutMs);
      }
      return inner.tick(state, bot, io, dt);
    },
  };
}

/** Walk onto the nearest ground pickup (optionally a specific item map) and
 *  collect it — mirrors the pickup message (pickupTargetId + destination).
 *  Done when the target is gone (collected); done immediately if none in range. */
export function pickupNearest(radius = 40, timeoutMs = DEFAULT_TIMEOUT_MS): BotStep {
  let targetId: string | null = null;
  let elapsed = 0;
  const findIn = (state: GameState, bot: Player): { id: string; x: number; z: number } | null => {
    let best: { id: string; x: number; z: number } | null = null;
    let bd = radius;
    const consider = (id: string, e: { x: number; z: number }) => {
      const d = Math.hypot(e.x - bot.x, e.z - bot.z);
      if (d < bd) {
        bd = d;
        best = { id, x: e.x, z: e.z };
      }
    };
    state.logs.forEach((e, id) => consider(id, e));
    state.stones.forEach((e, id) => consider(id, e));
    state.potions.forEach((e, id) => consider(id, e));
    state.bananas.forEach((e, id) => consider(id, e));
    state.items.forEach((e, id) => consider(id, e));
    return best;
  };
  const stillThere = (state: GameState, id: string) =>
    state.logs.has(id) || state.stones.has(id) || state.potions.has(id) || state.bananas.has(id) || state.items.has(id);
  return {
    reset() {
      targetId = null;
      elapsed = 0;
    },
    tick(state, bot, _io, dt) {
      elapsed += dt * 1000;
      if (elapsed > timeoutMs) return "failed";
      if (targetId) {
        if (!stillThere(state, targetId)) return "done"; // collected
        return "running";
      }
      const target = findIn(state, bot);
      if (!target) return "done"; // nothing to loot — not a failure
      targetId = target.id;
      bot.attackTargetId = "";
      bot.pickupTargetId = target.id;
      setDestination(bot, target.x, target.z);
      return "running";
    },
  };
}

/** Fight the nearest living enemy through the real combat pipeline; done when
 *  it dies/despawns, done immediately when no enemy is in range. */
export function attackNearest(radius = 60, timeoutMs = DEFAULT_TIMEOUT_MS): BotStep {
  let targetId: string | null = null;
  let elapsed = 0;
  return {
    reset() {
      targetId = null;
      elapsed = 0;
    },
    tick(state, bot, _io, dt) {
      elapsed += dt * 1000;
      if (elapsed > timeoutMs) return "failed";
      if (targetId) {
        const target = state.enemies.get(targetId);
        if (!target || target.hp <= 0 || target.state === AnimState.DEAD) return "done";
        handleAttack(state, bot.id, targetId); // re-approach a moving target
        return "running";
      }
      let bestId: string | null = null;
      let bd = radius;
      state.enemies.forEach((e, id) => {
        if (e.hp <= 0 || e.state === AnimState.DEAD) return;
        const d = Math.hypot(e.x - bot.x, e.z - bot.z);
        if (d < bd) {
          bd = d;
          bestId = id;
        }
      });
      if (!bestId) return "done"; // nothing to fight
      targetId = bestId;
      handleAttack(state, bot.id, bestId);
      return "running";
    },
  };
}

/** Use one item of `itemType` from the bot's inventory (fails without one). */
export function eat(itemType: string): BotStep {
  return {
    reset() {},
    tick(_state, bot, io, _dt) {
      const inv = io.inventory(bot.id);
      const slot = inv?.findIndex((s) => s.type === itemType && s.count > 0) ?? -1;
      if (slot < 0) return "failed";
      io.useItem(bot.id, slot);
      return "done";
    },
  };
}

/** Wait in SIM time — a timeScale-accelerated scenario fast-forwards waits too. */
export function waitFor(ms: number): BotStep {
  let elapsed = 0;
  return {
    reset() {
      elapsed = 0;
    },
    tick(_state, _bot, _io, dt) {
      elapsed += dt * 1000;
      return elapsed >= ms ? "done" : "running";
    },
  };
}

/** Wait until a predicate over the bot/state holds (with a sim-time timeout). */
export function waitUntil(
  pred: (bot: Player, state: GameState) => boolean,
  timeoutMs = DEFAULT_TIMEOUT_MS * 3,
): BotStep {
  let elapsed = 0;
  return {
    reset() {
      elapsed = 0;
    },
    tick(state, bot, _io, dt) {
      elapsed += dt * 1000;
      if (pred(bot, state)) return "done";
      return elapsed > timeoutMs ? "failed" : "running";
    },
  };
}

/** Say one chat line (no-op IO in headless runs). */
export function say(text: string): BotStep {
  return {
    reset() {},
    tick(_state, bot, io, _dt) {
      io.say?.(bot.id, text);
      return "done";
    },
  };
}

// ---- reserved primitives (feature-lab.md names; systems land in later issues) ----

function reserved(name: string): BotStep {
  let warned = false;
  return {
    reset() {},
    tick() {
      if (!warned) {
        warned = true;
        console.warn(`[bots] "${name}" is reserved — its gameplay system hasn't landed yet`);
      }
      return "failed";
    },
  };
}

export const craft = (_recipe: string): BotStep => reserved("craft"); // crafting v1 (#76)
export const equip = (_item: string): BotStep => reserved("equip"); // equipment (#75)
export const cast = (_ability: string): BotStep => reserved("cast"); // abilities (#78)
export const plant = (_item: string): BotStep => reserved("plant"); // farming (#77)

// ---- combinators ----

export function seq(...steps: BotStep[]): BotStep {
  let i = 0;
  return {
    reset() {
      i = 0;
      for (const s of steps) s.reset();
    },
    tick(state, bot, io, dt) {
      while (i < steps.length) {
        const r = steps[i].tick(state, bot, io, dt);
        if (r !== "done") return r;
        i++;
      }
      return "done";
    },
  };
}

/** Repeat the sequence forever (a failing child fails the whole behavior). */
export function loop(...steps: BotStep[]): BotStep {
  const inner = seq(...steps);
  return {
    reset() {
      inner.reset();
    },
    tick(state, bot, io, dt) {
      const r = inner.tick(state, bot, io, dt);
      if (r === "failed") return "failed";
      if (r === "done") inner.reset();
      return "running";
    },
  };
}
