import {
  Scene,
  SceneLoader,
  AssetContainer,
  TransformNode,
  AbstractMesh,
  PBRMaterial,
  MeshBuilder,
  StandardMaterial,
  Color3,
} from "@babylonjs/core";
import "@babylonjs/loaders/glTF";

const BANANA_URL = "/models/banana.glb";
const BANANA_SCALE = 0.3; // the source model is ~2u long; shrink to a small item

let container: AssetContainer | null = null;

export interface BananaModel {
  root: TransformNode;
  meshes: AbstractMesh[];
  dispose(): void;
}

/** Load the banana mesh once; cloned per ground/thrown banana. Falls back to a
 * yellow capsule if the glb is missing. */
export async function preloadBanana(scene: Scene): Promise<void> {
  let exists = false;
  try {
    const res = await fetch(BANANA_URL, { method: "HEAD" });
    const type = res.headers.get("content-type") ?? "";
    exists = res.ok && !type.includes("text/html");
  } catch {
    exists = false;
  }
  if (!exists) {
    container = null;
    return;
  }
  try {
    container = await SceneLoader.LoadAssetContainerAsync("", BANANA_URL, scene);
    // Same fix as the gorilla: matte + single-sided so the glTF __root__ negative
    // scale doesn't invert the shading from the iso camera's angle.
    container.materials.forEach((m) => {
      if (m instanceof PBRMaterial) {
        m.metallic = 0;
        m.roughness = 0.6;
        // Force OPAQUE — a transparent material is skipped by the shadow map, so
        // the banana wouldn't drop a shadow (on the ground or mid-flight) otherwise.
        m.transparencyMode = PBRMaterial.PBRMATERIAL_OPAQUE;
        m.backFaceCulling = true;
        m.twoSidedLighting = false;
      }
    });
  } catch {
    container = null;
  }
}

/** Instantiate a banana (cloned from the loaded model, or a fallback capsule). */
export function buildBanana(scene: Scene): BananaModel {
  const root = new TransformNode("banana", scene);
  if (container) {
    const entries = container.instantiateModelsToScene((n) => n, false);
    (entries.rootNodes[0] as TransformNode).parent = root;
    root.scaling.setAll(BANANA_SCALE);
    return { root, meshes: root.getChildMeshes(), dispose: () => root.dispose() };
  }
  const m = MeshBuilder.CreateCapsule("bananaFallback", { radius: 0.12, height: 0.6 }, scene);
  m.rotation.z = Math.PI / 2;
  const mat = new StandardMaterial("bananaMat", scene);
  mat.diffuseColor = new Color3(0.95, 0.85, 0.15);
  mat.specularColor = new Color3(0.1, 0.1, 0.05);
  m.material = mat;
  m.parent = root;
  return { root, meshes: [m], dispose: () => root.dispose() };
}
