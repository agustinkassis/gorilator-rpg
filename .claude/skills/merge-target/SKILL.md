---
name: merge-target
description: Bring target-branch changes into this work branch, or merge this branch to its base. Use for merge/sync/PR-base requests.
---

# Merging with the target branch

1. Read `codex-workflow.json` → `targetBranch` (default `main` only when the file/property is missing). The dev UI's worktree drawer updates this file.
2. **Sync FROM target**: `git merge <targetBranch>` (or the selected target history point) into the current branch. **Abort and stop on conflicts** — surface them, don't resolve unilaterally.
3. **Merge TO target** (whole work branch): the destination is `targetBranch`, never an assumed `main`.
4. Never cherry-pick target commits from the dev UI rows — selecting a newer target commit merges all older target commits in history order.
5. The dev UI pending-commit action merges only the selected commit into `targetBranch` — one row ≠ the whole branch.
6. Before any PR: `pnpm version:check` + the run-tests ladder.
