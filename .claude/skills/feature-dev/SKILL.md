---
name: feature-dev
description: Turn a GitHub feature issue (or feature request) into an implemented, scenario-staged, bot-verified, ready-to-play instance. Use for "implement issue #N" or any new gameplay-feature request. The Feature Lab pipeline (docs/feature-lab.md).
---

# Feature dev pipeline

The Definition of Done for EVERY roadmap feature (docs/feature-lab.md): **code +
scenario manifest + bot self-test + tweak knobs + docs.** This skill walks the
pipeline that produces all five and ends with a link the human just plays.

1. **Read the issue**: `gh issue view <N>` (the feature template carries the DoD
   checklist + file anchors). Restate the gameplay loop being built in one
   sentence — if you can't, the spec is ambiguous.
2. **Clarify before coding**: numbers missing, an interaction undefined, two
   valid readings? Ask the human 2–3 pointed questions FIRST.
3. **Pick the lowest tier that works** (docs/plugins.md): content manifest
   (`/add-entity`) → plugin (`/add-plugin`, incl. `registerEventModule` game
   loops) → core (`/add-system`). New tunables go in `constants.ts` +
   `devTuning.ts` (+ a `TuningControl` entry in `dev/DevMode.ts` for a slider).
4. **Implement**. Every new system runs in a perf span; pure `(state, dt)`; all
   randomness through `rng(state, "<stream>")` — the guard test rejects
   `Math.random` (engineering.md §3).
5. **Author `scenarios/<feature>.json`** (shape: `scenarios/README.md`; worked
   example: `scenarios/bot-arena.json`). Stage ONLY this feature:
   `"systems": {"events": false}`, crank `tuning`/`timeScale` so the full loop
   plays out in under a minute, and pin a `seed` for reproducibility.
6. **Bot self-test**: reuse a builtin behavior (`wander/aggro/loot/eat_when_low`)
   or register one (`registerBotBehavior`, primitives in
   `packages/server/src/systems/bots/driver.ts`). Write a headless test with
   `createScenarioSim` — template: `packages/server/src/systems/bots/botArena.test.ts`.
   `pnpm --filter @rpg/server test` until green.
7. **Verification ladder**: `/run-tests` (lint · typecheck · build · unit · e2e).
8. **Hand off a playable instance**: `pnpm scenario <feature>` (or `/dev-up`
   with `GORILATOR_SCENARIO=<feature>`), then give the human the link
   `http://localhost:<client-port>/?scenario=<feature>` (port: `.claude/launch.json`).
   It auto-joins single-player; the Dev Mode gameplay panel pins the manifest's
   knobs under **Scenario tweaks**. Tell them: *play it, tune the sliders, press
   "Bake values" when it feels right* (bake persists to realm.json).
9. **Done = all five DoD artifacts.** Update the relevant doc (README map) and,
   if the scenario is a good template, list it in `scenarios/README.md`.
