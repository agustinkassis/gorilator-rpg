# Vision: Open Nostr MMORPG Sandbox

## Intent

Reframe Gorilator from a tower-defense brawler into an open-source multiplayer
online RPG sandbox: a persistent world where players can level, craft, quest,
build, socialize, battle, and move across independently operated servers.

The target inspiration set is:

- **Albion Online** for crafting, gathering, player economy, and sandbox loops.
- **World of Warcraft** for quests, progression, zones, parties, and social RPG
  structure.
- **Helbreath** for the feeling of players gathering in towns, talking, trading,
  forming groups, and creating emergent community moments.

The tower-defense loop should become one optional event module. It can be added
to a server, removed from a server, or run as a temporary activity inside a broader
RPG world. It is not the core identity of the game.

## Product Thesis

The game is a Nostr-first open MMORPG framework where:

- Anyone can run a server.
- Anyone can create entities, items, quests, events, NPCs, and server logic.
- Players own a portable identity through Nostr.
- Progress can persist beyond one server when servers choose to trust or accept it.
- Communities can form their own worlds, clans, economies, rules, and difficulty.
- Sats can be used for missions, rewards, access, trading, or community mechanics.

The goal is not only to make one game server. The goal is to build a collaborative
game network.

## Core Pillars

### 1. Persistent Player Identity

Players should connect with Nostr as the primary identity layer.

The player profile should be tied to a Nostr pubkey, with optional metadata from
kind 0 and game-specific state from app-specific events or server-signed saves.

Baseline persistent fields:

- Character name and visual profile.
- Level and XP.
- Core stats.
- Inventory, when the receiving server permits it.
- Quest progress, when compatible.
- Clan or social membership, when compatible.
- Server history and reputation.

Death should not wipe the character. Death may subtract XP, apply durability loss,
drop some inventory, create a respawn timer, or trigger server-specific penalties.
The default rule should be: level persists, progress matters, death hurts but does
not erase the player.

### 2. Server Sovereignty

Each server is sovereign. It can decide:

- Which item definitions it accepts.
- Which external player saves it accepts.
- Which quests, entities, and scripts are enabled.
- Whether imported inventory is allowed.
- Whether imported levels are allowed.
- Whether sats mechanics are enabled.
- Whether PvP, clans, raids, crafting, or tower-defense events are enabled.

This matters because different servers may have different difficulty, custom item
sets, economies, balance, or rules. A hardcore server should not be forced to accept
overpowered items from an easy server.

The architecture should treat portability as negotiated, not automatic.

### 3. Optional Player Migration

Players should be able to move between servers when both sides allow it.

Migration can include:

- Identity verification through Nostr.
- Proof that the source server currently owns the active session.
- A transfer handshake between source and destination servers.
- Optional transfer of level, XP, stats, inventory, quest state, or clan state.
- A policy check on the destination server.
- A session lock so the same player is not active on multiple cooperating servers
  at the same time.

Migration should support several trust modes:

- **Identity only:** the player moves, but starts with server-local stats/items.
- **Level import:** level and XP are accepted, inventory is not.
- **Inventory allowlist:** only known item IDs or categories are accepted.
- **Full trusted transfer:** level, stats, inventory, and quest state are accepted
  from a trusted source server.
- **No migration:** the server is isolated.

### 4. Collaborative World Creation

Dev Mode should evolve from an internal editor into a collaborative creation layer.

Creators should be able to define:

- NPCs and enemies.
- Resource nodes.
- Crafting recipes.
- Items and equipment.
- Buildings and destructible structures.
- Quest chains.
- Dialogues.
- Events.
- Spawn rules.
- Server-specific balance.
- Visual placements and imported models.
- Custom logic hooks, with sandboxing.

The game should be designed so contributors can join, create content, test it live,
and publish it as reusable server modules.

### 5. Crafting And Building

Crafting should become one of the central loops.

A baseline loop:

1. Gather resources.
2. Refine materials.
3. Craft tools, weapons, armor, consumables, furniture, or building parts.
4. Use crafted items to fight, trade, complete quests, or build.
5. Upgrade skills and unlock better recipes.

Building should let players and communities create persistent spaces:

- Houses.
- Guild halls.
- Shops.
- Crafting stations.
- Defensive structures.
- Quest hubs.
- Event arenas.

Server operators should be able to decide whether buildings are permanent,
decay over time, require upkeep, or can be destroyed.

### 6. Quests And User-Created Missions

Quests should be first-class content and should be creatable from Dev Mode.

Quest types:

- Talk to NPC.
- Gather resource.
- Craft item.
- Deliver item.
- Explore location.
- Defeat enemy.
- Defend structure.
- Participate in event.
- Pay or receive sats.
- Join clan or party.
- Multi-step story chain.

Quest definitions should be data-first where possible, with optional scripted hooks
for advanced servers.

### 7. Social World And Clans

The game should create places where players stay, talk, trade, and form groups.

Important social surfaces:

- Towns and safe zones.
- Local chat.
- Global or server chat.
- Clan chat.
- Trading.
- Party system.
- Clan/guild system.
- Shared buildings.
- Community events.

Helbreath-style social presence matters: players should have reasons to gather in
the world even when they are not fighting.

### 8. Sats Integration

Sats should be available as a native optional layer, not mandatory for every server.

Possible uses:

