# Agent Workflow

> This is the **canonical** agent-instructions file. `CLAUDE.md` is a symlink to it.
> Always edit **AGENTS.md** — never add a separate CLAUDE.md.

- Read `codex-workflow.json` before committing, merging, pushing, or opening a PR.
- Treat `targetBranch` as the selected merge/PR base branch. Default to `main` only when the file or property is missing.
- The local dev UI updates `codex-workflow.json` when the user changes the target branch selector in the lower-left worktree drawer.
- When asked to bring changes from the target branch into the current work branch, merge `targetBranch` or the selected target history point into the current branch and abort/stop on conflicts.
- The dev UI target-commit rows merge target history into the current branch; selecting a newer target commit includes older target commits in history order. Never cherry-pick target commits from the UI.
- When using the dev UI pending-commit merge action, merge only the selected commit into `targetBranch`; do not treat one row button as a whole-branch merge.
- When asked to merge the whole work branch, use `targetBranch` as the destination; do not assume `main` unless `targetBranch` is `main`.

## Versioning (SemVer)

- **Never hand-edit a `version` field** in any `package.json`. Always bump with the tool.
- The root `package.json` is the **app release version**. GitHub Release tags use this version. Package versions, including the npm `gorilator` CLI package, are independent.
- To change a version: `pnpm bump <cli|client|server|shared> <major|minor|patch>` — this bumps the package **and** the app together. Use `pnpm bump app <level>` for app release version bumps.
- Increments follow SemVer 2.0.0 (major resets minor+patch, minor resets patch; prereleases finalize, e.g. `1.4.0-rc.1` + patch → `1.4.0`).
- A PR check (`.github/workflows/version-guard.yml`) **fails** if a package version changed without the app bumping accordingly. Verify locally with `pnpm version:check` before opening/updating a PR.
- To release the CLI: `pnpm bump cli <level>` → merge to `main` → create a GitHub Release tagged with the app version. CI publishes the CLI only when the CLI package version is not already on npm.
- Full policy: `docs/versioning.md`.

## Package map

- `@rpg/shared` (`packages/shared/src`) — Colyseus `@type` schema in `schema/`, `types.ts`, `constants.ts`, `entityFeatures.ts`, `perf.ts`, plugin API in `plugin/`. **tsc-built to `dist/`** (decorators) — client/server consume the compiled output.
- `@rpg/server` (`packages/server/src`) — Express + Colyseus. Game logic = pure `(state, dt)` systems in `systems/`; the 20Hz tick lives in `rooms/GameRoom.ts`.
- `@rpg/client` (`packages/client/src`) — Babylon + Vite. In-game Dev Mode editor in `dev/`, perf overlay in `perf/`. `vite.config.ts` (~2000 lines) holds all `/__*/` dev endpoints.
- `gorilator` CLI (`packages/cli`) — npm-published installer/daemon. Its version is independent of the app release version (CI publishes only when the CLI version isn't already on npm).

## Where things live (intent → file)

| Change | Edit |
| --- | --- |
| Entity stats / HP / drops / brain | `packages/client/public/entity-features.json` (server: `systems/entityFeatures.ts`) |
| Props / collision | `public/props.json` (`systems/props.ts`) |
| Spawners | `public/spawners.json` (`systems/spawners.ts`) |
| Wave composition | `public/waves.json` (`systems/waves.ts`) — consumed by the la-crypta-defense event module |
| The tower-defense game loop (waves/house/wipe) | `plugins/la-crypta-defense/` (event module, API 1.1) — realm.json `events` toggles it |
| Feature Lab scenarios (isolated test maps) | `scenarios/<name>.json` (`systems/scenario.ts`) — run: `pnpm scenario <name>` |
| Bot driver (scripted players + self-tests) | `packages/server/src/systems/bots/` + `testing/scenarioSim.ts` |
| NPCs / character templates | `public/npcs.json` + `public/characters.json` (`systems/npcs.ts`) |
| Items (defs + icons/models) | `public/items.json` (`systems/items.ts`, client `items/itemRegistry.ts`) |
| Tree/rock drop tables | `public/resources.json` (`systems/resourceDrops.ts`) |
| Damage formula / combat | `packages/server/src/systems/combat.ts` |
| AI brains | `systems/goblins.ts` + plugin `registerBrain` (see `docs/plugins.md`) |
| New synced field | `packages/shared/src/schema/*` → rebuild shared → client **hard reload** |
| Game tuning constants | `packages/shared/src/constants.ts` (live knobs: Dev Mode tuning panel; scenario manifests pin them as tweak knobs) |
| Gameplay randomness | seeded streams via `systems/rng.ts` — NEVER `Math.random` (guard test enforces) |
| Realm policy (death penalty / progression persistence) | `realm.json` `policy` block (`packages/server/src/systems/policy.ts`) |
| Dev-editor HTTP endpoints | `packages/client/vite.config.ts` (`/__props/*`, `/__char/*`, `/__items/*`, …) |

All `public/*.json` manifests live-reload on the server (watchFile) — no restart needed.

## Rebuild gotchas

1. Editing `@rpg/shared` → `pnpm build:shared` (or rely on the `pnpm dev` watcher) before server/client pick it up.
2. Schema (`@type`) changes need a client **hard reload**, not HMR.
3. Everything is tsc-gated via `pnpm typecheck`; builds + tasks are Turbo-cached (`turbo.json`).

## Dev workflow commands

- `pnpm bootstrap` — clone-to-running setup (install, .env, ports, warm cache). Then `pnpm dev`.
- `pnpm scenario <name>` — boot the dev stack staged by `scenarios/<name>.json`; hand the user the printed `?scenario=` link (auto-joins; Dev Mode pins the manifest's tweak knobs).
- `pnpm dev` — game stack. Per-worktree ports: `.claude/launch.json` (regen: `pnpm wt:launch`).
- `pnpm dashboard` (main tree) — global kanban test board across all worktrees at :7300; the agent maintains `<worktree>/.gorilator/test-plan.json` (see `.claude/skills/test-plan/SKILL.md`, docs: `docs/test-dashboard.md`).
- `pnpm wt <name>` / `pnpm wt rm <name>` / `pnpm wt list` — parallel worktrees with collision-free ports (manifest: `.claude/worktrees-manifest.json` in the main tree).
- `pnpm typecheck` · `pnpm lint` · `pnpm test` · `pnpm e2e` · `pnpm bench` — the verification ladder; run typecheck+test before a PR, `pnpm version:check` too.
- Verify in-browser via DOM/network/`window.__perf` evals — never canvas screenshots (see `docs/TESTING.md`).

## Plugins & forks

- Two tiers: **data plugins** (JSON content packs, no code) and **code plugins** (`plugins/<name>/` with `plugin.json`, server/client entries against `@rpg/shared` plugin API). Guide: `docs/plugins.md`.
- **Fork rule:** forks customize `plugins/`, `packages/client/public/*.json`, and `realm.json` — never `packages/*/src` (keeps forks upstream-mergeable; check with `node scripts/check-fork.mjs`).

## Agent helpers

- Skills live in `.claude/skills/` (dev-up, add-entity, add-system, add-plugin, **feature-dev** — the issue→scenario→bot-test→playable-link pipeline, **test-plan** — the dashboard's per-worktree task file, run-tests, bench, release, merge-target, perf-triage); subagents in `.claude/agents/`; cached deep references in `.claude/context/` — read those fragments lazily, only when the task touches that area.
- Parallel worktree fan-out: only for independent, non-overlapping work (e.g. content JSON in one tree, a server system in another). Never edit the shared schema in two trees at once — every shared change forces a rebuild for all.
