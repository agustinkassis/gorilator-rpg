# Getting started (developing)

## Prerequisites

- **Node 20+** and **pnpm 10+** (`npm i -g pnpm`)
- A Chromium/Firefox/Safari browser with WebGL2

## Install

```bash
pnpm install
```

This is a **pnpm workspace** monorepo with three packages:

| Package | Name | Role |
| --- | --- | --- |
| `packages/shared` | `@rpg/shared` | Colyseus schema + types + constants — imported by **both** client and server |
| `packages/server` | `@rpg/server` | Authoritative Colyseus game server (WebSocket, port **2567**) |
| `packages/client` | `@rpg/client` | Babylon.js + Vite browser client (port **5173**) |

## Run the dev environment

```bash
pnpm dev
```

`pnpm dev` does three things (via `concurrently`):

1. **Builds `@rpg/shared` once** (`tsc` → `packages/shared/dist`)
2. Watches `@rpg/shared` (`tsc --watch`)
3. Runs the **server** (`tsx watch src/index.ts`, port 2567) and the **client**
   (`vite`, port 5173)

Then open **http://localhost:5173**. Open a second tab to see live multiplayer.
The Colyseus room inspector is at **http://localhost:2567/colyseus**.

### ⚠️ The `@rpg/shared` rebuild gotcha

`@rpg/shared` is consumed as a **built package** (`dist/`), not as raw TypeScript —
its Colyseus schema uses decorators that must be compiled by `tsc`. So:

- Editing `client/` or `server/` → hot-reloads instantly (Vite HMR / `tsx watch`).
- Editing **`shared/src`** → the `shared` watcher rebuilds `dist`, which then
  triggers the server to restart. If you ever run a package in isolation, rebuild
  shared first:
  ```bash
  pnpm --filter @rpg/shared build
  ```
- **Schema changes require BOTH client and server on the rebuilt shared.** A stale
  client tab will desync from the server's new schema (the binary protocol depends
  on field order/types) — **hard-reload the browser** after a schema change.

### Standalone package scripts

```bash
pnpm dev:server     # build shared, then run only the server
pnpm dev:client     # build shared, then run only the client
pnpm build:shared   # compile @rpg/shared → dist
pnpm build          # build shared + the production client bundle
```

## Ports & env

- Client: `5173` (Vite). Server: `2567` (`GAME_SERVER_PORT` overrides; do **not**
  reuse `PORT`, which dev tooling repurposes for the web port).
- In dev no env is required. For production/identity/discovery config see
  [configuration.md](configuration.md) and `.env.example`.

If a server restart ever wedges with `EADDRINUSE :::2567`, the old instance hasn't
released the port yet — stop the dev process and restart `pnpm dev`.

## Project conventions

- **Server-authoritative:** the client sends *intents* (move/attack/throw); the
  server simulates at 20 Hz and syncs state. Never trust the client for game logic.
- **Shared is the contract:** anything both sides need (schema, message shapes,
  tuning) lives in `@rpg/shared`.
- **Systems:** server game logic is split into `packages/server/src/systems/*`
  (movement, combat, goblins, bananas, …), each a pure function over `GameState`.

## Verifying changes

There's no automated test suite; verification is manual:

1. `pnpm dev`, open two tabs.
2. Exercise the change (move, fight, throw, defend La Crypta).
3. Inspect live room state at `http://localhost:2567/colyseus`, or read
   `http://localhost:2567/api/status` for realm/server stats.

## Deploying

See [`../DEPLOY.md`](../DEPLOY.md) (Docker + Cloudflare) and
[`../RAILWAY.md`](../RAILWAY.md) (one-click). The `gorilator` CLI (`pnpm gorilator`)
wraps the self-host flow.
