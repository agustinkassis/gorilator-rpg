import {
  type GameState,
  Potion,
  POTION_COUNT,
  POTION_HEAL,
  POTION_RESPAWN_MS,
  AMBIENT_ITEM_SPAWN_CLEAR_RADIUS,
} from "@rpg/shared";
import { nearestFreeWorld } from "./pathfinding";
import { rng } from "./rng";

/** Per-room respawn bookkeeping (kept off the synced state). */
interface PotionMeta {
  seq: number;
  respawnTimer: number;
}
const meta = new WeakMap<GameState, PotionMeta>();

const SPAWN_RANGE = 110; // potions scatter within this half-extent of the centre

function randomFreeSpot(state: GameState): { x: number; z: number } {
  const roll = rng(state, "world");
  for (let i = 0; i < 80; i++) {
    const x = (roll() * 2 - 1) * SPAWN_RANGE;
    const z = (roll() * 2 - 1) * SPAWN_RANGE;
    const spot = nearestFreeWorld(x, z); // never inside an obstacle
    if (Math.hypot(spot.x, spot.z) >= AMBIENT_ITEM_SPAWN_CLEAR_RADIUS) return spot;
  }
  return nearestFreeWorld(AMBIENT_ITEM_SPAWN_CLEAR_RADIUS, 0);
}

function addPotion(state: GameState, m: PotionMeta) {
  const p = new Potion();
  p.id = `potion-${m.seq++}`;
  const spot = randomFreeSpot(state);
  p.x = spot.x;
  p.z = spot.z;
  p.heal = POTION_HEAL;
  state.potions.set(p.id, p);
}

export function spawnInitialPotions(state: GameState) {
  state.potions.clear();
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
