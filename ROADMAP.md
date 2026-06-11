# Roadmap

The phased plan from tower-defense brawler to **open Nostr MMORPG sandbox**
([docs/vision.md](docs/vision.md)). Design detail:
[docs/game-design.md](docs/game-design.md) ·
[docs/federation.md](docs/federation.md) ·
[docs/feature-lab.md](docs/feature-lab.md) ·
[docs/engineering.md](docs/engineering.md) ·
[docs/ai-creation.md](docs/ai-creation.md).

> **Sizing:** S/M/L assume a solo dev + AI agents + community contributors —
> not a studio. **Definition of Done for every feature:** code + an isolated
> [Feature Lab](docs/feature-lab.md) scenario + bot self-test + tweak knobs +
> docs. Phases overlap; ordering within a phase is a suggestion, dependencies
> are not.

| Phase | Theme | Status |
| --- | --- | --- |
| 1 | Vision & reframe | ✅ done (this PR) |
| 2 | Persistence first | 🔨 in progress |
| 2.5 | Feature Lab | next |
| 3 | Modular game loops + RPG combat core | planned |
| 4 | Collaborative creation | planned |
| 5 | Federation | planned |
| 6 | Social + economy | sketch |

---

## Phase 1 — Vision & reframe ✅

Done by this PR: [docs/vision.md](docs/vision.md),
[docs/game-design.md](docs/game-design.md), this roadmap,
[docs/federation.md](docs/federation.md) (draft v0),
[docs/strategy.md](docs/strategy.md), [docs/feature-lab.md](docs/feature-lab.md),
and the README/docs repositioning ("La Crypta Defense" = first event module).

## Phase 2 — Persistence first 🔨

The smallest change that makes the new identity true: **your character
outlives the realm.**

| Workstream | Size | Notes |
| --- | --- | --- |
| Realm policy module | S | `realm.json` `policy` block → `packages/server/src/systems/policy.ts`: validated, sanitized, logged |
| Configurable death penalty | S | `death.mode`: `none` \| `xp-penalty` (configurable fraction, default 30%) \| `hardcore` |
| Wipe decoupling | M | realm reset keeps level/XP/stats/inventory by default; world state (waves, house, enemies, resources) still resets; legacy full-wipe = one config line |
| Save on realm end | S | every verified npub gets a `realm-end` save before the wipe |
| Client wipe banner copy | S | "the realm resets — your character endures" (policy-aware) |

New default = **persist** ("level persists, death hurts but does not erase").
Known follow-up: wave difficulty scales with player level, so persistent
veterans make fresh waves harder — tuning knobs are the relief valve until
Phase 3 event-module difficulty config.

## Phase 2.5 — Feature Lab

Built **before** Phase 3 — every later feature's Definition of Done depends on
it. Full design: [docs/feature-lab.md](docs/feature-lab.md).

| Workstream | Size | Notes |
| --- | --- | --- |
| Scenario manifest + loader | M (core) | `scenarios/<feature>.json` layered over realm.json/DevTuning; disables events, stages world/items/loadout |
| Scenario runner | S/M | `pnpm scenario <name>` + `?scenario=` dev URL param; auto-join single-player |
| timeScale audit | S/M | all gameplay timers respect `state.timeScale` so accelerated simulation works end-to-end |
| Bot driver v1 | M | scripted player behaviors + state assertions; reuses the brain registry + bench harness; headless and live |
| Scenario tweaks panel + feature-dev skill | S | Dev Mode "Scenario tweaks" section; `.claude/skills/feature-dev` pipeline + feature issue template |
| Seeded deterministic RNG service | M | per-realm-cycle seed, injectable PRNG replacing scattered `Math.random()` in gameplay systems — makes bot self-tests, replays, and bench runs reproducible ([docs/engineering.md](docs/engineering.md) §3) |

## Phase 3 — Modular game loops + RPG combat core

Every workstream ships with its scenario + bot self-test per the Feature Lab
DoD. Design detail per system: [docs/game-design.md](docs/game-design.md).

