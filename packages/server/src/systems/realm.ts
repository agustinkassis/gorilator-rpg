import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DevTuningKey, RealmConfig } from "@rpg/shared";
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
 *     }
 *   }
 *
 * Absent file (the default) changes nothing. Tuning keys seed the same live
 * devTuning knobs the in-game Gameplay Options panel edits; the policy block
 * seeds the realm policy (see ./policy.ts for defaults).
 */
export function applyRealmConfig(): void {
  const candidates = [resolve(process.cwd(), "realm.json"), resolve(process.cwd(), "../../realm.json")];
  const file = candidates.find((p) => existsSync(p));
  if (!file) return;
  try {
    const realm = JSON.parse(readFileSync(file, "utf8")) as RealmConfig;
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
  } catch (err) {
    console.warn("[realm] failed to read realm.json", err);
  }
}
