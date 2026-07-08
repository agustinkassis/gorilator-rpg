import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DevTuningKey, GameState } from "@rpg/shared";
import { setDevTuning } from "./devTuning";
import { setRealmPolicy } from "./policy";

export interface RealmWorldConfig {
  /** Spawn and defend the central La Crypta house. */
  homeObjective: boolean;
  /** Let the built-in wave clock run. */
  waves: boolean;
}

export const defaultRealmWorldConfig: RealmWorldConfig = {
  homeObjective: true,
  waves: true,
};

let currentWorldConfig: RealmWorldConfig = { ...defaultRealmWorldConfig };

export function realmWorldConfig(): RealmWorldConfig {
  return currentWorldConfig;
}

export function resetRealmWorldConfig(): RealmWorldConfig {
  currentWorldConfig = { ...defaultRealmWorldConfig };
  return currentWorldConfig;
}

export function setRealmWorldConfig(rawWorld?: unknown, rawEvents?: unknown): RealmWorldConfig {
  const next: RealmWorldConfig = { ...defaultRealmWorldConfig };

  if (rawEvents && typeof rawEvents === "object") {
    const events = rawEvents as Record<string, unknown>;
    if (Array.isArray(events.enabled)) {
      const enabled = new Set(events.enabled.map(String));
      const laCryptaEnabled = enabled.has("la-crypta-defense");
      next.homeObjective = laCryptaEnabled;
      next.waves = laCryptaEnabled && events.autoStart !== false;
    } else if (events.autoStart === false) {
      next.waves = false;
    }
  }

  if (rawWorld && typeof rawWorld === "object") {
    const world = rawWorld as Record<string, unknown>;
    if (world.homeObjective !== undefined) {
      if (typeof world.homeObjective === "boolean") next.homeObjective = world.homeObjective;
      else console.warn("[realm] world.homeObjective must be a boolean — ignored");
    }
    if (world.waves !== undefined) {
      if (typeof world.waves === "boolean") next.waves = world.waves;
      else console.warn("[realm] world.waves must be a boolean — ignored");
    }
  }

  currentWorldConfig = next;
  return currentWorldConfig;
}

export function hasStandingHomeObjective(state: GameState): boolean {
  let standing = false;
  state.houses.forEach((h) => {
    if (h.alive) standing = true;
  });
  return standing;
}

export function shouldEndRealmForHomeObjective(
  state: GameState,
  homeWasStanding: boolean,
): boolean {
  if (!currentWorldConfig.homeObjective) return false;
  return homeWasStanding && !hasStandingHomeObjective(state);
}

/**
 * realm.json — the per-realm / per-fork config file at the repo root. Lets an
 * operator or fork rebalance the game without touching packages/*\/src:
 *
 *   {
 *     "name": "my-realm",
 *     "plugins": { "disabled": ["example-arena"] },   // read by plugin discovery
 *     "events": { "enabled": ["la-crypta-defense"], "autoStart": true },
 *     "world": { "homeObjective": true, "waves": true },
 *     "tuning": { "waveSizeBase": 8, "playerMaxHp": 150 },  // any DevTuningKey
 *     "policy": {                                     // death + progression rules
 *       "death": { "mode": "xp-penalty", "xpPenalty": 0.3 },
 *       "progression": { "persistAcrossWipes": true, "keepInventoryOnWipe": true }
 *     }
 *   }
 *
 * Absent file (the default) changes nothing. Tuning keys seed the same live
 * devTuning knobs the in-game Gameplay Options panel edits; the policy block
 * seeds the realm policy (see ./policy.ts for defaults).
 */
export function applyRealmConfig(): void {
  const sources = realmConfigSources();
  const merged = sources.reduce<Record<string, unknown>>(
    (acc, source) => deepMerge(acc, source.config),
    {},
  );
  setRealmWorldConfig(merged.world, merged.events);

  if (sources.length === 0) return;
  try {
    const names = sources.map((s) => s.name).filter(Boolean);
    const labels = sources.map((s) => s.label).join(" + ");
    console.log(
      `[realm] config ${names.length ? `"${names.join(" + ")}"` : labels} loaded (${labels})`,
    );
    const realm = merged;
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
    const world = realmWorldConfig();
    console.log(`[realm] world: homeObjective=${world.homeObjective} waves=${world.waves}`);
  } catch (err) {
    console.warn("[realm] failed to read realm.json", err);
  }
}

function realmConfigSources(): Array<{
  label: string;
  name?: string;
  config: Record<string, unknown>;
}> {
  const sources: Array<{ label: string; name?: string; config: Record<string, unknown> }> = [];
  const candidates = [
    resolve(process.cwd(), "realm.json"),
    resolve(process.cwd(), "../../realm.json"),
  ];
  const file = candidates.find((p) => existsSync(p));
  if (file) {
    const source = readConfigSource(file, "realm.json");
    if (source) sources.push(source);
  }

  const scenario = String(process.env.GORILATOR_SCENARIO ?? "").trim();
  if (scenario) {
    const scenarioFile = scenarioConfigFile(scenario);
    if (scenarioFile) {
      const source = readConfigSource(scenarioFile, `scenario:${scenario}`);
      if (source) sources.push(source);
    } else console.warn(`[realm] scenario "${scenario}" not found in scenarios/`);
  }
  return sources;
}

function scenarioConfigFile(name: string): string | null {
  if (!/^[a-z0-9_-]+$/i.test(name)) {
    console.warn(`[realm] invalid scenario name "${name}" — use letters, numbers, _ or -`);
    return null;
  }
  const candidates = [
    resolve(process.cwd(), "scenarios", `${name}.json`),
    resolve(process.cwd(), "../../scenarios", `${name}.json`),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

function readConfigSource(
  file: string,
  label: string,
): { label: string; name?: string; config: Record<string, unknown> } | null {
  try {
    const config = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    return {
      label: `${label} ${file}`,
      name: typeof config.name === "string" ? config.name : undefined,
      config,
    };
  } catch (err) {
    console.warn(`[realm] failed to read ${label} (${file})`, err);
    return null;
  }
}

function deepMerge(
  base: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(next)) {
    const existing = out[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = deepMerge(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
