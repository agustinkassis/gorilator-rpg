import {
  Scene,
  TransformNode,
  MeshBuilder,
  StandardMaterial,
  Color3,
  AbstractMesh,
} from "@babylonjs/core";

export interface TreeModel {
  root: TransformNode;
  meshes: AbstractMesh[];
  setAlive: (alive: boolean) => void;
  shake: () => void;
  update: (dt: number) => void;
  dispose: () => void;
}

interface TreeMats {
  trunk: StandardMaterial;
  leaf: StandardMaterial;
  stump: StandardMaterial;
  stumpTop: StandardMaterial;
}

// Share materials across all trees in a scene (there can be dozens).
const matCache = new WeakMap<Scene, TreeMats>();
function getMats(scene: Scene): TreeMats {
  let m = matCache.get(scene);
  if (!m) {
    const mk = (name: string, c: Color3) => {
      const mat = new StandardMaterial(name, scene);
      mat.diffuseColor = c;
      mat.specularColor = new Color3(0.02, 0.02, 0.02);
      return mat;
    };
    m = {
      trunk: mk("treeTrunk", new Color3(0.34, 0.22, 0.13)),
      leaf: mk("treeLeaf", new Color3(0.16, 0.41, 0.19)),
      stump: mk("treeStump", new Color3(0.3, 0.2, 0.12)),
      stumpTop: mk("treeStumpTop", new Color3(0.55, 0.42, 0.26)),
    };
    matCache.set(scene, m);
  }
  return m;
}

/** A choppable pine tree (trunk + stacked cones) that can switch to a stump. */
export function buildTree(scene: Scene): TreeModel {
  const mats = getMats(scene);
  const root = new TransformNode("tree", scene);
  const meshes: AbstractMesh[] = [];

  // ---- alive tree ----
  const aliveG = new TransformNode("treeAlive", scene);
  aliveG.parent = root;

  const trunk = MeshBuilder.CreateCylinder(
    "trunk",
    { height: 2.4, diameterTop: 0.5, diameterBottom: 0.75, tessellation: 7 },
    scene,
  );
  trunk.position.y = 1.2;
  trunk.material = mats.trunk;
  trunk.parent = aliveG;
  meshes.push(trunk);

  const coneSpecs = [
    { y: 2.6, d: 3.0, h: 2.0 },
    { y: 3.7, d: 2.3, h: 1.7 },
    { y: 4.7, d: 1.5, h: 1.4 },
  ];
  for (const c of coneSpecs) {
    const cone = MeshBuilder.CreateCylinder(
      "leaves",
      { height: c.h, diameterTop: 0, diameterBottom: c.d, tessellation: 7 },
      scene,
    );
    cone.position.y = c.y;
    cone.material = mats.leaf;
    cone.parent = aliveG;
    meshes.push(cone);
  }

  // ---- stump (shown after cutting) ----
  const stumpG = new TransformNode("treeStump", scene);
  stumpG.parent = root;
  const stump = MeshBuilder.CreateCylinder(
    "stump",
    { height: 0.5, diameter: 0.85, tessellation: 8 },
    scene,
  );
  stump.position.y = 0.25;
  stump.material = mats.stump;
  stump.parent = stumpG;
  meshes.push(stump);
  const stumpTop = MeshBuilder.CreateCylinder(
    "stumpTop",
    { height: 0.06, diameter: 0.7, tessellation: 8 },
    scene,
  );
  stumpTop.position.y = 0.52;
  stumpTop.material = mats.stumpTop;
  stumpTop.parent = stumpG;
  meshes.push(stumpTop);
  stumpG.setEnabled(false);

  const stumpMeshes = [stump, stumpTop];
  const DEAD_HOLD = 10; // seconds the stump lingers before fading
  const DEAD_FADE = 0.7; // fade-out duration
  let shakeT = 0;
  let phase: "alive" | "dead" | "hidden" = "alive";
  let deadT = 0;

  return {
    root,
    meshes,
    setAlive: (alive) => {
      if (alive) {
        aliveG.setEnabled(true);
        stumpG.setEnabled(false);
        for (const m of stumpMeshes) m.visibility = 1;
        phase = "alive";
      } else {
        aliveG.setEnabled(false);
        if (phase === "alive") {
          // just cut: show the stump, then it'll hold 10s and fade out
          stumpG.setEnabled(true);
          for (const m of stumpMeshes) m.visibility = 1;
          phase = "dead";
          deadT = 0;
        }
      }
    },
    shake: () => {
      shakeT = 0.32;
    },
    update: (dt) => {
      if (shakeT > 0) {
        shakeT -= dt;
        const k = Math.max(0, shakeT / 0.32);
        aliveG.rotation.z = Math.sin(shakeT * 55) * 0.07 * k;
      } else if (aliveG.rotation.z !== 0) {
        aliveG.rotation.z = 0;
      }
      if (phase === "dead") {
        deadT += dt;
        if (deadT > DEAD_HOLD) {
          const k = Math.min(1, (deadT - DEAD_HOLD) / DEAD_FADE);
          for (const m of stumpMeshes) m.visibility = 1 - k;
          if (k >= 1) {
            stumpG.setEnabled(false);
            phase = "hidden"; // stays gone until the server respawns the tree
          }
        }
      }
    },
    dispose: () => {
      root.dispose();
    },
  };
}
