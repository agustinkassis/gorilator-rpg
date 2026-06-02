# Architecture & structure

## Monorepo

```
rpg-online/
├─ packages/
│  ├─ shared/   @rpg/shared — schema + types + constants (built to dist/, imported by both)
│  ├─ server/   @rpg/server — authoritative Colyseus server (Node, tsx)
│  └─ client/   @rpg/client — Babylon.js + Vite browser client
├─ cli/         gorilator CLI (self-host: docker compose + Cloudflare tunnel)
├─ docs/        this documentation
├─ REALMS.md    realm/server discovery spec (external apps)
└─ DEPLOY.md / RAILWAY.md   hosting
```

## Networking model — authoritative server + interpolation

- The **client sends intents only**: `move{x,z}`, `attack{targetId}`, `throw{x,z,power,item}`,
  `pickup{id}`, `sprint{on}`, inventory ops, and dev-mode edits.
- The **server runs the simulation** at a fixed **20 Hz** tick (`TICK_RATE`). It
  owns movement (A* pathfinding + collision), combat, goblin AI, waves, resources,
  and writes everything into the Colyseus **schema state**, which auto-syncs to all
  clients.
- The **client renders from synced state**, lerp-interpolating positions each frame
  and driving an animation FSM (idle/walk/attack/hit/death) from the synced `state`
  field. The local isometric camera follows the local player.
- **Events** (transient, not state) are broadcast as Colyseus messages: `damage`,
  `heal`, `xp`, `banana_throw`, `chat`, `wipe`, and per-owner `inventory`.

The single room class is `GameRoom` (`server/src/rooms/GameRoom.ts`); the room name
is `ROOM_NAME` (`"game"`). One game world = one room.

### The simulation tick (`GameRoom.onCreate → setSimulationInterval`)

Each tick (scaled by `state.timeScale` for Dev-Mode pause/slow-mo) runs, in order:
`stamina → movement (+ghost while paused) → combat → goblin AI → waves → spawners →
pending throws → tree/rock regrow → potion respawn → bananas → item pickup/auto-grab
→ checkHomeFall (the wipe) → save triggers → realm tracker`.

## `@rpg/shared`

The contract both sides compile against. Key modules:

- `schema/*` — Colyseus `Schema` classes (`Player`, `Enemy`, `Potion`, `Tree`,
  `Log`, `Rock`, `Stone`, `Banana`, `House`) and the root `GameState`. See
  [entities.md](entities.md).
- `types.ts` — `AnimState` enum, `ItemType`, `InventorySlot`, `PlayerSave`, and the
  client→server **message** + server→client **event** interfaces.
- `constants.ts` — all tuning. See [configuration.md](configuration.md).
- `obstacles.ts` — the static collision circles (crates + the house footprint).

> Built with `tsc` (decorators) to `dist/`. **Rebuild after editing** (see
> [getting-started.md](getting-started.md)).

## `@rpg/server` (systems)

Game logic is a set of systems in `server/src/systems/`, each a function over
`GameState`:

| System | Responsibility |
| --- | --- |
| `movement` | advance players along A* paths; depenetrate from obstacles; ghost free-roam while paused |
| `pathfinding` | grid A* + line-of-sight string-pulling + `depenetrate` + dynamic obstacle set |
| `combat` | melee attacks, damage formula, death/respawn, dummy spawns |
| `goblins` | wave spawner (`waveSystem`), goblin AI (march → fight → attack home), `resetWaves` |
| `bananas` | banana/stone spawn, charged throw flight, landing damage (incl. the house) |
| `houses` | spawn La Crypta |
| `resources` | spawn/regrow trees & rocks, item pickup, auto-grab |
| `pickups` | health potions |
| `inventory` | per-player inventory ops (off-state, sent only to the owner) |
| `leveling` | award XP, per-level stat growth, death XP penalty |
| `stamina` | sprint resource drain/regen |
| `separation` | keep crowded entities from overlapping |
| `spawners` / `resourceDrops` | dev-placed object spawners + drop tables (live-reload JSON) |
| `devEdit` | Dev-Mode relocate/delete/retune of synced entities |
| `nostr` / `nostrIdentity` / `nostrSave` | login verification, server key, server-signed saves |
| `realms` | realm lifecycle, lifetime stats, the Nostr discovery event, `/api/*` |

`server/src/index.ts` wires Express (HTTP: `/healthz`, `/nostr/challenge`,
`/api/status`, `/api/realm`, the `/colyseus` monitor) + the Colyseus WebSocket
transport, and resolves the server's Nostr identity at boot.

## `@rpg/client` (structure)

| Dir | Contents |
| --- | --- |
| `scene/` | engine, isometric ortho camera, ground, environment, shadows |
| `entities/` | `CharacterFactory` (loads/instances rigged glb), `Entity` (interpolation + anim FSM), `AnimationController`, low-poly model builders in `entities/models/` |
| `game/` | `Game` — owns all world objects, maps Colyseus callbacks → meshes, runs throw/collect/FX |
| `net/` | `NetworkClient` (Colyseus connect + state callbacks), Nostr (NIP-07) helpers |
| `input/` | click-to-move/attack, hold-to-sprint |
| `ui/` | HUD, health globe, XP/stamina bars, **home bar** (siege objective), hotkeys, inventory, minimap, chat, character sheet, splash, audio controls |
| `audio/` | self-contained Web Audio engine (spatial SFX + procedural fallback + music) |
| `fx/` | particle systems (lightning, blood, explosion, banana trail, damage flash) |
| `dev/` | in-game Dev Mode world editor + model/prop/character importers |

`client/src/main.ts` bootstraps everything: engine → scene → UI → `Game` → connect,
then the render loop drives `game.update(dt)` + the HUD from synced state.
