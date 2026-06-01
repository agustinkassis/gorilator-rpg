import {
  Scene,
  ParticleSystem,
  DynamicTexture,
  Color4,
  Vector3,
} from "@babylonjs/core";

// A single soft round sprite, drawn once and shared by every banana particle
// system (trail motes + impact puffs).
let dot: DynamicTexture | null = null;
function dotTexture(scene: Scene): DynamicTexture {
  if (dot) return dot;
  const size = 64;
  const tex = new DynamicTexture("fxDot", size, scene, false);
  const ctx = tex.getContext();
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.45, "rgba(255,255,255,0.65)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  tex.update();
  tex.hasAlpha = true;
  dot = tex;
  return tex;
}

/**
 * A glowing sparkle trail that streams off a flying banana. `emitterPos` is a
 * live Vector3 (e.g. the banana root's position) so the trail auto-follows.
 * Caller stops()+disposes it once the banana settles.
 */
export function makeBananaTrail(scene: Scene, emitterPos: Vector3): ParticleSystem {
  const ps = new ParticleSystem("bananaTrail", 140, scene);
  ps.particleTexture = dotTexture(scene);
  ps.emitter = emitterPos; // shared ref → follows the banana
  ps.minEmitBox = new Vector3(-0.06, -0.06, -0.06);
  ps.maxEmitBox = new Vector3(0.06, 0.06, 0.06);
  ps.color1 = new Color4(1.0, 0.92, 0.3, 1);
  ps.color2 = new Color4(1.0, 0.75, 0.12, 1);
  ps.colorDead = new Color4(1.0, 0.8, 0.2, 0);
  ps.minSize = 0.06;
  ps.maxSize = 0.17;
  ps.minLifeTime = 0.16;
  ps.maxLifeTime = 0.34;
  ps.emitRate = 95;
  ps.blendMode = ParticleSystem.BLENDMODE_ADD; // glowy
  ps.gravity = new Vector3(0, -1.0, 0);
  ps.direction1 = new Vector3(-0.3, -0.1, -0.3);
  ps.direction2 = new Vector3(0.3, 0.35, 0.3);
  ps.minEmitPower = 0.1;
  ps.maxEmitPower = 0.5;
  ps.updateSpeed = 0.02;
  ps.start();
  return ps;
}

/**
 * A short dust + sparkle puff at a ground bounce. `strength` (≈ impact speed)
 * scales the count, size and spread. Self-stops; caller disposes after its life.
 */
export function makeBananaBurst(
  scene: Scene,
  x: number,
  y: number,
  z: number,
  strength: number,
): ParticleSystem {
  const n = Math.round(8 + strength * 16);
  const ps = new ParticleSystem("bananaBurst", n + 8, scene);
  ps.particleTexture = dotTexture(scene);
  ps.emitter = new Vector3(x, y + 0.05, z);
  ps.color1 = new Color4(1.0, 0.9, 0.45, 1);
  ps.color2 = new Color4(0.88, 0.74, 0.42, 0.9);
  ps.colorDead = new Color4(0.85, 0.72, 0.4, 0);
  ps.minSize = 0.05;
  ps.maxSize = 0.1 + strength * 0.06;
  ps.minLifeTime = 0.14;
  ps.maxLifeTime = 0.32;
  ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
  ps.gravity = new Vector3(0, -3.5, 0);
  ps.direction1 = new Vector3(-1, 0.4, -1);
  ps.direction2 = new Vector3(1, 1.4, 1);
  ps.minEmitPower = 0.5 + strength;
  ps.maxEmitPower = 1.2 + strength * 1.6;
  // emit the whole puff in one quick burst, then idle until disposed
  ps.emitRate = n / 0.04;
  ps.targetStopDuration = 0.04;
  ps.start();
  return ps;
}
