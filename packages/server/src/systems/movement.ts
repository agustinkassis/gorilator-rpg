import {
  GameState,
  Player,
  AnimState,
  MOVE_SPEED,
  ARRIVE_THRESHOLD,
} from "@rpg/shared";
import { findPath, depenetrate, nearestFreeWorld } from "./pathfinding";

/** Route a player to (x,z) around obstacles and start them walking. */
export function setDestination(player: Player, x: number, z: number) {
  const path = findPath(player.x, player.z, x, z);
  player.path = path;
  player.pathIndex = 0;
  const last = path.length ? path[path.length - 1] : { x: player.x, z: player.z };
  player.targetX = last.x;
  player.targetZ = last.z;
}

/** Drop a player onto the nearest free spot (used on spawn/respawn). */
export function placeAtFreeSpot(player: Player, x: number, z: number) {
  const free = nearestFreeWorld(x, z);
  player.x = free.x;
  player.z = free.z;
  player.targetX = free.x;
  player.targetZ = free.z;
  player.path = [];
  player.pathIndex = 0;
}

/**
 * Advance each player along its waypoint path. Owns the IDLE <-> WALK transition
 * and facing; ATTACK/HIT/DEAD players are "busy" and don't walk. A depenetration
 * pass guarantees nobody ends up overlapping a solid obstacle.
 */
export function movementSystem(state: GameState, dt: number) {
  state.players.forEach((p) => {
    const busy =
      p.state === AnimState.ATTACK ||
      p.state === AnimState.THROW ||
      p.state === AnimState.HIT ||
      p.state === AnimState.DEAD;

    if (!busy) {
      const wp = p.path[p.pathIndex];
      if (wp) {
        const dx = wp.x - p.x;
        const dz = wp.z - p.z;
        const dist = Math.hypot(dx, dz);
        if (dist > ARRIVE_THRESHOLD) {
          const speed = p.moveSpeed > 0 ? p.moveSpeed : MOVE_SPEED; // grows with level
          const step = Math.min(dist, speed * dt);
          p.x += (dx / dist) * step;
          p.z += (dz / dist) * step;
          p.rotY = Math.atan2(dx, dz);
          if (p.state !== AnimState.WALK) p.state = AnimState.WALK;
        } else {
          p.pathIndex++;
          if (p.pathIndex >= p.path.length) {
            p.path = [];
            p.pathIndex = 0;
            if (p.state !== AnimState.IDLE) p.state = AnimState.IDLE;
          }
        }
      } else if (p.state !== AnimState.IDLE) {
        p.state = AnimState.IDLE;
      }
    }

    // Safety net: never allow a character to sit inside a solid obstacle.
    const fixed = depenetrate(p.x, p.z);
    p.x = fixed.x;
    p.z = fixed.z;
  });
}
