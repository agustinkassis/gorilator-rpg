# Debugging

Outside-in toolkit. Every artefact already exists — know where to look.

## Client

1. **F3 overlay** (or `?perf` URL param) — fps, CPU frame ms, GPU ms, draw
   calls, triangles, and the ranked "what's heavy" breakdown (reasons / render /
   elements / entities). The ● button records a labelled capture to `perf-logs/`.
2. **`window.__perf`** in the console — `latest()` (the live sample),
   `snapshot`, breakdown providers. The e2e suite uses the same surface.
3. **Auto-captured stutters** — `perf-logs/slowdowns-<ts>.json` snapshots WHY an
   FPS dip happened (the culprit breakdown at that moment), even with no overlay
   open. Deep render state: `perf-logs/render-profile-<ts>.json`. Read with `jq`.
4. **Source maps** — dev is inline; production builds now emit external maps, so
   deployed-realm stack traces map back to TypeScript.
5. **Dev Mode** (in-game editor) — inspect/move/retune live entities; the
   `[shared]`/`[server]`/`[client]` prefixed terminal streams come from
   `scripts/dev.mjs`.

## Server

1. **`GET /api/perf`** — latest tick + 5s rolling summary + per-system span
   tags (`movement`, `combat`, `goblinAi`, …, `plugin:*`). A hot tag maps 1:1 to
   `packages/server/src/systems/<tag>.ts`. `curl -s :2567/api/perf | jq '.latest.tags'`.
2. **Colyseus monitor** — `/colyseus` (open in dev; Basic-auth via
   `MONITOR_USER`/`MONITOR_PASS` in prod): live rooms, state, clients.
3. **`PERF_LOG=1`** — per-tick JSONL to `perf-logs/`; analyze/diff with
   `pnpm perf <file> [candidate]`.
4. **Log convention** — every subsystem logs with a `[tag]` prefix (`[room]`,
   `[waves]`, `[plugins]`, `[plugin:<name>]`, `[packs]`, `[realm]`, `[nostr]`)
   so `grep '\[plugins\]'` isolates a stream.
5. **`POST /api/bench`** — scripted benchmark capture (see `pnpm bench`).

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Port already in use / server won't bind | An orphaned `tsx watch` or `vite` from a crashed run, or a native `gorilator` install holding 2567 — `lsof -i :<port>`, kill it. `pnpm dev` auto-picks the next free port and prints it. |
| FPS frozen / perf numbers stuck | Background tabs throttle rAF — keep the tab foregrounded during captures. |
| Weird double UI / ghost websockets after an edit | Pre-guard HMR stacking; hard-reload. `main.ts` now tears down on `import.meta.hot.dispose`, so this should no longer occur — report it if it does. |
| Schema change not visible | `@type` edits need `pnpm build:shared` (the dev watcher does it) **and a client hard reload** — HMR can't migrate the room schema. |
| Shared type error | The stack keeps running on the last good build; the `[shared]` stream shows the error in red. Fix it, the watcher rebuilds. |
| Plugin didn't load | Check the `[plugins]` log lines: missing `dist/` → `pnpm build:plugins`; api mismatch → bump `apiVersion`; disabled → `realm.json`. |
| Tests can't find `@rpg/shared` schema | Run `pnpm build:shared` (or use `pnpm test`, whose Turbo DAG orders it). |
