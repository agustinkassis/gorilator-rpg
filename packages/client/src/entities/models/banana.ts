import {
  type Scene,
  SceneLoader,
  type AssetContainer,
  TransformNode,
  type AbstractMesh,
  PBRMaterial,
  MeshBuilder,
  StandardMaterial,
  Color3,
  Vector3,
  Quaternion,
  Mesh,
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
 * procedural banana mesh if the glb is missing. */
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

/** Instantiate a banana (cloned from the loaded model, or a procedural banana). */
export function buildBanana(scene: Scene): BananaModel {
  const root = new TransformNode("banana", scene);
  if (container) {
    // Independent clones (not instances) so disposing a thrown banana can never
    // corrupt the shared source mesh used by every ground banana.
    const entries = container.instantiateModelsToScene((n) => n, false, {
      doNotInstantiate: true,
    });
    (entries.rootNodes[0] as TransformNode).parent = root;
    root.scaling.setAll(BANANA_SCALE);
    return { root, meshes: root.getChildMeshes(), dispose: () => root.dispose() };
  }
  return buildProceduralBanana(scene, root);
}

/** A curved, tapered banana built from primitives — used whenever banana.glb is
 * absent. A crescent yellow body with a brown stem at one tip and a brown
 * blossom dot at the other, so it unmistakably reads as a banana lying on the
 * ground (the old fallback was a plain capsule that looked like a pill). */
function buildProceduralBanana(scene: Scene, root: TransformNode): BananaModel {
  const N = 28;
  const arc = Math.PI * 0.8; // crescent sweep (~144°)
  const R = 1.0;

  // Sample the crescent, then re-centre it on the root so the banana spins/bobs
  // in place instead of orbiting an off-centre origin.
  const raw: Vector3[] = [];
  for (let i = 0; i <= N; i++) {
    const a = (i / N - 0.5) * arc;
    raw.push(new Vector3(Math.sin(a) * R, 0, Math.cos(a) * R));
  }
  const centroid = raw
    .reduce((s, p) => s.addInPlace(p), Vector3.Zero())
    .scaleInPlace(1 / raw.length);
  const path = raw.map((p) => p.subtract(centroid));

  const body = MeshBuilder.CreateTube(
    "bananaBody",
    {
      path,
      // Thin tips, fat belly → the classic banana taper.
      radiusFunction: (i) =>
        0.045 + 0.16 * Math.sin((i / N) * Math.PI) ** 0.7,
      tessellation: 14,
      cap: Mesh.CAP_ALL,
    },
    scene,
  );
  body.parent = root;

  const yellow = new StandardMaterial("bananaMat", scene);
  yellow.diffuseColor = new Color3(0.96, 0.81, 0.12);
  yellow.specularColor = new Color3(0.18, 0.16, 0.06);
  yellow.specularPower = 32;
  body.material = yellow;

  const brown = new StandardMaterial("bananaTipMat", scene);
  brown.diffuseColor = new Color3(0.3, 0.2, 0.08);
  brown.specularColor = new Color3(0.05, 0.05, 0.05);

  // Stem: a short stub continuing the crescent's tangent off the first tip.
  const tip0 = path[0];
  const dir = tip0.subtract(path[1]).normalize();
  const stem = MeshBuilder.CreateCylinder(
    "bananaStem",
    { height: 0.22, diameterBottom: 0.14, diameterTop: 0.06, tessellation: 10 },
    scene,
  );
  stem.parent = root;
  const axis = Vector3.Cross(Vector3.Up(), dir);
  if (axis.lengthSquared() > 1e-6) {
    const angle = Math.acos(Math.min(1, Math.max(-1, Vector3.Dot(Vector3.Up(), dir))));
    stem.rotationQuaternion = Quaternion.RotationAxis(axis.normalize(), angle);
  }
  stem.position.copyFrom(tip0.add(dir.scale(0.09)));
  stem.material = brown;

  // Blossom: a tiny brown dot capping the far tip.
  const blossom = MeshBuilder.CreateSphere("bananaTip", { diameter: 0.09, segments: 6 }, scene);
  blossom.parent = root;
  blossom.position.copyFrom(path[N]);
  blossom.material = brown;

  root.scaling.setAll(BANANA_SCALE);
  return { root, meshes: root.getChildMeshes(), dispose: () => root.dispose() };
}
