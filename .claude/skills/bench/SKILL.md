---
name: bench
description: Capture or compare a performance run — server tick benchmark, client F3 captures, perf log analysis. Use for "is this faster", "benchmark", or perf-regression checks.
---

# Benchmark workflow

**Server (automated):** `pnpm bench` — boots a deterministic server (`GORILATOR_TEST=1`: no waves, room pre-created), captures 15s of 20Hz tick samples via `POST /api/bench`, diffs against `perf-baselines/<scenario>.json`, exits non-zero past thresholds (default: tickMs/frameMs +25%, loopLagMs +50%, fps −10%).
- `pnpm bench:update` — re-record the baseline after an INTENTIONAL perf change (baselines are machine-specific; refresh on the machine that gates).
- `pnpm bench --duration=30000 --scenario=<label> --thresholds='{"tickMs":10}'` for custom runs.

**Client (interactive):** F3 overlay (or `?perf` URL param) → live fps/frame/GPU/draw-call breakdown; the ● button records a labelled capture. `PERF_LOG=1 pnpm dev` writes server JSONL to `perf-logs/`. Slow-frame dips auto-snapshot to `perf-logs/slowdowns-*.json` with the culprit breakdown.

**Analysis:** `pnpm perf <file>` summarizes a JSONL/bench file; `pnpm perf <baseline> <candidate>` diffs (✓/✗ per metric, fps higher-is-better); add `--gate` to exit non-zero on threshold breach. Stats come from the compiled `@rpg/shared` — run `pnpm build:shared` once first.

Gotchas: restart the client for a clean capture (HMR leaves stale perf state); keep the tab foregrounded (background tabs throttle rAF and freeze fps samples). Conventions: `docs/performance.md`.
