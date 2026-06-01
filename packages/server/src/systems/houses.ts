import {
  GameState,
  House,
  HOUSE_HP,
  HOUSE_COLLISION_RADIUS,
} from "@rpg/shared";

/** Stand one destructible house on the map origin (matches the client model). */
export function spawnHouse(state: GameState) {
  const h = new House();
  h.id = "house-0";
  h.x = 0;
  h.z = 0;
  h.radius = HOUSE_COLLISION_RADIUS;
  h.hp = HOUSE_HP;
  h.maxHp = HOUSE_HP;
  h.alive = true;
  state.houses.set(h.id, h);
}
