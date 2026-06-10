---
name: dev-up
description: Start or restart the local dev stack — the game (Babylon client + Colyseus server) or the landing site. Use when asked to run/start/restart the app, or when the SessionStart hook reports no server is up.
---

# Start the dev stack

1. Read this worktree's ports from `.claude/launch.json` (the SessionStart hook also reports them). Never hardcode 5173/2567 — every worktree has its own deterministic block. Missing file → run `pnpm wt:launch` first.
2. Start in the background:
   - **Game**: `CLIENT_PORT=<client> GAME_SERVER_PORT=<server> pnpm dev` — spawns the shared tsc watcher, Colyseus server, and Vite client in parallel. The stack is reachable within ~3s; the `[shared]` watcher logs `ready` when typechecking settles.
   - **Landing**: `pnpm --filter @gorilator/landing exec vite --host 0.0.0.0 --port <landing> --strictPort`
3. Verify: `curl -sf http://localhost:<server>/healthz` → `ok`, and the client URL returns HTML. Colyseus monitor: `http://localhost:<server>/colyseus/`.
4. A red `[shared] N type error(s)` line never blocks the stack — it keeps running on the last good build. Fix the type error; the watcher rebuilds automatically.
5. If a port is stuck, find the orphan with `lsof -i :<port>` (a previous crash can leave `tsx watch`/`vite` running) and kill it.

Flags: `pnpm dev --skip-shared` skips the shared watcher when another process already watches it.
