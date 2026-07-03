import {
  type GameState,
  type HealEvent,
  House,
  HOUSE_HP,
  HOUSE_COLLISION_RADIUS,
  HOUSE_CENTER,
  HOUSE_REGEN_FULL_MS,
  HOUSE_REGEN_IDLE_MS,
  HOUSE_REGEN_MAX_PER_SEC,
  HOUSE_REGEN_RATE_STEP_PER_SEC,
  HOUSE_REGEN_START_PER_SEC,
} from "@rpg/shared";
import { entityHp } from "./entityFeatures";

interface HouseRegenRecord {
  idleMs: number;
  regenMs: number;
  healCarry: number;
  emitCarry: number;
  emitMs: number;
}

export type HouseRegenTimers = Map<string, HouseRegenRecord>;

/** Stand La Crypta, the destructible home objective, at the map centre. */
export function spawnHouse(state: GameState) {
  const h = new House();
  h.id = "house-0";
  h.x = HOUSE_CENTER.x;
  h.z = HOUSE_CENTER.z;
  h.radius = HOUSE_COLLISION_RADIUS;
  h.maxHp = entityHp("house", h.id, undefined, HOUSE_HP);
  h.hp = h.maxHp;
  h.alive = true;
  state.houses.set(h.id, h);
}

export function noteHouseDamage(state: GameState, timers: HouseRegenTimers, targetId: string) {
  const house = state.houses.get(targetId);
  if (!house) return;
  timers.set(targetId, freshRegenRecord());
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
