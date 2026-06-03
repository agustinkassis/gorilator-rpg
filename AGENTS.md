# Agent Workflow

- Read `codex-workflow.json` before committing, merging, pushing, or opening a PR.
- Treat `targetBranch` as the selected merge/PR base branch. Default to `main` only when the file or property is missing.
- The local dev UI updates `codex-workflow.json` when the user changes the target branch selector in the lower-left worktree drawer.
- When asked to bring changes from the target branch into the current work branch, merge `targetBranch` or the selected target history point into the current branch and abort/stop on conflicts.
- The dev UI target-commit rows merge target history into the current branch; selecting a newer target commit includes older target commits in history order. Never cherry-pick target commits from the UI.
- When using the dev UI pending-commit merge action, merge only the selected commit into `targetBranch`; do not treat one row button as a whole-branch merge.
- When asked to merge the whole work branch, use `targetBranch` as the destination; do not assume `main` unless `targetBranch` is `main`.
