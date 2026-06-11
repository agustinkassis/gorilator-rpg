# Dev-server HTTP endpoints

## Vite dev endpoints (`packages/client/vite.config.ts`, dev only)

Dev Mode's editors write content through these (they persist into `public/*.json`):

- `/__props/*` — prop library: list/place/move/delete/import GLB models
- `/__char/*` — character library: defs, place, placement-update/delete (npcs.json + characters.json)
- `/__items/*` — item defs (items.json)
- `/__waves/*` — wave author (waves.json)
- `/__perf/save` — saves a client perf capture/benchmark to `perf-logs/`
- `/__worktree/*` — the worktree drawer: branch info, target-commit rows, pending-commit merges (writes `codex-workflow.json`)
- `/plugins/manifest.json` — enabled plugin manifests + client entry URLs (pluginBundler)

## Game server (Express, `packages/server/src/index.ts`)

- `GET /healthz` — liveness (`ok`)
- `GET /api/status` — identity + lifetime stats + current realm (player counts)
- `GET /api/realm` — joinable realm info (REALMS.md spec)
- `GET /api/perf` — latest tick + 5s rolling summary + per-system span tags
- `POST /api/bench` `{label?, durationMs?}` — run a benchmark, returns BenchmarkResult (open in dev; Basic-auth via MONITOR_USER/PASS in prod)
- `GET /api/update` — release-check verdict (update banner)
- `GET/POST /api/admin/*` — NIP-98 authed admin ops (whoami, admins, update)
- `GET /nostr/challenge` — login challenge + server pubkey
- `/colyseus` — live room monitor (Basic-auth in prod, open in dev)
