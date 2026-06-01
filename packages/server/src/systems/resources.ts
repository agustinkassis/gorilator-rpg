import {
  GameState,
  Tree,
  Log,
  Rock,
  Stone,
  ItemType,
  BOULDERS,
  TREE_COUNT,
  TREE_HP,
  TREE_ARMOR,
  TREE_REGROW_MS,
  LOGS_PER_TREE,
  LOG_PICKUP_RADIUS,
  PICKUP_RADIUS,
  TREE_SPAWN_RANGE,
  ROCK_HP,
  ROCK_ARMOR,
  ROCK_REGROW_MS,
  STONES_PER_ROCK,
  BANANA_PICKUP_RADIUS,
  AUTO_GRAB_RADIUS,
  AnimState,
} from "@rpg/shared";
import { nearestFreeWorld } from "./pathfinding";

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

/** A tree's HP hit 0: turn it into a stump, drop logs, schedule regrow. */
export function onTreeCut(state: GameState, tree: Tree) {
  tree.alive = false;
  tree.hp = 0;
  tree.regrowTimer = TREE_REGROW_MS;

  const s = getSeq(state);
  for (let i = 0; i < LOGS_PER_TREE; i++) {
    const log = new Log();
    log.id = `log-${s.log++}`;
    const angle = (i / LOGS_PER_TREE) * Math.PI * 2 + Math.random();
    const r = 0.8 + Math.random() * 0.9;
    const spot = nearestFreeWorld(tree.x + Math.cos(angle) * r, tree.z + Math.sin(angle) * r);
    log.x = spot.x;
    log.z = spot.z;
    state.logs.set(log.id, log);
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

/** A rock's HP hit 0: turn it to rubble, drop stone, schedule regrow. */
export function onRockMined(state: GameState, rock: Rock) {
  rock.alive = false;
  rock.hp = 0;
  rock.regrowTimer = ROCK_REGROW_MS;

  const s = getSeq(state);
  for (let i = 0; i < STONES_PER_ROCK; i++) {
    const stone = new Stone();
    stone.id = `stone-${s.stone++}`;
    const angle = (i / STONES_PER_ROCK) * Math.PI * 2 + Math.random();
    const r = rock.radius + 0.8 + Math.random() * 0.7; // outside the rock body
    const spot = nearestFreeWorld(rock.x + Math.cos(angle) * r, rock.z + Math.sin(angle) * r);
    stone.x = spot.x;
    stone.z = spot.z;
    state.stones.set(stone.id, stone);
  }
}

export function rockRegrowSystem(state: GameState, dt: number) {
  const dtMs = dt * 1000;
  state.rocks.forEach((r) => {
    if (!r.alive) {
      r.regrowTimer -= dtMs;
      if (r.regrowTimer <= 0) {
        r.alive = true;
        r.hp = r.maxHp;
      }
    }
  });
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
