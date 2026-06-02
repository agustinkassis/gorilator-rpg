# Game dynamics

Gorilator is a **co-op tower defense**. You are a gorilla; the objective is **La
Crypta**, the house at the map centre. Goblins besiege it in escalating waves; you
defend. Lose La Crypta and the realm wipes.

## Controls

| Input | Action |
| --- | --- |
| Left-click ground | move there (server pathfinds around obstacles) |
| Left-click an enemy/resource | approach + attack/chop/mine it |
| Hold **left-click** + move mouse | continuous move (cursor tracking) |
| Hold **Q** (or W/E/R) | charge a throw of the hotkey's item; release to fling at the cursor |
| Hold **SPACE** | sprint (drains stamina) |
| **I** | inventory · **C** | character sheet · **TAB** / Map button | minimap · **Enter** | chat |

## Movement & combat

- **Movement** is server-authoritative: the client sends a target point, the server
  A*-paths around obstacles and walks the player at `moveSpeed` (grows with level).
  A depenetration pass guarantees you never end up stuck inside a solid object.
- **Melee:** clicking an enemy approaches to `ATTACK_RANGE` and swings on a cooldown.
  Damage is server-rolled:
  `raw = attack × random(1 ± ATTACK_VARIANCE)`, then
  `mitigated = raw × (1 − armor/(armor+ARMOR_K))`, then `÷ DAMAGE_DIVISOR`, with a
  `CRIT_MULTIPLIER×` chance = `critChance`.
- **Throwing:** hold a hotkey to charge a power bar; release to throw toward the
  cursor. **Bananas** are light/long-range; **stones** (mined from rocks) hit much
  harder but shorter. Throw speed/arc are constant regardless of where it lands
  (a prop just clips the flight short). A thrown item can damage characters **and**
  La Crypta.
- **Hit/death:** taking damage plays a brief HIT flinch (it never interrupts your
  own attack/throw). At 0 HP you die, then respawn after `PLAYER_RESPAWN_MS` with a
  lightning strike — keeping your level/stats (unless a wipe resets them).

## Leveling

Kills grant XP (`GOBLIN_XP_REWARD`, `PLAYER_KILL_XP`, `DUMMY_XP_REWARD`,
`TREE_XP_REWARD`, `ROCK_XP_REWARD`). XP to reach the next level scales as
`XP_BASE × level^XP_GROWTH`. Each level raises **maxHp, attack, armor, crit chance
(capped), run speed, and throw power** (`*_PER_LEVEL`). Dying costs ~30% of XP (can
de-level). Every character (goblins included) derives its stats from its level via
the same growth curve, so threat scales with the party.

## The siege — waves

A horde spawns roughly a **30-second march** from La Crypta (≈108 units out,
`WAVE_SPAWN_DISTANCE = GOBLIN_CHASE_SPEED × WAVE_MARCH_SECONDS`) and converges on the
house.

- **Wave size** = `WAVE_SIZE_BASE + WAVE_SIZE_PER_PLAYER × defenders +
  WAVE_SIZE_PER_WAVE × (wave−1)`, capped at `WAVE_SIZE_MAX`; goblin levels escalate
  over time. A wave is held while the live-goblin count is at `GOBLIN_LIVE_CAP`.
- **Cadence:** the first wave comes after a short grace (`WAVE_FIRST_DELAY_MS`); each
  successive **rest grows** to give more rebuild time —
  `WAVE_INTERVAL_BASE_MS + WAVE_INTERVAL_STEP_MS × (wave−1)` (≈ **2.5 min, 3 min,
  3.5 min…**), capped at `WAVE_INTERVAL_MAX_MS`. The countdown **freezes** while no
  defender is alive, so a death never shortcuts it.
- Every player always sees the **home bar** (top-centre): La Crypta's HP + the wave
  number + the countdown to the next wave.

## Goblin AI

Each goblin, by default, **marches on La Crypta** and batters it on arrival
(`GOBLIN_HOUSE_DAMAGE` per hit). But a defender who comes within `GOBLIN_AGGRO_RADIUS`
(or strikes it) **pulls it off the house** to fight, until that player dies or breaks
past `GOBLIN_DEAGGRO_RADIUS` — then it resumes the march. So goblins attack the house
*and* each player that defends it. A felled goblin's corpse lingers then is removed
(a consumed wave is not respawned — the next wave brings reinforcements).

## The wipe & realms

When La Crypta's HP hits 0 it **collapses → a round wipe fires** (once):

1. **Every player dies and respawns from scratch** — reset to level-1 defaults
   (HP/attack/armor/crit/speed/throw), XP 0, and a **fresh starter inventory**.
2. The besieging horde is **cleared**, **La Crypta is rebuilt** to full HP, and the
   **wave clock restarts**.
3. A "🏛 La Crypta has fallen" banner flashes for everyone.

A **realm** is one such game: it starts when a player is present and alive, and ends
when La Crypta falls (or the room empties). Each "survive as long as you can" run is
one realm — see [nostr.md](nostr.md) and [`../REALMS.md`](../REALMS.md) for how
realms are tracked, counted, and published for external discovery.

## Resources & economy

- **Trees** (`TREE_COUNT`) can be chopped for a log; every chop has a
  `TREE_BANANA_DROP_CHANCE` to shake a banana loose. Felled trees regrow.
- **Rocks/boulders** (`ROCK_COUNT`) can be mined for grouped **stones** — your
  hard-hitting throwable. Mined-out rubble stays depleted until the realm resets.
- **Bananas** litter the map (and drop from trees); they're your default throwable
  ammo (you start with `STARTING_BANANAS`).
- **Potions** (`POTION_COUNT`) heal `POTION_HEAL` when consumed from the inventory.
- Items within `AUTO_GRAB_RADIUS` are auto-collected; the inventory is a
  `INV_COLS × INV_ROWS` Diablo-style grid (stacks to `MAX_STACK`).

## Sprint / stamina

Holding SPACE while moving sprints at a speed multiplier, draining `stamina`. Empty
the bar and you're "winded" until it recovers; it regenerates when not sprinting.
The bar is shown under the health globe.

## Dev Mode (dev builds)

An in-game world editor: pause/slow/speed time, toggle god mode, relocate/delete/
retune synced entities, and place imported props/characters/spawners (persisted to
JSON, live-reloaded by the server). Toggle with the Dev button or the `` ` `` key.
