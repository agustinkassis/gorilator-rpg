# Testing

Four layers, all wired into `turbo` (cached — unchanged packages skip) and CI.

## 1. Unit tests (Vitest)

```bash
pnpm test            # turbo run test → shared + server Vitest, CLI node:test
pnpm --filter @rpg/server exec vitest   # watch mode for one package
```

- Tests live next to the code: `packages/*/src/**/*.test.ts`.
- **Schema gotcha**: anything importing the Colyseus schema must use the
  *compiled* `@rpg/shared` (the workspace resolves it to `dist/`) — the
  `@type` decorators only compile via tsc, never through Vitest's esbuild.
  `turbo run test` orders the shared build first; running vitest directly needs
  `pnpm build:shared` once.
- Decorator-free shared modules (`perf.ts`, `obstacles.ts`, `entityFeatures.ts`)
  are imported from source.
- `combat.test.ts` / `movement.test.ts` are **characterization tests**: they pin
  the damage formula, windup flow, movement and spawn keep-out behavior
  (`Math.random` is mocked for determinism). If you intentionally change game
  balance, update them in the same PR.
- The plugin seam is covered by `packages/server/src/systems/plugins/plugins.test.ts`,
  which loads the worked-example plugin against the real host registries.

## 2. E2E (Playwright)

```bash
pnpm e2e:game        # full stack: real splash join → Colyseus WS → render loop
pnpm e2e             # same game smoke through the default Playwright project set
```

- Config: `playwright.config.ts`. Fixed ports 1462x (never collide with dev).
- The game project boots the server with `GORILATOR_TEST=1` — deterministic
  room: no goblin waves, room pre-created — plus `GORILATOR_SCENARIO=hunger`
  for the Feature Lab smoke, and headless Chromium with swiftshader for
  software WebGL.
- **The cardinal rule: assert on DOM / network / `window.__perf` — never canvas
  pixels.** The Babylon frame is timing-dependent, and HMR used to stack
  `main.ts` instances (now guarded by an `import.meta.hot.dispose` teardown, but
  the rule stands).
- The game smoke proves: WS to the Colyseus port opens, `/api/status` registers
  the player, `__perf.latest().fps > 0` (the render loop is alive).
- The Hunger Lab smoke opens `?scenario=hunger&autojoin=HungerBot` with waves,
  La Crypta defense, and authored spawners disabled; it polls synced hunger,
  uses food from slot 0, and verifies hunger rises.

## 3. Benchmark gate

```bash
pnpm bench           # capture vs perf-baselines/<scenario>.json, fail past thresholds
pnpm bench:update    # re-record the baseline after an INTENTIONAL perf change
```

See `docs/performance.md` and the `bench` skill. Baselines are machine-specific —
gate on the machine that recorded them; CI runs functional tests only.

## 4. CI

`.github/workflows/test.yml` (every PR): one `turbo run lint typecheck build test`
DAG invocation (pnpm-store + .turbo caches) + the game smoke as a soft gate
(WebGL-in-CI variance). `version-guard.yml` enforces the version topology.

## Verifying by hand

Two browser tabs + the Colyseus monitor (`/colyseus`) + `curl /api/status`
remains the quickest sanity pass for sync behavior; `window.__perf.latest()`
in the console proves the render loop without screenshots. See
[DEBUGGING.md](DEBUGGING.md) for the full toolkit.
