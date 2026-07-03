import type {
  DevTuningKey,
  EventModuleContext,
  EventModuleSpec,
  EventOutcome,
  GameEvent,
} from "@rpg/shared";
import { devTuning } from "../devTuning";
import { perfTracker } from "../perf";
import { rng, type RngStream } from "../rng";
import { customWave } from "../waves";
import { serverPluginHost } from "./host";
import { type RoomBridge, makePluginWorld } from "./world";

export type { RoomBridge } from "./world";

interface ActiveEvent {
  id: string;
  spec: EventModuleSpec;
  ctx: EventModuleContext;
  bridge: RoomBridge;
  ended: boolean;
}

/**
 * Host-side runtime for event modules (plugin API 1.1). Modules register via
 * registerEventModule; the ROOM decides which one runs (realm.json `events`)
 * and drives it through this runtime: start → onTick inside a perf span
 * (`event:<id>` in /api/perf + F3) → endEvent → the room's realm-end flow.
 * One active event at a time (the server runs one GameRoom per process).
 */
export class EventRuntime {
  private active: ActiveEvent | null = null;

  /** Start a registered module. False (with a loud log) if it isn't registered. */
  start(moduleId: string, bridge: RoomBridge, realmConfig: Record<string, unknown> = {}): boolean {
    if (this.active && !this.active.ended) {
      console.warn(`[events] "${this.active.id}" already running — not starting "${moduleId}"`);
      return false;
    }
    const spec = serverPluginHost.eventModules.get(moduleId);
    if (!spec) {
      console.warn(
        `[events] event module "${moduleId}" is not registered — is its plugin built + enabled? (pnpm build:plugins)`,
      );
      return false;
    }

    const state = bridge.state;
    const config = { ...(spec.config ?? {}), ...realmConfig };
    const ctx: EventModuleContext = {
      eventId: spec.id,
      state,
      world: makePluginWorld(bridge),
      config,
      tuning: (key: DevTuningKey) => devTuning()[key],
      rng: (stream: RngStream) => rng(state, stream),
      customWave: (n: number) => customWave(n),
      setEventHud: (patch) => {
        if (patch.label !== undefined) state.eventLabel = patch.label;
        if (patch.timerMs !== undefined) state.eventTimerMs = Math.max(0, patch.timerMs);
        if (patch.progress !== undefined)
          state.eventProgress = Math.max(0, Math.min(1, patch.progress));
      },
      completeObjective: (id, payload) =>
        serverPluginHost.fire("objective:complete", { eventId: spec.id, objectiveId: id, ...payload }, state),
      emit: (event: GameEvent, payload) => serverPluginHost.fire(event, payload, state),
      endEvent: (outcome) => this.end(outcome),
      log: (msg) => console.log(`[event:${spec.id}] ${msg}`),
    };

    this.active = { id: spec.id, spec, ctx, bridge, ended: false };
    state.eventId = spec.id;
    state.eventLabel = spec.label ?? spec.id;
    state.eventTimerMs = 0;
    state.eventProgress = 0;
    serverPluginHost.fire("event:start", { eventId: spec.id }, state);
    try {
      spec.onStart(ctx);
    } catch (err) {
      console.error(`[events] "${spec.id}" onStart failed:`, err);
    }
    console.log(`[events] "${spec.id}" started`);
    return true;
  }

  /** Tick the active module (scaled dt) — spanned + contained like plugin systems. */
  tick(dt: number): void {
    const active = this.active;
    if (!active || active.ended || !active.spec.onTick) return;
    perfTracker.span(`event:${active.id}`, () => {
      try {
        active.spec.onTick?.(active.ctx, dt);
      } catch (err) {
        console.error(`[events] "${active.id}" onTick failed:`, err);
      }
    });
  }

  /** Route a dev/admin command (force_next_wave, …) to the active module. */
  command(command: string, payload?: Record<string, unknown>): void {
    const active = this.active;
    if (!active || active.ended) return;
    try {
      active.spec.onCommand?.(active.ctx, command, payload);
    } catch (err) {
      console.error(`[events] "${active.id}" onCommand("${command}") failed:`, err);
    }
  }

  /** End the active event exactly once: onEnd → "event:end" → HUD cleared →
   *  the room's realm-end flow (bridge.onEventEnd). */
  end(outcome: EventOutcome): void {
    const active = this.active;
    if (!active || active.ended) return;
    active.ended = true;
    try {
      active.spec.onEnd?.(active.ctx, outcome);
    } catch (err) {
      console.error(`[events] "${active.id}" onEnd failed:`, err);
    }
    const state = active.bridge.state;
    serverPluginHost.fire(
      "event:end",
      { eventId: active.id, result: outcome.result, ...(outcome.stats ?? {}) },
      state,
    );
    state.eventId = "";
    state.eventLabel = "";
    state.eventTimerMs = 0;
    state.eventProgress = 0;
    const bridge = active.bridge;
    this.active = null;
    console.log(`[events] "${active.id}" ended (${outcome.result})`);
    bridge.onEventEnd(outcome);
  }

  activeId(): string {
    return this.active && !this.active.ended ? this.active.id : "";
  }

  /** Test/realm-restart hook. */
  reset(): void {
    this.active = null;
  }
}

export const eventRuntime = new EventRuntime();
