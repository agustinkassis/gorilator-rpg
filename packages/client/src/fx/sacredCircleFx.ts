import {
  Color4,
  DynamicTexture,
  Mesh,
  MeshBuilder,
  ParticleSystem,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
} from "@babylonjs/core";

let dot: DynamicTexture | null = null;
let ring: DynamicTexture | null = null;

function dotTexture(scene: Scene): DynamicTexture {
  if (dot) return dot;
  const size = 64;
  const tex = new DynamicTexture("sacredCircleDot", size, scene, false);
  const ctx = tex.getContext();
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.45, "rgba(255,255,255,0.7)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  tex.update();
  tex.hasAlpha = true;
  dot = tex;
  return tex;
}

function ringTexture(scene: Scene): DynamicTexture {
  if (ring) return ring;
  const size = 512;
  const tex = new DynamicTexture("sacredCircleRing", size, scene, false);
  const ctx = tex.getContext();
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.42;

  ctx.clearRect(0, 0, size, size);

  const glow = ctx.createRadialGradient(cx, cy, r * 0.72, cx, cy, r * 1.16);
  glow.addColorStop(0, "rgba(80,255,125,0)");
  glow.addColorStop(0.7, "rgba(80,255,125,0.24)");
  glow.addColorStop(1, "rgba(80,255,125,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, size, size);

  ctx.strokeStyle = "rgba(180,255,196,0.86)";
  ctx.lineWidth = size * 0.018;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = "rgba(70,255,120,0.34)";
  ctx.lineWidth = size * 0.04;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  tex.update();
  tex.hasAlpha = true;
  return (ring = tex);
}

export interface SacredCircleFx {
  root: TransformNode;
  setEnabled(on: boolean): void;
  dispose(): void;
}

export function makeSacredCircleFx(scene: Scene, radius: number): SacredCircleFx {
  const root = new TransformNode("sacredCircle", scene);

  const ringMat = new StandardMaterial("sacredCircleMat", scene);
  ringMat.diffuseTexture = ringTexture(scene);
  ringMat.opacityTexture = ringMat.diffuseTexture;
  ringMat.emissiveTexture = ringMat.diffuseTexture;
  ringMat.disableLighting = true;
  ringMat.useAlphaFromDiffuseTexture = true;
  ringMat.alphaMode = 2;
  ringMat.backFaceCulling = false;

  const groundRing = MeshBuilder.CreateDisc(
    "sacredCircleGroundRing",
    { radius: radius * 1.16, tessellation: 64, sideOrientation: Mesh.DOUBLESIDE },
    scene,
  );
  groundRing.parent = root;
  groundRing.position.y = 0.055;
  groundRing.rotation.x = Math.PI / 2;
  groundRing.material = ringMat;
  groundRing.isPickable = false;

  const ps = new ParticleSystem("sacredCircleParticles", 160, scene);
  ps.particleTexture = dotTexture(scene);
  ps.emitter = root;
  ps.createCylinderEmitter(radius * 0.95, 0.04, 0.04, 0);
  ps.minEmitBox = new Vector3(-radius, 0.05, -radius);
  ps.maxEmitBox = new Vector3(radius, 0.05, radius);
  ps.color1 = new Color4(0.1, 1.0, 0.25, 0.95);
  ps.color2 = new Color4(0.45, 1.0, 0.35, 0.7);
  ps.colorDead = new Color4(0.0, 0.5, 0.12, 0);
  ps.minSize = 0.05;
  ps.maxSize = 0.2;
  ps.minLifeTime = 0.7;
  ps.maxLifeTime = 1.5;
  ps.emitRate = 28;
  ps.blendMode = ParticleSystem.BLENDMODE_ADD;
  ps.gravity = new Vector3(0, 0.45, 0);
  ps.direction1 = new Vector3(-0.15, 0.5, -0.15);
  ps.direction2 = new Vector3(0.15, 1.2, 0.15);
  ps.minEmitPower = 0.2;
  ps.maxEmitPower = 0.65;
  ps.updateSpeed = 0.02;
  ps.start();

  return {
    root,
    setEnabled(on: boolean) {
      root.setEnabled(on);
      if (on && !ps.isStarted()) ps.start();
      if (!on && ps.isStarted()) ps.stop();
    },
    dispose() {
      ps.dispose();
      root.getChildMeshes().forEach((mesh: Mesh) => mesh.dispose());
      ringMat.dispose(false, false);
      root.dispose();
    },
  };
}
