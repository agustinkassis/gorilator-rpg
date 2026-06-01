import {
  Scene,
  HighlightLayer,
  Color3,
  AbstractMesh,
  Mesh,
  TransformNode,
  Nullable,
} from "@babylonjs/core";
import { PropManager } from "./PropManager";

/** A world object the editor can act on, resolved from a picked mesh. `root` is
 *  the transform that positions it; `meshes` are highlighted on selection. The
 *  per-kind editing rules live in the Inspector, keyed off `kind`. */
export interface Selectable {
  kind: string; // prop | tree | rock | potion | enemy | player | log | stone | banana
  id: string;
  root: TransformNode;
  meshes: AbstractMesh[];
}

/** Outline colour per kind (purely cosmetic). */
const COLORS: Record<string, Color3> = {
  prop: new Color3(0.4, 1, 0.55),
  tree: new Color3(0.5, 1, 0.4),
  rock: new Color3(0.6, 0.78, 1),
  potion: new Color3(1, 0.6, 0.95),
  enemy: new Color3(1, 0.55, 0.3),
  player: new Color3(1, 0.85, 0.3),
};

const keyOf = (s: Selectable | null) => (s ? `${s.kind}:${s.id}` : "");

/**
 * Turns a picked mesh into a selectable world object and draws a glow outline on
 * the current selection. Props come from the PropManager registry; every other
 * world object is found by walking up the picked mesh's parents to the node that
 * carries an `entityId` (set by Game when it spawns synced entities).
 */
export class SelectionManager {
  private hl: HighlightLayer;
  private current: Selectable | null = null;

  constructor(
    scene: Scene,
    private propManager: PropManager,
  ) {
    this.hl = new HighlightLayer("devSelect", scene);
    this.hl.innerGlow = false;
    this.hl.outerGlow = true;
  }

  get selected(): Selectable | null {
    return this.current;
  }

  /** Resolve a picked mesh to a selectable, or null if it's bare ground/decoration. */
  resolve(mesh: Nullable<AbstractMesh>): Selectable | null {
    const prop = this.propManager.resolve(mesh);
    if (prop) {
      return { kind: "prop", id: prop.id, root: prop.loaded.root, meshes: prop.loaded.meshes };
    }
    let node: Nullable<TransformNode> = mesh ?? null;
    while (node) {
      const md = node.metadata as { entityId?: string; kind?: string } | null;
      if (md?.entityId) {
        const meshes = node.getChildMeshes ? node.getChildMeshes(false) : [];
        return { kind: md.kind ?? "", id: md.entityId, root: node, meshes };
      }
      node = node.parent as Nullable<TransformNode>;
    }
    return null;
  }

  /** Highlight a selection (or clear, with null). No-op if already selected. */
  select(s: Selectable | null) {
    if (keyOf(this.current) === keyOf(s)) {
      this.current = s; // refresh reference (meshes may have been rebuilt)
      return;
    }
    this.clear();
    this.current = s;
    if (s) {
      const color = COLORS[s.kind] ?? Color3.Yellow();
      for (const m of s.meshes) this.tryHighlight(m, color);
    }
  }

  /** Re-apply the outline to the current selection (after its meshes change). */
  refresh() {
    const s = this.current;
    this.current = null;
    this.select(s);
  }

  clear() {
    if (!this.current) return;
    for (const m of this.current.meshes) this.tryUnhighlight(m);
    this.current = null;
  }

  // HighlightLayer only accepts real Mesh geometry — instanced/empty nodes throw.
  private tryHighlight(m: AbstractMesh, color: Color3) {
    if (m instanceof Mesh && m.getTotalVertices() > 0) {
      try {
        this.hl.addMesh(m, color);
      } catch {
        /* unsupported mesh — skip */
      }
    }
  }

  private tryUnhighlight(m: AbstractMesh) {
    if (m instanceof Mesh) {
      try {
        this.hl.removeMesh(m);
      } catch {
        /* wasn't highlighted */
      }
    }
  }

  dispose() {
    this.clear();
    this.hl.dispose();
  }
}
