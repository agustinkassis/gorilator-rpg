import { Scene, ShadowGenerator, AbstractMesh, TransformNode, Nullable } from "@babylonjs/core";
import { AnimState } from "@rpg/shared";
import { assembleCharacter, CharacterDef, AssembledCharacter } from "../entities/characterDef";

export interface Placement {
  id: string;
  defId: string;
  x: number;
  z: number;
  rotationY: number;
  scale?: number;
}

/** A placed character instance in the world. */
export interface PlacedCharacter {
  placement: Placement;
  def: CharacterDef;
  built: AssembledCharacter;
}

/**
 * Owns custom characters placed in the world (from npcs.json): assembles each via
 * `assembleCharacter`, stands it at its placement playing IDLE, and (in Dev Mode)
 * lets it be selected / dragged / deleted. Runtime-decorative for now — Phase 2
 * gives them server-driven behavior. Mirrors PropManager.
 */
export class CharacterManager {
  private chars = new Map<string, PlacedCharacter>();
  private defs = new Map<string, CharacterDef>();
  private pickable = false;

  constructor(
    private scene: Scene,
    private shadow: ShadowGenerator,
  ) {}

  /** Fetch the def library + placements and instantiate every placed character. */
  async loadAll(opts: { placements?: boolean } = {}): Promise<void> {
    try {
      const [defs, placements] = await Promise.all([
        fetch("/__char/defs", { cache: "no-store" }).then((r) => (r.ok ? r.json() : [])),
        opts.placements === false
          ? Promise.resolve([])
          : fetch("/__char/placements", { cache: "no-store" }).then((r) => (r.ok ? r.json() : [])),
      ]);
      for (const d of defs as CharacterDef[]) this.defs.set(d.id, d);
      await Promise.all(
        (placements as Placement[]).map((p) =>
          this.spawn(p).catch((e) => console.warn(`[char] failed to place ${p.defId}`, e)),
        ),
      );
    } catch {
      return; // no dev endpoint / manifest — nothing placed
    }
  }

  /** Place a character live (called by the importer's "Add to game"). */
  async placeNew(
    def: CharacterDef,
    placement: { id: string; x: number; z: number; rotationY: number; scale?: number },
  ): Promise<void> {
    this.defs.set(def.id, def);
    await this.spawn({ ...placement, defId: def.id });
  }

  private async spawn(placement: Placement): Promise<void> {
    if (this.chars.has(placement.id)) return;
    const def = this.defs.get(placement.defId);
    if (!def) return;
    const built = await assembleCharacter(this.scene, def);
    built.root.position.x = placement.x;
    built.root.position.z = placement.z;
    built.root.scaling.setAll((def.scale || 1) * (placement.scale ?? 1));
    built.root.rotation.y = (def.yaw || 0) + (placement.rotationY || 0);
    const md = { charPlacementId: placement.id, kind: "character" };
    (built.root as TransformNode).metadata = md;
    for (const m of built.meshes) {
      m.metadata = md;
      m.isPickable = this.pickable;
      this.shadow.addShadowCaster(m); // cast + receive real shadows like every character
    }
    built.controller.play(AnimState.IDLE); // idle loops on the scene clock
    this.chars.set(placement.id, { placement, def, built });
  }

  /** Relocate a placed character (drag/inspector) + persist. */
  move(id: string, x: number, z: number) {
    const c = this.chars.get(id);
    if (!c) return;
    c.placement.x = x;
    c.placement.z = z;
    c.built.root.position.x = x;
    c.built.root.position.z = z;
  }

  setRotation(id: string, rotationY: number) {
    const c = this.chars.get(id);
    if (!c) return;
    c.placement.rotationY = rotationY;
    c.built.root.rotation.y = (c.def.yaw || 0) + rotationY;
  }

  setScale(id: string, scale: number) {
    const c = this.chars.get(id);
    if (!c) return;
    c.placement.scale = Math.max(0.05, Math.min(40, Number(scale) || 1));
    c.built.root.scaling.setAll((c.def.scale || 1) * c.placement.scale);
  }

  async persist(id: string): Promise<void> {
    const c = this.chars.get(id);
    if (!c) return;
    await fetch("/__char/placement-update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, x: c.placement.x, z: c.placement.z, rotationY: c.placement.rotationY, scale: c.placement.scale ?? 1 }),
    }).catch((e) => console.warn("[char] placement-update failed", e));
  }

  async remove(id: string): Promise<void> {
    const c = this.chars.get(id);
    if (!c) return;
    for (const m of c.built.meshes) this.shadow.removeShadowCaster(m);
    c.built.dispose();
    this.chars.delete(id);
    await fetch("/__char/placement-delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    }).catch((e) => console.warn("[char] placement-delete failed", e));
  }

  get(id: string): PlacedCharacter | undefined {
    return this.chars.get(id);
  }

  /** Walk a picked mesh up to its owning placed character, or null. */
  resolve(mesh: Nullable<AbstractMesh>): PlacedCharacter | null {
    let node: Nullable<TransformNode> = mesh ?? null;
    while (node) {
      const md = node.metadata as { charPlacementId?: string } | null;
      if (md?.charPlacementId) return this.chars.get(md.charPlacementId) ?? null;
      node = node.parent as Nullable<TransformNode>;
    }
    return null;
  }

  /** Cheap Dev Mode ground-footprint pick used instead of ray-picking character meshes. */
  pickAt(point: { x: number; z: number }): PlacedCharacter | null {
    let best: PlacedCharacter | null = null;
    let bestD2 = Infinity;
    const radius = 1.4;
    for (const c of this.chars.values()) {
      const d2 = (point.x - c.placement.x) ** 2 + (point.z - c.placement.z) ** 2;
      if (d2 <= radius * radius && d2 < bestD2) {
        best = c;
        bestD2 = d2;
      }
    }
    return best;
  }

  /** Toggle pickability for every placed character (on while editing). */
  setPickable(on: boolean) {
    this.pickable = on;
    for (const c of this.chars.values()) for (const m of c.built.meshes) m.isPickable = on;
  }
}
