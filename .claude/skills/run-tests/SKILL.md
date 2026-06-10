---
name: run-tests
description: Run the verification ladder before a PR — lint, typecheck, build, unit tests, e2e, version check. Use for "run the tests", "verify this", or pre-PR checks.
---

# Verification ladder

All tasks are Turbo-cached — unchanged packages are skipped, so run the full set freely:

1. `pnpm exec turbo run lint typecheck build test` — Biome lint, tsc typecheck (all packages incl. client), builds, Vitest unit suites (shared + server) + CLI node:test. One DAG invocation.
2. `pnpm e2e:landing` — Playwright DOM tests for the React landing (fast, no WebGL).
3. `pnpm e2e:game` — headless full-stack smoke: real splash join → Colyseus WS → `/api/status` registers the player → `window.__perf` reports fps>0. Needs ~30s.
4. `pnpm bench` — server tick benchmark vs `perf-baselines/`; fails on >25% tick-cost regression. Run when server systems changed.
5. `pnpm version:check` — always before opening/updating a PR (version-guard mirrors it in CI).

Gotchas:
- Unit tests that import the schema use the **compiled** `@rpg/shared` dist — Turbo's `^build` edge handles the ordering; running `vitest` directly in `packages/server` needs `pnpm build:shared` first.
- e2e asserts on DOM/network/`__perf` only — never write canvas-screenshot assertions (WebGL output is not stable; see `docs/TESTING.md`).
- e2e ports are fixed at 1462x and never collide with dev stacks.
