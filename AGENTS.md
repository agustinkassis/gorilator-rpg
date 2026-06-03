# Agent Workflow

- Read `codex-workflow.json` before committing, merging, pushing, or opening a PR.
- Treat `targetBranch` as the selected merge/PR base branch. Default to `main` only when the file or property is missing.
- The local dev UI updates `codex-workflow.json` when the user changes the target branch selector in the lower-left worktree drawer.
- When asked to commit work from this worktree and merge it, commit the current work branch and merge the whole branch into `targetBranch`; do not assume `main` unless `targetBranch` is `main`.
