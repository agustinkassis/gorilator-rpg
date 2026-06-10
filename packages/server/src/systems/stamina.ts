import {
  type GameState,
  AnimState,
  STAMINA_DRAIN_PER_SEC,
  STAMINA_REGEN_PER_SEC,
  STAMINA_REGEN_DELAY_MS,
  STAMINA_SPRINT_REENGAGE,
} from "@rpg/shared";

/**
 * Valheim-style stamina, server-authoritative. Each tick this decides whether a
 * player is sprinting (SPACE held + actually moving + not winded + has stamina),
 * drains the bar while they are, and otherwise regenerates it after a short
 * delay. Run this BEFORE the movement system: it sets `p.sprinting`, which
 * movement reads to apply the +SPRINT_SPEED_MULT speed boost this same tick.
 */
export function staminaSystem(state: GameState, dt: number) {
  state.players.forEach((p) => {
    // How far the body actually translated since last tick. We only ever spend
    // stamina on real movement — so sprinting into a wall (blocked) or coasting
    // to a stop costs nothing. (movementSystem runs after us, so this reflects
    // the previous tick's motion; the one-tick lag is imperceptible.)
    const movedDist = Math.hypot(p.x - p.prevX, p.z - p.prevZ);
    p.prevX = p.x;
    p.prevZ = p.z;

    // Dead players don't sprint — refill so they respawn ready to run.
    if (p.state === AnimState.DEAD) {
      p.stamina = p.maxStamina;
      p.exhausted = false;
      p.sprinting = false;
      p.staminaRegen = 0;
      return;
    }

    // ATTACK/THROW/HIT root the player; they aren't walking, so they can't sprint.
    const busy =
      p.state === AnimState.ATTACK ||
      p.state === AnimState.THROW ||
      p.state === AnimState.HIT;
    const moving = !busy && movedDist > 1e-3; // actually translated this tick

    p.sprinting = p.sprintHeld && moving && !p.exhausted && p.stamina > 0;

    if (p.sprinting) {
      p.stamina = Math.max(0, p.stamina - STAMINA_DRAIN_PER_SEC * dt);
      p.staminaRegen = STAMINA_REGEN_DELAY_MS; // hold off regen until a beat after the sprint ends
      if (p.stamina <= 0) {
        p.stamina = 0;
        p.exhausted = true; // winded — must recover before sprinting again
        p.sprinting = false;
      }
      return;
    }

    // Not sprinting: regenerate after a short delay since the last drain.
    if (p.staminaRegen > 0) {
      p.staminaRegen = Math.max(0, p.staminaRegen - dt * 1000);
    } else if (p.stamina < p.maxStamina) {
      p.stamina = Math.min(p.maxStamina, p.stamina + STAMINA_REGEN_PER_SEC * dt);
    }
    if (p.exhausted && p.stamina >= STAMINA_SPRINT_REENGAGE) p.exhausted = false;
  });
}
