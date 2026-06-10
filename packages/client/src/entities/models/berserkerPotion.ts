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
  type Mesh,
} from "@babylonjs/core";
import "@babylonjs/loaders/glTF";

const MODEL_URL = "/models/berserker_potion.glb";
const MODEL_SCALE = 0.28; // world-space size roughly matching the regular health potion

let container: AssetContainer | null = null;

export interface BerserkerPotionModel {
  root: TransformNode;
  meshes: AbstractMesh[];
  dispose(): void;
}

/** Load the berserker-potion GLB once; each call to buildBerserkerPotion gets
 *  an independent clone. Falls back gracefully to a procedural green flask. */
export async function preloadBerserkerPotion(scene: Scene): Promise<void> {
  let exists = false;
  try {
    const res = await fetch(MODEL_URL, { method: "HEAD" });
    const ct = res.headers.get("content-type") ?? "";
    exists = res.ok && !ct.includes("text/html");
  } catch {
    exists = false;
  }
  if (!exists) { container = null; return; }
  try {
    container = await SceneLoader.LoadAssetContainerAsync("", MODEL_URL, scene);
    container.materials.forEach((m) => {
      if (m instanceof PBRMaterial) {
        m.metallic = 0.1;
        m.roughness = 0.5;
        m.transparencyMode = PBRMaterial.PBRMATERIAL_OPAQUE;
        m.backFaceCulling = true;
      }
    });
  } catch {
    container = null;
  }
}

/** Build one berserker-potion model — GLB if loaded, else a procedural green flask. */
export function buildBerserkerPotion(scene: Scene): BerserkerPotionModel {
  const root = new TransformNode("berserkerPotion", scene);

  if (container) {
    const entries = container.instantiateModelsToScene((n) => n, false, {
      doNotInstantiate: true,
    });
    (entries.rootNodes[0] as TransformNode).parent = root;
    root.scaling.setAll(MODEL_SCALE);
    return { root, meshes: root.getChildMeshes(), dispose: () => root.dispose() };
  }

  return buildProceduralFlask(scene, root);
}

// ---------------------------------------------------------------------------
// Procedural berserker-potion flask (used when no GLB is present).
// A dark glass bottle with glowing green liquid: round body + cylindrical neck
// + cork, plus a small inner "liquid glow" sphere and a crackling ring.
// ---------------------------------------------------------------------------
function buildProceduralFlask(scene: Scene, root: TransformNode): BerserkerPotionModel {
  const mats: StandardMaterial[] = [];
  const meshes: AbstractMesh[] = [];

  const mat = (
    name: string,
    diff: Color3,
    emissive: Color3,
    alpha = 1,
    specular = new Color3(0.3, 0.3, 0.3),
  ) => {
    const m = new StandardMaterial(name, scene);
    m.diffuseColor = diff;
    m.emissiveColor = emissive;
    m.specularColor = specular;
    m.alpha = alpha;
    mats.push(m);
    return m;
  };

  // Dark glass (slight green tint, semi-transparent)
  const glass = mat(
    "bpGlass",
    new Color3(0.05, 0.22, 0.08),
    new Color3(0.0, 0.28, 0.06),
    0.82,
  );
  // Bright green liquid glow (fully opaque emissive core)
  const liquid = mat(
    "bpLiquid",
    new Color3(0.0, 0.9, 0.2),
    new Color3(0.0, 0.75, 0.15),
    1,
    new Color3(0.1, 0.5, 0.1),
  );
  // Cork / stopper (brown)
  const cork = mat(
    "bpCork",
    new Color3(0.42, 0.27, 0.1),
    Color3.Black(),
    1,
    new Color3(0.05, 0.05, 0.05),
  );
  // Lightning rune ring accent (bright green crackling rim)
  const rune = mat(
    "bpRune",
    new Color3(0.1, 1.0, 0.25),
    new Color3(0.05, 0.9, 0.2),
    1,
    new Color3(0.5, 1.0, 0.5),
  );

  const add = (m: Mesh, material: StandardMaterial) => {
    m.material = material;
    m.parent = root;
    meshes.push(m);
    return m;
  };

  // Round bottle body (slightly taller than the red potion, more slender)
  const body = add(
    MeshBuilder.CreateSphere("bpBody", { diameter: 0.54, segments: 14 }, scene),
    glass,
  );
  body.position.y = 0.4;
  body.scaling.set(1, 1.15, 1); // slightly elongated vertically

  // Glowing liquid core (inner sphere, smaller + bright)
  const glow = add(
    MeshBuilder.CreateSphere("bpGlow", { diameter: 0.38, segments: 10 }, scene),
    liquid,
  );
  glow.position.y = 0.4;
  glow.scaling.set(1, 1.1, 1);

  // Narrow neck
  const neck = add(
    MeshBuilder.CreateCylinder(
      "bpNeck",
      { height: 0.3, diameterTop: 0.16, diameterBottom: 0.22, tessellation: 12 },
      scene,
    ),
    glass,
  );
  neck.position.y = 0.78;

  // Cork
  const corkMesh = add(
    MeshBuilder.CreateCylinder(
      "bpCork",
      { height: 0.15, diameterTop: 0.14, diameterBottom: 0.18, tessellation: 12 },
      scene,
    ),
    cork,
  );
  corkMesh.position.y = 0.97;

  // Lightning rune ring around the shoulder of the bottle (thin torus)
  const runeRing = add(
    MeshBuilder.CreateTorus(
      "bpRune",
      { diameter: 0.56, thickness: 0.04, tessellation: 24 },
      scene,
    ),
    rune,
  );
  runeRing.position.y = 0.52;
  runeRing.rotation.x = Math.PI / 2; // lay flat around the bottle equator

  // Second smaller ring at the neck base (crackling energy collar)
  const runeNeck = add(
    MeshBuilder.CreateTorus(
      "bpRuneNeck",
      { diameter: 0.26, thickness: 0.03, tessellation: 20 },
      scene,
    ),
    rune,
  );
  runeNeck.position.y = 0.68;
  runeNeck.rotation.x = Math.PI / 2;

  root.scaling.setAll(MODEL_SCALE);

  return {
    root,
    meshes,
    dispose: () => {
      root.dispose();
      for (const m of mats) m.dispose();
    },
  };
}
