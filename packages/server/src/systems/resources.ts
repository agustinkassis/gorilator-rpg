import {
  GameState,
  Tree,
  Log,
  Rock,
  Stone,
  Potion,
  ItemType,
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
  ROCK_REGROW_MS,
  ROCK_COLLISION_SCALE,
  BANANA_PICKUP_RADIUS,
  AUTO_GRAB_RADIUS,
  AnimState,
} from "@rpg/shared";
import { nearestFreeWorld } from "./pathfinding";
import { spawnBanana } from "./bananas";
import { dropConfig } from "./resourceDrops";

let dropSeq = 0; // id counter for misc drops (potions / future custom items)

/** Spawn one collectible of `type` at (x,z), routed to the matching entity map.
 *  The drop editor sets which `type` a resource yields; unknown types fall back to
 *  a stone so a mis-typed/custom item still produces a pickup. */
function dropItem(state: GameState, type: string, x: number, z: number): void {
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
      e.id = `potion-d${dropSeq++}`;
      e.x = spot.x;
      e.z = spot.z;
      state.potions.set(e.id, e);
      break;
    }
    default: {
      const e = new Stone();
      e.id = `stone-${s.stone++}`;
      e.x = spot.x;
      e.z = spot.z;
      state.stones.set(e.id, e);
      break;
    }
  }
}

/** Per-room id counters for dropped pickups. */
const seq = new WeakMap<GameState, { log: number; stone: number }>();
function getSeq(state: GameState) {
  let s = seq.get(state);
  if (!s) {
    s = { log: 0, stone: 0 };
    seq.set(state, s);
  }
  return s;
}

function scatterFree(range: number): { x: number; z: number } {
  const x = (Math.random() * 2 - 1) * range;
  const z = (Math.random() * 2 - 1) * range;
  return nearestFreeWorld(x, z); // keep clear of boulders/crates
}

