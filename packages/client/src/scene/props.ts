import {
  Scene,
  SceneLoader,
  PBRMaterial,
  AbstractMesh,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import "@babylonjs/loaders/glTF";
import type { ShadowHandle, ShadowRuntime } from "./contactShadows";

export interface PropDef {
  id?: string; // stable handle for editing/deleting (assigned by the importer endpoint)
  name: string;
  model: string; // url under /models
  x: number;
  z: number;
  scale: number; // target footprint (largest horizontal dimension, world units)
  rotationY: number; // radians
  collisionRadius?: number; // present + > 0 ⇒ concrete (server adds collision)
}

/** A loaded, transformable prop instance (the glTF lives under `root`, a plain
 *  holder node so scale/rotation stay clean). */
export interface LoadedProp {
  root: TransformNode;
  meshes: AbstractMesh[];
  nativeFootprint: number; // largest horizontal size at scale 1
  dispose: () => void;
}

export function bounds(meshes: AbstractMesh[]): { min: Vector3; max: Vector3 } {
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

/** A glb just written under public/ can momentarily resolve to Vite's SPA fallback
 *  (index.html is returned for the not-yet-served path), so Babylon parses "<!do…"
 *  and throws "Unexpected magic". This signature spots that HTML-instead-of-binary
 *  case (vs a genuine 404/network error, which we don't want to sit and retry on). */
function looksLikeNotServedYet(e: unknown): boolean {
  const m = String((e as { message?: string })?.message ?? e);
  return /magic|unexpected token|<!doctype|<html|not valid json/i.test(m);
}

/** Poll a model URL until the dev server actually serves the binary (not its HTML
 *  SPA fallback), so a load that raced a fresh upload can be retried. Cheap: a
 *  1-byte ranged request, judged by content-type; the body is cancelled unread. */
async function waitUntilServed(url: string, tries = 8, gapMs = 200): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { Range: "bytes=0-0" }, cache: "no-store" });
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      const served = res.ok && !!ct && !ct.includes("html");
      try {
        await res.body?.cancel();
      } catch {
        /* body already consumed/absent */
      }
      if (served) return true;
    } catch {
      /* dev server hiccup — keep polling */
    }
    await new Promise((r) => setTimeout(r, gapMs));
  }
  return false;
}

/** Import the meshes, transparently recovering from the fresh-upload race: if the
 *  first load fails because the file isn't being served yet, wait for it + retry. */
async function loadMeshes(scene: Scene, url: string) {
  try {
    // Force the glTF-binary loader. An uploaded blob: URL has no ".glb" extension for
    // Babylon to sniff, so without this hint it tries to JSON-parse the binary → fails.
    return await SceneLoader.ImportMeshAsync("", url, "", scene, null, ".glb");
  } catch (e) {
    if (url.startsWith("blob:") || !looksLikeNotServedYet(e) || !(await waitUntilServed(url))) throw e;
    return await SceneLoader.ImportMeshAsync("", url, "", scene, null, ".glb");
  }
}

/** Load a glb under a holder node, matte + opaque its materials. */
export async function importModel(scene: Scene, url: string): Promise<LoadedProp> {
  const r = await loadMeshes(scene, url);
  const gltfRoot = (r.meshes.find((m) => !m.parent) ?? r.meshes[0]) as AbstractMesh;
  const holder = new TransformNode("propHolder", scene);
  gltfRoot.parent = holder;
  for (const mesh of r.meshes) {
    const mat = mesh.material;
    if (mat instanceof PBRMaterial) {
      mat.metallic = 0;
      mat.roughness = 0.9;
      mat.transparencyMode = PBRMaterial.PBRMATERIAL_OPAQUE;
      mat.backFaceCulling = true;
      mat.twoSidedLighting = false;
    }
    mesh.receiveShadows = true;
    mesh.isPickable = false;
  }
  holder.computeWorldMatrix(true);
  const b = bounds(r.meshes);
  const nativeFootprint = Math.max(0.001, Math.max(b.max.x - b.min.x, b.max.z - b.min.z));
  return {
    root: holder,
    meshes: r.meshes,
    nativeFootprint,
    dispose: () => {
      r.meshes.forEach((m) => m.dispose());
      holder.dispose();
    },
  };
}

/** Scale a prop to a target footprint (world units), face it, sit it on the ground.
 *  Absolute — safe to call repeatedly (the importer does, live). */
export function applyTransform(
  p: LoadedProp,
  footprint: number,
  x: number,
  z: number,
  rotationY: number,
): void {
  const k = footprint / p.nativeFootprint;
  p.root.scaling.set(k, k, k);
  p.root.rotation.set(0, rotationY, 0);
  p.root.position.set(x, 0, z);
  p.root.computeWorldMatrix(true);
  const b = bounds(p.meshes);
  p.root.position.x += x - (b.min.x + b.max.x) / 2;
  p.root.position.z += z - (b.min.z + b.max.z) / 2;
  p.root.position.y += -b.min.y; // base on the ground
  p.root.computeWorldMatrix(true);
}

/** Soft projected prop shadow. Returns the handle so callers can reposition/dispose it. */
export function addPropContactShadow(shadows: ShadowRuntime, p: LoadedProp, name: string): ShadowHandle {
  const b = bounds(p.meshes);
  return shadows.addWorldObject({
    name: `propShadow_${name}`,
    shape: "structure",
    root: p.root,
    casters: p.meshes,
    x: p.root.position.x,
    z: p.root.position.z,
    width: Math.max(0.8, b.max.x - b.min.x),
    depth: Math.max(0.8, b.max.z - b.min.z),
    opacity: 0.5,
  });
}

/** Fetch the manifest and place every persisted prop into the world. */
export async function loadProps(scene: Scene, shadows: ShadowRuntime): Promise<void> {
  let defs: PropDef[] = [];
  try {
    const res = await fetch("/props.json", { cache: "no-store" });
    if (res.ok) defs = await res.json();
  } catch {
    return;
  }
  for (const d of defs) {
    importModel(scene, d.model)
      .then((p) => {
        applyTransform(p, d.scale, d.x, d.z, d.rotationY || 0);
        addPropContactShadow(shadows, p, d.name || "prop");
      })
      .catch((e) => console.warn(`[props] failed to place ${d.model}`, e));
  }
}
