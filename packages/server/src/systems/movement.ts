import {
  GameState,
  Player,
  AnimState,
  MOVE_SPEED,
  SPRINT_SPEED_MULT,
  ARRIVE_THRESHOLD,
} from "@rpg/shared";
import { findPath, depenetrate, safeSpawnWorld } from "./pathfinding";

/** Route a player to (x,z) around obstacles and start them walking. */
export function setDestination(player: Player, x: number, z: number) {
  const path = findPath(player.x, player.z, x, z);
  player.path = path;
  player.pathIndex = 0;
  const last = path.length ? path[path.length - 1] : { x: player.x, z: player.z };
  player.targetX = last.x;
  player.targetZ = last.z;
}

/** Drop a player onto the nearest free spot (used on spawn/respawn/takeover).
 *  Snaps to the nearest open nav cell, then nudges fully clear of every collision
 *  circle — so a player can never start INSIDE a solid object (where they'd be
 *  unable to move). When the requested spot is already free this is a no-op, so it
 *  preserves an exact position (e.g. a takeover) whenever that position is valid. */
export function placeAtFreeSpot(player: Player, x: number, z: number) {
  const safe = safeSpawnWorld(x, z); // guaranteed clear of every concrete object
  player.x = safe.x;
  player.z = safe.z;
  player.targetX = safe.x;
  player.targetZ = safe.z;
  player.prevX = safe.x; // so staminaSystem sees no "movement" from the spawn/respawn jump
  player.prevZ = safe.z;
  player.path = [];
  player.pathIndex = 0;
}

/**
 * Advance each player along its waypoint path. Owns the IDLE <-> WALK transition
 * and facing; ATTACK/HIT/DEAD players are "busy" and don't walk. A depenetration
 * pass guarantees nobody ends up overlapping a solid obstacle.
 */
/** Dev Mode "ghost" free-roam while the game is paused: glide every player
 *  straight toward its target, ignoring obstacles. Driven by REAL (unscaled) time
 *  so the player can roam while the rest of the world is frozen. Moves at 1.08×
 *  normal speed (the original 0.6× ghost speed bumped +80%) so dev navigation is
 *  snappy. Only players who set a fresh target (clicked) actually move. */
const GHOST_SPEED_MULT = 1.08;
export function ghostMovementSystem(state: GameState, dt: number) {
  const speed = MOVE_SPEED * GHOST_SPEED_MULT;
  state.players.forEach((p) => {
    if (p.state === AnimState.DEAD) return;
    const dx = p.targetX - p.x;
    const dz = p.targetZ - p.z;
    const dist = Math.hypot(dx, dz);
    if (dist <= 0.05) return;
    const step = Math.min(dist, speed * dt);
    p.x += (dx / dist) * step;
    p.z += (dz / dist) * step;
    p.rotY = Math.atan2(dx, dz);
    // no depenetration — a ghost passes freely through rocks/walls/props
  });
}

export function movementSystem(state: GameState, dt: number) {
  if (dt <= 0) return; // paused (timeScale 0): normal movement frozen — ghostMovementSystem roams instead
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
          const base = p.moveSpeed > 0 ? p.moveSpeed : MOVE_SPEED; // grows with level
          const speed = p.sprinting ? base * SPRINT_SPEED_MULT : base; // +30% while sprinting (staminaSystem gates this)
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
