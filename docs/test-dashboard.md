# Test-plan dashboard

`pnpm dashboard` (run in the **main tree**) starts one global kanban board at
<http://localhost:7300> that aggregates **every worktree**: the agent's test
plan per worktree, live stack status, and one-click Test buttons per task.
It is the human half of the Feature Lab pipeline (docs/feature-lab.md) — the
agent half is `.claude/skills/test-plan/SKILL.md`.

## The pipeline

1. **Start worktrees** — `pnpm wt <name>` per parallel feature (or the board's
   *＋ New worktree* button, which streams the setup output).
2. **The agent authors a plan** before coding:
   `<worktree>/.gorilator/test-plan.json` — one task per verifiable behavior,
   each with a `test` block. The file is local-only (gitignored).
3. **Statuses update live** — the board polls every 2s; cards move
   Planned → In progress → Ready to test as the agent works.
4. **You test with one click** — per `test.type` the Test button:
   - `scenario` → boots the worktree's dev stack into that Feature Lab
     (or opens `?scenario=` against a running one; the game's `dev_scenario`
     switch recycles a mismatched live room),
   - `cli` → runs the allowlisted command, output streams in the drawer,
   - `doc` → opens the file (md/pdf inline, pptx download),
   - `manual` → shows the steps checklist.
5. **You record a verdict** — ✓ Verify moves the card to Verified; ✗ Reject
   requires a note, which lands in the plan file where the agent reads it,
   reworks, and puts the card back in Ready to test.

## Kanban semantics

Columns: **Planned / In progress / Ready to test / Verified**. A `rejected`
task renders in *In progress* with the red note badge — it's the agent's turn.
Lane chips (top bar) = one worktree each: status dot (gray down · green up ·
gold scenario · pulsing starting), dirty marker, start/stop/play buttons,
click to filter. ⚠ on a lane = two trees declare the same ports in their
`.claude/launch.json`.

**Process dock** (bottom bar): one chip per process the dashboard holds —
managed/starting stacks and the latest run per worktree. Logs open in a
side panel (the board shrinks, stays fully usable); the `─` button or a
second chip click minimizes it while the process keeps running. `■ stop`
kills the focused run or stack. Chips show live (pulsing) / ✓ / ✗ state,
so several stacks and runs can be held and switched between at any time.

## Under the hood

- `scripts/dashboard/server.mjs` — plain `node:http`, no deps, binds
  `127.0.0.1:7300` (`DASHBOARD_PORT` to override; picks the next free port if
  taken). Rejects foreign `Host` headers.
- Worktrees = `git worktree list` ∪ manifest, filtered by existence. Ports per
  tree: live `.gorilator/dev-state.json` (written by `dev.mjs`) → the tree's
  `.claude/launch.json` → `portsFor()` hash.
- **Run manager** — `cli` commands come from the plan file only (the client
  sends a `taskId`, never a command) and must exact-match `RUN_ALLOWLIST` in
  `scripts/dashboard/lib.mjs`; argv spawn, no shell; one live run per tree;
  20-min watchdog.
- **Stack manager** — spawns `node scripts/dev.mjs` detached per tree with
  stdout/err to `.gorilator/stack.log` (a piped child would die with the
  dashboard); marker `.gorilator/dashboard-stack.json` lets a restarted
  dashboard re-adopt running stacks. Stop = group SIGINT → TERM → KILL.
- Verdicts are written into the plan file atomically (tmp + rename, mtime
  retry) — the only fields the dashboard owns.
- Unit suite: `pnpm test:dashboard` (`scripts/dashboard/lib.test.mjs`).

## API

| Route | Does |
| --- | --- |
| `GET /api/state` | Everything the board renders (worktrees, plans, stacks, runs) + content hash |
| `POST /api/task/status` | `{dir, taskId, status}` — move a card |
| `POST /api/task/verdict` | `{dir, taskId, result, note?}` — verify/reject (reject needs a note; only from `ready`) |
| `POST /api/run` | `{dir, taskId}` — run the task's allowlisted command |
| `GET /api/run/log?id&from` | Poll streamed output (ring buffer, seq-resume) |
| `POST /api/run/kill` | `{id}` — stop a live run |
| `POST /api/stack/start` | `{dir, scenario?}` — boot the tree's dev stack (409 if already up) |
| `POST /api/stack/stop` | `{dir}` — stop a managed/adopted stack |
| `GET /api/stack/log?dir&from` | Tail `.gorilator/stack.log` (byte offsets) |
| `POST /api/worktree/create` | `{name}` — `pnpm wt <name>` streamed through the run manager |
| `GET /api/file?dir&path` | Serve a doc from a worktree (extension allowlist, traversal-guarded) |
