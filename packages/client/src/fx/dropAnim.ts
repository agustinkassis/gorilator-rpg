/**
 * The classic loot "pop": a freshly-dropped item launches into the air and falls
 * back down, bouncing a couple of times before it settles into its resting hover.
 * Shared by every collectible (logs, stones, bananas, potions).
 */
export interface DropAnim {
  y: number; // current height
  vy: number; // vertical velocity (units/s)
  restY: number; // settle height + bounce floor (the item's resting/hover height)
  settled: boolean; // true once the bounces have died down
}

const POP_MIN = 4.5; // initial upward speed (randomised for variety)
const POP_MAX = 6.5;
const GRAVITY = 16; // units/s² pulling it back down
const RESTITUTION = 0.45; // fraction of speed kept on each bounce
const SETTLE_VY = 1.2; // once a bounce is slower than this, the item settles

/** Begin a drop pop at `restY` (where the item will ultimately hover). */
export function startDrop(restY: number): DropAnim {
  return {
    y: restY,
    vy: POP_MIN + Math.random() * (POP_MAX - POP_MIN),
    restY,
    settled: false,
  };
}

/** Advance the pop-and-bounce one step; returns the new height. Flips `settled`
 *  once the item has stopped bouncing. */
export function updateDrop(d: DropAnim, dt: number): number {
  d.vy -= GRAVITY * dt;
  d.y += d.vy * dt;
  if (d.y <= d.restY && d.vy < 0) {
    d.y = d.restY;
    d.vy = -d.vy * RESTITUTION; // bounce
    if (d.vy < SETTLE_VY) {
      d.vy = 0;
      d.settled = true; // done bouncing — hand off to the resting bob
    }
  }
  return d.y;
}
