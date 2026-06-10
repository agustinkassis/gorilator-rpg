import {
  type Scene,
  TransformNode,
  MeshBuilder,
  StandardMaterial,
  Color3,
  Constants,
} from "@babylonjs/core";

export interface Lightning {
  update: (dt: number) => boolean;
  dispose: () => void;
}

const LIFE = 0.55; // seconds

/** A quick electric-blue lightning strike (jagged bolt + flash + expanding ring). */
export function buildLightning(scene: Scene, x: number, z: number): Lightning {
  const root = new TransformNode("lightning", scene);
  root.position.set(x, 0, z);
  const color = new Color3(0.78, 0.9, 1.0);

  const mats: StandardMaterial[] = [];
  const glow = (a: number) => {
    const m = new StandardMaterial("lmat", scene);
    m.emissiveColor = color;
    m.diffuseColor = new Color3(0, 0, 0);
    m.specularColor = new Color3(0, 0, 0);
    m.disableLighting = true;
    m.alpha = a;
    m.alphaMode = Constants.ALPHA_ADD;
    m.backFaceCulling = false;
    m.disableDepthWrite = true;
    mats.push(m);
    return m;
  };

  // jagged bolt: a stack of slightly offset/tilted bright segments
  const boltMat = glow(1);
  const top = 13;
  const N = 6;
  for (let i = 0; i < N; i++) {
    const seg = MeshBuilder.CreateCylinder(
      "bolt",
      { height: top / N + 0.25, diameter: 0.14, tessellation: 5 },
      scene,
    );
    seg.material = boltMat;
    seg.isPickable = false;
    seg.parent = root;
    seg.position.set(
      (Math.random() - 0.5) * 1.0,
      top - (top / N) * (i + 0.5),
      (Math.random() - 0.5) * 1.0,
    );
    seg.rotation.z = (Math.random() - 0.5) * 0.55;
    seg.rotation.x = (Math.random() - 0.5) * 0.55;
  }

  const flashMat = glow(0.9);
  const flash = MeshBuilder.CreateSphere("lflash", { diameter: 1.7, segments: 8 }, scene);
  flash.material = flashMat;
  flash.isPickable = false;
  flash.parent = root;
  flash.position.y = 0.45;

  const ringMat = glow(0.85);
  const ring = MeshBuilder.CreateTorus("lring", { diameter: 1, thickness: 0.18, tessellation: 28 }, scene);
  ring.material = ringMat;
  ring.isPickable = false;
  ring.parent = root;
  ring.position.y = 0.08;

  let t = 0;
  return {
    update: (dt) => {
      t += dt;
      if (t >= LIFE) return false;
      const k = t / LIFE;
      // bolt: flicker bright, then fade
      boltMat.alpha = k < 0.4 ? 0.6 + Math.random() * 0.4 : Math.max(0, 1 - (k - 0.4) / 0.6);
      // flash: bright pop, shrink + fade
      flashMat.alpha = Math.max(0, 1 - k * 2.2);
      flash.scaling.setAll(1 + k * 1.6);
      // ring: expand + fade
      ringMat.alpha = Math.max(0, 0.85 * (1 - k));
      const rs = 1 + k * 5;
      ring.scaling.set(rs, 1, rs);
      return true;
    },
    dispose: () => {
      root.dispose();
      for (const m of mats) m.dispose();
    },
  };
}
