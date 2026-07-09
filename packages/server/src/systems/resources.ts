import {
  type GameState,
  Tree,
  Log,
  Rock,
  Stone,
  Potion,
  type ItemType,
  BOULDERS,
  TREE_COUNT,
  TREE_HP,
  TREE_ARMOR,
  TREE_REGROW_MS,
  LOG_PICKUP_RADIUS,
  PICKUP_RADIUS,
  TREE_SPAWN_RANGE,
  ROCK_HP,
  ROCK_ARMOR,
  ROCK_COLLISION_SCALE,
  BANANA_PICKUP_RADIUS,
  AUTO_GRAB_RADIUS,
  AnimState,
} from "@rpg/shared";
import { nearestFreeWorld } from "./pathfinding";
import { spawnBanana } from "./bananas";
import { dropConfig } from "./resourceDrops";
import { devTuning } from "./devTuning";
import { structureLoot } from "./structureDrops";
import { entityDrops, entityFeature, entityHp } from "./entityFeatures";
import { hasCustomItem, spawnCustomItem } from "./items";
import { rng } from "./rng";
import type { DropRuleConfig } from "@rpg/shared";

const STONE_GROUP_MIN = 2;
const STONE_GROUP_MAX = 9;

/** Spawn one collectible of `type` at (x,z), routed to the matching entity map.
 *  The drop editor sets which `type` a resource yields; custom ids route to the
 *  generic item map. Unknown types still fall back to stone. */
export function dropItem(state: GameState, type: string, x: number, z: number): void {
  const spot = nearestFreeWorld(x, z);
  const s = getSeq(state);
  switch (type) {
    case "log": {
      const e = new Log();
      e.id = `log-${s.log++}`;
      e.x = spot.x;
      e.z = spot.z;
      state.logs.set(e.id, e);
      break;
    }
    case "banana":
      spawnBanana(state, spot.x, spot.z);
      break;
    case "potion": {
      const e = new Potion();
      e.id = `potion-d${s.drop++}`;
      e.x = spot.x;
      e.z = spot.z;
      // default kind is "potion" (set by schema); no override needed
      state.potions.set(e.id, e);
      break;
    }
    case "berserker_potion": {
      const e = new Potion();
      e.id = `bpot-d${s.drop++}`;
      e.x = spot.x;
      e.z = spot.z;
      e.kind = "berserker_potion"; // signals the distinct green model + buff on collect
      state.potions.set(e.id, e);
      break;
    }
    default: {
      if (hasCustomItem(type) && spawnCustomItem(state, type, spot.x, spot.z)) break;
      const e = new Stone();
      e.id = `stone-${s.stone++}`;
      e.x = spot.x;
      e.z = spot.z;
      state.stones.set(e.id, e);
      break;
    }
  }
}

/** Drop a single health potion at (x,z) — e.g. loot from a slain goblin. */
export function dropPotion(state: GameState, x: number, z: number): void {
  dropItem(state, "potion", x, z);
}

/** Drop a single berserker potion at (x,z) — rare combat loot. */
export function dropBerserkerPotion(state: GameState, x: number, z: number): void {
  dropItem(state, "berserker_potion", x, z);
}

const dropDamage = new WeakMap<GameState, WeakMap<object, Record<string, number>>>();

function damageMap(state: GameState): WeakMap<object, Record<string, number>> {
  let map = dropDamage.get(state);
  if (!map) {
    map = new WeakMap<object, Record<string, number>>();
    dropDamage.set(state, map);
  }
  return map;
}

function legacyResourceDrops(kind: string): DropRuleConfig[] {
  if (entityFeature(kind).drops !== undefined) return entityDrops(kind);
  const cfg = dropConfig(kind);
  return [
    {
      item: cfg.item,
      quantity: Math.max(0, Math.round(cfg.amount)),
      probability: 1,
      trigger: cfg.trigger === "hit" ? "damage" : "kill",
    },
  ];
}

function treeResourceKind(tree: Tree): string {
  const kind = String(tree.kind || "").trim().toLowerCase();
  if (kind) return kind;
  return tree.id.includes("bush") ? "bush" : "tree";
}

function rulesFor(kind: string, id?: string, modelId?: string): DropRuleConfig[] {
  return entityDrops(kind, id, modelId);
}

