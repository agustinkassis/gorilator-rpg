# Vision — an open Nostr MMORPG sandbox

> Companion docs: [ROADMAP.md](../ROADMAP.md) (the phased plan) ·
> [game-design.md](game-design.md) (combat / crafting / survival detail) ·
> [federation.md](federation.md) (the cross-server protocol, draft) ·
> [strategy.md](strategy.md) (positioning & growth) ·
> [feature-lab.md](feature-lab.md) (how features get built and verified).

## Intent

Gorilator started as a tower-defense brawler: gorillas holding **La Crypta**
against goblin waves. That game stays — but it is no longer the identity of the
project.

**Gorilator is an open-source Nostr MMORPG sandbox where anyone can run a
world, create content, and let players carry identity and progress across
compatible servers.**

Tower defense becomes the first **event module** — *"La Crypta Defense"* — one
of many game loops a world can run on top of the sandbox. The siege is over;
now we rebuild the town. (And the goblins still come back on Fridays.)

## Product thesis

MMORPGs are walled gardens: your character, your items, and your friendships
live inside one company's database, and they die when the servers do. Nostr
already solved the hard part — portable, cryptographic identity and a public
relay network anyone can write to. Gorilator applies it to a game world:

- **Players** own their identity (their npub) and their progress (relay-stored
  saves), not the server operator.
- **Operators** run sovereign worlds — self-hosted in five minutes, with
  published policies instead of terms of service.
- **Creators** publish game content (characters, items, structures — later
  quests and recipes) as signed Nostr events anyone's world can import.
- **The network** compounds: every new server makes every player's identity
  more valuable, and every published entity makes every server richer.

Most of the substrate already exists in this repo: NIP-42 login, server-signed
saves on relays (kind 30078), server discovery + the live dashboard, kind-30333
community entities with Blossom asset hosting, a versioned plugin API, and an
operator CLI with systemd/launchd services and one-click tunnels. The vision is
about finishing the game on top of the protocol — and opening the protocol so
other games can use it too.

## The eight pillars

| # | Pillar | One line |
| --- | --- | --- |
| 1 | **Identity** | Your npub is your character. Log in anywhere with your Nostr key; guests can play, but persistence and portability require a key. |
| 2 | **Sovereignty** | Anyone runs a world. Servers are self-hostable, policy-publishing, and independent — no central authority, no master server. |
| 3 | **Migration** | Progress travels. Compatible servers can import your save under their own published trust policy ([federation.md](federation.md)). |
| 4 | **Collaborative creation** | Content is a Nostr event. Players author characters, items, structures — later quests and recipes — in-game and publish them for any world to import. AI-assisted creation opens the same pipeline to total beginners: prompt → sats-paid generation → Library ([ai-creation.md](ai-creation.md)). |
| 5 | **Crafting & building** | A player-made economy. All meaningful gear is player-crafted through refinement chains at player-built stations. |
| 6 | **Quests** | Data-driven objectives. Quests are JSON manifests — server-authored or community-published — driving gather/kill/craft/deliver loops with XP, item, and (optionally) sats rewards. |
| 7 | **Social** | Parties, chat channels, clans. Team play is mechanically rewarded (trinity combat), and clans are founder-signed Nostr rosters. |
| 8 | **Sats** | An optional economy. Lightning rewards, trading, and AI generation fees ([ai-creation.md](ai-creation.md)) via NWC, always plugin-tier and operator-opt-in — never pay-to-win by default. |

## Combat, crafting & survival — the sharpened pillars

The sandbox needs a game inside it. These are the design commitments (detail
and examples in [game-design.md](game-design.md)):

- **Player-crafted everything.** All special items, weapons, armor, and
  wearables are player-crafted — an Albion-style player economy with no vendor
  gear by default. If someone is wearing it, someone made it.
- **Crafting chains with a Factorio vibe.** Minecraft-style recipes arranged
  into refinement/production chains: gather (logs, ore, fibers) → refine
  (planks, ingots, cloth) → craft at **player-built stations** (workbench,
  forge, alchemy table — themselves crafted and placed).
- **You are what you wear.** No class picker. Equipped items grant abilities
  and define your role (Albion model): staff + cloth robe = healer/mage,
  sword + shield + plate = tank, daggers/bow + leather = DPS. Swap gear, swap
  class.
