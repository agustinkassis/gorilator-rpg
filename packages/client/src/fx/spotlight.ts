import {
  Scene,
  TransformNode,
  MeshBuilder,
  StandardMaterial,
  Color3,
  Constants,
} from "@babylonjs/core";

export interface Spotlight {
  root: TransformNode;
  /** Advance the animation. Returns false once it has finished. */
  update: (dt: number) => boolean;
  dispose: () => void;
}

const LIFETIME = 1.8; // seconds

/**
 * A target-marker "spotlight": a soft downward light cone plus a pulsing,
 * spinning ground ring + glow disc, all additively blended and tinted by the
 * pending action. Fades in, pulses, then fades out.
 */
export function buildSpotlight(scene: Scene, color: Color3): Spotlight {
  const root = new TransformNode("spotlight", scene);

  const glow = (name: string, alpha: number) => {
    const m = new StandardMaterial(name, scene);
    m.emissiveColor = color;
    m.diffuseColor = new Color3(0, 0, 0);
    m.specularColor = new Color3(0, 0, 0);
    m.disableLighting = true;
    m.alpha = alpha;
    m.alphaMode = Constants.ALPHA_ADD;
    m.backFaceCulling = false;
    m.disableDepthWrite = true;
    return m;
  };

  const coneMat = glow("spotCone", 0.16);
  const cone = MeshBuilder.CreateCylinder(
    "spotCone",
    { height: 7, diameterTop: 3.4, diameterBottom: 0.5, tessellation: 20 },
    scene,
  );
  cone.material = coneMat;
  cone.position.y = 3.55;
  cone.isPickable = false;
  cone.parent = root;

  const discMat = glow("spotDisc", 0.2);
  const disc = MeshBuilder.CreateDisc("spotDisc", { radius: 1.2, tessellation: 36 }, scene);
  disc.material = discMat;
  disc.rotation.x = Math.PI / 2;
  disc.position.y = 0.05;
  disc.isPickable = false;
  disc.parent = root;

  const ringMat = glow("spotRing", 0.75);
  const ring = MeshBuilder.CreateTorus(
    "spotRing",
    { diameter: 2.5, thickness: 0.16, tessellation: 36 },
    scene,
  );
  ring.material = ringMat;
  ring.position.y = 0.07;
  ring.isPickable = false;
  ring.parent = root;

  let t = 0;

  return {
    root,
    update: (dt) => {
      t += dt;
      if (t >= LIFETIME) return false;
      const fade = Math.min(t / 0.18, (LIFETIME - t) / 0.45, 1);
      const pulse = 0.7 + 0.3 * Math.sin(t * 7);
      coneMat.alpha = 0.16 * fade * pulse;
      discMat.alpha = 0.2 * fade * pulse;
      ringMat.alpha = 0.78 * fade * (0.8 + 0.2 * Math.sin(t * 7));
      ring.rotation.y += dt * 2.2;
      const s = 1 + 0.07 * Math.sin(t * 6);
      ring.scaling.set(s, 1, s);
      return true;
    },
    dispose: () => {
      root.dispose();
      coneMat.dispose();
      discMat.dispose();
      ringMat.dispose();
    },
  };
}
