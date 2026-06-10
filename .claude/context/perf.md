# Perf system pointers

Canonical doc: `docs/performance.md` (pipeline, tag vocabulary, improvement workflow).

- Shared stat types + percentile/summarize: `packages/shared/src/perf.ts` (unit-tested; the analyzer imports the compiled copy — never duplicate them).
- Server: `packages/server/src/systems/perf.ts` (`perfTracker` — span tags per system, ring buffer, `/api/perf`, `POST /api/bench`, `PERF_LOG=1` JSONL).
- Client: `packages/client/src/perf/` (PerfTracker + F3 overlay + probes; `window.__perf`, `?perf` param, slow-frame auto-snapshots, render profiles).
- Analysis: `pnpm perf <file> [candidate] [--gate]` (`scripts/perf-analyze.mjs`); automated regression gate: `pnpm bench` / `pnpm bench:update` (`scripts/bench.mjs`, baselines in `perf-baselines/`).
- Artefacts land in `perf-logs/` (gitignored): `bench-*.json`, `slowdowns-*.json`, `render-profile-*.json`, sample JSONL.

Gotchas: background tab throttles rAF (frozen fps); HMR leaves stale perf state (hard reload before captures); benches need `GORILATOR_TEST=1` for reproducibility.