| Workstream | Size | Notes |
| --- | --- | --- |
| Plugin API 1.1 | M (core) | `registerEventModule({id, autoStart, onStart, onTick, onEnd})`, `EventModuleContext` (`setEventHud`, `endEvent`), host-owned `PluginWorld` mutators (`spawnEnemy`, `spawnStructure`, `giveItem`, `grantXp`, `broadcast`); new lifecycle events `realm:start`, `event:start/end`, `objective:complete` |
| One batched schema change | S/M (core) | do once: `GameState` +`eventId/eventLabel/eventTimerMs/eventProgress`; `Player` +`mana/maxMana`, `hunger/maxHunger`, synced visible-gear fields (`gearWeapon/gearHead/gearChest/gearBoots`) — shared rebuild + client hard reload |
| Extract `plugins/la-crypta-defense/` | L | wave orchestration, `checkHomeFall`, house spawn/regen, scheduler + `waves.json` move into the plugin; brains/schema/combat stay core; `realm.json` gains `events: {enabled, autoStart}`; flagship keeps it on |
| De-tower-defense rename refactor | S/M | dedicated rename-only PRs, characterization tests first: `goblins.ts` → generic `enemyAi.ts` + wave scheduler into the event plugin, generic objective structure, GameRoom slimming ([docs/engineering.md](docs/engineering.md) §4) |
| Default sandbox loop | M | `realm:start` without a house; ambient spawner/resource tuning; passive/patrol brains |
| Equipment & wearables | L | equipment defs in items.json `{slot, tier, stats, abilities[], durability}`; `systems/equipment.ts`; single stat-recompute path (base + level + gear); durability loss on death (ties into Phase 2 policy); `PlayerSave` v2 +`equipment[]` +`mana`; crafting-only gear |
| Crafting v1 — recipes + chains | L | `recipes.json` (inputs/output/station/craftMs/xp/tier); `systems/crafting.ts`; **stations = craftable, placeable structures** (absorbs the building workstream: `placeable` flag, `place` message, spawns into `state.structures`); v1 builds last until realm reset |
| Survival: hunger, food & farming | M/L | `systems/hunger.ts` drain (rate = realm knob, 0 disables) + starvation effects; food defs eaten via item-use; cooking rides crafting; farming: `plantable` items → growth timer → harvest (extends resource regrow); harvests yield seeds; hunger HUD |
| Abilities & spells | L | `abilities.json` (damage/heal/buff/taunt/shield; mana/stamina cost; cooldown/range/AoE/cast time); `systems/abilities.ts` (cast validation, cooldowns, effects, threat); abilities granted by gear → classes from wearables; action bar UI |
| Trinity combat & threat | M | enemy targeting: nearest-player → per-enemy threat tables (damage/healing/taunt generate threat); elite/boss archetypes in entity-features.json; ambient content stays soloable |
| Parties | M | moved up from Phase 6 — prerequisite for trinity play: invite/accept, transient server-side party map, shared-XP radius, party frames (hp/mana) |
| Quests | L | `quests.json` (giver, prerequisites, gather/kill/craft/deliver/reach objectives, rewards {xp, items, sats}); `systems/quests.ts` driven by plugin events + new `item:crafted`; per-session state + owner-only send (inventory pattern, **no schema change**); `PlayerSave` v2 `quests[]`; quest log UI; Dev Mode quest editor (`/__quests/*`) |

**Suggested solo-dev sequencing:** event-module extraction first (unblocks
everything) → equipment → crafting chains → survival (hunger/food/farming —
rides crafting) → abilities → threat/trinity → parties → quests. Each is
independently shippable; gear/abilities/threat form the combat arc; survival
gives the sandbox its day-to-day loop while combat is built; quests can land
any time after equipment.

## Phase 4 — Collaborative creation

Community content beyond models — quests and recipes are pure JSON (no Blossom
assets), the easiest community content type and a good early win. Then the
**AI Forge** ([docs/ai-creation.md](docs/ai-creation.md)): prompt-to-content
creation, sats-paid, landing in the same Library/publish flow.

