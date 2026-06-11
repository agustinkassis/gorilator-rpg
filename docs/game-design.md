# Game design — combat, crafting & survival

The detailed design for the sandbox's RPG core, expanding the pillars in
[vision.md](vision.md). Implementation order, sizes, and file anchors live in
[ROADMAP.md](../ROADMAP.md) (Phase 3); every system here ships with a Feature
Lab scenario + bot self-test ([feature-lab.md](feature-lab.md)).

Design rules carried over from the existing codebase: content is **data-first
JSON** (live-reloaded, no recompile — see [configuration.md](configuration.md)),
the **server is authoritative** over every outcome, and loops that aren't core
live in **plugins** ([plugins.md](plugins.md)).

## Equipment & wearables

Players equip items into fixed slots. Equipment is the progression system:
levels grow your base, gear defines what you *are*.

| Slot | Examples |
| --- | --- |
| `weapon` | sword, staff, daggers, bow |
| `offhand` | shield, tome, quiver |
| `head` | plate helm, leather hood, cloth cowl |
| `chest` | plate armor, leather jerkin, cloth robe |
| `boots` | greaves, boots, sandals |
| `accessory` | ring, amulet, charm |

Equipment defs extend `items.json` (same manifest, new fields):

```jsonc
{
  "id": "iron_sword",
  "name": "Iron Sword",
  "equipment": {
    "slot": "weapon",
    "tier": 2,
    "stats": { "attack": 6, "speed": -0.2 },     // hp/attack/armor/speed/spellPower/mana
    "abilities": ["heavy_swing"],                 // granted while equipped
    "durability": 100                             // max durability
  }
}
```

- **Stat resolution** is one recompute path: `base + level growth + equipped
  gear` (extending the existing per-level growth in `systems/leveling.ts`).
- **Durability** decays on death (the amount follows the realm's death policy —
  see [configuration.md](configuration.md)). Broken gear stops granting stats
  and abilities until repaired at a station. Durability is the economy's sink:
  gear wears out, so crafters always have customers.
- **All gear is player-crafted.** No vendor gear by default. Starter characters
  get bare-hands basics; everything better enters the world through the
  crafting chains below.

## Classes from wearables (the Albion model)

There is no class picker. Your equipped items grant your abilities and define
your role — *you are what you wear*.

| Archetype | Loadout | Role profile |
| --- | --- | --- |
| **Healer / mage** | staff + cloth robe | healing + ranged spells, big mana pool, low armor — dies fast if focused |
| **Tank** | sword + shield + plate | taunt, damage mitigation, threat generation — low damage, hard to kill |
| **DPS** | daggers or bow + leather | high damage and mobility — squishy, lives on positioning |

Swapping gear swaps your class — mid-session, anywhere. This keeps one
character viable forever (no alts needed), makes gear the entire progression
economy, and lets a party rebalance ("we need a healer — who has a staff?") on
the spot. Hybrid loadouts are allowed and intentionally mediocre at everything:
the stats and granted abilities do the balancing, not a rule.

## Abilities & spells

Abilities are data-first, defined in a new `abilities.json` manifest and
granted by equipped items (never learned permanently):

```jsonc
{
  "id": "minor_heal",
  "name": "Minor Heal",
  "type": "heal",            // damage | heal | buff | taunt | shield
  "cost": { "mana": 12 },    // mana or stamina
  "cooldownMs": 4000,
  "range": 10,
  "aoeRadius": 0,            // 0 = single target
  "castMs": 1200,            // 0 = instant
  "effects": { "heal": 18 }
}
```

- **Mana** joins stamina as a player resource (synced, regenerating, grown by
  gear). Physical abilities cost stamina; spells cost mana.
- The server validates every cast (range, cost, cooldown, line of sight),
  applies effects, and generates threat (below). The client gets an action bar
  populated from equipped gear, plus target/cast UI.
- Types cover the trinity: `damage` (DPS), `heal`/`shield`/`buff` (support),
  `taunt` (tank). New types are additive manifest changes.

## Trinity team play

Group combat is designed so role diversity wins — the LoL/WoW comp instinct,
not a zerg.

- **Threat tables, not nearest-player.** Each enemy keeps a per-player threat
  score: damage adds threat, healing adds threat to everyone the heal target's
  attackers know about, taunts spike threat to the top. Enemies attack their
  highest-threat target. (This replaces the current nearest/aggro-radius logic
  in the goblin brains.)
