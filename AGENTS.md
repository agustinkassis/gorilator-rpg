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
- The root `package.json` is the **app release version**. GitHub Release tags use this version, and the npm `gorilator` CLI package must use the same version.
- To change a version: `pnpm bump <cli|client|server|shared|landing> <major|minor|patch>` — this bumps the package **and** the app together. For CLI releases, keep `packages/cli/package.json` equal to the app version. Use `pnpm bump app <level>` for app release version bumps.
- Increments follow SemVer 2.0.0 (major resets minor+patch, minor resets patch; prereleases finalize, e.g. `1.4.0-rc.1` + patch → `1.4.0`).
- A PR check (`.github/workflows/version-guard.yml`) **fails** if a package version changed without the app bumping accordingly. Verify locally with `pnpm version:check` before opening/updating a PR.
- To release the CLI: `pnpm bump cli <level>` so the CLI and app versions match → merge to `main` → create a GitHub Release tagged with the app version (CI publishes the same version to npm).
- Full policy: `docs/versioning.md`.
