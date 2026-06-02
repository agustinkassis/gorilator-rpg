# Gorilator — Documentation

**Gorilator** is an online, isometric, low-poly multiplayer **tower-defense brawler**.
Players are gorillas defending **La Crypta** (the house at the centre of the map)
against escalating waves of goblins. Survive as long as you can — when La Crypta
falls, everyone is wiped back to level 1 and a fresh game (a "realm") begins.

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
| [getting-started.md](getting-started.md) | Prerequisites, install, the dev loop, build, the `@rpg/shared` rebuild gotcha, env, deploy pointers |
| [architecture.md](architecture.md) | Monorepo layout, the three packages, the authoritative-server networking model, the simulation tick, full directory tree |
| [gameplay.md](gameplay.md) | The tower-defense loop in depth: waves, goblin AI, defenders, combat, leveling, sprint/stamina, items, resources, the wipe & realms |
| [entities.md](entities.md) | Every world object + its synchronized fields + behaviour (player, goblin, dummy, La Crypta, tree, rock, stone, log, potion, banana) |
| [configuration.md](configuration.md) | The `constants.ts` tuning reference, environment variables, and the runtime JSON config files (props, spawners, characters, audio, resources) |
| [nostr.md](nostr.md) | All Nostr events: login challenge, server-signed player saves, and the server/realm **discovery** event (+ the public HTTP API) |

Related top-level docs: [`../README.md`](../README.md) (quick start + stack),
[`../REALMS.md`](../REALMS.md) (realm/discovery spec for external apps),
[`../DEPLOY.md`](../DEPLOY.md) / [`../RAILWAY.md`](../RAILWAY.md) (hosting).

> Source of truth: this documentation describes the code, but tuning values live in
> `packages/shared/src/constants.ts` and schemas in `packages/shared/src/schema/`.
> When in doubt, those files win.
