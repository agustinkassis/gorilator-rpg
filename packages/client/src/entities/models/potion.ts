import {
  type Scene,
  TransformNode,
  type Mesh,
  MeshBuilder,
  StandardMaterial,
  Color3,
  type AbstractMesh,
} from "@babylonjs/core";

export interface PotionModel {
  root: TransformNode;
  meshes: AbstractMesh[];
  dispose: () => void;
}

/** A small glowing red health-potion flask (round-bottom bottle + cork). */
export function buildPotion(scene: Scene): PotionModel {
  const mats: StandardMaterial[] = [];
  const mat = (name: string, color: Color3, emissive: Color3) => {
    const m = new StandardMaterial(name, scene);
    m.diffuseColor = color;
    m.emissiveColor = emissive;
    m.specularColor = new Color3(0.4, 0.4, 0.4);
    mats.push(m);
    return m;
  };

  const glass = mat("potGlass", new Color3(0.85, 0.1, 0.12), new Color3(0.55, 0.05, 0.06));
  glass.alpha = 0.94;
  const cork = mat("potCork", new Color3(0.45, 0.3, 0.16), Color3.Black());

  const root = new TransformNode("potion", scene);
  const meshes: AbstractMesh[] = [];
  const add = (m: Mesh, material: StandardMaterial) => {
    m.material = material;
    m.parent = root; // follow the root's world position + bob
    meshes.push(m); // pickable so the player can click to collect it
    return m;
  };

  const body = add(MeshBuilder.CreateSphere("potBody", { diameter: 0.6, segments: 12 }, scene), glass);
  body.position.y = 0.4;
  body.scaling.y = 1.05;

  const neck = add(MeshBuilder.CreateCylinder("potNeck", { height: 0.28, diameter: 0.2 }, scene), glass);
  neck.position.y = 0.74;

  const corkMesh = add(MeshBuilder.CreateCylinder("potCork", { height: 0.14, diameter: 0.22 }, scene), cork);
  corkMesh.position.y = 0.92;

  return {
    root,
    meshes,
    dispose: () => {
      root.dispose();
      for (const m of mats) m.dispose();
    },
  };
}
