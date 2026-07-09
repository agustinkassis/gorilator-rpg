# Feature Lab — scenario harness + AI dev pipeline

The testing/automation layer every [ROADMAP.md](../ROADMAP.md) Phase 3+ feature
depends on. The first thin implementation exists for `scenarios/hunger.json`;
the remaining sections describe the fuller Phase 2.5 direction.

The core idea: **every feature ships with an isolated simulation scenario** —
a single-player test map staging exactly that feature, with developer tweak
variables for final gameplay tuning, and scripted bots that let an AI agent
*self-verify* the feature before handing it to a human.

> Definition of Done for every roadmap feature:
> **code + scenario manifest + bot self-test + tweak knobs + docs.**

Related: [TESTING.md](TESTING.md) (the four test layers + the "DOM not canvas"
rule) · [configuration.md](configuration.md) (realm.json + tuning) ·
[game-design.md](game-design.md) (the features this harness exists to build).

## Scenario manifests

A scenario is a JSON file in `scenarios/<feature>.json`: an isolated,
single-player-by-default test map that stages **one feature** and nothing
else. It layers over `realm.json`/DevTuning at boot — same merge order, last
write wins.

```jsonc
{
  "name": "hunger",
  "description": "Hunger drain + eating. Food scattered around spawn.",
  "world": {
    "clearPickups": true,
    "wavesEnabled": false,
    "laCryptaDefense": false,
    "spawnersEnabled": false,
    "resources": [{ "kind": "bush", "id": "cranberry_bush_0", "x": 2.5, "z": 2.5 }],
    "groundItems": [{ "item": "wild_berry", "x": 2, "z": 0, "count": 5 }]
  },
  "player": {
    "position": { "x": 0, "z": 0 },
    "stats": { "hunger": 40, "maxHunger": 100 },
    "loadout": [{ "item": "trail_ration", "count": 1 }]
  },
  "tuning": { "hungerDrainPerMin": 6 },             // any DevTuningKey
  "timeScale": 1,
  "tweaks": ["hungerDrainPerMin"]
}
```

Worked examples that define the bar:

- **`scenarios/hunger.json`** — waves, La Crypta defense, and authored spawners
  off; a cranberry bush resource and loose food staged around spawn; hunger
  tuning starts at the default survival pace while food restore can still be
  tested immediately.
- **`scenarios/farming.json`** — seeds in the starting inventory, tilled plots
  staged near spawn, `timeScale: 20` so crops grow in seconds instead of
  minutes.

## Runner

```bash
pnpm scenario hunger        # boots the dev stack with scenarios/hunger.json layered in
```

- The runner sets `GORILATOR_TEST=1` and `GORILATOR_SCENARIO=hunger`, then
  prints a ready-to-test URL with `?scenario=hunger&autojoin=HungerBot`.
- Scenario sandboxes default `wavesEnabled`, `laCryptaDefense`, and
  `spawnersEnabled` to `false`; the normal non-scenario game still starts with
  the La Crypta defense loop enabled.
- v1 scenarios are process-scoped: `?scenario=` labels/auto-joins the already
  booted scenario server; it does not switch a live server to a different
  manifest.
- Builds on what exists: the `GORILATOR_TEST` isolation flag, the
  `applyRealmConfig`/DevTuning seeding path, and per-worktree ports — a
  scenario in one worktree never collides with the game in another.
- Scenarios become **fully reproducible** (same scenario + same seed → same
  run) once the seeded RNG service lands
  ([engineering.md](engineering.md) §3).

## Time shift

`state.timeScale` already exists in the schema (Dev Mode pause/slow-mo).
Phase 2.5 promotes it to a first-class tuning knob and **audits every gameplay
timer** — growth, regrow, hunger drain, craft times, ability cooldowns — to
respect it, so accelerated simulation works end-to-end: grow crops in seconds,
run a "day" of hunger in a minute, fast-forward a craft queue.

## Tweak panel

Each scenario declares the tuning keys it is about. The Dev Mode tuning panel
pins them in a **"Scenario tweaks"** section at the top — the human's final
gameplay pass happens on sliders, in the running scenario, not in a config
file. A **"bake values"** export writes the tuned numbers back out (to
`realm.json` or as a `constants.ts` suggestion) so tuning survives the
session.

## Bot player simulation

Scripted simulated players that run **server-side**, reusing the brain
registry and the bench harness patterns:

- **Behavior primitives:** `moveTo`, `pickup`, `eat`, `plant`, `craft`,
  `equip`, `attack`, `cast` — composed into named behaviors
  (`eat_when_hungry`, `farm_loop`, `tank_and_taunt`).
- **State assertions:** behaviors pair with checks over `GameState` — *bot
  eats → hunger refills*, *bot plants → resource appears → harvest yields
  seeds*. Inspection, not pixels — per the repo's DOM-not-canvas verification
  rule ([TESTING.md](TESTING.md)).
- **Two run modes:** **headless** (Vitest integration tests — a scenario + bot
  + assertions is a test case) and **live** (bots join the running scenario so
  a human watches the loop while tuning it).

Bots are how an AI agent self-verifies a feature before a human ever loads the
game.

## AI dev pipeline

A new `.claude/skills/feature-dev` skill turns a GitHub feature issue into a
ready-to-play test instance:

```
GitHub issue (feature template, includes the DoD checklist)
  → agent analyzes the issue + file anchors
  → asks clarifying questions if the spec is ambiguous
  → implements (content → plugin → core, lowest tier that works)
  → authors scenarios/<feature>.json
  → self-tests: bot behaviors + assertions, then the verification ladder
    (lint · typecheck · build · test · e2e as applicable)
  → starts the dev instance and hands the human a ready-to-play
    ?scenario=<feature> link with the Scenario tweaks panel pre-pinned
```

The human's job collapses to the part humans are for: **play it, feel it, tune
the sliders, say yes or no.**

## Definition of Done (restated)

A roadmap feature is done when all five exist:

| # | Artifact | Where |
| --- | --- | --- |
| 1 | Code | lowest tier that works (content / plugin / core) |
| 2 | Scenario manifest | `scenarios/<feature>.json` |
| 3 | Bot self-test | headless scenario test asserting the loop |
| 4 | Tweak knobs | tuning keys declared + pinned in Scenario tweaks |
| 5 | Docs | the relevant doc updated ([README map](README.md)) |