- Quest rewards.
- Entry fees for tournaments or events.
- Clan treasury.
- Crafting fees.
- Player-to-player tips.
- Marketplace settlement.
- Server donations.
- Bounties.
- Paid missions.

Bitcoin/Lightning should not turn the game into pay-to-win by default. Each server
must choose its economic rules, and the default open-source server should bias
toward fairness and experimentation.

## Rebrand Direction

The current identity is too narrow: tower-defense brawler. The new identity should
signal:

- Open world.
- Multiplayer RPG.
- Nostr identity.
- Community servers.
- User-generated content.
- Crafting and persistent progression.
- Open-source collaboration.

Working positioning:

> An open-source Nostr MMORPG sandbox where anyone can run a world, create content,
> and let players carry identity and progress across compatible servers.

Potential naming directions:

- Keep **Gorilator** as the first world or reference server.
- Rename the engine/framework separately from the first server.
- Treat "La Crypta defense" as one event module inside the broader game.

Example split:

- Engine/framework: the open MMORPG toolkit.
- Default world/server: Gorilator.
- Event module: La Crypta Defense.

## Architecture Implications

### Current Strengths To Preserve

- TypeScript monorepo.
- Authoritative Colyseus server.
- Babylon.js isometric client.
- Shared schemas and typed messages.
- Nostr login and server-signed saves.
- Dev Mode world editing.
- Runtime config files for props, spawners, waves, resources, structures, and
  characters.

### Refactor Direction

The current game loop is centered on defending one home structure. The refactor
should separate engine primitives from game modules.

Suggested module boundaries:

- **Identity:** Nostr login, profiles, active-session lock, server trust.
- **Persistence:** player saves, server-signed snapshots, migration payloads.
- **World:** maps, zones, structures, terrain, resources.
- **Entities:** players, NPCs, enemies, pets, summons.
- **Items:** definitions, inventory, equipment, durability, transfer policy.
- **Crafting:** recipes, stations, skills, resource transformations.
- **Quests:** quest definitions, objectives, rewards, state machine.
- **Combat:** PvE, PvP, damage formulas, death penalties.
- **Social:** chat, parties, clans, trading.
- **Events:** tower defense, raids, tournaments, seasonal activities.
- **Dev Mode:** collaborative editor, permissions, publishing pipeline.
- **Economy:** sats, marketplace, rewards, treasury.

Tower defense should live under **Events**, not as the root game loop.

## Server Federation And Handshake

When a player migrates from Server A to Server B:

1. Player authenticates to Server B with Nostr.
2. Server B asks whether this player has an active source server.
3. If the player requests migration, Server B contacts Server A.
4. Server A verifies the player is active there and signs a transfer payload.
5. Server B validates:
   - source server identity
   - payload signature
   - freshness
   - player pubkey
   - transfer policy
   - item allowlist
   - level/stat policy
6. If accepted, Server B creates the player session.
7. Server A locks or releases the old session.
8. Server B becomes the active server for cooperating peers.

The system should avoid one Nostr pubkey playing in multiple cooperating servers
at the same time when migration is enabled. Isolated servers can ignore this.

## Save And Transfer Policy

Every server should publish a policy document:

- Server name and Nostr pubkey.
- Accepted source servers.
- Accepted item namespaces.
- Accepted max level or stat caps.
- Accepted quest namespaces.
- Whether inventory import is enabled.
- Whether sats balances or claims are recognized.
- Death and PvP rules.
- Economy rules.
- Required client version or protocol version.

Players and other servers can inspect this before transfer.

## Roadmap

### Phase 1: Vision And Reframe

- Update docs to describe the broader MMORPG sandbox vision.
- Rename tower-defense docs as current/default event, not final product identity.
- Define engine vs default world vs event modules.
- Decide whether Gorilator remains the world name or becomes the whole project name.

### Phase 2: Persistence First

- Make Nostr login the default path.
- Stabilize server-signed player saves.
- Preserve level and XP across sessions.
- Change death from full wipe to XP penalty or configurable death policy.
- Keep tower-defense wipes from resetting global player progression.

### Phase 3: Modular Game Loops

- Extract tower-defense into an event module.
- Add quest schema and basic quest objectives.
- Add crafting recipes and resource refinement.
- Add persistent building primitives.

### Phase 4: Collaborative Creation

- Expand Dev Mode into a content creation tool.
- Support quest creation.
- Support item and recipe creation.
- Support server modules or content packs.
- Add permissions for creators/admins.

### Phase 5: Server Network

- Publish server policy documents.
- Implement server-to-server handshake.
- Support optional migration.
- Add active-session locking across cooperating servers.
- Add item/level import policy checks.

### Phase 6: Economy And Community

- Add clans.
- Add trading.
- Add sats-enabled quests or bounties.
- Add marketplace experiments.
- Add public server discovery through Nostr.

## Open Questions

- What is the final name: Gorilator, a new engine name, or a split identity?
- Should Nostr be mandatory for all persistent characters, or only for portable
  characters?
- What is the default death penalty?
- Which item transfer mode should the first public server allow?
- Should sats be integrated at the protocol layer first, or start as quest rewards?
- How much scripting should creators get, and how do we sandbox it?
- Should content packs be Nostr-published, git-based, or both?

## One-Line North Star

Build an open-source Nostr MMORPG sandbox where communities can run worlds,
collaboratively create content, and let players carry identity and compatible
progress across servers.
