import { GameState, AnimState, WORLD_SIZE } from "@rpg/shared";

/**
 * Dev Mode world edits applied to the authoritative state at runtime. Because the
 * edited maps are synced, every client sees the change immediately (move/delete a
 * tree, retune a dummy). These are NOT persisted: trees/potions are spawned at
 * random spots each server start, so the world is regenerated per run anyway —
 * only the authored props (props.json) persist across restarts. Durable authored
 * entities are a later, manifest-driven phase.
 *
 * Rocks are supported too: a rock is also a collision circle, so after a rock
 * move/delete the room calls refreshRockObstacles() to rebuild the nav grid from
 * the live Rock entities (see GameRoom). Crates/house remain static for now.
 */

type EditableMap = { get(id: string): { x: number; z: number } | undefined; delete(id: string): boolean };

/** The synced state map a dev-editable `kind` lives in (or null if not editable). */
function mapFor(state: GameState, kind: string): EditableMap | null {
  switch (kind) {
    case "tree":
      return state.trees as unknown as EditableMap;
    case "potion":
      return state.potions as unknown as EditableMap;
    case "enemy":
      return state.enemies as unknown as EditableMap;
    case "rock":
      return state.rocks as unknown as EditableMap; // collision is refreshed by the room
    default:
      return null; // player/static handled elsewhere
  }
}

const clamp = (v: number) => Math.max(-WORLD_SIZE, Math.min(WORLD_SIZE, v));

/** Relocate an editable entity to a ground point. */
export function devMove(state: GameState, kind: string, id: string, x: number, z: number): boolean {
  const obj = mapFor(state, kind)?.get(id);
  if (!obj) return false;
  obj.x = clamp(x);
  obj.z = clamp(z);
  return true;
}

/** Remove an editable entity from the world. */
export function devDelete(state: GameState, kind: string, id: string): boolean {
  return mapFor(state, kind)?.delete(id) ?? false;
}

/** Set one editable field, with the side effects each kind needs (hp follows
 *  maxHp; toggling a tree alive heals/fells it). Unknown fields are ignored. */
export function devSet(
  state: GameState,
  kind: string,
  id: string,
  field: string,
  value: number | boolean | string,
): boolean {
  if (kind === "tree") {
    const t = state.trees.get(id);
    if (!t) return false;
    if (field === "maxHp") {
      t.maxHp = Math.max(1, Number(value) || t.maxHp);
      t.hp = Math.min(t.hp, t.maxHp);
      return true;
    }
    if (field === "alive") {
      t.alive = !!value;
      t.hp = t.alive ? t.maxHp : 0;
      if (!t.alive) t.regrowTimer = 0; // a felled-by-dev tree won't auto-regrow this instant
      return true;
    }
    return false;
  }
  if (kind === "enemy") {
    const e = state.enemies.get(id);
    if (!e) return false;
    if (field === "maxHp") {
      e.maxHp = Math.max(1, Number(value) || e.maxHp);
      e.hp = Math.min(e.hp, e.maxHp);
      return true;
    }
    return false;
  }
  return false;
}