| Workstream | Size | Notes |
| --- | --- | --- |
| Extend kind-30333 `CommunityEntity` | M | `type: "quest" \| "recipe"` ([docs/community-entities.md](docs/community-entities.md)) |
| EntityCreator wizards | M | form wizards for quests/recipes in the in-game Library |
| Curation | S/M | `realm.json` `content: {authors, blockedIds}` + NIP-98 admin endpoint to hot-add trusted authors |
| Docs | S | extend community-entities.md |
| Forge provider interface + Meshy creature pipeline | L | `ForgeProvider` API + first provider: ONE text prompt → model → auto-rig → auto-animate (every engine anim slot: idle/walk/hit/attack/death) → Local library — no rigging/animation knowledge needed ([docs/ai-creation.md](docs/ai-creation.md) §3.1) |
| LLM data-content generator | M | schema-constrained JSON output — stats, items, recipes, drop tables, quests — the same manifests Dev Mode writes, validated before preview |
| Sats payment rail via NWC | M | per-generation Lightning pricing, paid before the job runs; operator BYO keys = free for their community |
| Hosted Forge experiment + operator BYO keys | M | managed-realms-style revenue rail: operators point at a hosted Forge instead of holding provider keys ([docs/strategy.md](docs/strategy.md)) |
| Forge-in-scenario test-drive | S | generated content auto-staged in a Feature Lab scenario before saving ([docs/feature-lab.md](docs/feature-lab.md)) |

## Phase 5 — Federation

Pragmatic v1: **relays as transport, server signatures as trust — no
server-to-server HTTP.** Full draft spec: [docs/federation.md](docs/federation.md).

| Workstream | Size | Notes |
| --- | --- | --- |
| Server policy event | M | kind 30078, `d: gorilator-server-policy`, published alongside discovery from `systems/realms.ts`; content: deathPolicy, progression, migration (accepts/trustedServers/level + gear-tier caps/item rules), events, economy; source of truth = `realm.json` `federation` block; landing renders policy badges |
| Migration v1 | M | join-time import: no own save → query trusted servers' saves → sanitize + clamp per policy → import → publish own save (`migrated-in`) → publish transfer receipt (kind 30334) |
| Session locking | S/M | ephemeral kind 21333 heartbeat (~30s) per logged-in npub; refuse join on a fresh foreign heartbeat |
| Item namespace sanitizer | S | strip/translate unknown item ids on import |
| `docs/federation.md` spec | S | ✅ draft v0 ships with this PR |

## Phase 6 — Social + economy (sketch)

| Workstream | Size | Notes |
| --- | --- | --- |
| Chat channels | M | local/global/party/clan routing on the existing `chat` message |
| Clans | L | kind 30335 founder-signed roster; one synced `clanTag` field (batch with another schema release) |
| Trading | M | two-phase server-authoritative swap — high-value once gear is player-crafted |
| Lightning | L | optional per policy: NWC client in `plugins/lightning-economy/`; quest reward type `sats` zaps the player's lud16; **all economy code in a plugin** |

---

## Proposed Nostr kind / d-tag allocation

Reuse 30078/30333 with new d-tags/type values wherever possible; new kinds only
where semantics demand it. Full event formats: [docs/federation.md](docs/federation.md).

| Kind | d tag / discriminator | Author | Status | Purpose |
| --- | --- | --- | --- | --- |
| 30078 | `gorilator-save-v1:<player-pubkey>` | server | **existing** | latest player save |
| 30078 | `gorilator-player-realm-v1:<realm>:<pk>` | server | **existing** | per-realm player update |
| 30078 | `gorilator-server` | server | **existing** | server discovery/status |
| 30078 | `gorilator-server-policy` | server | proposed (P5) | published server policy |
| 30333 | `gorilator-entity-v1:<id>` | player | **existing** | community entity; +`type: quest\|recipe` proposed (P4) |
| 30334 | `gorilator-transfer-v1:<pk>` | server | proposed (P5) | migration transfer receipt |
| 21333 | — (ephemeral) | server | proposed (P5) | session heartbeat / lock |
| 30335 | `gorilator-clan-v1:<id>` | clan founder | proposed (P6) | clan roster |
