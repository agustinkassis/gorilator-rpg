import {
  type Scene,
  TransformNode,
  MeshBuilder,
  StandardMaterial,
  Color3,
  type AbstractMesh,
} from "@babylonjs/core";

export interface LogModel {
  root: TransformNode;
  meshes: AbstractMesh[];
  dispose: () => void;
}

interface LogMats {
  bark: StandardMaterial;
  end: StandardMaterial;
}

const matCache = new WeakMap<Scene, LogMats>();
function getMats(scene: Scene): LogMats {
  let m = matCache.get(scene);
  if (!m) {
    const mk = (name: string, c: Color3) => {
      const mat = new StandardMaterial(name, scene);
      mat.diffuseColor = c;
      mat.specularColor = new Color3(0.03, 0.03, 0.03);
      return mat;
    };
    m = {
      bark: mk("logBark", new Color3(0.36, 0.24, 0.14)),
      end: mk("logEnd", new Color3(0.62, 0.46, 0.28)),
    };
    matCache.set(scene, m);
  }
  return m;
}

/** A small pile of cut logs lying on the ground. */
export function buildLog(scene: Scene): LogModel {
  const mats = getMats(scene);
  const root = new TransformNode("logpile", scene);
  const meshes: AbstractMesh[] = [];

  const place = (x: number, y: number, z: number, yaw: number) => {
    const log = MeshBuilder.CreateCylinder(
      "log",
      { height: 0.85, diameter: 0.26, tessellation: 8 },
      scene,
    );
    log.material = mats.bark;
    log.rotation.z = Math.PI / 2; // lie flat (along X)
    log.rotation.y = yaw;
    log.position.set(x, y, z);
    log.parent = root;
    meshes.push(log);
    // light-coloured cut ends
    for (const ex of [-0.45, 0.45]) {
      const end = MeshBuilder.CreateCylinder(
        "logEnd",
        { height: 0.04, diameter: 0.26, tessellation: 8 },
        scene,
      );
      end.material = mats.end;
      end.rotation.z = Math.PI / 2;
      end.rotation.y = yaw;
      end.position.set(x + ex * Math.cos(yaw), y, z + ex * Math.sin(yaw));
      end.parent = root;
      meshes.push(end);
    }
  };

  place(0, 0.14, 0, 0.15);
  place(0.12, 0.14, 0.26, -0.35);
  place(-0.1, 0.4, 0.12, 0.5);

  return {
    root,
    meshes,
    dispose: () => root.dispose(),
  };
}
