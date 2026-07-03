import {
  type EventModuleContext,
  type GameState,
  HOUSE_CENTER,
  HOUSE_REGEN_FULL_MS,
  HOUSE_REGEN_IDLE_MS,
  HOUSE_REGEN_MAX_PER_SEC,
  HOUSE_REGEN_RATE_STEP_PER_SEC,
  HOUSE_REGEN_START_PER_SEC,
  type HealEvent,
  type House,
} from "@rpg/shared";

/**
 * La Crypta — the module's destructible objective — plus its slow self-repair.
 * Moved verbatim from packages/server/src/systems/houses.ts in the #73
 * extraction; houses.characterization.test.ts pins the behavior across the move.
 */

interface HouseRegenRecord {
  idleMs: number;
  regenMs: number;
  healCarry: number;
  emitCarry: number;
  emitMs: number;
}

export type HouseRegenTimers = Map<string, HouseRegenRecord>;

// Regen bookkeeping per room state (WeakMap: a realm restart on a fresh state
// starts clean; the module's onEnd clears the live one explicitly).
const regenTimers = new WeakMap<GameState, HouseRegenTimers>();

export function timersFor(state: GameState): HouseRegenTimers {
  let timers = regenTimers.get(state);
  if (!timers) {
    timers = new Map();
    regenTimers.set(state, timers);
  }
  return timers;
}

/** Stand La Crypta at the map centre (HP resolves via entity-features through
 *  the host's spawnStructure — the same default spawnHouse used). */
export function spawnLaCrypta(ctx: EventModuleContext): string {
  return ctx.world.spawnStructure({
    kind: "house",
    id: "house-0",
    x: HOUSE_CENTER.x,
    z: HOUSE_CENTER.z,
  });
}

/** A damage event touched this id: if it's one of our houses, reset its regen
 *  window (wired to the host's "entity:damaged" chokepoint — 0-damage pokes
 *  reset the timer too, exactly like the old noteHouseDamage call). */
export function noteHouseDamage(state: GameState, targetId: string): void {
  const house = state.houses.get(targetId);
  if (!house) return;
  timersFor(state).set(targetId, freshRegenRecord());
}

export function anyAliveHouse(state: GameState): boolean {
  let standing = false;
  state.houses.forEach((h) => {
    if (h.alive) standing = true;
  });
  return standing;
}

/** The objective's health fraction — the event HUD's progress bar. */
export function houseHpFraction(state: GameState): number {
  let hp = 0;
  let maxHp = 0;
  state.houses.forEach((h) => {
    hp += Math.max(0, h.hp);
    maxHp += Math.max(0, h.maxHp);
  });
  return maxHp > 0 ? hp / maxHp : 0;
}

/** Module-tick wrapper: regen every standing house, heal popups via the world. */
export function houseRegenTick(ctx: EventModuleContext, scaledMs: number): void {
  houseRegenSystem(ctx.state, scaledMs, timersFor(ctx.state), (ev) =>
    ctx.world.broadcast("heal", ev),
  );
}

/** `scaledMs` is the timeScale-scaled tick delta (#67): a paused world (0) never
 *  regens, and accelerated simulation regens proportionally faster. */
export function houseRegenSystem(
  state: GameState,
  scaledMs: number,
  timers: HouseRegenTimers,
  emitHeal: (ev: HealEvent) => void,
) {
  const deltaMs = scaledMs;
  if (deltaMs <= 0) return;

  const seen = new Set<string>();
  state.houses.forEach((house, id) => {
    seen.add(id);
    if (!house.alive || house.maxHp <= 0 || house.hp <= 0) {
      timers.delete(id);
      return;
    }

    if (house.hp >= house.maxHp) {
      timers.delete(id);
      house.hp = house.maxHp;
      return;
    }

    const rec = timers.get(id) ?? freshRegenRecord();
    rec.idleMs += deltaMs;
    if (rec.idleMs < HOUSE_REGEN_IDLE_MS) {
      timers.set(id, rec);
      return;
    }

    rec.regenMs += deltaMs;
    const rateStep = Math.floor(rec.regenMs / 1000);
    const ratePerSec = Math.min(
      HOUSE_REGEN_MAX_PER_SEC,
      HOUSE_REGEN_START_PER_SEC + rateStep * HOUSE_REGEN_RATE_STEP_PER_SEC,
    );
    rec.healCarry += ratePerSec * (deltaMs / 1000);

    let healed = 0;
    const carriedHeal = Math.floor(rec.healCarry);
    if (carriedHeal > 0) {
      healed += applyHouseHeal(house, carriedHeal);
      rec.healCarry -= carriedHeal;
    }

    if (house.hp < house.maxHp && rec.regenMs >= HOUSE_REGEN_FULL_MS) {
      healed += applyHouseHeal(house, house.maxHp - house.hp);
      rec.healCarry = 0;
    }

    if (healed > 0) {
      rec.emitCarry += healed;
      rec.emitMs += deltaMs;
      if (rec.emitMs >= 1000 || house.hp >= house.maxHp) {
        const amount = Math.floor(rec.emitCarry);
        if (amount > 0) {
          emitHeal({ targetId: id, amount });
          rec.emitCarry -= amount;
        }
        rec.emitMs = 0;
      }
    } else {
      rec.emitMs += deltaMs;
    }

    if (house.hp >= house.maxHp) {
      house.hp = house.maxHp;
      timers.delete(id);
    } else {
      timers.set(id, rec);
    }
  });

  for (const id of timers.keys()) {
    if (!seen.has(id)) timers.delete(id);
  }
}

function freshRegenRecord(): HouseRegenRecord {
  return { idleMs: 0, regenMs: 0, healCarry: 0, emitCarry: 0, emitMs: 0 };
}

function applyHouseHeal(house: House, amount: number): number {
  const heal = Math.max(0, Math.min(amount, house.maxHp - house.hp));
  house.hp += heal;
  return heal;
}
