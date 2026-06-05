import {
  GameState,
  AnimState,
  WORLD_SIZE,
  Tree,
  Rock,
  Potion,
  Log,
  Stone,
  Banana,
  House,
  Enemy,
  TREE_HP,
  TREE_ARMOR,
  ROCK_HP,
  ROCK_ARMOR,
  HOUSE_HP,
  HOUSE_COLLISION_RADIUS,
  BrainId,
} from "@rpg/shared";
import { entityHp } from "./entityFeatures";
import { configureEnemy } from "./enemyConfig";
import { safeItemId, spawnCustomItem } from "./items";

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
 * the live Rock entities (see GameRoom). Crates remain static for now.
 */

type EditableEntity = { x: number; z: number; rotY?: number; scale?: number };
type EditableMap = { get(id: string): EditableEntity | undefined; delete(id: string): boolean };

/** The synced state map a dev-editable `kind` lives in (or null if not editable). */
function mapFor(state: GameState, kind: string): EditableMap | null {
  switch (kind) {
    case "tree":
      return state.trees as unknown as EditableMap;
    case "potion":
      return state.potions as unknown as EditableMap;
    case "log":
      return state.logs as unknown as EditableMap;
    case "stone":
      return state.stones as unknown as EditableMap;
    case "banana":
      return state.bananas as unknown as EditableMap;
    case "item":
      return state.items as unknown as EditableMap;
    case "enemy":
      return state.enemies as unknown as EditableMap;
    case "rock":
      return state.rocks as unknown as EditableMap; // collision is refreshed by the room
    case "house":
      return state.houses as unknown as EditableMap;
    default:
      return null; // player/static handled elsewhere
  }
}

const clamp = (v: number) => Math.max(-WORLD_SIZE, Math.min(WORLD_SIZE, v));
const safeId = (kind: string, id: string) =>
  id && id.length <= 80 ? id : `dev-${kind}-${Date.now().toString(36)}`;
const normalizedScale = (value: number | boolean | string) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0.05, Math.min(40, n)) : 1;
};

function setCommonTransform(obj: EditableEntity | undefined, field: string, value: number | boolean | string): boolean {
  if (!obj) return false;
  if (field === "rotY") {
    const n = Number(value);
    if (!Number.isFinite(n)) return false;
    obj.rotY = n;
    return true;
  }
  if (field === "scale") {
    obj.scale = normalizedScale(value);
    return true;
  }
  return false;
}

export function devSpawn(
  state: GameState,
  kind: string,
  id: string,
  x: number,
  z: number,
): { kind: string; id: string } | null {
  const px = clamp(Number(x) || 0);
  const pz = clamp(Number(z) || 0);
  const k = String(kind || "").trim().toLowerCase();
  const eid = safeId(k, id);

  if (k === "item" || k.startsWith("item:")) {
    const itemId = safeItemId(k.startsWith("item:") ? k.slice(5) : id);
    const e = spawnCustomItem(state, itemId, px, pz, eid);
    return e ? { kind: "item", id: e.id } : null;
  }

  switch (k) {
    case "tree": {
      if (state.trees.has(eid)) return null;
      const e = new Tree();
      e.id = eid;
      e.x = px;
      e.z = pz;
      e.maxHp = entityHp("tree", eid, undefined, TREE_HP);
      e.hp = e.maxHp;
      e.armor = TREE_ARMOR;
      e.alive = true;
      state.trees.set(e.id, e);
      return { kind: "tree", id: e.id };
    }
    case "rock": {
      if (state.rocks.has(eid)) return null;
      const e = new Rock();
      e.id = eid;
      e.x = px;
      e.z = pz;
      e.radius = 1.4;
      e.maxHp = entityHp("rock", eid, undefined, ROCK_HP);
      e.hp = e.maxHp;
      e.armor = ROCK_ARMOR;
      e.alive = true;
      state.rocks.set(e.id, e);
      return { kind: "rock", id: e.id };
    }
    case "potion":
    case "berserker_potion": {
      if (state.potions.has(eid)) return null;
      const e = new Potion();
      e.id = eid;
      e.x = px;
      e.z = pz;
      e.kind = k;
      state.potions.set(e.id, e);
      return { kind: "potion", id: e.id };
    }
    case "log": {
      if (state.logs.has(eid)) return null;
      const e = new Log();
      e.id = eid;
      e.x = px;
      e.z = pz;
      state.logs.set(e.id, e);
      return { kind: "log", id: e.id };
    }
    case "stone": {
      if (state.stones.has(eid)) return null;
      const e = new Stone();
      e.id = eid;
      e.x = px;
      e.z = pz;
      state.stones.set(e.id, e);
      return { kind: "stone", id: e.id };
    }
    case "banana": {
      if (state.bananas.has(eid)) return null;
      const e = new Banana();
      e.id = eid;
      e.x = px;
      e.z = pz;
      state.bananas.set(e.id, e);
      return { kind: "banana", id: e.id };
    }
    case "house": {
      if (state.houses.has(eid)) return null;
      const e = new House();
      e.id = eid;
      e.x = px;
      e.z = pz;
      e.radius = HOUSE_COLLISION_RADIUS;
      e.maxHp = entityHp("house", eid, undefined, HOUSE_HP);
      e.hp = e.maxHp;
      e.alive = true;
      state.houses.set(e.id, e);
      return { kind: "house", id: e.id };
    }
    case "dummy":
    case "goblin": {
      if (state.enemies.has(eid)) return null;
      const e = new Enemy();
      e.rotY = 0;
      configureEnemy(e, { kind: k, id: eid, x: px, z: pz });
      state.enemies.set(e.id, e);
      return { kind: "enemy", id: e.id };
    }
    default:
      return null;
  }
}

