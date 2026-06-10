import {
  type Scene,
  TransformNode,
  MeshBuilder,
  StandardMaterial,
  Color3,
  type AbstractMesh,
} from "@babylonjs/core";

export interface StoneModel {
  root: TransformNode;
  meshes: AbstractMesh[];
  dispose: () => void;
}

const matCache = new WeakMap<Scene, StandardMaterial>();
function getMat(scene: Scene): StandardMaterial {
  let m = matCache.get(scene);
  if (!m) {
    m = new StandardMaterial("stoneMat", scene);
    m.diffuseColor = new Color3(0.5, 0.5, 0.54);
    m.specularColor = new Color3(0.05, 0.05, 0.06);
    matCache.set(scene, m);
  }
  return m;
}

/** A small pile of mined stones, on the ground. */
export function buildStone(scene: Scene): StoneModel {
  const mat = getMat(scene);
  const root = new TransformNode("stonepile", scene);
  const meshes: AbstractMesh[] = [];

  const spots: Array<[number, number, number, number]> = [
    [0, 0.16, 0, 0.34],
    [0.22, 0.13, 0.12, 0.26],
    [-0.16, 0.13, 0.18, 0.24],
    [0.05, 0.32, 0.04, 0.2],
  ];
  for (const [x, y, z, r] of spots) {
    const s = MeshBuilder.CreateIcoSphere("stone", { radius: r, subdivisions: 1, flat: true }, scene);
    s.material = mat;
    s.position.set(x, y, z);
    s.scaling.set(1, 0.8, 1);
    s.rotation.y = x + z;
    s.parent = root;
    meshes.push(s);
  }

  return {
    root,
    meshes,
    dispose: () => root.dispose(),
  };
}
