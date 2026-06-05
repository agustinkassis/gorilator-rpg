import {
  Scene,
  SceneLoader,
  ShadowGenerator,
  PBRMaterial,
  AbstractMesh,
  Vector3,
  MeshBuilder,
} from "@babylonjs/core";
import "@babylonjs/loaders/glTF";

const HOUSE_URL = "/models/house.glb";
const HOUSE_SIZE = 11; // footprint matches the centre cross (its arms span 11 units)

/** World-space bounding box of a whole loaded hierarchy (skips empty nodes). */
function hierarchyBounds(meshes: AbstractMesh[]): { min: Vector3; max: Vector3 } {
  let min = new Vector3(Infinity, Infinity, Infinity);
  let max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const m of meshes) {
    if (!m.getTotalVertices || m.getTotalVertices() === 0) continue;
    m.computeWorldMatrix(true);
    const bb = m.getBoundingInfo().boundingBox;
    min = Vector3.Minimize(min, bb.minimumWorld);
    max = Vector3.Maximize(max, bb.maximumWorld);
  }
  return { min, max };
}

export interface HouseModel {
  /** Collapse the house: hide the model and its shadow proxy. */
  hide(): void;
  /** Rebuild the house: re-show the model and its shadow proxy (after a wipe). */
  show(): void;
  /** Toggle picking on the house model geometry. */
  setPickable(on: boolean): void;
  /** Move the visible model to the synced house centre. */
  moveTo(x: number, z: number): void;
  /** Apply the full Dev Mode transform to the visible model. */
  transformTo(x: number, z: number, rotY: number, scale: number): void;
}

/**
 * Load the Viking house once and stand it on the centre cross (map origin),
 * scaled so its footprint matches the cross. It casts + receives shadows like the
 * rest of the world. Loaded in the background (large model) so it just pops in.
 * Returns a handle to hide it (when the server says it's been destroyed), or null.
 */
export async function loadHouse(
  scene: Scene,
  shadow: ShadowGenerator,
): Promise<HouseModel | null> {
  // HEAD probe so a missing file doesn't crash the client.
  try {
    const res = await fetch(HOUSE_URL, { method: "HEAD" });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || type.includes("text/html")) {
      console.info(`[assets] ${HOUSE_URL} not present.`);
      return null;
    }
  } catch {
    return null;
  }

  try {
    const r = await SceneLoader.ImportMeshAsync("", HOUSE_URL, "", scene);
    const root = r.meshes.find((m) => !m.parent) ?? r.meshes[0];

    // Matte the PBR materials (no IBL in this scene → metallic renders black) and
    // force them OPAQUE so the house participates in the shadow map.
    for (const mesh of r.meshes) {
      const mat = mesh.material;
      if (mat instanceof PBRMaterial) {
        mat.metallic = 0;
        mat.roughness = 0.9;
        mat.transparencyMode = PBRMaterial.PBRMATERIAL_OPAQUE;
        mat.backFaceCulling = true;
        mat.twoSidedLighting = false;
      }
      // Receive shadows (cheap shader flag) but do NOT cast — this model is ~6M
      // verts, and rendering it into the shadow map every frame would be brutal.
      mesh.receiveShadows = true;
    }

    // Scale so the larger horizontal dimension matches the cross.
    let b = hierarchyBounds(r.meshes);
    const sizeX = b.max.x - b.min.x;
    const sizeZ = b.max.z - b.min.z;
    const scale = HOUSE_SIZE / Math.max(0.001, Math.max(sizeX, sizeZ));
    root.scaling.scaleInPlace(scale);
    root.computeWorldMatrix(true);

    // Re-measure, then sit it centred on the origin with its base on the ground.
    b = hierarchyBounds(r.meshes);
    root.position.x += -(b.min.x + b.max.x) / 2;
    root.position.z += -(b.min.z + b.max.z) / 2;
    root.position.y += -b.min.y;
    root.computeWorldMatrix(true);

    root.metadata = { entityId: "house-0", kind: "house" };
    root.isPickable = false;
    r.meshes.forEach((m) => {
      m.isPickable = false;
      m.metadata = { entityId: "house-0", kind: "house" };
    });

    // Shadow: the real house is ~6M verts — far too heavy to render into the shadow
    // map every frame. Instead an invisible box that matches its footprint casts a
    // clean house-shaped shadow at ~zero cost (a shadow-only mesh isn't drawn by the
    // camera, only into the shadow map).
    b = hierarchyBounds(r.meshes);
    const proxy = MeshBuilder.CreateBox(
      "houseShadowProxy",
      { width: b.max.x - b.min.x, height: b.max.y - b.min.y, depth: b.max.z - b.min.z },
      scene,
    );
    proxy.position.set((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
    proxy.isVisible = false; // not drawn by the camera...
    proxy.isPickable = false;
    shadow.addShadowCaster(proxy); // ...but it still casts a shadow

    const rootBaseX = root.position.x;
    const rootBaseZ = root.position.z;
    const rootBaseScale = root.scaling.clone();
    const proxyBaseX = proxy.position.x;
    const proxyBaseZ = proxy.position.z;
    const proxyBaseScale = proxy.scaling.clone();
    const transformTo = (x: number, z: number, rotY: number, scaleMult: number) => {
      const s = Number.isFinite(scaleMult) ? Math.max(0.05, scaleMult) : 1;
      root.position.x = rootBaseX + x;
      root.position.z = rootBaseZ + z;
      root.rotation.y = rotY;
      root.scaling.set(rootBaseScale.x * s, rootBaseScale.y * s, rootBaseScale.z * s);
      proxy.position.x = proxyBaseX + x;
      proxy.position.z = proxyBaseZ + z;
      proxy.rotation.y = rotY;
      proxy.scaling.set(proxyBaseScale.x * s, proxyBaseScale.y * s, proxyBaseScale.z * s);
    };
    const moveTo = (x: number, z: number) => transformTo(x, z, 0, 1);

    console.log(`[assets] placed house at origin (footprint ${HOUSE_SIZE}u) + shadow proxy`);

    return {
      hide: () => {
        root.setEnabled(false); // collapse: hide the whole model...
        proxy.setEnabled(false);
        shadow.removeShadowCaster(proxy); // ...and stop it casting a shadow
      },
      show: () => {
        root.setEnabled(true); // rebuilt after a wipe: show it again...
        proxy.setEnabled(true);
        shadow.addShadowCaster(proxy); // ...and resume its shadow
      },
      setPickable: (on: boolean) => {
        root.isPickable = on;
        for (const mesh of r.meshes) mesh.isPickable = on;
      },
      moveTo,
      transformTo,
    };
  } catch (e) {
    console.warn(`[assets] failed to load ${HOUSE_URL}`, e);
    return null;
  }
}