- **Spells & abilities.** A data-first ability system — healing, damage,
  buffs, taunts, shields — with mana/stamina costs, cooldowns, and cast times.
- **Trinity team play.** Enemies use threat tables, not nearest-player
  targeting. Tanks taunt, healers sustain, DPS burns — encounter design
  enforces LoL/WoW-style team composition for group content while ambient
  content stays soloable.
- **Survival & renewable ecology (Don't Starve-style).** Players have hunger
  and must eat; food is foraged, **farmed** (plant → grow → harvest), and
  **cooked** by players. Harvests yield seeds, felled trees yield saplings —
  the loop closes, and ambient regrowth backstops player planting so the world
  economy never permanently depletes.

## Rebrand direction

One brand: **Gorilator** is the engine, the network, *and* the flagship world.

- **Gorilator (the engine + network)** — the open-source sandbox, the plugin
  API, the federation protocol, the CLI. What operators run and developers
  extend.
- **Gorilator (the flagship world)** — `game.gorilator.io`, the reference
  server the maintainers run, where new systems land first.
- **"La Crypta Defense" (the first event module)** — today's tower-defense
  loop, extracted into a plugin ([ROADMAP.md](../ROADMAP.md) Phase 3). The
  flagship keeps it enabled; other worlds can disable it, schedule it, or run
  something else entirely.

The pivot messaging is *expansion, not replacement*: nothing players love is
removed — the siege becomes one event among many.

## Module boundaries

The architecture implication of "sandbox, not single game": every loop is a
module against stable seams. The boundaries:

| Module | Owns | Today |
| --- | --- | --- |
| **Identity** | NIP-42 login, npub ↔ player binding, admin auth | exists ([nostr-auth.md](nostr-auth.md)) |
| **Persistence** | PlayerSave, save triggers, restore, wipe policy | exists; policy block lands in Phase 2 |
| **World** | map, props, collision, pathfinding, time scale | exists |
| **Entities** | schema, brains, spawners, entity features | exists ([entities.md](entities.md)) |
| **Items** | item defs, inventory, pickups, drops | exists |
| **Crafting** | recipes, refinement chains, stations, placement | Phase 3 |
| **Quests** | quest manifests, objectives, rewards | Phase 3 |
| **Combat** | damage, abilities, threat, death policy | exists; abilities/threat in Phase 3 |
| **Social** | parties, chat channels, clans | Phase 3/6 |
| **Events** | pluggable game loops (La Crypta Defense first) | Phase 3 (plugin API 1.1) |
| **Dev Mode** | in-game editor, libraries, Feature Lab scenarios | exists; scenarios in Phase 2.5 |
| **Economy** | trading, sats rewards, marketplace experiments | Phase 6, plugin-tier |

Core stays small; loops live in plugins ([plugins.md](plugins.md)); content
stays JSON; the fork rule ([CONTRIBUTING.md](../CONTRIBUTING.md)) keeps every
world upstream-mergeable.

## Resolved questions (defaults)

Decisions that were open during the reframe, now resolved. All are defaults —
operators can change them per world:

| Question | Default |
| --- | --- |
| Is Nostr required? | **Optional for guests, required for persistence/portability.** Anonymous play always works; saves and migration need an npub. |
| What does death cost? | **XP penalty; level persists.** Default death = configurable XP loss (`realm.json` policy block). Hardcore (reset to level 1) and no-penalty modes are config options. |
| What survives a realm reset? | **The character.** Level/XP/stats/inventory persist across wipes by default; the world (waves, structures, resources) resets. Legacy full-wipe is one config line away. |
| What migration mode does the flagship run? | **Inventory-allowlist.** The first public server imports level + allowlisted items from trusted servers ([federation.md](federation.md) trust modes). |
| How do sats enter? | **Quest rewards first, via an NWC plugin.** No custodial wallets, no pay-to-win defaults; all economy code stays plugin-tier. |
| How is content distributed? | **Both Nostr-published and git-based.** Kind-30333 events / realm packs for community content, git for core content — the same JSON either way. |

## North star

> **An open-source Nostr MMORPG sandbox where anyone can run a world, create
> content, and let players carry identity and progress across compatible
> servers.**

Every roadmap item either makes the world deeper, the network bigger, or the
player more sovereign — ideally all three.
