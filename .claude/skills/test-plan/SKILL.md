---
name: test-plan
description: Author and maintain the per-worktree test plan (.gorilator/test-plan.json) that drives the global kanban dashboard (pnpm dashboard). Use at the START of any feature/bugfix work, whenever task status changes, and at session start to check for rejected tasks. Docs: docs/test-dashboard.md.
---

# Test plan — the agent side of the dashboard

The human watches `pnpm dashboard` (run from the MAIN tree — it aggregates every
worktree). You keep `<worktree>/.gorilator/test-plan.json` truthful in realtime;
the board re-reads it every ~2s. The file is local-only (`.gorilator/` is
gitignored) — never commit it.

## Schema v1

```json
{
  "v": 1,
  "feature": "quests-v1",
  "issue": 81,
  "updatedAt": "2026-07-05T12:00:00Z",
  "tasks": [
    {
      "id": "quest-accept",
      "title": "Accept a quest from an NPC",
      "kind": "feature | bugfix | optimization | docs",
      "status": "planned | in_progress | ready | verified | rejected",
      "details": "one short paragraph of what changed / what to look at",
      "expected": "what the tester should SEE when it works — the pass criterion",
      "test": {
        "type": "scenario | cli | doc | manual",
        "scenario": "quests",
        "command": "pnpm --filter @rpg/server test",
        "path": "docs/presentations/x.pdf",
        "steps": ["only for manual: what the human should do"]
      },
      "verdict": { "result": "…", "note": "…", "at": "ISO", "by": "dashboard" },
      "verdictHistory": []
    }
  ]
}
```

Per `test.type`, only the matching field is required: `scenario` → scenario
name (Test button boots/converges the lab and opens `?scenario=`), `cli` →
`command` (MUST match the dashboard allowlist in `scripts/dashboard/lib.mjs` —
`pnpm test|typecheck|lint|e2e|bench|…`, `pnpm --filter @rpg/<pkg> …`, or
`node scripts/<bench|perf-analyze|check-versions>.mjs …`), `doc` → repo-relative
`path` (md/html/pdf/png/jpg/pptx), `manual` → `steps`.

## Rules

1. **Author the plan BEFORE coding** — one task per independently verifiable
   behavior, each with a concrete `test` block AND an `expected` line (the
   human clicks a card to read details/expected/how-to-test — write for them).
   This is the feature's public contract with the human.
2. **Keep `status` truthful the moment it changes** — flip to `in_progress`
   when you start, back off if you park it. The human is watching live.
3. **`ready` only after the task's own test passed for you** — a `cli` task's
   command exits 0, a `scenario` task's lab was actually played/simulated, a
   `doc` task's file exists.
4. **Verdict fields are dashboard-owned.** Never write `verdict`; never edit
   `verdictHistory` entries. The dashboard sets `verified`/`rejected` (+note).
5. **Rework loop**: on a `rejected` task, read `verdict.note`, move the whole
   `verdict` object into `verdictHistory`, set `status: "in_progress"`, fix,
   then back to `ready`. The card moves back to "Ready to test" for the human.
6. **Re-read before every write** (the dashboard writes verdicts concurrently);
   update `updatedAt` on each write.
7. **At session start, check for `rejected` tasks first** — a rejection note is
   direct human feedback awaiting you.
8. **If `.gorilator/brief.md` exists and the plan has no tasks**, the human
   created this worktree from the dashboard with that brief as the spec —
   author the plan from it, then start implementing.
