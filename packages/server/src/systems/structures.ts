import { type GameState, Structure, STRUCTURE_HP } from "@rpg/shared";
import { concreteProps } from "./props";
import { entityHp } from "./entityFeatures";

/**
 * Concrete props (collisionRadius>0) become destructible "structures": a synced
 * entity keyed by the prop id that carries HP, so players can attack & destroy
 * them. HP resolves per MODEL via entityFeatures, so every instance of a model
 * shares it. Re-run whenever props.json or entity-features.json changes (it
 * re-stamps HP on every instance, mirroring applyResourceConfig for trees/rocks).
 */
export function applyStructures(state: GameState): void {
  const props = concreteProps();
  const wanted = new Set(props.map((p) => p.id).filter(Boolean));

  // Drop structures whose prop is gone / no longer concrete / was destroyed.
  for (const id of [...state.structures.keys()]) {
    if (!wanted.has(id)) state.structures.delete(id);
  }

  for (const p of props) {
    if (!p.id) continue;
    const maxHp = Math.max(0, Math.round(entityHp("structure", p.id, p.model, STRUCTURE_HP)));
    let s = state.structures.get(p.id);
    if (!s) {
      s = new Structure();
      s.id = p.id;
      s.alive = true;
      s.hp = maxHp;
      state.structures.set(p.id, s);
    }
    s.x = p.x;
    s.z = p.z;
    s.rotY = p.rotY;
    s.scale = 1;
    s.radius = p.radius;
    s.modelId = p.model ?? "";
    s.maxHp = maxHp;
    // Re-stamp HP for living structures (an HP edit applies to every instance live).
    if (s.alive) s.hp = maxHp;
  }
}
