import {
  type Scene,
  ParticleSystem,
  DynamicTexture,
  Color4,
  Vector3,
} from "@babylonjs/core";

let dot: DynamicTexture | null = null;
function dotTexture(scene: Scene): DynamicTexture {
  if (dot) return dot;
  const size = 64;
  const tex = new DynamicTexture("fxDotExpl", size, scene, false);
  const ctx = tex.getContext();
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.45, "rgba(255,255,255,0.6)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  tex.update();
  tex.hasAlpha = true;
  dot = tex;
  return tex;
}

/**
 * A bright golden burst that erupts up and out from a character who just leveled
 * up. One quick emission, then it idles until disposed by the caller.
 */
export function makeLevelUpExplosion(
  scene: Scene,
  x: number,
  y: number,
  z: number,
): ParticleSystem {
  const n = 160;
  const ps = new ParticleSystem("levelUp", n + 8, scene);
  ps.particleTexture = dotTexture(scene);
  ps.emitter = new Vector3(x, y, z);
  ps.minEmitBox = new Vector3(-0.25, 0, -0.25);
  ps.maxEmitBox = new Vector3(0.25, 1.2, 0.25);
  ps.color1 = new Color4(1.0, 0.92, 0.45, 1);
  ps.color2 = new Color4(1.0, 0.66, 0.12, 1);
  ps.colorDead = new Color4(1.0, 0.8, 0.3, 0);
  ps.minSize = 0.12;
  ps.maxSize = 0.42;
  ps.minLifeTime = 0.45;
  ps.maxLifeTime = 1.0;
  ps.blendMode = ParticleSystem.BLENDMODE_ADD; // glowy
  ps.gravity = new Vector3(0, -4, 0);
  ps.direction1 = new Vector3(-3.5, 5, -3.5);
  ps.direction2 = new Vector3(3.5, 11, 3.5);
  ps.minEmitPower = 2.5;
  ps.maxEmitPower = 7;
  ps.emitRate = n / 0.12;
  ps.targetStopDuration = 0.12; // one quick burst
  ps.start();
  return ps;
}
