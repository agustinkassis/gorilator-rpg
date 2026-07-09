import type { ItemType, Player } from "@rpg/shared";
import { devTuning } from "./devTuning";
import { itemDef } from "./items";

export interface FoodUseResult {
  used: boolean;
  hungerRestored: number;
  hpRestored: number;
  staminaRestored: number;
}

function restore(current: number, max: number, amount: number): { next: number; delta: number } {
  if (amount <= 0 || max <= 0) return { next: current, delta: 0 };
  const before = Math.max(0, Math.min(max, current));
  const next = Math.min(max, before + amount);
  return { next, delta: Math.max(0, next - before) };
}

/** Apply an item definition's optional food effects. Returns used=false when the
 * item is not edible or all affected meters are already full. */
export function useFoodItem(player: Player, itemId: ItemType): FoodUseResult {
  const food = itemDef(itemId)?.food;
  if (!food) return { used: false, hungerRestored: 0, hpRestored: 0, staminaRestored: 0 };
  const tuning = devTuning();
  const hunger = restore(player.hunger, player.maxHunger, (food.hunger ?? 0) * tuning.foodHungerMult);
  const hp = restore(player.hp, player.maxHp, (food.hp ?? 0) * tuning.foodHpMult);
  const stamina = restore(player.stamina, player.maxStamina, (food.stamina ?? 0) * tuning.foodStaminaMult);
  const used = hunger.delta > 0 || hp.delta > 0 || stamina.delta > 0;
  if (!used) return { used: false, hungerRestored: 0, hpRestored: 0, staminaRestored: 0 };
  player.hunger = hunger.next;
  player.hp = hp.next;
  player.stamina = stamina.next;
  return {
    used,
    hungerRestored: hunger.delta,
    hpRestored: hp.delta,
    staminaRestored: stamina.delta,
  };
}