function scatterDrop(state: GameState, item: string, x: number, z: number, radius = 1.5): void {
  const roll = rng(state, "world");
  const angle = roll() * Math.PI * 2;
  const r = 0.4 + roll() * radius;
  dropItem(state, item, x + Math.cos(angle) * r, z + Math.sin(angle) * r);
}

export function dropEntityLoot(
  state: GameState,
  kind: string,
  id: string,
  modelId: string | undefined,
  x: number,
  z: number,
  radius = 1.5,
): void {
  const mult = devTuning().dropRateMult;
  for (const rule of rulesFor(kind, id, modelId)) {
    if (rule.trigger !== "kill") continue;
    if (rng(state, "drops")() >= rule.probability * mult) continue;
    for (let i = 0; i < rule.quantity; i++) scatterDrop(state, rule.item, x, z, radius);
  }
}

export function applyDamageDrops(
  state: GameState,
  target: object,
  kind: string,
  id: string,
  modelId: string | undefined,
  x: number,
  z: number,
  totalHp: number,
  amount: number,
  radius = 1.5,
): void {
  if (totalHp <= 0 || amount <= 0) return;
  const rules = rulesFor(kind, id, modelId).filter((r) => r.trigger === "damage");
  if (!rules.length) return;
  const damage = damageMap(state);
  let rec = damage.get(target);
  if (!rec) {
    rec = {};
    damage.set(target, rec);
  }
  rules.forEach((rule, index) => {
    if (rule.quantity <= 0) return;
    const perItem = Math.max(1, totalHp) / rule.quantity;
    const key = `${kind}:${id}:${index}:${rule.item}`;
    rec![key] = (rec![key] ?? 0) + amount;
    while (rec![key] >= perItem) {
      rec![key] -= perItem;
      if (rng(state, "drops")() < rule.probability * devTuning().dropRateMult)
        scatterDrop(state, rule.item, x, z, radius);
    }
  });
}

/** A structure was destroyed: roll its loot table. Each entry is rolled
 *  INDEPENDENTLY against its probability and, on success, drops `amount` of
 *  its item scattered around the structure's footprint. */
export function dropStructureLoot(state: GameState, kind: string, x: number, z: number): void {
  const featureLoot = entityDrops(kind);
  const chance = rng(state, "drops");
  const scatter = rng(state, "world");
  if (entityFeature(kind).drops !== undefined) {
    for (const e of featureLoot) {
      if (e.trigger !== "kill" || chance() >= e.probability) continue;
      for (let i = 0; i < e.quantity; i++) {
        const ang = scatter() * Math.PI * 2;
        const r = 1 + scatter() * 3;
        dropItem(state, e.item, x + Math.cos(ang) * r, z + Math.sin(ang) * r);
      }
    }
    return;
  }
  for (const e of structureLoot(kind)) {
    if (chance() >= e.probability) continue;
    const n = Math.max(0, Math.round(e.amount));
    for (let i = 0; i < n; i++) {
      const ang = scatter() * Math.PI * 2;
      const r = 1 + scatter() * 3; // scatter around the structure footprint
      dropItem(state, e.item, x + Math.cos(ang) * r, z + Math.sin(ang) * r);
    }
  }
}

/** Per-room id counters for dropped pickups. */
const seq = new WeakMap<GameState, { log: number; stone: number; drop: number }>();
function getSeq(state: GameState) {
  let s = seq.get(state);
  if (!s) {
    s = { log: 0, stone: 0, drop: 0 };
    seq.set(state, s);
  }
  return s;
}

function scatterFree(state: GameState, range: number): { x: number; z: number } {
  const roll = rng(state, "world");
  const x = (roll() * 2 - 1) * range;
  const z = (roll() * 2 - 1) * range;
  return nearestFreeWorld(x, z); // keep clear of boulders/crates
}

// ---- trees ----
export function spawnTrees(state: GameState) {
  let placed = 0;
  let guard = 0;
  while (placed < TREE_COUNT && guard < TREE_COUNT * 12) {
    guard++;
    const spot = scatterFree(state, TREE_SPAWN_RANGE);
    let tooClose = false;
    state.trees.forEach((t) => {
      if ((t.x - spot.x) ** 2 + (t.z - spot.z) ** 2 < 3.5 * 3.5) tooClose = true;
    });
    if (tooClose) continue;

    const tree = new Tree();
    tree.id = `tree-${placed}`;
    tree.x = spot.x;
    tree.z = spot.z;
    tree.hp = TREE_HP;
    tree.maxHp = TREE_HP;
    tree.armor = TREE_ARMOR;
    tree.alive = true;
    state.trees.set(tree.id, tree);
    placed++;
  }
}

