# Gorilator — Defend La Crypta

An isometric low-poly multiplayer brawler: click-to-move, an animation state
machine (idle / walk / attack / hit / death), and **live multiplayer** — open two
browser tabs and you'll see both gorillas move and fight in real time.

## Deploy

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/REPLACE_WITH_TEMPLATE_ID)

- **Self-host (native, no Docker):** `npx gorilator install` clones, builds, and runs the game as a boot service; `gorilator setup` adds a Cloudflare tunnel on your own subdomains. See [DEPLOY.md](DEPLOY.md).
- **Railway (one click):** a single service serves the client **and** the multiplayer server — no variables to set. See [RAILWAY.md](RAILWAY.md).

## Stack

| Layer | Tech |
|-------|------|
| Render engine | **Babylon.js** (3D, orthographic isometric camera) |
| Multiplayer | **Colyseus** (authoritative rooms, automatic state sync) |
| Language / build | **TypeScript** + **Vite** |
| Monorepo | **pnpm** workspaces (`shared` schema imported by client + server) |

```
packages/
  shared/   @rpg/shared — Colyseus schema + types + constants (used by client AND server)
  server/   @rpg/server — Colyseus authoritative game server (default port 2567)
  client/   @rpg/client — Babylon.js + Vite browser client (default port 5173)
```

## Run it

```bash
pnpm dev          # installs missing deps, then starts server + client
```

Then open the client URL printed by `pnpm dev` (default: <http://localhost:5173>).

- **Left-click the ground** → your knight walks there (walk → idle on arrival).
- **Left-click a training dummy** (or another knight) → approach + attack; target plays hit, HP drops, dies, respawns.
- **Open a second tab** → a second knight appears; movement/combat sync across both.
- Live room state inspector: the monitor URL printed by `pnpm dev`
  (default: <http://localhost:2567/colyseus>).

## Documentation

Full docs live in [`docs/`](docs/README.md): [getting started](docs/getting-started.md),
[architecture & structure](docs/architecture.md), [game dynamics](docs/gameplay.md),
[entities & objects](docs/entities.md), [configuration & tuning](docs/configuration.md),
and [Nostr events](docs/nostr.md). Server/realm discovery for external apps: [REALMS.md](REALMS.md).

## Character model

The demo runs out of the box with a **capsule placeholder** (procedural idle/walk/attack/hit/death feedback).
To use the real low-poly knight, drop a glTF binary at:

```
packages/client/public/models/knight.glb
```

It must contain animation groups whose names contain `idle`, `walk` (or `run`),
`attack`, `hit` (or `damage`/`recieve`), and `death` (or `die`). Recommended free CC0 source:
**Quaternius — LowPoly Animated Knight** (export the included Blender/FBX to `.glb`).
See `packages/client/public/models/README.md`.

## Architecture notes

- **Server-authoritative**: clients send only intents (`move {x,z}`, `attack {targetId}`).
  The server runs a 20 Hz simulation tick, owns positions/HP/animation-state, and syncs
  via `@colyseus/schema`. Clients interpolate remote entities and drive animations from synced state.
- See [the full plan](.) for the design and future phases (navmesh pathfinding, accounts, persistence, deploy).
