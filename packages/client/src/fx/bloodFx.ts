import {
  Scene,
  ParticleSystem,
  DynamicTexture,
  Color4,
  Vector3,
} from "@babylonjs/core";

// A soft round sprite shared by every blood burst (tinted red per-particle).
let dot: DynamicTexture | null = null;
function dotTexture(scene: Scene): DynamicTexture {
  if (dot) return dot;
  const size = 64;
  const tex = new DynamicTexture("bloodDot", size, scene, false);
  const ctx = tex.getContext();
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.5, "rgba(255,255,255,0.7)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  tex.update();
  tex.hasAlpha = true;
  dot = tex;
  return tex;
}

/**
 * A quick spray of dark-red droplets at a character that just took a hit.
 * `strength` (≈ damage) scales the count, size and spread. Self-stops in one
 * burst; the caller ages it out and disposes it.
 */
export function makeBloodBurst(
  scene: Scene,
  x: number,
  y: number,
  z: number,
  strength: number,
): ParticleSystem {
  const n = Math.round(10 + strength * 20);
  const ps = new ParticleSystem("blood", n + 10, scene);
  ps.particleTexture = dotTexture(scene);
  ps.emitter = new Vector3(x, y, z);
  ps.color1 = new Color4(0.72, 0.02, 0.02, 1);
  ps.color2 = new Color4(0.45, 0.0, 0.0, 1);
  ps.colorDead = new Color4(0.28, 0.0, 0.0, 0);
  ps.minSize = 0.06;
  ps.maxSize = 0.13 + strength * 0.08;
  ps.minLifeTime = 0.2;
  ps.maxLifeTime = 0.5;
  ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
  ps.gravity = new Vector3(0, -9, 0); // droplets arc up then fall
  ps.direction1 = new Vector3(-1, 0.3, -1);
  ps.direction2 = new Vector3(1, 1.1, 1);
  ps.minEmitPower = 1 + strength;
  ps.maxEmitPower = 2.4 + strength * 2;
  // fire the whole spray in one quick burst, then idle until disposed
  ps.emitRate = n / 0.03;
  ps.targetStopDuration = 0.03;
  ps.start();
  return ps;
}