/** Drop one of the configured item near a tree (within easy reach of the stump). */
function dropFromTree(state: GameState, tree: Tree, item: string) {
  const roll = rng(state, "world");
  const ang = roll() * Math.PI * 2;
  const r = 0.8 + roll() * 0.9;
  dropItem(state, item, tree.x + Math.cos(ang) * r, tree.z + Math.sin(ang) * r);
}

/** Chop damage landed on a tree: when its drop is PROGRESSIVE ("hit"), shed the
 *  configured item every (hp/amount) damage, so it yields `amount` total across its
 *  full hp. Kill-drop trees yield nothing here (everything drops when felled). */
export function onTreeDamaged(state: GameState, tree: Tree, amount: number) {
  const kind = treeResourceKind(tree);
  const rules = legacyResourceDrops(kind);
  if (entityFeature(kind).drops !== undefined) {
    applyDamageDrops(state, tree, kind, tree.id, undefined, tree.x, tree.z, tree.maxHp, amount, 0.9);
    return;
  }
  const cfg = rules[0];
  if (!cfg || cfg.trigger !== "damage") return;
  const total = Math.round(cfg.quantity);
  if (total <= 0) return;
  const perItem = Math.max(1, dropConfig(kind).hp) / total; // user's formula: total HP / total items
  tree.damageSinceDrop += amount;
  while (tree.damageSinceDrop >= perItem) {
    tree.damageSinceDrop -= perItem;
    if (rng(state, "drops")() < cfg.probability) dropFromTree(state, tree, cfg.item);
  }
}

/** A tree's HP hit 0: turn it into a stump, schedule regrow, and (for a KILL-drop
 *  tree) shed the full configured amount. Progressive trees already shed while
 *  being chopped (see onTreeDamaged), so nothing extra drops here. */
export function onTreeCut(state: GameState, tree: Tree) {
  const kind = treeResourceKind(tree);
  tree.alive = false;
  tree.hp = 0;
  tree.regrowTimer = TREE_REGROW_MS;
  tree.damageSinceDrop = 0;

  const cfg = dropConfig(kind);
  if (entityFeature(kind).drops !== undefined) {
    dropEntityLoot(state, kind, tree.id, undefined, tree.x, tree.z, 0.9);
    return;
  }
  if (cfg.trigger !== "kill") return;
  const n = Math.max(0, Math.round(cfg.amount));
  const roll = rng(state, "world");
  for (let i = 0; i < n; i++) {
    const angle = (i / Math.max(1, n)) * Math.PI * 2 + roll();
    const r = 0.8 + roll() * 0.9;
    dropItem(state, cfg.item, tree.x + Math.cos(angle) * r, tree.z + Math.sin(angle) * r);
  }
}

export function treeRegrowSystem(state: GameState, dt: number) {
  const dtMs = dt * 1000;
  state.trees.forEach((t) => {
    if (!t.alive) {
      t.regrowTimer -= dtMs;
      if (t.regrowTimer <= 0) {
        t.alive = true;
        t.hp = t.maxHp;
        t.damageSinceDrop = 0;
      }
    }
  });
}

// ---- rocks (mineable boulders) ----
export function spawnRocks(state: GameState) {
  BOULDERS.forEach((b, i) => {
    const rock = new Rock();
    rock.id = `rock-${i}`;
    rock.x = b.x;
    rock.z = b.z;
    rock.radius = b.radius;
    rock.hp = ROCK_HP;
    rock.maxHp = ROCK_HP;
    rock.armor = ROCK_ARMOR;
    rock.alive = true;
    state.rocks.set(rock.id, rock);
  });
}

/** Drop one of the configured item just outside a rock's body (within reach). */
function dropFromRock(state: GameState, rock: Rock, item: string) {
  const roll = rng(state, "world");
  const angle = roll() * Math.PI * 2;
  // drop close to the rock's base (just outside its shrunken collision) so the
  // items land within the player's reach instead of scattering out of range.
  const r = rock.radius * (rock.scale || 1) * ROCK_COLLISION_SCALE + 0.5 + roll() * 0.5;
  dropItem(state, item, rock.x + Math.cos(angle) * r, rock.z + Math.sin(angle) * r);
}

