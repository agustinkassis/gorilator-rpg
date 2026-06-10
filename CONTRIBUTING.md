# Contributing to Gorilator

Multiplayer isometric RPG — Babylon.js client, Colyseus server, pnpm monorepo.
This guide is the **complete dev workflow**: setup → develop → verify → PR.

## One-command setup

```bash
git clone https://github.com/agustinkassis/gorilator-rpg.git
cd gorilator-rpg
pnpm bootstrap   # install + .env + per-worktree ports + warm build cache
pnpm dev         # game: Babylon client + Colyseus server + shared watcher
```

Open the printed client URL, type a name, hit ENTER — you're in the game.
`pnpm landing` runs the marketing site + live stats dashboard instead.
Requirements: Node ≥ 20, pnpm 10 (`corepack enable`).

## Repo layout (where to make your change)

| You want to… | Go to | Tier |
| --- | --- | --- |
| Add/tune entities, NPCs, waves, items, drops | `packages/client/public/*.json` (live-reload, no recompile) | **content** |
| Add behaviors/integrations (AI brains, item effects, tick systems, event hooks) | `plugins/<name>/` — see [docs/plugins.md](docs/plugins.md) | **plugin** |
| Change the engine itself | `packages/{shared,server,client}/src` | **core** |

Always prefer the lowest tier that can express your change. The
[AGENTS.md](AGENTS.md) "Where things live" table maps intents to exact files.

**Core layout:** `@rpg/shared` (Colyseus schema + types + constants — tsc-built,
both sides consume its `dist/`), `@rpg/server` (pure `(state, dt)` systems +
the 20Hz `GameRoom` tick), `@rpg/client` (Babylon + Vite + the in-game Dev Mode
editor), `@gorilator/landing` (React), `packages/cli` (the npm `gorilator`
installer — its version must always equal the app version).

## Day-to-day workflow

- `pnpm dev` boots in ~3s (server + client spawn in parallel; the shared tsc
  watcher rebuilds in the background — a shared type error logs red but never
  blocks the running stack).
- Edits hot-reload: client via Vite HMR (schema changes need a **hard reload**),
  server via tsx watch, content JSON via server file-watchers.
- Parallel work? `pnpm wt <name>` creates a git worktree with its own
  collision-free ports (`pnpm wt list`, `pnpm wt rm <name>`).
- Everything build-shaped is cached by Turborepo — repeat builds/typechecks/tests
  of unchanged packages cost ~0.5s.

## Verification ladder (run before a PR)

```bash
pnpm exec turbo run lint typecheck build test   # Biome + tsc + builds + unit tests (cached DAG)
pnpm e2e:landing                                # Playwright DOM tests for the landing
pnpm e2e:game                                   # headless full-stack smoke (join + WS + render loop)
pnpm bench                                      # server tick regression gate (when server code changed)
pnpm version:check                              # version topology (CI enforces it too)
```

Unit tests live next to the code (`packages/*/src/**/*.test.ts`, Vitest);
characterization tests for combat/movement pin the gameplay formulas. E2E
asserts on DOM/network/`window.__perf` — **never canvas screenshots** (see
[docs/TESTING.md](docs/TESTING.md)). Debugging tools: [docs/DEBUGGING.md](docs/DEBUGGING.md).

## Versions & releases

Never hand-edit a `version` field — use `pnpm bump <pkg|app> <major|minor|patch>`
(it bumps the package and the app together; CI's version-guard rejects PRs that
don't). Full policy: [docs/versioning.md](docs/versioning.md).

## PRs

1. Branch from `main`, keep PRs focused.
2. Run the verification ladder; CI runs the same Turbo DAG + Playwright landing
   suite + the version guard.
3. The PR base is the `targetBranch` in `codex-workflow.json` (defaults to `main`).

## Forks & integrations

Building your own realm/mod? **Don't edit `packages/*/src`** — put everything in
`plugins/`, `packages/client/public/*.json`, and `realm.json` (tuning + plugin
toggles). Then `git merge upstream/main` stays conflict-free forever. Check
yourself with `node scripts/check-fork.mjs` (use `--strict` in your fork's CI).
Plugin author guide: [docs/plugins.md](docs/plugins.md).

## AI-assisted development

The repo ships agent infrastructure (Claude Code / Codex):

- [AGENTS.md](AGENTS.md) — the always-loaded map (package map, where-things-live,
  rebuild gotchas). `CLAUDE.md` is a symlink to it.
- `.claude/skills/` — task playbooks (`dev-up`, `add-entity`, `add-system`,
  `add-plugin`, `run-tests`, `bench`, `release`, `merge-target`, `perf-triage`).
- `.claude/agents/` — scoped subagents (explore, plan, review, content-author).
- `.claude/context/` — cached deep references (systems index, manifest catalog,
  dev endpoints, perf pointers) that agents read lazily.
- A SessionStart hook reports the worktree's ports + target branch automatically.

To cut permission prompts, add a project allowlist to `.claude/settings.json`
(`permissions.allow`) for read-only commands — e.g. `Bash(git status:*)`,
`Bash(git diff:*)`, `Bash(git log:*)`, `Bash(ls:*)`, `Bash(jq:*)`,
`Bash(curl -s http://localhost:*)`, `Bash(pnpm typecheck)`, `Bash(pnpm lint)`,
`Bash(pnpm test)`, `Bash(pnpm version:check)`, `Bash(node scripts/perf-analyze.mjs:*)`
— keep commit/push/bump/deploy/rm gated. The `/fewer-permission-prompts` skill
can mine your transcripts to extend this precisely.
