import {
  type GameState,
  type InventorySlot,
  AnimState,
  POTION_HEAL,
  CRIT_MULTIPLIER,
  BERSERKER_SPEED_MULT,
  BERSERKER_CRIT_CHANCE_ADD,
  BERSERKER_CRIT_DAMAGE_MULT,
  BERSERKER_ARMOR_MULT,
  BERSERKER_HP_MULT,
} from "@rpg/shared";
import { devTuning } from "./devTuning";
import { serverPluginHost } from "./plugins/host";

/** Pre-buff stats saved when a berserker potion is consumed; restored on expiry. */
export interface BerserkerBase {
  attack: number;
  armor: number;
  critChance: number;
  critMultiplier: number;
  moveSpeed: number;
  maxHp: number;
}

/** The room capabilities item-use needs — GameRoom hands its own maps/broadcast in;
 *  headless harnesses (bot driver, scenario sims) hand in stubs. */
export interface UseItemDeps {
  inventories: Map<string, InventorySlot[]>;
  berserkerBase: Map<string, BerserkerBase>;
  sendInventory(sessionId: string): void;
  broadcast(type: string, payload: unknown): void;
}

/**
 * Consume the item in `slotIndex` of a player's inventory — the body of the
 * `use_item` message. Plugin-registered item behaviors dispatch first (a plugin
 * may override a builtin id); the builtins (potion, berserker_potion) stay inline.
 */
export function useItemFromSlot(
  state: GameState,
  sessionId: string,
  slotIndex: number,
  deps: UseItemDeps,
): void {
  const inv = deps.inventories.get(sessionId);
  const p = state.players.get(sessionId);
  if (!inv || !p || p.state === AnimState.DEAD) return;
  const slot = inv[slotIndex];
  if (!slot || slot.count <= 0) return;

  const pluginBehavior = serverPluginHost.items.get(slot.type);
  if (pluginBehavior) {
    const itemId = slot.type;
    try {
      pluginBehavior.onUse(p, slotIndex, {
        state,
        consume: () => {
          slot.count -= 1;
          if (slot.count <= 0) {
            slot.type = "";
            slot.count = 0;
          }
          deps.sendInventory(sessionId);
        },
        broadcast: (type, payload) => deps.broadcast(type, payload),
        heal: (target, amount) => {
          const healed = Math.min(amount, target.maxHp - target.hp);
          if (healed <= 0) return;
          target.hp += healed;
          deps.broadcast("heal", { targetId: target.id, amount: healed });
        },
        log: (m) => console.log(`[plugin:item:${itemId}] ${m}`),
      });
    } catch (err) {
      console.error(`[plugins] item "${itemId}" onUse failed:`, err);
    }
    return;
  }

  if (slot.type === "potion") {
    if (p.hp >= p.maxHp) return; // don't waste a potion at full HP
    const heal = Math.min(POTION_HEAL, p.maxHp - p.hp);
    p.hp += heal;
    slot.count -= 1;
    if (slot.count <= 0) {
      slot.type = "";
      slot.count = 0;
    }
    deps.broadcast("heal", { targetId: sessionId, amount: heal });
    deps.sendInventory(sessionId);
  } else if (slot.type === "berserker_potion") {
    if (p.berserkerMs > 0) return; // already berserk — don't stack
    // Save base stats so we can restore them exactly when the buff expires.
    deps.berserkerBase.set(sessionId, {
      attack: p.attack,
      armor: p.armor,
      critChance: p.critChance,
      critMultiplier: p.critMultiplier,
      moveSpeed: p.moveSpeed,
      maxHp: p.maxHp,
    });
    // Apply the berserker multipliers.
    p.attack = p.attack * devTuning().berserkerAttackMult;
    p.armor = p.armor * BERSERKER_ARMOR_MULT;
    p.critChance = Math.min(1, p.critChance + BERSERKER_CRIT_CHANCE_ADD);
    const baseCrit = p.critMultiplier > 0 ? p.critMultiplier : CRIT_MULTIPLIER;
    p.critMultiplier = baseCrit * BERSERKER_CRIT_DAMAGE_MULT;
    p.moveSpeed = p.moveSpeed * BERSERKER_SPEED_MULT;
    const hpFraction = p.hp / p.maxHp;
    p.maxHp = Math.round(p.maxHp * BERSERKER_HP_MULT);
    p.hp = Math.min(p.maxHp, Math.round(hpFraction * p.maxHp));
    p.berserkerMs = devTuning().berserkerDurationMs;
    slot.count -= 1;
    if (slot.count <= 0) {
      slot.type = "";
      slot.count = 0;
    }
    deps.sendInventory(sessionId);
  }
}