/** Relocate an editable entity to a ground point. */
export function devMove(state: GameState, kind: string, id: string, x: number, z: number): boolean {
  const obj = mapFor(state, kind)?.get(id);
  if (!obj) return false;
  obj.x = clamp(x);
  obj.z = clamp(z);
  if (kind === "enemy") {
    const e = state.enemies.get(id);
    if (e) {
      e.homeX = obj.x;
      e.homeZ = obj.z;
      e.targetX = obj.x;
      e.targetZ = obj.z;
    }
  }
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
    if (setCommonTransform(t, field, value)) return true;
    if (field === "maxHp") {
      t.maxHp = Math.max(0, Number(value) || 0);
      t.hp = t.maxHp <= 0 ? 0 : Math.min(t.hp || t.maxHp, t.maxHp);
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
    if (setCommonTransform(e, field, value)) return true;
    if (field === "maxHp") {
      e.maxHp = Math.max(0, Number(value) || 0);
      e.hp = e.maxHp <= 0 ? 0 : Math.min(e.hp || e.maxHp, e.maxHp);
      return true;
    }
    if (field === "hp") {
      e.hp = Math.max(0, Math.min(e.maxHp, Number(value) || 0));
      return true;
    }
    if (field === "level") {
      e.level = Math.max(1, Math.round(Number(value) || e.level));
      return true;
    }
    if (field === "attack" || field === "armor" || field === "critChance" || field === "moveSpeed" || field === "throwPower") {
      const n = Number(value);
      if (!Number.isFinite(n)) return false;
      (e as unknown as Record<string, number>)[field] = Math.max(0, n);
      return true;
    }
    if (field === "brain") {
      const v = String(value || "") as BrainId;
      if (!["idle", "passive_patrol", "war_seeker", "attacks_home"].includes(v)) return false;
      e.brain = v;
      e.aggro = false;
      e.aiTargetId = "";
      e.targetX = e.homeX || e.x;
      e.targetZ = e.homeZ || e.z;
      e.state = v === "idle" ? AnimState.IDLE : AnimState.WALK;
      return true;
    }
    if (field === "displayName") {
      e.displayName = String(value || "").slice(0, 40);
      return true;
    }
    return false;
  }
  if (kind === "rock") {
    const r = state.rocks.get(id);
    if (!r) return false;
    if (setCommonTransform(r, field, value)) return true;
    if (field === "maxHp") {
      r.maxHp = Math.max(0, Number(value) || 0);
      r.hp = r.maxHp <= 0 ? 0 : Math.min(r.hp || r.maxHp, r.maxHp);
      return true;
    }
    if (field === "alive") {
      r.alive = !!value;
      r.hp = r.alive ? r.maxHp : 0;
      return true;
    }
    return false;
  }
  if (kind === "player") {
    const p = state.players.get(id);
    if (!p) return false;
    if (setCommonTransform(p, field, value)) return true;
    if (field === "maxHp") {
      p.maxHp = Math.max(0, Number(value) || 0);
      p.hp = p.maxHp <= 0 ? 0 : Math.min(p.hp || p.maxHp, p.maxHp);
      return true;
    }
    if (field === "hp") {
      p.hp = Math.max(0, Math.min(p.maxHp, Number(value) || 0));
      return true;
    }
    if (field === "level") {
      p.level = Math.max(1, Math.round(Number(value) || p.level));
      return true;
    }
    if (field === "attack" || field === "armor" || field === "critChance" || field === "moveSpeed" || field === "throwPower") {
      const n = Number(value);
      if (!Number.isFinite(n)) return false;
      (p as unknown as Record<string, number>)[field] = Math.max(0, n);
      return true;
    }
    return false;
  }
  if (kind === "house") {
    const h = state.houses.get(id);
    if (!h) return false;
    if (setCommonTransform(h, field, value)) return true;
    if (field === "maxHp") {
      // A structure's HP. 0 ⇒ INDESTRUCTIBLE: damage is ignored server-side
      // (combat guards on maxHp), so the home never collapses.
      const v = Math.max(0, Math.round(Number(value) || 0));
      h.maxHp = v;
      h.hp = v; // refill to the new HP (0 when indestructible)
      h.alive = true; // editing HP keeps/brings the structure standing
      return true;
    }
    if (field === "alive") {
      // Toggle La Crypta's standing state. Collapsing it (alive=false) ends the
      // realm and kicks off the next-realm countdown — handy for testing.
      h.alive = !!value;
      h.hp = h.alive ? h.maxHp : 0;
      return true;
    }
    return false;
  }
  if (kind === "structure") {
    const s = state.structures.get(id);
    if (!s) return false;
    if (setCommonTransform(s, field, value)) return true;
    if (field === "maxHp") {
      const v = Math.max(0, Math.round(Number(value) || 0));
      s.maxHp = v;
      s.hp = v; // refill to the new HP (0 = indestructible, combat reduces but never kills)
      s.alive = true;
      return true;
    }
    if (field === "alive") {
      s.alive = !!value;
      s.hp = s.alive ? s.maxHp : 0;
      return true;
    }
    return false;
  }
  const obj = mapFor(state, kind)?.get(id);
  return setCommonTransform(obj, field, value);
}
