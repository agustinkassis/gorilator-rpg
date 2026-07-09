import {
  type DamageEvent,
  GameState,
  type HealEvent,
  type InventorySlot,
  type ItemType,
  type KillEvent,
  type ScenarioBotSpec,
  type ScenarioManifest,
  type XpEvent,
} from "@rpg/shared";
import { registerBuiltinBotBehaviors } from "../systems/bots/behaviors";
import { type BotIO, type BotRuntime, botStatuses, botSystem, clearBots, spawnBot } from "../systems/bots/driver";
import { combatSystem } from "../systems/combat";
import { goblinAiSystem } from "../systems/goblins";
import { hungerSystem } from "../systems/hunger";
import { addItem } from "../systems/inventory";
import { movementSystem } from "../systems/movement";
import { potionRespawnSystem } from "../systems/pickups";
import { autoGrabSystem, itemPickupSystem, treeRegrowSystem } from "../systems/resources";
import { resetDevTuning } from "../systems/devTuning";
import { resetRealmEvents } from "../systems/realm";
import { resolveCycleSeed, seedRng } from "../systems/rng";
import { applyScenarioConfig, applyScenarioWorld } from "../systems/scenario";
import { separationSystem } from "../systems/separation";
import { staminaSystem } from "../systems/stamina";
import { type BerserkerBase, useItemFromSlot } from "../systems/useItem";

/**
 * Headless scenario harness (#68, docs/TESTING.md): composes the REAL systems
 * in GameRoom tick order at fixed 50ms steps — no Colyseus, no sockets, no
 * ports. A scenario + bots + assertions is a vitest case:
 *
 *   const sim = createScenarioSim({ scenario: loadScenario("bot-arena")! });
 *   sim.runUntil((state) => allEnemiesDead(state));
 *   expect(countItem(sim.inventories.get(botId)!, "banana")).toBe(3);
 *   sim.dispose();
 *
 * Tick-order anchor: rooms/GameRoom.ts setSimulationInterval (bots → stamina →
 * movement → combat → goblinAi → separation → regrow/respawn → pickups). The
 * realm event module is intentionally NOT run — scenarios stage their own
 * enemies and default to events off (feature-lab.md); events.test.ts +
 * waves.characterization.test.ts cover the module itself.
 *
 * devTuning/realmEvents are module-global: ALWAYS call sim.dispose() (afterEach)
 * or tuning leaks across test files.
 */

export interface ScenarioSimOptions {
  scenario?: ScenarioManifest;
  bots?: ScenarioBotSpec[]; // extra bots beyond the manifest's
  stepMs?: number; // default 50 (20Hz)
}

export interface SimEvent {
  type: "damage" | "kill" | "heal" | "xp" | "chat" | string;
  payload: unknown;
}

export interface ScenarioSim {
  state: GameState;
  inventories: Map<string, InventorySlot[]>;
  events: SimEvent[]; // recorded broadcasts (damage/kill/heal/xp/chat…)
  step(): void; // one tick
  runFor(ms: number): void; // sim-time (timeScale applies)
  runUntil(pred: (state: GameState, sim: ScenarioSim) => boolean, timeoutMs?: number): boolean;
  bot(id: string): BotRuntime | undefined;
  bots(): ReadonlyMap<string, BotRuntime>;
  dispose(): void;
}

export function createScenarioSim(opts: ScenarioSimOptions = {}): ScenarioSim {
  registerBuiltinBotBehaviors();
  const state = new GameState();
  const stepMs = opts.stepMs ?? 50;
  const inventories = new Map<string, InventorySlot[]>();
  const berserkerBase = new Map<string, BerserkerBase>();
  const events: SimEvent[] = [];

  const record = (type: string, payload: unknown) => events.push({ type, payload });
  const emitDamage = (ev: DamageEvent) => record("damage", ev);
  const emitKill = (ev: KillEvent) => record("kill", ev);
  const emitXp = (ev: XpEvent) => record("xp", ev);
  const emitHeal = (ev: HealEvent) => record("heal", ev);
  const useItemDeps = {
    inventories,
    berserkerBase,
    sendInventory: () => {},
    broadcast: record,
  };
  const io: BotIO = {
    useItem: (botId, slot) => useItemFromSlot(state, botId, slot, useItemDeps),
    inventory: (botId) => inventories.get(botId),
    say: (botId, text) => record("chat", { playerId: botId, text }),
  };

  if (opts.scenario) {
    seedRng(state, resolveCycleSeed(opts.scenario.seed).seed);
    applyScenarioConfig(state, opts.scenario);
    applyScenarioWorld(state, opts.scenario);
  }
  for (const spec of opts.scenario?.bots ?? []) {
    const count = Math.max(1, Math.round(Number(spec.count) || 1));
    for (let i = 0; i < count; i++) spawnBot(state, inventories, spec);
  }
  for (const spec of opts.bots ?? []) spawnBot(state, inventories, spec);

  const collect = (pid: string, type: ItemType) => {
    const inv = inventories.get(pid);
    if (inv) addItem(inv, type, 1);
  };

  const sim: ScenarioSim = {
    state,
    inventories,
    events,
    step() {
      const dt = (stepMs * state.timeScale) / 1000;
      botSystem(state, dt, io);
      hungerSystem(state, dt);
      staminaSystem(state, dt);
      movementSystem(state, dt);
      combatSystem(state, dt, emitDamage, emitKill, emitXp, emitHeal);
      goblinAiSystem(state, dt, emitDamage, emitKill);
      if (state.timeScale > 0) separationSystem(state);
      treeRegrowSystem(state, dt);
      potionRespawnSystem(state, dt);
      if (state.timeScale > 0) {
        itemPickupSystem(state, dt, collect);
        autoGrabSystem(state, collect);
      }
    },
    runFor(ms: number) {
      const steps = Math.ceil(ms / stepMs);
      for (let i = 0; i < steps; i++) sim.step();
    },
    runUntil(pred, timeoutMs = 30_000) {
      const steps = Math.ceil(timeoutMs / stepMs);
      for (let i = 0; i < steps; i++) {
        if (pred(state, sim)) return true;
        sim.step();
      }
      return pred(state, sim);
    },
    bot(id: string) {
      return botStatuses(state).get(id);
    },
    bots() {
      return botStatuses(state);
    },
    dispose() {
      clearBots(state, inventories);
      resetDevTuning(); // scenario tuning is module-global — never leak it
      resetRealmEvents();
    },
  };
  return sim;
}
