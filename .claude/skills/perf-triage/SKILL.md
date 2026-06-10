---
name: perf-triage
description: Diagnose a slowdown, FPS drop, or tick-time spike. Use for "the game is lagging", "fps dropped", "server is slow".
---

# Perf triage

Work outside-in; every artefact below already exists (see `docs/performance.md` for tag vocabulary):

1. **Server tick**: `curl -s http://localhost:<server>/api/perf | jq '.latest, .window.metrics.tickMs'` — per-system span times are in `.latest.tags` (`movement`, `combat`, `goblinAi`, `waves`, …, `plugin:*`). A hot tag maps 1:1 to `packages/server/src/systems/<tag>.ts`.
2. **Client frame**: F3 overlay (or `?perf`) — fps, CPU frame ms, GPU ms, draw calls, and the "what's heavy" breakdown (reasons/render/elements/entities, heaviest first).
3. **Stutters that already happened**: `perf-logs/slowdowns-<ts>.json` — auto-captured FPS dips with the culprit breakdown at that moment. `perf-logs/render-profile-<ts>.json` — deep render snapshot (per-kind triangles, sub-phase ms, top meshes). Read with `jq`.
4. **Compare runs**: capture before/after with `pnpm bench` (server) or the F3 ● record button (client), then `pnpm perf <baseline> <candidate>`.
5. **Live state**: Colyseus monitor at `/colyseus` (entity counts, room state).

Gotchas: background tabs throttle rAF (fps reads as frozen — keep the tab foregrounded); HMR leaves stale perf state (hard-reload before capturing); a port held by a crashed native build can shadow the server (`lsof -i :2567`).
