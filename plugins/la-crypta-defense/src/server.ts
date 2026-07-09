import type { EventModuleContext, EventModuleSpec, ServerPlugin } from "@rpg/shared";
import {
  anyAliveHouse,
  houseHpFraction,
  houseRegenTick,
  noteHouseDamage,
  spawnLaCrypta,
  timersFor,
} from "./house";
import { forceNextWave, previousWave, resetClock, waveTick } from "./waves";

/**
 * La Crypta Defense — the flagship tower-defense EVENT MODULE (#73). Goblin
 * waves besiege La Crypta; the realm cycle ends in defeat when it falls.
 *
 * Everything here runs against the plugin API 1.1 surface (@rpg/shared only):
 * spawning via ctx.world, tuning via ctx.tuning, rolls via ctx.rng, wave
 * compositions via ctx.customWave. Disable it (realm.json `events.enabled:
 * false`, GORILATOR_TEST=1, or a scenario) and the core runs as an open
 * sandbox — no house, no waves, no wipe.
 */
const laCryptaDefense: EventModuleSpec = {
  id: "la-crypta-defense",
  label: "La Crypta Defense",
  config: { difficultyMult: 1 },

  onStart(ctx) {
    resetClock(ctx);
    spawnLaCrypta(ctx);
    syncHud(ctx);
  },

  onTick(ctx, dt) {
    waveTick(ctx, dt); // pacing + spawning (scaled dt — same clock as before)
    houseRegenTick(ctx, dt * 1000); // ≡ the old houseRegenSystem(state, scaledMs, …)
    syncHud(ctx);
    if (!anyAliveHouse(ctx.state)) {
      // La Crypta fell → the event (and with it, the realm cycle) is over.
      ctx.endEvent({ result: "defeat", stats: { wave: ctx.state.waveNumber } });
    }
  },

  onCommand(ctx, command) {
    if (command === "force_next_wave") forceNextWave(ctx);
    else if (command === "previous_wave") previousWave(ctx);
  },

  onEnd(ctx) {
    timersFor(ctx.state).clear(); // drop regen bookkeeping for this cycle
  },
};

/** Mirror the wave clock + objective health onto the synced event HUD fields. */
function syncHud(ctx: EventModuleContext) {
  ctx.setEventHud({
    timerMs: ctx.state.waveTimerMs,
    progress: houseHpFraction(ctx.state),
  });
}

const plugin: ServerPlugin = {
  setup(ctx) {
    ctx.registerEventModule(laCryptaDefense);
    // The host fires entity:damaged at its emitDamage chokepoint — exactly
    // where noteHouseDamage was called pre-extraction (0-damage pokes included).
    ctx.on("entity:damaged", (payload, state) => {
      noteHouseDamage(state, String(payload.targetId ?? ""));
    });
  },
};

export default plugin;
