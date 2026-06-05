# Claude Code — project instructions

This project's agent rules live in `AGENTS.md` (the tool-agnostic standard). They
apply to Claude Code too — imported here so Claude reads them automatically:

@AGENTS.md

Key reminders:

- **Versioning:** never hand-edit a `package.json` `version`. Use
  `pnpm bump <package> <major|minor|patch>` (bumps the package + the umbrella app
  version together). The PR `version-guard` check enforces it; run `pnpm version:check`
  locally. See `docs/versioning.md`.
- **Branch/PR workflow:** follow the `codex-workflow.json` / `targetBranch` rules in
  `AGENTS.md` before committing, merging, pushing, or opening a PR.
