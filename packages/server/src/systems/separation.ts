import { GameState, Player, Enemy, AnimState } from "@rpg/shared";
import { depenetrate } from "./pathfinding";

const SEPARATION = 1.4; // min gap between character centres (bodies are AGENT_RADIUS 0.6)
const SEP2 = SEPARATION * SEPARATION;

interface Body {
  ref: Player | Enemy;
  isPlayer: boolean;
}

/**
 * Soft character-vs-character separation so attackers fan out around a target
 * instead of all stacking on one tile (the world's collision only handles static
 * obstacles, not other characters). Any two living characters closer than
 * SEPARATION are pushed apart in place (Gauss-Seidel — later pairs see the
 * already-nudged positions, which settles a crowd smoothly into a ring).
 *
 * A PLAYER is never shoved by mobs: in an enemy↔player overlap only the enemy
 * gives ground. enemy↔enemy and player↔player split the push evenly. A final
 * depenetration pass keeps a push from ever landing someone inside a wall.
 */
export function separationSystem(state: GameState) {
  const bodies: Body[] = [];
  state.players.forEach((p) => {
    if (p.hp > 0 && p.state !== AnimState.DEAD) bodies.push({ ref: p, isPlayer: true });
  });
  state.enemies.forEach((e) => {
    // only the marching goblins jostle; the fixed training dummies stay put
    if (e.kind === "goblin" && e.hp > 0 && e.state !== AnimState.DEAD)
      bodies.push({ ref: e, isPlayer: false });
  });

  for (let i = 0; i < bodies.length; i++) {
    const a = bodies[i];
    for (let j = i + 1; j < bodies.length; j++) {
      const b = bodies[j];
      let dx = b.ref.x - a.ref.x;
      let dz = b.ref.z - a.ref.z;
      let d2 = dx * dx + dz * dz;
      if (d2 >= SEP2) continue;
      let d = Math.sqrt(d2);
      if (d < 1e-4) {
        // exactly stacked → shove apart along a deterministic axis
        dx = 1;
        dz = 0;
        d = 1;
      }
      const overlap = SEPARATION - d;
      const nx = dx / d;
      const nz = dz / d;
      if (a.isPlayer !== b.isPlayer) {
        // mixed: only the enemy gives ground (never push a player around)
        if (a.isPlayer) {
          b.ref.x += nx * overlap;
          b.ref.z += nz * overlap;
        } else {
          a.ref.x -= nx * overlap;
          a.ref.z -= nz * overlap;
        }
      } else {
        const half = overlap * 0.5;
        a.ref.x -= nx * half;
        a.ref.z -= nz * half;
        b.ref.x += nx * half;
        b.ref.z += nz * half;
      }
    }
  }

  // keep everyone clear of solid obstacles after the pushes
  for (const bdy of bodies) {
    const f = depenetrate(bdy.ref.x, bdy.ref.z);
    bdy.ref.x = f.x;
    bdy.ref.z = f.z;
  }
}
