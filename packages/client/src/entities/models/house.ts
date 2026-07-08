import {
  type Scene,
  SceneLoader,
  PBRMaterial,
  type AbstractMesh,
  Vector3,
} from "@babylonjs/core";
import "@babylonjs/loaders/glTF";
import type { ShadowHandle, ShadowRuntime } from "../../scene/contactShadows";

const HOUSE_URL = "/models/house.glb";
const HOUSE_SIZE = 11; // old La Crypta objective footprint size, in world units

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
  /** Collapse the house: hide the model and its contact shadow. */
  hide(): void;
  /** Rebuild the house: re-show the model and its contact shadow (after a wipe). */
  show(): void;
  /** Toggle picking on the house model geometry. */
  setPickable(on: boolean): void;
  /** Move the visible model to the synced house centre. */
  moveTo(x: number, z: number): void;
  /** Apply the full Dev Mode transform to the visible model. */
  transformTo(x: number, z: number, rotY: number, scale: number): void;
}

/**
 * Load the Viking house once and stand it at the map origin,
 * scaled to the old objective footprint size. It casts + receives shadows like the
 * rest of the world. Loaded in the background (large model) so it just pops in.
 * Returns a handle to hide it (when the server says it's been destroyed), or null.
 */
export async function loadHouse(
  scene: Scene,
  shadows: ShadowRuntime,
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
      // Contact shadows handle visible grounding; keep the receiver flag harmlessly
      // true for materials that already expect it.
      mesh.receiveShadows = true;
    }

    // Scale so the larger horizontal dimension matches the objective footprint.
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

    // Contact shadow: the real house is far too heavy for a live shadow map. A soft
    // projected footprint grounds it visually without rendering the GLB from the sun.
    b = hierarchyBounds(r.meshes);
    const contactShadow: ShadowHandle = shadows.addProjected({
      name: "houseContactShadow",
      shape: "structure",
      root,
      casters: r.meshes,
      x: root.position.x,
      z: root.position.z,
      width: Math.max(4, b.max.x - b.min.x),
      depth: Math.max(4, b.max.z - b.min.z),
      opacity: 0.42,
    });
    const rootBaseX = root.position.x;
    const rootBaseZ = root.position.z;
    const rootBaseScale = root.scaling.clone();
    const transformTo = (x: number, z: number, rotY: number, scaleMult: number) => {
      const s = Number.isFinite(scaleMult) ? Math.max(0.05, scaleMult) : 1;
      root.position.x = rootBaseX + x;
      root.position.z = rootBaseZ + z;
      root.rotation.y = rotY;
      root.scaling.set(rootBaseScale.x * s, rootBaseScale.y * s, rootBaseScale.z * s);
      contactShadow.setPosition(root.position.x, root.position.z, 0);
      contactShadow.refresh();
    };
    const moveTo = (x: number, z: number) => transformTo(x, z, 0, 1);

    console.log(`[assets] placed house at origin (footprint ${HOUSE_SIZE}u) + contact shadow`);

    return {
      hide: () => {
        root.setEnabled(false); // collapse: hide the whole model...
        contactShadow.setEnabled(false);
      },
      show: () => {
        root.setEnabled(true); // rebuilt after a wipe: show it again...
        contactShadow.setEnabled(true);
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
