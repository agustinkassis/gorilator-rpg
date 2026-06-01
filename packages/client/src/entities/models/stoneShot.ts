import { Scene, MeshBuilder, StandardMaterial, Color3, TransformNode } from "@babylonjs/core";
import { BananaModel } from "./banana";

/**
 * A primitive thrown-stone projectile: a small faceted grey rock, slightly oblong
 * so it reads as a hurled missile. Same shape as BananaModel, so the throw renderer
 * (Game.showBananaThrow) can fly either a banana or a stone.
 */
export function buildStoneShot(scene: Scene): BananaModel {
  const root = new TransformNode("stoneShot", scene);
  const rock = MeshBuilder.CreateIcoSphere(
    "stoneShotMesh",
    { radius: 0.34, subdivisions: 1, flat: true },
    scene,
  );
  rock.parent = root;
  rock.scaling.set(1, 0.8, 1.3); // oblong → a hurled rock / missile
  const mat = new StandardMaterial("stoneShotMat", scene);
  mat.diffuseColor = new Color3(0.5, 0.5, 0.55);
  mat.specularColor = new Color3(0.12, 0.12, 0.12);
  rock.material = mat;
  return { root, meshes: [rock], dispose: () => root.dispose() };
}
