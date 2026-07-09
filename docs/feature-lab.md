# Feature Lab — scenario harness + AI dev pipeline

The testing/automation layer every [ROADMAP.md](../ROADMAP.md) Phase 3+ feature
depends on. **Implemented** (Phase 2.5): scenario loader
(`packages/server/src/systems/scenario.ts`), runner (`pnpm scenario`), bot
driver (`packages/server/src/systems/bots/`), headless harness
(`packages/server/src/testing/scenarioSim.ts`), Scenario-tweaks panel +
bake (Dev Mode), and the `/feature-dev` skill.

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
  "seed": 1234,                           // pin the cycle RNG → reproducible runs
  "world": {
    "clearPickups": true,
    "resources": [{ "kind": "bush", "id": "cranberry_bush_0", "x": 2.5, "z": 2.5 }],
    "npcs": [{ "defId": "gorila", "x": -4, "z": 3 }],
    "groundItems": [{ "item": "wild_berry", "x": 2, "z": 0, "count": 5 }],
    "enemies": [{ "kind": "goblin", "x": 8, "z": 0, "level": 1 }]
  },
  "player": {
    "loadout": [{ "item": "potion", "count": 3 }],  // replaces the starter inventory
    "stats": { "level": 5, "hunger": 40 },          // whitelisted Player fields (#72 incl.)
    "position": { "x": 0, "z": 0 }
  },
  "systems": { "events": false, "spawners": false }, // realm event/spawners; DEFAULT event off
  "tuning": { "hungerDrainPerMin": 6 },              // any DevTuningKey → seeded knob values
  "tweaks": ["starvationDamagePerSec"],              // extra pinned knobs using current defaults
  "timeScale": 2,                                   // 0..TIME_SCALE_MAX (16)
  "bots": [{ "behavior": "eat_when_low", "count": 1 }]
}
```

(`world.props` is reserved for a client-side overlay — not server-staged in v1.
`world.resources` accepts `tree`, `rock`, and the Hunger Lab `bush`; older
`world.wavesEnabled` / `laCryptaDefense` / `spawnersEnabled` flags are still
accepted as aliases for the `systems` toggles.)

Worked examples that define the bar (in [scenarios/](../scenarios/README.md)):

- **`scenarios/bot-arena.json`** — the bot driver's own self-test: an aggro bot
  clears staged goblins while a loot bot collects the staged bananas;
  `botArena.test.ts` is the headless template every feature copies.
- **`scenarios/hunger.json`** — Hunger Lab: no realm event or ambient spawners,
  a cranberry bush resource, staged food, and survival food multipliers pinned.
- **`scenarios/death-penalty-l10.json`** — starts a fresh player at level 10
  with 1200 XP progress and a close goblin pack so death drains the XP bar and
  reports the exact EXP loss.
- **`scenarios/wave-siege.json`** — the La Crypta Defense event with the
  difficulty knobs (#64) pinned for slider tuning.
- **`scenarios/baseline.json`** — the empty-sandbox e2e smoke stage.

## Runner

```bash
pnpm scenario hunger        # boots the dev stack with scenarios/hunger.json layered in
pnpm scenario sandbox       # default open-realm fixture: no home objective, no waves
```

- The runner sets `GORILATOR_SCENARIO` (the server-side source of truth) and
  prints the ready-to-play `?scenario=...&autojoin=...` link; on open dev
  servers the URL param alone also selects it for a freshly created room.
- `?scenario=hunger` auto-joins single-player (no splash); the realm event
  module stays off unless the manifest sets `"systems": {"events": true}`.
- Merge order (binding): defaults → realm.json → scenario → `GORILATOR_TEST` →
  live `dev_tune`. Per-worktree ports keep labs from colliding.
- **Fully reproducible**: the manifest `seed` (or `GORILATOR_SEED`) pins the
  cycle RNG ([engineering.md](engineering.md) §3); `/api/status` reports
  `activeScenario` + `cycleSeed`.

## Time shift

Every gameplay timer runs on the timeScale-scaled tick delta (audited in #67;
equivalence-tested in `timeScale.test.ts`), so accelerated simulation works
end-to-end — cap `TIME_SCALE_MAX = 16` (the Dev Mode time bar goes to 16×;
above that a 20Hz tick starts tunnelling, sub-stepping is the follow-up).
Bot `waitFor`/`waitUntil` run on sim time, so accelerated labs fast-forward
bot programs too.

## Tweak panel

The manifest's `tuning` keys ARE the declared tweak knobs: the server sends a
`"scenario"` message on join and the Dev Mode gameplay panel pins them in a
**"Scenario tweaks"** section at the top (sliders seeded with the manifest
values, applied live via `dev_tune`; keys without a slider definition get a
numeric input). The **"Bake values"** button POSTs `/__scenario/bake`, which
read-merge-writes ONLY the `tuning` block of the repo-root `realm.json` — the
tuned numbers survive the session. A **"Bots"** section spawns/clears scripted
players live (`dev_bot`).

## Bot player simulation

Scripted simulated players that run **server-side**, reusing the brain
registry and the bench harness patterns:

- **Behavior primitives** (`systems/bots/driver.ts`): `moveTo`,
  `pickupNearest`, `attackNearest`, `eat`, `waitFor`, `waitUntil`, `say`,
  composed with `seq`/`loop`; `craft`/`equip`/`cast`/`plant` are **reserved**
  (they fail loudly until their systems land — each Phase 3 feature adds its
  primitive alongside the system). Builtins: `wander`, `aggro`, `loot`,
  `eat_when_low` (`BUILTIN_BOT_BEHAVIORS`); register more via
  `registerBotBehavior`. Every primitive carries a sim-time timeout →
  `"failed"` in `botStatuses()` instead of a hung test.
- **State assertions:** checks over `GameState` — *bot eats → hunger refills*.
  Inspection, not pixels — per the repo's DOM-not-canvas verification rule
  ([TESTING.md](TESTING.md)).
- **Two run modes:** **headless** — `createScenarioSim` composes the real
  systems in GameRoom tick order (a scenario + bots + assertions is a Vitest
  case; template: `systems/bots/botArena.test.ts`) — and **live**: scenarios
  auto-spawn their `bots[]`, and the `dev_bot` message / the panel's Bots
  section spawns them ad hoc.

Bots are how an AI agent self-verifies a feature before a human ever loads the
game.

## AI dev pipeline

The `.claude/skills/feature-dev` skill turns a GitHub feature issue into a
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
