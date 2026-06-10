/** Shortest-path interpolation between two angles (radians). */
export function lerpAngle(from: number, to: number, t: number): number {
  let diff = (to - from) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return from + diff * Math.min(1, Math.max(0, t));
}

/** Frame-rate independent smoothing factor for exponential lerps. */
export function smooth(dt: number, halfLife = 0.06): number {
  return 1 - 2 ** (-dt / halfLife);
}