/** Drop a clustered burst of stones around one reachable point at a rock's base. */
function dropStoneGroupFromRock(state: GameState, rock: Rock, count: number) {
  const roll = rng(state, "world");
  const angle = roll() * Math.PI * 2;
  const r = rock.radius * (rock.scale || 1) * ROCK_COLLISION_SCALE + 0.5 + roll() * 0.5;
  const cx = rock.x + Math.cos(angle) * r;
  const cz = rock.z + Math.sin(angle) * r;
  for (let i = 0; i < count; i++) {
    const spreadAngle = roll() * Math.PI * 2;
    const spread = roll() * 0.75;
    dropItem(state, "stone", cx + Math.cos(spreadAngle) * spread, cz + Math.sin(spreadAngle) * spread);
  }
}

/** Mining damage landed on a rock: shed the configured item progressively — `amount`
 *  total, spread evenly across the rock's HP (so it runs out as the rock is mined). */
export function onRockDamaged(state: GameState, rock: Rock, amount: number) {
  const featureRules = entityFeature("rock").drops !== undefined;
  const cfg = dropConfig("rock");
  if (featureRules) {
    applyDamageDrops(
      state,
      rock,
      "rock",
      rock.id,
      undefined,
      rock.x,
      rock.z,
      rock.maxHp,
      amount,
      rock.radius * (rock.scale || 1) * ROCK_COLLISION_SCALE + 0.8,
    );
    return;
  }
  if (cfg.trigger !== "hit") return; // a kill-trigger rock doesn't shed while being hit
  const total = Math.round(cfg.amount);
  if (total <= 0) return; // configured to yield nothing (also guards the divide below)
  const perItem = Math.max(1, cfg.hp) / total; // user's formula: total HP / total items
  rock.damageSinceStone += amount;
  let ready = Math.floor(rock.damageSinceStone / perItem);
  while (ready >= STONE_GROUP_MIN) {
    const group = Math.min(
      ready,
      STONE_GROUP_MIN + Math.floor(rng(state, "drops")() * (STONE_GROUP_MAX - STONE_GROUP_MIN + 1)),
    );
    rock.damageSinceStone -= perItem * group;
    ready -= group;
    if (cfg.item === "stone") {
      dropStoneGroupFromRock(state, rock, group);
    } else {
      for (let i = 0; i < group; i++) dropFromRock(state, rock, cfg.item);
    }
  }
}

/** A rock's HP hit 0: turn it to rubble for the rest of the realm. A KILL-drop rock yields
 *  its full configured amount here; a progressive ("hit") rock already shed its items
 *  while being mined (see onRockDamaged), so nothing extra drops. */
export function onRockMined(state: GameState, rock: Rock) {
  const cfg = dropConfig("rock");
  if (entityFeature("rock").drops !== undefined) {
    dropEntityLoot(state, "rock", rock.id, undefined, rock.x, rock.z, rock.radius * (rock.scale || 1) * ROCK_COLLISION_SCALE + 0.8);
    rock.alive = false;
    rock.hp = 0;
    rock.damageSinceStone = 0;
    return;
  }
  if (cfg.trigger === "kill") {
    const n = Math.max(0, Math.round(cfg.amount));
    for (let i = 0; i < n; i++) dropFromRock(state, rock, cfg.item);
  }
  rock.alive = false;
  rock.hp = 0;
  rock.damageSinceStone = 0;
}

/** Push the live drop config's HP onto EVERY resource of each kind (not just the one
 *  selected in Dev Mode): set maxHp, re-up living resources to full, and clear the
 *  progressive-drop accumulators. Called once after spawn and on every resources.json
 *  change, so editing a tree/rock's HP commits to all trees/rocks at once. */
export function applyResourceConfig(state: GameState) {
  state.trees.forEach((t) => {
    const kind = treeResourceKind(t);
    const treeHp = Math.max(0, entityHp(kind, t.id, undefined, dropConfig(kind).hp));
    t.maxHp = treeHp;
    if (t.alive) t.hp = treeHp;
    t.damageSinceDrop = 0;
  });
  state.rocks.forEach((r) => {
    const rockHp = Math.max(0, entityHp("rock", r.id, undefined, dropConfig("rock").hp));
    r.maxHp = rockHp;
    if (r.alive) r.hp = rockHp;
    r.damageSinceStone = 0;
  });
}

