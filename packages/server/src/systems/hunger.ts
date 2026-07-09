import { AnimState, type GameState, type Player } from "@rpg/shared";
import { devTuning } from "./devTuning";
import { applyDeathXpPenalty } from "./leveling";

function killByStarvation(p: Player): void {
  p.hp = 0;
  p.state = AnimState.DEAD;
  p.respawnTimer = devTuning().playerRespawnMs;
  p.attackTargetId = "";
  p.pendingHitId = "";
  p.pickupTargetId = "";
  p.path = [];
  p.pathIndex = 0;
  applyDeathXpPenalty(p);
}

/** Drain hunger over scaled simulation time. At zero, hunger becomes HP damage. */
export function hungerSystem(state: GameState, dt: number): void {
  if (dt <= 0) return;
  const tuning = devTuning();
  const drainPerSec = Math.max(0, tuning.hungerDrainPerMin) / 60;
  const starvePerSec = Math.max(0, tuning.starvationDamagePerSec);
  state.players.forEach((p) => {
    if (p.state === AnimState.DEAD || p.hp <= 0) return;
    p.maxHunger = Math.max(1, p.maxHunger);
    p.hunger = Math.max(0, Math.min(p.maxHunger, p.hunger));
    if (drainPerSec > 0 && p.hunger > 0) {
      p.hunger = Math.max(0, p.hunger - drainPerSec * dt);
    }
    if (p.hunger > 0 || starvePerSec <= 0) return;
    p.hp = Math.max(0, p.hp - starvePerSec * dt);
    if (p.hp <= 0) killByStarvation(p);
  });
}
