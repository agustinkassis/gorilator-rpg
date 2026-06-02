# Entities, objects & elements

Every world object is a Colyseus `Schema` in `packages/shared/src/schema/`. Fields
marked `@type(...)` are **synchronized** to all clients; plain fields (where noted)
are **server-only** bookkeeping. The root is `GameState`, which holds a `MapSchema`
of each kind keyed by `id`.

## `GameState` (root, synced)

| Field | Type | Meaning |
| --- | --- | --- |
| `players` | `MapSchema<Player>` | connected players |
| `enemies` | `MapSchema<Enemy>` | goblins + training dummies |
| `potions`, `trees`, `logs`, `rocks`, `stones`, `bananas`, `houses` | `MapSchema<…>` | world objects |
| `timeScale` | number | Dev-Mode sim speed (1 normal, 0 paused) |
| `waveNumber` | number | current siege wave |
| `waveTimerMs` | number | ms until the next wave |

## Player

The gorilla you control. **Synced:** `id, name, x, z, rotY, hp, maxHp, stamina,
maxStamina, state` (`AnimState`), `hue` (colour tint), Nostr identity (`pubkey,
nostrVerified, picture, nip05`), progression (`level, xp`), combat stats (`attack,
armor, critChance, moveSpeed, throwPower`), `sprinting`, `godMode`.
**Server-only:** movement target/path, attack/respawn timers, pursuit ids, stamina
bookkeeping. Level-1 defaults come from constants (`PLAYER_MAX_HP`, `PLAYER_ATTACK`,
…); leveling grows them. Inventory is **not** on the player schema — it's kept
server-side and sent only to its owner via the `inventory` message.

## Enemy (`kind: "goblin" | "dummy"`)

One schema, two behaviours (the `kind` picks the model + AI). **Synced:** `id, kind,
x, z, rotY, hp, maxHp, level, state, attack, armor, critChance`. **Server-only:** AI
target/home, aggro flag, attack/wander/respawn timers.

- **Goblin** — the besieger. Marches on La Crypta and attacks it; diverts to fight
  any nearby defender, then resumes. Stats derive from its level; corpses are
  consumed (not respawned). See goblin AI in [gameplay.md](gameplay.md).
- **Dummy** — a stationary training target near spawn; takes hits, "dies", respawns
  after `DUMMY_RESPAWN_MS`. Good for testing combat.

## House — "La Crypta" (the objective)

`id` (`"house-0"` — the first/oldest house is **home**), `x, z, radius` (collision
footprint a throw stops at), `hp, maxHp` (`HOUSE_HP`), `alive`. Goblins and thrown
items chip its HP. At 0 it collapses and is removed from state → the server fires the
**wipe** (reset everyone + rebuild). Only the first house is the defended home.

## Tree (choppable)

`id, x, z, hp, maxHp` (`TREE_HP`), `alive` (false = a stump regrowing after
`TREE_REGROW_MS`), `armor` (`TREE_ARMOR`, used by the damage formula). Chopping drops
a **log**, with a `TREE_BANANA_DROP_CHANCE` to also drop a banana.

## Rock / boulder (mineable)

`id, x, z, radius` (visual + nav size), `hp, maxHp` (`ROCK_HP`), `alive` (rubble
stays mined out until the realm resets), `armor` (`ROCK_ARMOR`). Mining sheds
grouped **stones** from the rock drop amount in `resources.json`. Rocks are dynamic
nav obstacles (collision follows the live entity, so Dev-Mode moves update
pathfinding).

## Collectibles (position-only schemas)

These carry just `id, x, z` (+ `heal` for potions) — appearance is client-side:

| Object | Extra | Notes |
| --- | --- | --- |
| **Banana** | — | default throwable ammo; litters the map, drops from trees, lands from throws |
| **Stone** | — | hard-hitting throwable, mined from rocks |
| **Log** | — | dropped when a tree is felled |
| **Potion** | `heal` (`POTION_HEAL`) | consumed from the inventory to heal |

Items within `AUTO_GRAB_RADIUS` of a player are auto-collected into the inventory.

## Static obstacles (non-entity)

Defined in `shared/src/obstacles.ts` as collision circles (crates + the house
footprint) that the nav grid and depenetration read. Imported "concrete" props (via
Dev Mode → `props.json` with `collisionRadius > 0`) are added to this set at runtime.

## Animation states (`AnimState`)

`IDLE · WALK · ATTACK · THROW · HIT · DEAD` — synced on players & enemies; the client
drives a per-clip FSM (looping idle/walk, one-shot attack/hit, frozen death pose).

## Inventory (server-side)

A Diablo-style `INV_COLS × INV_ROWS` grid of `InventorySlot { type: ItemType | "",
count }`, stacking to `MAX_STACK`. Kept off the synced state and pushed to its owner
only (the `inventory` message). `ItemType = "log" | "potion" | "stone" | "banana"`.
