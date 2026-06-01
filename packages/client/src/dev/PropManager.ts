import {
  Scene,
  ShadowGenerator,
  AbstractMesh,
  TransformNode,
  Nullable,
} from "@babylonjs/core";
import { PropDef, LoadedProp, importModel, applyTransform } from "../scene/props";

/** A prop that has been placed into the world and registered for editing. `def`
 *  is the live, mutable manifest entry the inspector edits; `loaded` is its glTF
 *  instance. */
export interface PlacedProp {
  id: string;
  def: PropDef;
  loaded: LoadedProp;
}

/**
 * Owns every imported prop in the world: loads them from `props.json`, keeps them
 * in a registry keyed by a stable id, tags their meshes so the editor can select
 * them, and applies live transform/removal edits. Persistence (writing back to
 * `props.json` via the Vite dev endpoints) is layered on in later phases; this
 * class is the scene-side source of truth.
 */
export class PropManager {
  private props = new Map<string, PlacedProp>();
  private pickable = false;

  constructor(
    private scene: Scene,
    private shadow: ShadowGenerator,
  ) {}

  /** Fetch the manifest and place every persisted prop (replaces `loadProps`). */
  async loadAll(): Promise<void> {
    let defs: PropDef[] = [];
    try {
      const res = await fetch("/props.json", { cache: "no-store" });
      if (res.ok) defs = await res.json();
    } catch {
      return; // no manifest / dev endpoint — nothing imported yet
    }
    await Promise.all(
      defs.map((d) =>
        this.place(d).catch((e) => console.warn(`[props] failed to place ${d.model}`, e)),
      ),
    );
  }

  /** Load one prop into the world and register it. Returns the existing entry if
   *  this id is already placed (idempotent). */
  async place(def: PropDef): Promise<PlacedProp> {
    const id = def.id ?? def.model; // endpoint assigns ids; legacy entries key by model url
    const existing = this.props.get(id);
    if (existing) return existing;
    const loaded = await importModel(this.scene, def.model);
    applyTransform(loaded, def.scale, def.x, def.z, def.rotationY || 0);
    // Cast + receive real shadows exactly like characters and trees: each mesh
    // throws its true silhouette into the sun's shadow map (no box proxy), and
    // other objects' shadows fall on it. Shadows track the live transform, so
    // moving/scaling the prop updates them automatically.
    for (const m of loaded.meshes) {
      this.shadow.addShadowCaster(m);
      m.receiveShadows = true;
    }
    const placed: PlacedProp = { id, def: { ...def, id }, loaded };
    this.tag(placed);
    this.props.set(id, placed);
    return placed;
  }

  /** Tag the holder + meshes with the prop id so selection can resolve them, and
   *  apply the current pickable state. */
  private tag(p: PlacedProp) {
    const md = { propId: p.id, kind: "prop" };
    (p.loaded.root as TransformNode).metadata = md;
    for (const m of p.loaded.meshes) {
      m.metadata = md;
      m.isPickable = this.pickable;
    }
  }

  /** Re-apply the (mutated) def's transform. Real-mesh shadows follow the live
   *  transform automatically, so there's nothing else to refresh.
   *  Call after editing def.scale / x / z / rotationY. */
  applyDef(id: string) {
    const p = this.props.get(id);
    if (!p) return;
    applyTransform(p.loaded, p.def.scale, p.def.x, p.def.z, p.def.rotationY || 0);
  }

  /** Drop a prop's meshes from the shadow map and dispose them; forget it. */
  remove(id: string) {
    const p = this.props.get(id);
    if (!p) return;
    for (const m of p.loaded.meshes) this.shadow.removeShadowCaster(m);
    p.loaded.dispose();
    this.props.delete(id);
  }

  get(id: string): PlacedProp | undefined {
    return this.props.get(id);
  }

  all(): PlacedProp[] {
    return [...this.props.values()];
  }

  /** Walk a picked mesh up its parent chain to the owning prop, or null. */
  resolve(mesh: Nullable<AbstractMesh>): PlacedProp | null {
    let node: Nullable<TransformNode> = mesh ?? null;
    while (node) {
      const md = node.metadata as { propId?: string } | null;
      if (md?.propId) return this.props.get(md.propId) ?? null;
      node = node.parent as Nullable<TransformNode>;
    }
    return null;
  }

  /** Persist the (edited) def back to props.json via the dev endpoint. */
  async persistUpdate(id: string): Promise<void> {
    const p = this.props.get(id);
    if (!p) return;
    const d = p.def;
    await fetch("/__props/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: d.id ?? d.model,
        name: d.name,
        x: d.x,
        z: d.z,
        scale: d.scale,
        rotationY: d.rotationY,
        collisionRadius: d.collisionRadius ?? 0, // 0 ⇒ endpoint drops the key (not concrete)
      }),
    }).catch((e) => console.warn("[props] update failed", e));
  }

  /** Remove a prop from the manifest (+ its model file) and from the world. */
  async persistDelete(id: string): Promise<void> {
    const p = this.props.get(id);
    const key = p?.def.id ?? p?.def.model ?? id;
    this.remove(id);
    await fetch("/__props/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: key, deleteFile: true }),
    }).catch((e) => console.warn("[props] delete failed", e));
  }

  /** Toggle pickability for every prop mesh — on while editing, off during play
   *  (props are click-through in normal play, like before). */
  setPickable(on: boolean) {
    this.pickable = on;
    for (const p of this.props.values())
      for (const m of p.loaded.meshes) m.isPickable = on;
  }
}