/** Round wipe → restart resources from scratch: remove runtime-created resources,
 *  rebuild the initial tree/rock maps, reset drop counters/accumulators, and clear
 *  any loot dropped during the realm. */
export function resetResources(state: GameState) {
  state.trees.clear();
  state.rocks.clear();
  state.logs.clear();
  state.stones.clear();
  state.items.clear();
  seq.set(state, { log: 0, stone: 0, drop: 0 });
  dropDamage.set(state, new WeakMap<object, Record<string, number>>());
  spawnTrees(state);
  spawnRocks(state);
  applyResourceConfig(state);
}

// ---- collection ----
/** Collect a world item a player walked onto after clicking it. */
export function itemPickupSystem(
  state: GameState,
  _dt: number,
  onCollect: (sessionId: string, type: ItemType) => void,
) {
  state.players.forEach((player, pid) => {
    if (!player.pickupTargetId) return;
    const id = player.pickupTargetId;
    const log = state.logs.get(id);
    const stone = log ? undefined : state.stones.get(id);
    const potion = log || stone ? undefined : state.potions.get(id);
    const banana = log || stone || potion ? undefined : state.bananas.get(id);
    const item = log || stone || potion || banana ? undefined : state.items.get(id);
    const target = log ?? stone ?? potion ?? banana ?? item;
    if (!target) {
      player.pickupTargetId = "";
      return;
    }
    const dx = target.x - player.x;
    const dz = target.z - player.z;
    const radius = potion
      ? PICKUP_RADIUS
      : banana
        ? BANANA_PICKUP_RADIUS
        : LOG_PICKUP_RADIUS;
    if (dx * dx + dz * dz <= radius * radius) {
      if (log) {
        state.logs.delete(id);
        onCollect(pid, "log");
      } else if (stone) {
        state.stones.delete(id);
        onCollect(pid, "stone");
      } else if (banana) {
        state.bananas.delete(id);
        onCollect(pid, "banana");
      } else if (potion) {
        // Use the synced kind so berserker_potion gives the buff item, not a heal.
        const kind = (potion.kind ?? "potion") as ItemType;
        state.potions.delete(id);
        onCollect(pid, kind);
      } else if (item) {
        state.items.delete(id);
        onCollect(pid, item.itemId as ItemType);
      }
      player.pickupTargetId = "";
    }
  });
}

type ItemMap = {
  forEach(cb: (v: { x: number; z: number }, k: string) => void): void;
  delete(k: string): boolean;
};

/** Auto-collect any world item a player walks near (no click). */
export function autoGrabSystem(
  state: GameState,
  onCollect: (sessionId: string, type: ItemType) => void,
) {
  const r2 = AUTO_GRAB_RADIUS * AUTO_GRAB_RADIUS;
  state.players.forEach((player, pid) => {
    if (player.state === AnimState.DEAD) return;
    const grab = (map: ItemMap, type: ItemType) => {
      const ids: string[] = [];
      map.forEach((item, id) => {
        const dx = item.x - player.x;
        const dz = item.z - player.z;
        if (dx * dx + dz * dz <= r2) ids.push(id);
      });
      for (const id of ids) {
        map.delete(id);
        onCollect(pid, type);
      }
    };
    grab(state.logs, "log");
    grab(state.stones, "stone");
    grab(state.bananas, "banana");
    // Potions: check the kind field so berserker_potion gives the buff item.
    const potionIds: string[] = [];
    state.potions.forEach((item, id) => {
      const dx = item.x - player.x;
      const dz = item.z - player.z;
      if (dx * dx + dz * dz <= r2) potionIds.push(id);
    });
    for (const id of potionIds) {
      const kind = (state.potions.get(id)?.kind ?? "potion") as ItemType;
      state.potions.delete(id);
      onCollect(pid, kind);
    }
    const itemIds: string[] = [];
    state.items.forEach((item, id) => {
      const dx = item.x - player.x;
      const dz = item.z - player.z;
      if (dx * dx + dz * dz <= r2) itemIds.push(id);
    });
    for (const id of itemIds) {
      const kind = state.items.get(id)?.itemId as ItemType | undefined;
      state.items.delete(id);
      if (kind) onCollect(pid, kind);
    }
  });
}
