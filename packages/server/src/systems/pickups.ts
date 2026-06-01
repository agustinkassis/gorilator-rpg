import {
  GameState,
  Potion,
  POTION_COUNT,
  POTION_HEAL,
  POTION_RESPAWN_MS,
} from "@rpg/shared";
import { nearestFreeWorld } from "./pathfinding";

/** Per-room respawn bookkeeping (kept off the synced state). */
interface PotionMeta {
  seq: number;
  respawnTimer: number;
}
const meta = new WeakMap<GameState, PotionMeta>();

const SPAWN_RANGE = 110; // potions scatter within this half-extent of the centre

function randomFreeSpot(): { x: number; z: number } {
  const x = (Math.random() * 2 - 1) * SPAWN_RANGE;
  const z = (Math.random() * 2 - 1) * SPAWN_RANGE;
  return nearestFreeWorld(x, z); // never inside an obstacle
}

function addPotion(state: GameState, m: PotionMeta) {
  const p = new Potion();
  p.id = `potion-${m.seq++}`;
  const spot = randomFreeSpot();
  p.x = spot.x;
  p.z = spot.z;
  p.heal = POTION_HEAL;
  state.potions.set(p.id, p);
}

export function spawnInitialPotions(state: GameState) {
  const m: PotionMeta = { seq: 0, respawnTimer: POTION_RESPAWN_MS };
  meta.set(state, m);
  for (let i = 0; i < POTION_COUNT; i++) addPotion(state, m);
}

/** Keep the world stocked with potions (collection is handled by the item pickup system). */
export function potionRespawnSystem(state: GameState, dt: number) {
  const m = meta.get(state);
  if (!m) return;
  if (state.potions.size < POTION_COUNT) {
    m.respawnTimer -= dt * 1000;
    if (m.respawnTimer <= 0) {
      addPotion(state, m);
      m.respawnTimer = POTION_RESPAWN_MS;
    }
  } else {
    m.respawnTimer = POTION_RESPAWN_MS;
  }
}