- **Tanks** generate threat faster than their damage justifies and mitigate
  incoming hits; **healers** keep the tank alive but pull threat by healing;
  **DPS** rides the threat ceiling — overextend and the boss turns around.
- **Elite/boss archetypes** (entity-features.json) deal damage profiles that
  *require* tank mitigation + healer sustain — an unhealed solo player cannot
  face-tank them at any level.
- **Solo stays viable** against ambient content (gathering zones, small camps,
  standard goblins). Group content rewards composition; it never gates basic
  play.
- **Parties** are first-class: invite/accept, shared-XP radius, party frames
  showing HP/mana — the minimum UI for trinity play.

## Crafting chains (Minecraft recipes, Factorio production vibe)

Three steps, each its own gameplay: **gather → refine → craft**.

```
chop tree ─▶ log    ─▶ plank (workbench) ─▶ bow, building parts
mine rock ─▶ ore    ─▶ ingot (forge)     ─▶ sword, plate armor
harvest   ─▶ fiber  ─▶ cloth (loom)      ─▶ robe, bandages
forage    ─▶ herbs  ─▶ extract (alchemy) ─▶ potions, oils
```

Recipes live in a new `recipes.json` manifest:

```jsonc
{
  "id": "iron_ingot",
  "station": "forge",                    // null = hand-craftable
  "inputs": [{ "item": "iron_ore", "count": 2 }, { "item": "log", "count": 1 }],
  "output": { "item": "iron_ingot", "count": 1 },
  "craftMs": 3000,
  "xp": 5,
  "tier": 2
}
```

- **Stations are player-built structures.** A workbench, forge, or alchemy
  table is itself a crafted item with a `placeable` flag — place it in the
  world and it becomes a usable station (this is also how building enters the
  game: stations, then walls and decorations, through the same placement path).
  v1 player builds last until the realm resets.
- **Tiers gate progression**: higher-tier recipes unlock as crafting grants XP
  and as you build better stations. Tier ladders are content, not code.
- **Multi-step chains are the point** — the Factorio itch. A tier-3 sword is
  ore × 6 → ingots × 3 → blade + crafted hilt → sword, touching two stations.
  Chains create interdependence (the smelter needs the lumberjack) and
  therefore an economy. The door stays open for later automation experiments
  (stations with queues and production rates).

## Survival & ecology (Don't Starve-style)

The survival layer gives the sandbox a day-to-day loop that exists even when
no event module is running.

- **Hunger** is a new player meter that drains over time. Eating restores it.
  At zero, HP drains and stats debuff until you eat (death by starvation obeys
  the normal death policy). The drain rate is a **realm tuning knob** —
  peaceful worlds set it to 0, hardcore worlds crank it.
- **Food sources**, in ascending quality:
  1. **Foraging** — bananas and wild food on the map (exists today).
  2. **Farming** — plant a seed or sapling (`plantable` items), wait out a
     growth timer, harvest. Rides the existing tree/resource regrow machinery.
  3. **Cooking** — recipes at a campfire/kitchen station. Raw food is weak,
     cooked food is good: cooking is just another crafting chain, so farmers
     and cooks are economy roles too.
- **The loop closes**: harvests yield seeds, felled trees yield saplings —
  chop a tree, get logs *and* the next tree. Food defs are item-manifest data:
  `"food": { "hunger": 20, "hp": 5 }`, eaten through the existing item-use
  path.
- **Renewable ecology**: baseline ambient regrowth (today's tree/potion
  respawn cycles) + player planting on top, balanced so an active community
  keeps its world abundant and an abandoned area slowly recovers on its own.
  **Resources never permanently run out** — scarcity is local and temporary,
  created by player activity, healed by player (or ambient) replanting.

## Tuning & verification

Every number above — hunger drain, growth timers, craft times, threat
multipliers, durability loss — is a tuning knob, not a constant: live-editable
in the Dev Mode tuning panel and overridable per world via `realm.json`
([configuration.md](configuration.md)). Each system ships with an isolated
Feature Lab scenario (hunger map with scattered food, farming plot with 20×
time, threat-table boss room) so it can be played, botted, and tuned in
isolation before it hits the flagship — see [feature-lab.md](feature-lab.md).
