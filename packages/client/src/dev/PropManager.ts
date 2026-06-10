import type {
  Scene,
  AbstractMesh,
  TransformNode,
  Nullable,
} from "@babylonjs/core";
import { type PropDef, type LoadedProp, importModel, applyTransform, bounds } from "../scene/props";
import type { ShadowHandle, ShadowRuntime } from "../scene/contactShadows";

/** A prop that has been placed into the world and registered for editing. `def`
 *  is the live, mutable manifest entry the inspector edits; `loaded` is its glTF
 *  instance. */
export interface PlacedProp {
  id: string;
  def: PropDef;
  loaded: LoadedProp;
  shadow: ShadowHandle;
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
    private shadows: ShadowRuntime,
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
    this.shadows.registerMeshes(loaded.meshes, { cast: false, receive: true });
    const shadow = this.createShadow(loaded, def, id);
    const placed: PlacedProp = { id, def: { ...def, id }, loaded, shadow };
    this.tag(placed);
    this.props.set(id, placed);
    return placed;
  }

  private createShadow(loaded: LoadedProp, def: PropDef, id: string): ShadowHandle {
    const b = bounds(loaded.meshes);
    return this.shadows.addWorldObject({
      name: `shadow_prop_${id}`,
      shape: "structure",
      root: loaded.root,
      casters: loaded.meshes,
      x: loaded.root.position.x,
      z: loaded.root.position.z,
      width: Math.max(0.8, def.collisionRadius ? def.collisionRadius * 2 : b.max.x - b.min.x),
      depth: Math.max(0.8, def.collisionRadius ? def.collisionRadius * 2 : b.max.z - b.min.z),
      opacity: def.collisionRadius && def.collisionRadius > 0 ? 0.52 : 0.42,
    });
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

  /** Re-apply the (mutated) def's transform and refresh its projected shadow. */
  applyDef(id: string) {
    const p = this.props.get(id);
    if (!p) return;
    applyTransform(p.loaded, p.def.scale, p.def.x, p.def.z, p.def.rotationY || 0);
    p.shadow.dispose();
    p.shadow = this.createShadow(p.loaded, p.def, id);
    this.shadows.refreshStaticShadows();
  }

  /** Dispose a prop and its projected shadow; forget it. */
  remove(id: string) {
    const p = this.props.get(id);
    if (!p) return;
    p.shadow.dispose();
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

  /** Cheap Dev Mode ground-footprint pick used instead of ray-picking prop meshes. */
  pickAt(point: { x: number; z: number }): PlacedProp | null {
    let best: PlacedProp | null = null;
    let bestD2 = Infinity;
    for (const p of this.props.values()) {
      const radius = Math.max(0.75, p.def.collisionRadius && p.def.collisionRadius > 0 ? p.def.collisionRadius : p.def.scale / 2);
      const d2 = (point.x - p.def.x) ** 2 + (point.z - p.def.z) ** 2;
      if (d2 <= radius * radius && d2 < bestD2) {
        best = p;
        bestD2 = d2;
      }
    }
    return best;
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