// ---- trees ----
export function spawnTrees(state: GameState) {
  let placed = 0;
  let guard = 0;
  while (placed < TREE_COUNT && guard < TREE_COUNT * 12) {
    guard++;
    const spot = scatterFree(TREE_SPAWN_RANGE);
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
  const ang = Math.random() * Math.PI * 2;
  const r = 0.8 + Math.random() * 0.9;
  dropItem(state, item, tree.x + Math.cos(ang) * r, tree.z + Math.sin(ang) * r);
}

/** Chop damage landed on a tree: when its drop is PROGRESSIVE ("hit"), shed the
 *  configured item every (hp/amount) damage, so it yields `amount` total across its
 *  full hp. Kill-drop trees yield nothing here (everything drops when felled). */
export function onTreeDamaged(state: GameState, tree: Tree, amount: number) {
  const cfg = dropConfig("tree");
  if (cfg.trigger !== "hit") return;
  const total = Math.round(cfg.amount);
  if (total <= 0) return;
  const perItem = Math.max(1, cfg.hp) / total; // user's formula: total HP / total items
  tree.damageSinceDrop += amount;
  while (tree.damageSinceDrop >= perItem) {
    tree.damageSinceDrop -= perItem;
    dropFromTree(state, tree, cfg.item);
  }
}

/** A tree's HP hit 0: turn it into a stump, schedule regrow, and (for a KILL-drop
 *  tree) shed the full configured amount. Progressive trees already shed while
 *  being chopped (see onTreeDamaged), so nothing extra drops here. */
export function onTreeCut(state: GameState, tree: Tree) {
  tree.alive = false;
  tree.hp = 0;
  tree.regrowTimer = TREE_REGROW_MS;
  tree.damageSinceDrop = 0;

  const cfg = dropConfig("tree");
  if (cfg.trigger !== "kill") return;
  const n = Math.max(0, Math.round(cfg.amount));
  for (let i = 0; i < n; i++) {
    const angle = (i / Math.max(1, n)) * Math.PI * 2 + Math.random();
    const r = 0.8 + Math.random() * 0.9;
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
  const angle = Math.random() * Math.PI * 2;
  // drop close to the rock's base (just outside its shrunken collision) so the
  // items land within the player's reach instead of scattering out of range.
  const r = rock.radius * ROCK_COLLISION_SCALE + 0.5 + Math.random() * 0.5;
  dropItem(state, item, rock.x + Math.cos(angle) * r, rock.z + Math.sin(angle) * r);
}

/** Mining damage landed on a rock: shed the configured item progressively — `amount`
 *  total, spread evenly across the rock's HP (so it runs out as the rock is mined). */
export function onRockDamaged(state: GameState, rock: Rock, amount: number) {
  const cfg = dropConfig("rock");
  if (cfg.trigger !== "hit") return; // a kill-trigger rock doesn't shed while being hit
  const total = Math.round(cfg.amount);
  if (total <= 0) return; // configured to yield nothing (also guards the divide below)
  const perItem = Math.max(1, cfg.hp) / total; // user's formula: total HP / total items
  rock.damageSinceStone += amount;
  while (rock.damageSinceStone >= perItem) {
    rock.damageSinceStone -= perItem;
    dropFromRock(state, rock, cfg.item);
  }
}

/** A rock's HP hit 0: turn it to rubble and schedule regrow. A KILL-drop rock yields
 *  its full configured amount here; a progressive ("hit") rock already shed its items
 *  while being mined (see onRockDamaged), so nothing extra drops. */
export function onRockMined(state: GameState, rock: Rock) {
  const cfg = dropConfig("rock");
  if (cfg.trigger === "kill") {
    const n = Math.max(0, Math.round(cfg.amount));
    for (let i = 0; i < n; i++) dropFromRock(state, rock, cfg.item);
  }
  rock.alive = false;
  rock.hp = 0;
  rock.damageSinceStone = 0;
  rock.regrowTimer = ROCK_REGROW_MS;
}

/** Push the live drop config's HP onto EVERY resource of each kind (not just the one
 *  selected in Dev Mode): set maxHp, re-up living resources to full, and clear the
 *  progressive-drop accumulators. Called once after spawn and on every resources.json
 *  change, so editing a tree/rock's HP commits to all trees/rocks at once. */
export function applyResourceConfig(state: GameState) {
  const treeHp = Math.max(1, Math.round(dropConfig("tree").hp));
  const rockHp = Math.max(1, Math.round(dropConfig("rock").hp));
  state.trees.forEach((t) => {
    t.maxHp = treeHp;
    if (t.alive) t.hp = treeHp;
    t.damageSinceDrop = 0;
  });
  state.rocks.forEach((r) => {
    r.maxHp = rockHp;
    if (r.alive) r.hp = rockHp;
    r.damageSinceStone = 0;
  });
}

export function rockRegrowSystem(state: GameState, dt: number) {
  const dtMs = dt * 1000;
  state.rocks.forEach((r) => {
    if (!r.alive) {
      r.regrowTimer -= dtMs;
      if (r.regrowTimer <= 0) {
        r.alive = true;
        r.hp = r.maxHp;
        r.damageSinceStone = 0;
      }
    }
  });
}

/** Round wipe → restart resources from scratch: restore every structure to pristine
 *  (all trees/rocks full + alive, regrow timers cleared) and clear any loot dropped
 *  during the realm. Untouched structures encode no delta, so this is cheap. */
export function resetResources(state: GameState) {
  state.trees.forEach((t) => {
    t.alive = true;
    t.hp = t.maxHp;
    t.regrowTimer = 0;
  });
  state.rocks.forEach((r) => {
    r.alive = true;
    r.hp = r.maxHp;
    r.regrowTimer = 0;
    r.damageSinceStone = 0;
  });
  state.logs.clear();
  state.stones.clear();
}

// ---- collection ----
/** Collect a world item (log / stone / potion / banana) a player walked onto after clicking it. */
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
    const target = log ?? stone ?? potion ?? banana;
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
      } else {
        state.potions.delete(id);
        onCollect(pid, "potion");
      }
      player.pickupTargetId = "";
    }
  });
}

type ItemMap = {
  forEach(cb: (v: { x: number; z: number }, k: string) => void): void;
  delete(k: string): boolean;
};

/** Auto-collect any log / stone / potion / banana a player walks near (no click). */
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
    grab(state.potions, "potion");
    grab(state.bananas, "banana");
  });
}
