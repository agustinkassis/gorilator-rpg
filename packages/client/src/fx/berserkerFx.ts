import {
  Scene,
  ParticleSystem,
  DynamicTexture,
  Color4,
  Vector3,
} from "@babylonjs/core";

// Shared soft-circle sprite for berserker particles.
let dot: DynamicTexture | null = null;
function dotTexture(scene: Scene): DynamicTexture {
  if (dot) return dot;
  const size = 64;
  const tex = new DynamicTexture("berserkDot", size, scene, false);
  const ctx = tex.getContext();
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.4, "rgba(255,255,255,0.6)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  tex.update();
  tex.hasAlpha = true;
  dot = tex;
  return tex;
}

/**
 * A swirling green power aura that streams off a berserked player. `emitterPos`
 * is a live Vector3 (e.g. entity.root.position) so the aura auto-follows.
 * Caller calls stop() + dispose() when the buff ends.
 */
export function makeBerserkerAura(scene: Scene, emitterPos: Vector3): ParticleSystem {
  const ps = new ParticleSystem("berserkerAura", 300, scene);
  ps.particleTexture = dotTexture(scene);
  ps.emitter = emitterPos;
  // Spread the emitter across the character's footprint so particles drift off
  // the whole body, not just the feet.
  ps.minEmitBox = new Vector3(-0.35, 0.1, -0.35);
  ps.maxEmitBox = new Vector3(0.35, 1.6, 0.35);
  // Vivid green → slightly yellowish-green dead
  ps.color1 = new Color4(0.1, 1.0, 0.25, 1.0);
  ps.color2 = new Color4(0.3, 0.9, 0.1, 0.8);
  ps.colorDead = new Color4(0.0, 0.6, 0.15, 0.0);
  ps.minSize = 0.04;
  ps.maxSize = 0.20;
  ps.minLifeTime = 0.3;
  ps.maxLifeTime = 0.7;
  ps.emitRate = 160;
  ps.blendMode = ParticleSystem.BLENDMODE_ADD; // additive → glowing green
  // Drift upward + outward, a bit of swirl
  ps.gravity = new Vector3(0, 0.8, 0);
  ps.direction1 = new Vector3(-0.8, 1.2, -0.8);
  ps.direction2 = new Vector3(0.8, 2.5, 0.8);
  ps.minEmitPower = 0.3;
  ps.maxEmitPower = 1.2;
  ps.updateSpeed = 0.02;
  ps.start();
  return ps;
}
