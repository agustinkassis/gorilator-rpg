import {
  type Scene,
  type AssetContainer,
  SceneLoader,
  TransformNode,
  type AbstractMesh,
  type AnimationGroup,
  PBRMaterial,
} from "@babylonjs/core";
import "@babylonjs/loaders/glTF";
import type { AnimState } from "@rpg/shared";
import { AnimationController, type AnimGroups, type AnimSpeeds } from "./AnimationController";
import { bounds } from "../scene/props";

/**
 * A custom character imported from a Meshy zip: a base skinned mesh plus several
 * per-animation glbs (each a full skinned mesh + one AnimationGroup) that get
 * retargeted onto the base skeleton — the same cross-glb path `throw.glb` already
 * uses on the player rig. `CharacterDef` is the reusable template persisted in
 * characters.json; `assembleCharacter` instantiates it (mesh + mapped, retargeted
 * clips) into any scene.
 */

/** Action slots a clip can be mapped to (string values match AnimState). */
export type CharAction = "IDLE" | "WALK" | "ATTACK" | "THROW" | "HIT" | "DEAD";

export interface CharAnim {
  file: string; // url under /models
  speed?: number; // playback multiplier
  yawFix?: number; // radians, per-clip facing correction
}

export interface CharacterDef {
  id: string;
  name: string;
  category?: string;
  baseModel: string; // url under /models
  anims: Partial<Record<CharAction, CharAnim>>;
  yaw: number; // base orientation (radians)
  scale: number;
  stats?: Record<string, number>; // default placeholders (driven by behaviors in a later phase)
}

export interface AssembledCharacter {
  root: TransformNode; // holder, already scaled / yawed / grounded
  meshes: AbstractMesh[];
  groups: AnimGroups; // action → retargeted AnimationGroup
  yawFix: Partial<Record<AnimState, number>>;
  controller: AnimationController;
  dispose: () => void;
}

// Per-scene container cache. Containers are kept alive because each retargeted
// clip's clone references the source container's bones (disposing it breaks the
// animation). Keyed by scene so the editor's preview scene and the game scene
// don't cross-contaminate.
const sceneCaches = new WeakMap<Scene, Map<string, Promise<AssetContainer>>>();
function loadContainer(scene: Scene, url: string): Promise<AssetContainer> {
  let m = sceneCaches.get(scene);
  if (!m) {
    m = new Map();
    sceneCaches.set(scene, m);
  }
  let p = m.get(url);
  if (!p) {
    p = SceneLoader.LoadAssetContainerAsync("", url, scene);
    m.set(url, p);
  }
  return p;
}

/** Matte a Meshy PBR material so it reads under the scene's lights (no IBL) and
 *  participates in the shadow map — same treatment as the player rig + props. */
function matte(mesh: AbstractMesh) {
  const mat = mesh.material;
  if (mat instanceof PBRMaterial) {
    mat.metallic = 0;
    mat.roughness = 0.85;
    mat.transparencyMode = PBRMaterial.PBRMATERIAL_OPAQUE;
    mat.backFaceCulling = true;
    mat.twoSidedLighting = false;
  }
}

/**
 * Instantiate a CharacterDef into `scene`: clone the base rig under a holder, then
 * for each mapped action load its animation glb and retarget its AnimationGroup
 * onto this instance's bones (by name). Returns the holder + an AnimationController.
 */
export async function assembleCharacter(scene: Scene, def: CharacterDef): Promise<AssembledCharacter> {
  const baseC = await loadContainer(scene, def.baseModel);
  // Use full mesh clones, not InstancedMesh. Instanced meshes share source-mesh
  // overlay flags, so a hit flash on one imported character would flash every
  // copy of that same character definition.
  const inst = baseC.instantiateModelsToScene((n) => n, false, {
    doNotInstantiate: true,
  });
  inst.animationGroups.forEach((g) => g.stop()); // ignore any clips baked into the base

  const holder = new TransformNode(`char_${def.id}_${Date.now()}`, scene);
  for (const r of inst.rootNodes) r.parent = holder;
  const meshes = holder.getChildMeshes(false);
  for (const m of meshes) {
    matte(m);
    m.receiveShadows = true;
    m.isPickable = false;
  }

  // Map this instance's bones by name, then retarget each mapped clip onto them.
  const boneByName = new Map<string, TransformNode>();
  for (const n of holder.getDescendants(false)) {
    if (n instanceof TransformNode) boneByName.set(n.name, n);
  }
  const groups: AnimGroups = {};
  const speeds: AnimSpeeds = {};
  const yawFix: Partial<Record<AnimState, number>> = {};
  const gRec = groups as Record<string, AnimationGroup>;
  const sRec = speeds as Record<string, number>;
  const yRec = yawFix as Record<string, number>;
  for (const action of Object.keys(def.anims) as CharAction[]) {
    const a = def.anims[action];
    if (!a?.file) continue;
    try {
      const animC = await loadContainer(scene, a.file);
      const template = animC.animationGroups[0];
      if (!template) continue;
      template.stop();
      const clip = template.clone(`${def.id}_${action}_${holder.uniqueId}`, (old) => {
        const name = (old as { name?: string } | null)?.name;
        return (name && boneByName.get(name)) || old;
      });
      clip.stop();
      gRec[action] = clip;
      if (a.speed) sRec[action] = a.speed;
      if (a.yawFix) yRec[action] = a.yawFix;
    } catch (e) {
      console.warn(`[char] failed to load anim ${a.file} for ${action}`, e);
    }
  }

  // Orientation + scale, then sit the feet on the ground (y=0).
  holder.scaling.setAll(def.scale || 1);
  holder.rotation.y = def.yaw || 0;
  holder.computeWorldMatrix(true);
  const b = bounds(meshes);
  if (Number.isFinite(b.min.y)) holder.position.y -= b.min.y;
  holder.computeWorldMatrix(true);

  const controller = new AnimationController(groups, speeds);
  return {
    root: holder,
    meshes,
    groups,
    yawFix,
    controller,
    dispose: () => {
      for (const g of Object.values(groups)) g?.dispose();
      inst.dispose();
      holder.dispose();
    },
  };
}
