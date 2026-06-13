# Gorilator — Documentation

**Gorilator** is an open-source **Nostr MMORPG sandbox** — an online, isometric,
low-poly multiplayer world where anyone can run a server and players carry their
identity and progress on Nostr ([vision.md](vision.md)). Its first **event
module** ("La Crypta Defense") is a tower-defense brawl: gorillas defending
**La Crypta** (the house at the centre of the map) against escalating waves of
goblins. When La Crypta falls the world resets and a fresh cycle (a "realm")
begins — by default your character's progression persists across resets.

- **Engine:** Babylon.js (3D, orthographic isometric camera)
- **Multiplayer:** Colyseus (authoritative server, automatic state sync)
- **Language/build:** TypeScript + Vite, in a pnpm monorepo
- **Identity/persistence:** optional Nostr login; the server signs each player's
  progress to relays and announces itself for discovery

## The loop in one paragraph

Click the ground to move (server-pathfound around obstacles), left-click an enemy
to attack, hold **Q** to charge and throw a banana/stone. Goblins spawn a ~30-second
march from La Crypta and converge on it, fighting any defender who engages them.
Killing goblins grants XP → levels → bigger stats. Every wave the rest period grows
(2.5 min, 3 min, 3.5 min…). If the goblins destroy La Crypta, the **wipe** resets all
players (level 1, fresh inventory), rebuilds the house, and starts the next realm.

## Documentation map

| Doc | What's inside |
| --- | --- |
| [vision.md](vision.md) | **The vision**: the open Nostr MMORPG sandbox — product thesis, the eight pillars, rebrand direction ("La Crypta Defense" = first event module), module boundaries, resolved defaults |
| [game-design.md](game-design.md) | Combat / crafting / survival design: equipment slots, classes from wearables, abilities & spells, trinity threat combat, crafting chains & stations, hunger/farming/ecology |
| [federation.md](federation.md) | **DRAFT v0** cross-server protocol: save/discovery/policy events, the relay-mediated migration handshake, session locking, trust modes, transfer receipts, kind allocation |
| [strategy.md](strategy.md) | Public business/growth strategy: positioning, business model, grants-first funding sequence, the 8-week rebrand launch, partnerships, metrics & targets |
| [feature-lab.md](feature-lab.md) | The scenario harness + AI dev pipeline: per-feature simulation scenarios, time shift, tweak panel, bot self-tests, and the Definition of Done |
| [engineering.md](engineering.md) | Engineering conventions & refactor direction: the terminology glossary, code conventions, the seeded-RNG direction, the rename/refactor map, interoperability principles |
| [ai-creation.md](ai-creation.md) | **The AI Forge**: prompt-to-content creation — sats-paid generation of creatures (Meshy), items, recipes, and quests, landing in the existing Library/publish flow |
| [getting-started.md](getting-started.md) | Prerequisites, install, the dev loop, build, the `@rpg/shared` rebuild gotcha, env, deploy pointers |
| [plugins.md](plugins.md) | **The plugin system**: data vs code tiers, the `@rpg/shared` plugin API (brains, items, systems, events), plugin.json, the Vite bundler, Nostr realm packs, `realm.json`, fork rules |
| [presentations/how-plugins-work.pptx](presentations/how-plugins-work.pptx) | 🚧 *Under development* — a 10-slide intro deck to the plugin system (tiers, manifest, discovery, hooks, realm packs, safety rails, CLI) |
| [TESTING.md](TESTING.md) | The four test layers: Vitest unit/characterization tests, Playwright game smoke, the bench gate, CI — and the "DOM not canvas" rule |
| [DEBUGGING.md](DEBUGGING.md) | The debugging toolkit (F3, `__perf`, `/api/perf`, Colyseus monitor, auto-captured stutters) + the troubleshooting table |
| [architecture.md](architecture.md) | Monorepo layout, the three packages, the authoritative-server networking model, the simulation tick, full directory tree |
| [gameplay.md](gameplay.md) | The tower-defense loop in depth: waves, goblin AI, defenders, combat, leveling, sprint/stamina, items, resources, the wipe & realms |
| [entities.md](entities.md) | Every world object + its synchronized fields + behaviour (player, goblin, dummy, La Crypta, tree, rock, stone, log, potion, banana) |
| [configuration.md](configuration.md) | The `constants.ts` tuning reference, environment variables, and the runtime JSON config files (props, spawners, characters, audio, resources) |
| [performance.md](performance.md) | The perf pipeline: the F3 overlay, tagging any work, recording benchmarks, the JSONL data format, and the `pnpm perf` analyzer (FPS / CPU / GPU / memory) |
| [performance-research.md](performance-research.md) | The living benchmarking **process**, standard scenarios, dated **findings log**, and the prioritized **optimization backlog** (continuous perf research) |
| [nostr.md](nostr.md) | All Nostr events: login challenge, server-signed player saves, the server/realm **discovery** event (+ the public HTTP API), and user-published **community entities** (kind 30333) |
| [community-entities.md](community-entities.md) | Player-published characters/structures/items: the Library's Local/Community split, the kind-30333 event + `CommunityEntity` schema, Blossom asset hosting, the pending/commit lifecycle, and creator profile pages |
| [nostr-auth.md](nostr-auth.md) | **Authentication** with Nostr keys: player login (NIP-42 kind 22242) and admin HTTP auth (NIP-98 kind 27235), the trust model, and how to call protected endpoints |
| [versioning.md](versioning.md) | SemVer policy: per-package versions + the umbrella **app** version, the `pnpm bump` tool, and the CI version guard |
| [publishing-cli.md](publishing-cli.md) | How the `gorilator` CLI is auto-published to npm on each GitHub Release via CI (OIDC Trusted Publishing, no token), plus the release checklist |
| [admin.md](admin.md) | The admin list (`ADMIN_NPUBS`) + NIP-98-protected `/api/admin/*` API, and the admin "Update now" self-update button on the splash |

Related top-level docs: [`../README.md`](../README.md) (quick start + stack),
[`../ROADMAP.md`](../ROADMAP.md) (the public phased roadmap, S/M/L sized),
[`../CONTRIBUTING.md`](../CONTRIBUTING.md) (the complete dev workflow: setup →
verify → PR, fork rules, AI-assisted development),
[`../REALMS.md`](../REALMS.md) (realm/discovery spec for external apps),
[`../DEPLOY.md`](../DEPLOY.md) / [`../RAILWAY.md`](../RAILWAY.md) (hosting).

> Source of truth: this documentation describes the code, but tuning values live in
> `packages/shared/src/constants.ts` and schemas in `packages/shared/src/schema/`.
> When in doubt, those files win.
