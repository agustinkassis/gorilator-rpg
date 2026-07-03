import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DevTuningKey } from "@rpg/shared";
import { setDevTuning } from "./devTuning";
import { setRealmPolicy } from "./policy";

/**
 * realm.json — the per-realm / per-fork config file at the repo root. Lets an
 * operator or fork rebalance the game without touching packages/*\/src:
 *
 *   {
 *     "name": "my-realm",
 *     "plugins": { "disabled": ["example-arena"] },   // read by plugin discovery
 *     "tuning": { "waveSizeBase": 8, "playerMaxHp": 150 },  // any DevTuningKey
 *     "policy": {                                     // death + progression rules
 *       "death": { "mode": "xp-penalty", "xpPenalty": 0.3 },
 *       "progression": { "persistAcrossWipes": true, "keepInventoryOnWipe": true }
 *     },
 *     "events": {                                     // pluggable game loops (API 1.1)
 *       "enabled": true,                              // false → open sandbox, no event
 *       "autoStart": true,                            // start the module with the realm
 *       "module": "la-crypta-defense",                // default: the flagship module
 *       "config": { "difficultyMult": 1 }             // per-event overrides
 *     }
 *   }
 *
 * Absent file (the default) changes nothing. Tuning keys seed the same live
 * devTuning knobs the in-game Gameplay Options panel edits; the policy block
 * seeds the realm policy (see ./policy.ts for defaults).
 */

export interface RealmEventsConfig {
  enabled: boolean;
  autoStart: boolean;
  /** Explicit module id; default: the single registered module, else la-crypta-defense. */
  module?: string;
  config: Record<string, unknown>;
}

const eventsDefaults = (): RealmEventsConfig => ({ enabled: true, autoStart: true, config: {} });

let currentEvents: RealmEventsConfig = eventsDefaults();

export function realmEvents(): RealmEventsConfig {
  return currentEvents;
}

/** Override the events config (realm.json block, GORILATOR_TEST, scenarios).
 *  Partial input merges over the current values; unknown fields are ignored. */
export function setRealmEvents(raw: unknown): RealmEventsConfig {
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    currentEvents = {
      enabled: r.enabled === undefined ? currentEvents.enabled : Boolean(r.enabled),
      autoStart: r.autoStart === undefined ? currentEvents.autoStart : Boolean(r.autoStart),
      module: r.module === undefined ? currentEvents.module : String(r.module),
      config:
        r.config && typeof r.config === "object"
          ? { ...currentEvents.config, ...(r.config as Record<string, unknown>) }
          : currentEvents.config,
    };
  }
  return currentEvents;
}

/** Test hook — back to the defaults (enabled + autoStart). */
export function resetRealmEvents(): RealmEventsConfig {
  currentEvents = eventsDefaults();
  return currentEvents;
}
export function applyRealmConfig(): void {
  const candidates = [resolve(process.cwd(), "realm.json"), resolve(process.cwd(), "../../realm.json")];
  const file = candidates.find((p) => existsSync(p));
  if (!file) return;
  try {
    const realm = JSON.parse(readFileSync(file, "utf8"));
    if (realm?.name) console.log(`[realm] config "${realm.name}" loaded (${file})`);
    const tuning = realm?.tuning;
    if (tuning && typeof tuning === "object") {
      for (const [key, value] of Object.entries(tuning)) {
        const applied = setDevTuning(key as DevTuningKey, Number(value));
        if (applied === null) console.warn(`[realm] unknown tuning key "${key}" — ignored`);
        else console.log(`[realm] tuning ${key} = ${applied}`);
      }
    }
    if (realm?.policy) {
      const applied = setRealmPolicy(realm.policy);
      console.log(
        `[realm] policy: death=${applied.death.mode} (xpPenalty=${applied.death.xpPenalty}) ` +
          `persistAcrossWipes=${applied.progression.persistAcrossWipes} ` +
          `keepInventoryOnWipe=${applied.progression.keepInventoryOnWipe}`,
      );
    }
    if (realm?.events) {
      const applied = setRealmEvents(realm.events);
      console.log(
        `[realm] events: enabled=${applied.enabled} autoStart=${applied.autoStart}` +
          (applied.module ? ` module=${applied.module}` : ""),
      );
    }
  } catch (err) {
    console.warn("[realm] failed to read realm.json", err);
  }
}
