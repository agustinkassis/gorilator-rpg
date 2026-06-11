import { XP_DEATH_PENALTY } from "@rpg/shared";

/**
 * Realm policy — the death/progression rules an operator sets in realm.json:
 *
 *   {
 *     "policy": {
 *       "death": { "mode": "xp-penalty", "xpPenalty": 0.3 },
 *       "progression": { "persistAcrossWipes": true, "keepInventoryOnWipe": true }
 *     }
 *   }
 *
 * Defaults follow the sandbox vision: level persists, death hurts but does not
 * erase the player. The legacy full wipe is one config line away
 * (`"persistAcrossWipes": false`). Mirrors the devTuning module shape:
 * module-level current value + sanitize-on-set + reset for tests.
 */

export type DeathMode = "none" | "xp-penalty" | "hardcore";

export interface RealmPolicy {
  death: {
    /** What dying costs: nothing, a slice of total XP, or the whole character. */
    mode: DeathMode;
    /** Fraction of TOTAL XP lost in "xp-penalty" mode (0..1). */
    xpPenalty: number;
  };
  progression: {
    /** Keep level/XP/stats when the realm wipes (La Crypta falls). */
    persistAcrossWipes: boolean;
    /** Keep inventories across a wipe (only meaningful with persistAcrossWipes). */
    keepInventoryOnWipe: boolean;
  };
}

const DEATH_MODES: readonly DeathMode[] = ["none", "xp-penalty", "hardcore"];

export const defaultRealmPolicy: RealmPolicy = {
  death: { mode: "xp-penalty", xpPenalty: XP_DEATH_PENALTY },
  progression: { persistAcrossWipes: true, keepInventoryOnWipe: true },
};

function clone(policy: RealmPolicy): RealmPolicy {
  return { death: { ...policy.death }, progression: { ...policy.progression } };
}

let current: RealmPolicy = clone(defaultRealmPolicy);

export function realmPolicy(): RealmPolicy {
  return current;
}

/** Apply a raw realm.json `policy` block: unknown/invalid fields fall back to the
 *  defaults (with a warn), numbers are clamped, partial blocks are fine. */
export function setRealmPolicy(raw: unknown): RealmPolicy {
  const next = clone(defaultRealmPolicy);
  if (raw && typeof raw === "object") {
    const policy = raw as Record<string, unknown>;
    const death = policy.death;
    if (death && typeof death === "object") {
      const d = death as Record<string, unknown>;
      if (d.mode !== undefined) {
        if (typeof d.mode === "string" && (DEATH_MODES as readonly string[]).includes(d.mode)) {
          next.death.mode = d.mode as DeathMode;
        } else {
          console.warn(`[policy] unknown death.mode ${JSON.stringify(d.mode)} — using "${next.death.mode}"`);
        }
      }
      if (d.xpPenalty !== undefined) {
        const n = Number(d.xpPenalty);
        if (Number.isFinite(n)) next.death.xpPenalty = Math.min(1, Math.max(0, n));
        else console.warn(`[policy] invalid death.xpPenalty — using ${next.death.xpPenalty}`);
      }
    }
    const progression = policy.progression;
    if (progression && typeof progression === "object") {
      const g = progression as Record<string, unknown>;
      if (g.persistAcrossWipes !== undefined) {
        if (typeof g.persistAcrossWipes === "boolean") next.progression.persistAcrossWipes = g.persistAcrossWipes;
        else console.warn(`[policy] progression.persistAcrossWipes must be a boolean — ignored`);
      }
      if (g.keepInventoryOnWipe !== undefined) {
        if (typeof g.keepInventoryOnWipe === "boolean") next.progression.keepInventoryOnWipe = g.keepInventoryOnWipe;
        else console.warn(`[policy] progression.keepInventoryOnWipe must be a boolean — ignored`);
      }
    }
  }
  current = next;
  return current;
}

export function resetRealmPolicy(): RealmPolicy {
  current = clone(defaultRealmPolicy);
  return current;
}
