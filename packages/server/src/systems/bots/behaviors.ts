import { BUILTIN_BOT_BEHAVIORS } from "@rpg/shared";
import {
  attackNearest,
  eat,
  isKnownBotBehavior,
  loop,
  moveToRandomNearby,
  pickupNearest,
  registerBotBehavior,
  waitFor,
  waitUntil,
} from "./driver";

/**
 * Builtin bot behaviors (#68). Idempotent registration — call from anywhere
 * that spawns bots (GameRoom, createScenarioSim, tests). Plugins/features add
 * their own via registerBotBehavior (the feature-dev pipeline pairs each new
 * gameplay loop with a behavior that exercises it).
 */
export function registerBuiltinBotBehaviors(): void {
  if (BUILTIN_BOT_BEHAVIORS.every((id) => isKnownBotBehavior(id))) return;

  // Amble around the spawn point forever.
  registerBotBehavior("wander", () => loop(moveToRandomNearby(10), waitFor(1000)));

  // Fight whatever living enemy is nearest; idle-scan between kills.
  registerBotBehavior("aggro", () => loop(attackNearest(60), waitFor(250)));

  // Walk onto every ground pickup in range; idle-scan when the field is clean.
  registerBotBehavior("loot", () => loop(pickupNearest(40), waitFor(250)));

  // Sip a potion whenever health drops below half.
  registerBotBehavior("eat_when_low", () =>
    loop(
      waitUntil((bot) => bot.hp < bot.maxHp * 0.5),
      eat("potion"),
      waitFor(500),
    ),
  );
}
