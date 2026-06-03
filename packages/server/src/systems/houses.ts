import {
  GameState,
  House,
  HOUSE_HP,
  HOUSE_COLLISION_RADIUS,
  HOUSE_CENTER,
} from "@rpg/shared";
import { entityHp } from "./entityFeatures";

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
